import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

/* ------------------------------------------------------------------ */
/* 配置持久化：data/config.json                                        */
/* - 环境变量仍是最高优先级（兼容云平台部署），网页保存写入 config.json */
/* - 支持多组配置（accounts）：每组 = 服务账号 + 文件夹 ID              */
/* - 每组密钥单独存 data/keys/<accountId>.json（0600）                  */
/* ------------------------------------------------------------------ */

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const KEY_DIR = path.join(DATA_DIR, 'keys');
const LEGACY_KEY_FILE = path.join(KEY_DIR, 'sa.json');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function writeAtomic(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* Windows 可能不支持 */ }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 把字符串/数组统一成去空的字符串数组（逗号或换行分隔） */
export function splitIds(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,\s]+/);
  return [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
}

/** 由服务账号邮箱生成稳定的账户 ID（用于密钥文件名） */
function accountIdFor(email) {
  const seed = String(email || 'account').toLowerCase();
  return 'acc_' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 14);
}

/* ---------------- .env 凭证读取（覆盖层） ---------------- */

function readServiceAccountFromEnv() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try { return JSON.parse(inline); } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 不是合法的 JSON');
    }
  }
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64 && b64.trim()) {
    return JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  }
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
    if (!fs.existsSync(abs)) throw new Error(`找不到服务账号密钥文件：${abs}`);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  return null;
}

/* ---------------- 运行时配置对象 ---------------- */

/** 校验 SA JSON 结构，返回规范化对象或抛错 */
export function parseServiceAccount(text) {
  let data;
  try { data = JSON.parse(String(text == null ? '' : text)); } catch {
    throw new Error('Service Account JSON 不是合法的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('SA JSON 格式不正确');
  if (data.type && data.type !== 'service_account') throw new Error('该 JSON 不是 service_account 类型');
  if (typeof data.client_email !== 'string' || !data.client_email.includes('@')) {
    throw new Error('SA JSON 缺少 client_email');
  }
  if (typeof data.private_key !== 'string' || !data.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('SA JSON 缺少 private_key');
  }
  return data;
}

const state = {
  /** 网页设置已保存的配置（data/config.json 内容） */
  saved: null,
};

/** 读取一组账号的密钥：优先 <id>.json，其次旧版 sa.json（并复制过来） */
function loadAccountKey(account) {
  let creds = readJson(path.join(KEY_DIR, `${account.id}.json`));
  if (!creds) {
    const legacy = readJson(LEGACY_KEY_FILE);
    if (legacy && (!account.email || legacy.client_email === account.email)) {
      creds = legacy;
      try {
        writeAtomic(path.join(KEY_DIR, `${account.id}.json`), JSON.stringify(creds, null, 2), 0o600);
      } catch { /* 忽略迁移写盘失败 */ }
    }
  }
  return creds || null;
}

function loadSaved() {
  const raw = readJson(CONFIG_FILE);
  const saved = {
    version: 2,
    accessCode: '',
    recursive: true,
    accounts: [],
  };

  if (raw && typeof raw === 'object') {
    saved.accessCode = typeof raw.accessCode === 'string' ? raw.accessCode : '';
    saved.recursive = raw.recursive !== false;

    if (Array.isArray(raw.accounts) && raw.accounts.length) {
      for (const a of raw.accounts) {
        if (!a || typeof a !== 'object') continue;
        const email = String(a.email || '');
        saved.accounts.push({
          id: String(a.id || accountIdFor(email)),
          email,
          folderIds: splitIds(a.folderIds),
          recursive: a.recursive !== false,
        });
      }
    } else if (Array.isArray(raw.folderIds) && raw.folderIds.length) {
      // 旧版单账号配置 → 迁移成一组
      const legacy = readJson(LEGACY_KEY_FILE);
      saved.accounts.push({
        id: accountIdFor(legacy?.client_email || 'legacy'),
        email: legacy?.client_email || '',
        folderIds: splitIds(raw.folderIds),
        recursive: raw.recursive !== false,
      });
    }
  } else {
    // 没有 config.json：只迁移已存在的密钥文件，文件夹等用户在网页填
    const legacy = readJson(LEGACY_KEY_FILE);
    if (legacy?.client_email) {
      saved.accounts.push({
        id: accountIdFor(legacy.client_email),
        email: legacy.client_email,
        folderIds: [],
        recursive: true,
      });
    }
  }

  for (const account of saved.accounts) {
    const creds = loadAccountKey(account);
    if (creds) {
      account.credentials = creds;
      account.email = creds.client_email || account.email;
    }
  }
  state.saved = saved;
}

function persistSaved() {
  const payload = {
    version: 2,
    accessCode: state.saved.accessCode || '',
    recursive: state.saved.recursive !== false,
    accounts: state.saved.accounts.map(({ credentials, ...rest }) => rest),
  };
  writeAtomic(CONFIG_FILE, JSON.stringify(payload, null, 2), 0o600);
}

const accountSignature = (list) =>
  list.map((a) => `${a.id}:${a.email || ''}:${(a.folderIds || []).join(',')}`).sort().join('|');

/**
 * 保存网页配置。
 * accounts: [{ id?, serviceAccountJson?, folderIds, recursive? }]
 *   - id 存在且未提供 JSON → 沿用已保存的密钥
 *   - 提供 JSON → 校验并写入 data/keys/<id>.json
 * accessCode 未提供（undefined）时保留原值。
 * 热生效：写盘后由 index.js 调用 drive.resetAuth() 并清曲库缓存。
 */
export function saveRuntimeConfig(input = {}) {
  const prevAccounts = state.saved.accounts || [];
  const prevCode = state.saved.accessCode || '';
  const prevById = new Map(prevAccounts.map((a) => [a.id, a]));

  let incoming = input.accounts;
  if (!Array.isArray(incoming)) {
    // 兼容旧版接口：顶层 serviceAccountJson + folderIds 视为单组
    const hasLegacy = input.serviceAccountJson != null || input.folderIds != null;
    if (!hasLegacy) throw new Error('缺少配置内容');
    incoming = [{
      id: prevAccounts[0]?.id,
      serviceAccountJson: input.serviceAccountJson ?? undefined,
      folderIds: input.folderIds,
    }];
  }
  if (incoming.length > 20) throw new Error('最多支持 20 组配置');

  const errors = [];
  const next = [];
  const usedIds = new Set();
  let keyChanged = false;

  incoming.forEach((raw, i) => {
    const label = `第 ${i + 1} 组`;
    if (!raw || typeof raw !== 'object') { errors.push(`${label}：格式不正确`); return; }

    const prev = raw.id ? prevById.get(String(raw.id)) : null;
    const folderIds = splitIds(raw.folderIds);
    const jsonText = typeof raw.serviceAccountJson === 'string' ? raw.serviceAccountJson.trim() : '';

    let credentials = prev?.credentials || null;
    if (jsonText) {
      try { credentials = parseServiceAccount(jsonText); } catch (err) {
        errors.push(`${label}：${err.message}`);
        return;
      }
    }
    if (!credentials) { errors.push(`${label}：缺少服务账号 JSON 密钥`); return; }
    if (!folderIds.length) { errors.push(`${label}：缺少文件夹 ID`); return; }

    const email = credentials.client_email;
    const baseId = prev?.id || accountIdFor(email);
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) id = `${baseId}-${n++}`;
    usedIds.add(id);

    if (jsonText) {
      writeAtomic(path.join(KEY_DIR, `${id}.json`), JSON.stringify(credentials, null, 2), 0o600);
      keyChanged = true;
    }

    next.push({
      id,
      email,
      folderIds,
      recursive: raw.recursive !== false && input.recursive !== false,
      credentials,
    });
  });

  if (errors.length) throw new Error(errors.join('；'));

  state.saved.version = 2;
  state.saved.accounts = next; // 内存中保留 credentials，persistSaved 落盘时会剥离
  state.saved.accessCode = input.accessCode === undefined ? String(prevCode) : String(input.accessCode).trim();
  state.saved.recursive = input.recursive !== false;
  persistSaved();

  config.accounts = next;
  config.credentials = next.find((a) => a.credentials)?.credentials || null;
  config.folderIds = next[0]?.folderIds || [];
  config.serviceAccountEmail = next.find((a) => a.credentials)?.email || null;
  config.recursive = state.saved.recursive;
  if (input.accessCode !== undefined) config.accessCode = state.saved.accessCode;
  config.changed = {
    accounts: keyChanged || accountSignature(prevAccounts) !== accountSignature(next),
    accessCode: state.saved.accessCode !== prevCode,
  };
  return config.changed;
}

export const config = {
  port: Number(process.env.PORT || 9527),
  host: process.env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  cacheDir: path.join(ROOT, process.env.CACHE_DIR || '.cache'),
  /** 运行时账号列表：{ id, email, credentials, folderIds, recursive } */
  accounts: [],
  /** 兼容字段：第一个可用账号 */
  credentials: null,
  folderIds: [],
  recursive: true,
  maxDepth: Number(process.env.MAX_DEPTH || 6),
  accessCode: '',
  serviceAccountEmail: null,
  /** 保存设置后标记哪些字段变了，供 index.js 决定是否清缓存 */
  changed: null,
};

/** 是否进入演示模式：没有任何「有密钥且有文件夹」的账号 */
export function computeDemo() {
  if (process.env.DEMO === 'true') return true;
  if (process.env.DEMO === 'false') return false;
  return !(config.accounts || []).some((a) => a.credentials && a.folderIds?.length);
}

// 初始化：env 覆盖层 > data/config.json > 默认演示
let envCredentials = null;
try { envCredentials = readServiceAccountFromEnv(); } catch (err) {
  console.error('[config]', err.message);
  process.exit(1);
}
loadSaved();

if (envCredentials) {
  const envFolders = splitIds(process.env.DRIVE_FOLDER_ID || '');
  config.accounts = [{
    id: 'env',
    email: envCredentials.client_email || '',
    credentials: envCredentials,
    folderIds: envFolders,
    recursive: process.env.RECURSIVE != null ? String(process.env.RECURSIVE) !== 'false' : true,
  }];
  config.recursive = config.accounts[0].recursive;
  if (process.env.ACCESS_CODE != null && process.env.ACCESS_CODE.trim()) config.accessCode = process.env.ACCESS_CODE.trim();
} else {
  config.accounts = state.saved.accounts;
  config.recursive = state.saved.recursive !== false;
  config.accessCode = state.saved.accessCode || '';
}
config.credentials = config.accounts.find((a) => a.credentials)?.credentials || null;
config.folderIds = config.accounts[0]?.folderIds || [];
config.serviceAccountEmail = config.credentials?.client_email || null;
config.demo = computeDemo();

/** env 层是否提供了完整配置 */
export const envDriven = Boolean(envCredentials);

/** 网页是否可修改配置：env 完整驱动时提示「由环境变量管理」 */
export const configSource = envDriven ? 'env' : 'data';

export function describeConfig() {
  const lines = [];
  if (config.demo) {
    lines.push('运行模式：演示模式（本地示例曲目，未连接 Google Drive）');
    if (!config.accounts.some((a) => a.credentials)) lines.push('  · 未检测到服务账号凭证');
    if (!config.accounts.some((a) => a.folderIds?.length)) lines.push('  · 未设置音乐文件夹 ID');
  } else {
    lines.push('运行模式：Google Drive');
    for (const account of config.accounts) {
      if (!account.credentials || !account.folderIds?.length) continue;
      lines.push(`  · 服务账号：${account.email}`);
      lines.push(`  · 音乐文件夹：${account.folderIds.join(', ')}`);
      lines.push(`  · 递归子目录：${account.recursive === false ? '否' : '是'}`);
    }
  }
  if (config.accessCode) lines.push('  · 访问口令：已启用（仅保护设置页）');
  lines.push(`  · 配置来源：${configSource === 'env' ? '环境变量' : 'data/config.json（网页设置）'}`);
  return lines.join('\n');
}
