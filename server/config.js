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
/* - SA 密钥不落 config.json，单独存 data/keys/sa.json（0600）          */
/* ------------------------------------------------------------------ */

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const KEY_FILE = path.join(DATA_DIR, 'keys', 'sa.json');

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

function loadSaved() {
  const saved = readJson(CONFIG_FILE);
  if (saved && typeof saved === 'object') {
    state.saved = saved;
  } else {
    state.saved = { version: 1, folderIds: [], accessCode: '', recursive: true };
  }
  // SA 密钥单独文件
  state.saved._sa = readJson(KEY_FILE);
}

function persistSaved() {
  const { _sa, ...rest } = state.saved;
  writeAtomic(CONFIG_FILE, JSON.stringify(rest, null, 2), 0o600);
}

/**
 * 保存网页配置：SA JSON（可空=不修改）+ folderIds + accessCode + recursive
 * 热生效：写盘后重置 drive.js 的 auth 客户端
 */
export function saveRuntimeConfig({ serviceAccountJson, folderIds, accessCode, recursive }) {
  const prevIds = Array.isArray(state.saved.folderIds) ? state.saved.folderIds : [];
  const prevCode = state.saved.accessCode;

  if (serviceAccountJson != null) {
    const sa = parseServiceAccount(serviceAccountJson);
    writeAtomic(KEY_FILE, JSON.stringify(sa, null, 2), 0o600);
    state.saved._sa = sa;
  }

  // folderIds 未提供（undefined/空白）时保留现有配置，不清空
  let ids;
  if (folderIds == null) {
    ids = prevIds;
  } else {
    const raw = Array.isArray(folderIds) ? folderIds : String(folderIds).split(',');
    const cleaned = raw.map((s) => String(s).trim()).filter(Boolean);
    if (!cleaned.length && prevIds.length) {
      throw new Error('文件夹 ID 不能为空；如需清空请先移除服务账号密钥');
    }
    ids = cleaned;
  }

  state.saved.folderIds = ids;
  // accessCode 未提供时保留现有值（undefined 不清空）
  state.saved.accessCode = accessCode === undefined ? String(prevCode ?? '') : String(accessCode).trim();
  state.saved.recursive = recursive !== false;
  persistSaved();

  config.credentials = state.saved._sa;
  config.folderIds = ids;
  if (accessCode !== undefined) config.accessCode = state.saved.accessCode;
  if (recursive !== undefined) config.recursive = recursive !== false;
  config.serviceAccountEmail = state.saved._sa?.client_email || null;
  config.changed = {
    credentials: serviceAccountJson != null,
    folderIds: ids.join() !== prevIds.join(),
    accessCode: state.saved.accessCode !== prevCode,
  };
  return config.changed;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  cacheDir: path.join(ROOT, process.env.CACHE_DIR || '.cache'),
  credentials: null,
  folderIds: [],
  recursive: true,
  maxDepth: Number(process.env.MAX_DEPTH || 6),
  accessCode: '',
  serviceAccountEmail: null,
  /** 保存设置后标记哪些字段变了，供 index.js 决定是否清缓存 */
  changed: null,
};

// 初始化：env 覆盖层 > data/config.json > 默认演示
let envCredentials = null;
try { envCredentials = readServiceAccountFromEnv(); } catch (err) {
  console.error('[config]', err.message);
  process.exit(1);
}
loadSaved();

if (envCredentials) {
  config.credentials = envCredentials;
  config.folderIds = (process.env.DRIVE_FOLDER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.ACCESS_CODE != null && process.env.ACCESS_CODE.trim()) config.accessCode = process.env.ACCESS_CODE.trim();
  if (process.env.RECURSIVE != null) config.recursive = String(process.env.RECURSIVE) !== 'false';
} else {
  config.credentials = state.saved._sa;
  config.folderIds = state.saved.folderIds || [];
  config.accessCode = state.saved.accessCode || '';
  config.recursive = state.saved.recursive !== false;
}
config.serviceAccountEmail = config.credentials?.client_email || null;

/** env 层是否提供了完整配置（此时网页设置仍可覆盖吗？不——env 优先，网页保存也写 data 但 env 优先） */
export const envDriven = Boolean(envCredentials);

/** 网页是否可修改配置：env 完整驱动时提示「由环境变量管理」 */
export const configSource = envDriven ? 'env' : 'data';

config.demo = (() => {
  if (process.env.DEMO === 'true') return true;
  if (process.env.DEMO === 'false') return false;
  return !config.credentials || config.folderIds.length === 0;
})();

export function describeConfig() {
  const lines = [];
  if (config.demo) {
    lines.push('运行模式：演示模式（本地示例曲目，未连接 Google Drive）');
    if (!config.credentials) lines.push('  · 未检测到服务账号凭证');
    if (config.credentials && !config.folderIds.length) lines.push('  · 未设置音乐文件夹 ID');
  } else {
    lines.push('运行模式：Google Drive');
    lines.push(`  · 服务账号：${config.serviceAccountEmail}`);
    lines.push(`  · 音乐文件夹：${config.folderIds.join(', ')}`);
    lines.push(`  · 递归子目录：${config.recursive ? '是' : '否'}`);
  }
  if (config.accessCode) lines.push('  · 访问口令：已启用');
  lines.push(`  · 配置来源：${configSource === 'env' ? '环境变量' : 'data/config.json（网页设置）'}`);
  return lines.join('\n');
}
