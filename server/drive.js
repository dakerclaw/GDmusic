import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff|aif|alac|weba|webm)$/i;

let authClient = null;

/** 网页保存新凭证后调用，强制下次请求重建 auth 客户端 */
export function resetAuth() {
  authClient = null;
}

async function getAuth() {
  if (authClient) return authClient;
  if (!config.credentials) throw new Error('未配置 Google 服务账号凭证');
  const auth = new GoogleAuth({
    credentials: config.credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  authClient = await auth.getClient();
  return authClient;
}

async function getToken() {
  const client = await getAuth();
  const res = await client.getAccessToken();
  const token = typeof res === 'string' ? res : res?.token;
  if (!token) throw new Error('无法获取 Google 访问令牌');
  return token;
}

async function apiFetch(url, { retry = true } = {}) {
  const token = await getToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if ((res.status === 401 || res.status === 403) && retry) {
    authClient = null; // 令牌失效，重新建一个客户端再试一次
    return apiFetch(url, { retry: false });
  }
  return res;
}

function isAudioFile(file) {
  if (!file || file.mimeType === FOLDER_MIME) return false;
  if (file.mimeType && file.mimeType.startsWith('audio/')) return true;
  return AUDIO_EXT.test(file.name || '');
}

/** 列出某个文件夹下的直接子项（文件 + 子文件夹） */
async function listChildren(folderId) {
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

    const res = await apiFetch(`${DRIVE_API}/files?${params}`);
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

/** 递归收集所有音频文件 */
export async function listTracks() {
  const found = [];
  const seenFolders = new Set();
  const queue = config.folderIds.map((id) => ({ id, depth: 0, path: '' }));

  while (queue.length) {
    const { id, depth, path } = queue.shift();
    if (seenFolders.has(id)) continue;
    seenFolders.add(id);

    let children;
    try {
      children = await listChildren(id);
    } catch (err) {
      if (depth === 0) throw err; // 根目录失败要明确报错
      console.warn(`[drive] 跳过子目录 ${id}：${err.message}`);
      continue;
    }

    for (const file of children) {
      if (file.mimeType === FOLDER_MIME) {
        if (config.recursive && depth + 1 < config.maxDepth) {
          queue.push({ id: file.id, depth: depth + 1, path: path ? `${path}/${file.name}` : file.name });
        }
      } else if (isAudioFile(file)) {
        found.push({
          id: file.id,
          name: file.name,
          size: Number(file.size || 0),
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          folder: path || null,
        });
      }
    }
  }

  return found;
}

/** 读取单个文件的元数据（含大小，用于 Range 计算） */
export async function getFileInfo(fileId) {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size,modifiedTime',
    supportsAllDrives: 'true',
  });
  const res = await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`);
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

/** 打开音频流，透传 Range 以便拖动进度条 */
export async function openMedia(fileId, range) {
  const token = await getToken();
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;
  return fetch(url, { headers });
}

/** 读取文件开头若干字节，用于解析 ID3 标签和内嵌封面 */
export async function readHead(fileId, bytes = 1536 * 1024) {
  const res = await openMedia(fileId, `bytes=0-${bytes - 1}`);
  if (!res.ok && res.status !== 206) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}
