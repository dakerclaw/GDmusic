import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseBuffer } from 'music-metadata';
import { config } from './config.js';

/**
 * 从音频文件头解析 ID3 / Vorbis / MP4 标签与内嵌封面。
 * 只读取文件开头约 1.5MB，解析结果缓存在内存和磁盘，避免每次进页面都重复下载。
 */

const memoryCache = new Map(); // id -> meta
const inflight = new Map(); // id -> Promise
let diskCacheLoaded = false;
let diskCache = {};
let saveTimer = null;

const CACHE_FILE = path.join(config.cacheDir, 'meta.json');
const COVER_DIR = path.join(config.cacheDir, 'covers');

async function loadDiskCache() {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    diskCache = JSON.parse(raw);
    for (const [id, meta] of Object.entries(diskCache)) memoryCache.set(id, meta);
  } catch {
    diskCache = {};
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.mkdir(config.cacheDir, { recursive: true });
      const obj = Object.fromEntries(memoryCache);
      await fsp.writeFile(CACHE_FILE, JSON.stringify(obj, null, 0), 'utf8');
    } catch (err) {
      console.warn('[meta] 写入缓存失败：', err.message);
    }
  }, 2000);
  saveTimer.unref?.();
}

/** 从文件名猜歌手与歌名： "周杰伦 - 晴天.mp3" / "01. 晴天.mp3" */
export function guessFromName(name) {
  const base = name.replace(/\.[^.]+$/, '').trim();
  const cleaned = base.replace(/^\s*\d{1,3}[.\-_、\s]\s*/, '').trim() || base;
  const sep = cleaned.split(/\s+[-–—]\s+/);
  if (sep.length >= 2) {
    const artist = sep[0].trim();
    const title = sep.slice(1).join(' - ').trim();
    if (artist && title) return { artist, title };
  }
  return { artist: '', title: cleaned };
}

async function parseOne(track, provider) {
  const fallback = guessFromName(track.name);
  const result = {
    id: track.id,
    title: fallback.title,
    artist: fallback.artist,
    album: '',
    duration: 0,
    hasCover: false,
    coverMime: null,
    parsed: false,
  };

  try {
    const head = await provider.readHead(track.id, 1536 * 1024);
    if (!head || head.length < 128) return result;

    const meta = await parseBuffer(head, {
      mimeType: track.mimeType,
      size: track.size,
    }, { duration: true, skipCovers: false });

    const c = meta.common || {};
    if (c.title) result.title = c.title.trim();
    if (c.artist) result.artist = c.artist.trim();
    else if (Array.isArray(c.artists) && c.artists.length) result.artist = c.artists.join(' / ');
    if (c.album) result.album = c.album.trim();
    if (meta.format?.duration) result.duration = Math.round(meta.format.duration * 1000) / 1000;

    const pic = Array.isArray(c.picture) ? c.picture[0] : null;
    if (pic?.data?.length) {
      await fsp.mkdir(COVER_DIR, { recursive: true });
      const ext = pic.format?.includes('png') ? 'png' : 'jpg';
      await fsp.writeFile(path.join(COVER_DIR, `${track.id}.${ext}`), pic.data);
      result.hasCover = true;
      result.coverMime = pic.format || 'image/jpeg';
      result.coverFile = `${track.id}.${ext}`;
    }
    result.parsed = true;
  } catch (err) {
    // 标签缺失、文件截断、格式不支持都走文件名兜底，不影响播放
    if (!/EndOfStream|Unexpected|corrupt|unsupported/i.test(err.message)) {
      console.warn(`[meta] 解析 ${track.name} 失败：${err.message}`);
    }
  }

  return result;
}

export async function getTrackMeta(track, provider) {
  await loadDiskCache();
  if (memoryCache.has(track.id)) return memoryCache.get(track.id);
  if (inflight.has(track.id)) return inflight.get(track.id);

  const task = parseOne(track, provider)
    .then((meta) => {
      memoryCache.set(track.id, meta);
      scheduleSave();
      return meta;
    })
    .finally(() => inflight.delete(track.id));

  inflight.set(track.id, task);
  return task;
}

export async function getCoverFile(trackId) {
  await fsp.mkdir(COVER_DIR, { recursive: true });
  for (const ext of ['jpg', 'png']) {
    const file = path.join(COVER_DIR, `${trackId}.${ext}`);
    try {
      const data = await fsp.readFile(file);
      return { data, mime: ext === 'png' ? 'image/png' : 'image/jpeg' };
    } catch {
      /* 继续找下一种 */
    }
  }
  return null;
}
