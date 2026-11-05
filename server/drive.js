import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff|aif|alac|weba|webm)$/i;

/** 每个服务账号一个 auth client，key = account.id */
const authClients = new Map();

/** 网页保存新凭证后调用，强制下次请求重建 auth 客户端 */
export function resetAuth() {
  authClients.clear();
}

/** 可用账号：有密钥且有文件夹 */
function usableAccounts() {
  return (config.accounts || []).filter((a) => a?.credentials && a?.folderIds?.length);
}

function accountById(id) {
  return (config.accounts || []).find((a) => a.id === id) || null;
}

async function getAuth(account) {
  if (authClients.has(account.id)) return authClients.get(account.id);
  if (!account?.credentials) throw new Error('未配置 Google 服务账号凭证');
  const auth = new GoogleAuth({
    credentials: account.credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const client = await auth.getClient();
  authClients.set(account.id, client);
  return client;
}

async function getToken(account) {
  const client = await getAuth(account);
  const res = await client.getAccessToken();
  const token = typeof res === 'string' ? res : res?.token;
  if (!token) throw new Error('无法获取 Google 访问令牌');
  return token;
}

async function apiFetch(url, account, { retry = true } = {}) {
  const token = await getToken(account);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if ((res.status === 401 || res.status === 403) && retry) {
    authClients.delete(account.id); // 令牌失效，重新建一个客户端再试一次
    return apiFetch(url, account, { retry: false });
  }
  return res;
}

/** 带连接超时的 fetch：仅约束「建立连接+收到响应头」，响应体流不受限（音频流会播放远超 15s） */
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`连接超时 (${ms}ms)`)), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer); // 响应头已到达，解除计时，音频流自由读取
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function isAudioFile(file) {
  if (!file || file.mimeType === FOLDER_MIME) return false;
  if (file.mimeType && file.mimeType.startsWith('audio/')) return true;
  return AUDIO_EXT.test(file.name || '');
}

/** Drive mimeType / 扩展名 → 浏览器可识别的 MIME */
export function browserMime(name, mimeType) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const byExt = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
    flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    wav: 'audio/wav', weba: 'audio/webm', webm: 'audio/webm',
    aiff: 'audio/aiff', aif: 'audio/aiff', wma: 'audio/x-ms-wma',
  };
  if (byExt[ext]) return byExt[ext];
  if (mimeType?.startsWith('audio/')) return mimeType;
  return 'audio/mpeg';
}

/** 列出某个文件夹下的直接子项（文件 + 子文件夹） */
async function listChildren(folderId, account) {
  const items = [];
  let pageToken = '';
  const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)';

  do {
    const params = new URLSearchParams({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      orderBy: 'folder,name_natural',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await apiFetch(`${DRIVE_API}/files?${params}`, account);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive 列表请求失败 (${res.status})：${body.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.files) items.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

/** 递归收集所有账号的音频文件（按文件 ID 去重） */
export async function listTracks() {
  const accounts = usableAccounts();
  if (!accounts.length) throw new Error('未配置 Google 服务账号或音乐文件夹');

  const found = [];
  const errors = [];
  const seenFiles = new Set();

  for (const account of accounts) {
    const seenFolders = new Set();
    const queue = account.folderIds.map((id) => ({ id, depth: 0, path: '' }));
    const accountErrors = [];
    const recursive = account.recursive !== false && config.recursive !== false;

    while (queue.length) {
      const { id, depth, path } = queue.shift();
      if (seenFolders.has(id)) continue;
      seenFolders.add(id);

      let children;
      try {
        children = await listChildren(id, account);
      } catch (err) {
        if (depth === 0) accountErrors.push(`${account.email || account.id} 根文件夹 ${id}：${err.message}`);
        else console.warn(`[drive] 跳过子目录 ${id}：${err.message}`);
        continue;
      }

      for (const file of children) {
        if (file.mimeType === FOLDER_MIME) {
          if (recursive && depth + 1 < config.maxDepth) {
            queue.push({ id: file.id, depth: depth + 1, path: path ? `${path}/${file.name}` : file.name });
          }
        } else if (isAudioFile(file) && !seenFiles.has(file.id)) {
          seenFiles.add(file.id);
          found.push({
            id: file.id,
            name: file.name,
            size: Number(file.size || 0),
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            folder: path || null,
            accountId: account.id,
            accountEmail: account.email || null,
          });
        }
      }
    }

    errors.push(...accountErrors);
  }

  if (!found.length && errors.length) {
    throw new Error(errors.join('；'));
  }
  if (errors.length) console.warn('[drive] 部分文件夹读取失败：', errors.join('；'));

  return found;
}

/** 解析请求对应的账号：优先 URL 里的 acc，其次第一个可用账号 */
function resolveAccount(accountId) {
  if (accountId) {
    const account = accountById(String(accountId));
    if (account?.credentials && account.folderIds?.length) return account;
  }
  return usableAccounts()[0] || null;
}

/** 读取单个文件的元数据（含大小，用于 Range 计算） */
export async function getFileInfo(fileId, accountId) {
  const account = resolveAccount(accountId);
  if (!account) throw new Error('未配置 Google 服务账号');
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size,modifiedTime',
    supportsAllDrives: 'true',
  });
  const res = await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, account);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`读取文件信息失败 (${res.status})：${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    size: Number(data.size || 0),
    mimeType: data.mimeType,
    modifiedTime: data.modifiedTime,
  };
}

/** 打开音频流，透传 Range 以便拖动进度条；429/5xx 自动重试一次 */
export async function openMedia(fileId, range, accountId) {
  const account = resolveAccount(accountId);
  if (!account) throw new Error('未配置 Google 服务账号');
  const token = await getToken(account);
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers }, 15000);
  } catch (err) {
    throw new Error(`连接 Google 超时或被重置：${err.message}`);
  }
  if ((res.status === 429 || res.status >= 500) && range === undefined) {
    // 完整流被限流：等 800ms 重试一次（带 Range 的分段请求让浏览器自己重试）
    await new Promise((r) => setTimeout(r, 800));
    try {
      res = await fetchWithTimeout(url, { headers }, 15000);
    } catch (err) {
      throw new Error(`连接 Google 超时或被重置：${err.message}`);
    }
  }
  return res;
}

/** 读取文件开头若干字节，用于解析 ID3 标签和内嵌封面 */
export async function readHead(fileId, bytes = 1536 * 1024, accountId) {
  const res = await openMedia(fileId, `bytes=0-${bytes - 1}`, accountId);
  if (!res.ok && res.status !== 206) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}
