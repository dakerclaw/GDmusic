import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import compression from 'compression';
import { config, ROOT, describeConfig, saveRuntimeConfig, configSource, envDriven } from './config.js';
import * as drive from './drive.js';
import * as local from './local.js';
import { getTrackMeta, getCoverFile, guessFromName } from './meta.js';
import { browserMime } from './drive.js';

const provider = config.demo ? local : drive;

function currentProvider() {
  return config.demo ? local : drive;
}

const app = express();
app.disable('x-powered-by');
// 音频流绝不 gzip（会破坏 Range/Content-Length 语义导致浏览器不播）
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api/stream/')) return false;
    if (res.getHeader('Content-Type')?.toString().startsWith('audio/')) return false;
    return compression.filter(req, res);
  },
}));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const VERSION = '1.1.15';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/* ---------------- 访问口令 ---------------- */

app.get('/api/config', (req, res) => {
  res.json({
    demo: config.demo,
    accessRequired: Boolean(config.accessCode),
    serviceAccountEmail: config.serviceAccountEmail,
    folders: config.folderIds.length,
    recursive: config.recursive,
    configSource,
    envDriven,
  });
});

/* ---------------- 网页设置（先安装后配置） ---------------- */

app.get('/api/setup/status', (req, res) => {
  res.json({
    configured: !config.demo,
    configSource,
    serviceAccountEmail: config.serviceAccountEmail,
    folderIds: config.folderIds,
    recursive: config.recursive,
    accessRequired: Boolean(config.accessCode),
    hint: config.demo
      ? '当前为演示模式。填入服务账号 JSON 与音乐文件夹 ID 即可接入 Google Drive。'
      : null,
  });
});

app.post('/api/setup', express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const { serviceAccountJson, folderIds, accessCode, recursive } = req.body || {};
  // 首次配置（当前无凭证无文件夹）：SA 必填
  if (!config.credentials && !serviceAccountJson && !config.folderIds.length) {
    return res.status(400).json({ ok: false, error: '请粘贴服务账号 JSON 密钥' });
  }
  try {
    const changed = saveRuntimeConfig({
      serviceAccountJson: serviceAccountJson ?? null,
      folderIds,
      accessCode,
      recursive,
    });
    if (changed.credentials || changed.folderIds) {
      drive.resetAuth();
      cache = { at: 0, tracks: [] }; // 清曲库缓存，下次请求重建（元数据按文件 ID 键控，无需清）
    }
    config.demo = !config.credentials || config.folderIds.length === 0;
    res.json({ ok: true, demo: config.demo, serviceAccountEmail: config.serviceAccountEmail, folderIds: config.folderIds });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

/** 测试文件夹连通性（不保存）：返回文件夹名与文件数 */
app.post('/api/setup/test', express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const { serviceAccountJson, folderId } = req.body || {};
  try {
    let credentials = config.credentials;
    if (serviceAccountJson) {
      const { parseServiceAccount } = await import('./config.js');
      credentials = parseServiceAccount(serviceAccountJson);
    }
    if (!credentials) return res.status(400).json({ ok: false, error: '缺少服务账号凭证' });
    const id = String(folderId || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: '缺少文件夹 ID' });
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
    const params = new URLSearchParams({
      fields: 'id,name,mimeType',
      supportsAllDrives: 'true',
    });
    const fr = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fr.ok) {
      const body = await fr.text().catch(() => '');
      return res.status(400).json({ ok: false, error: `无法访问文件夹 (${fr.status})：${body.slice(0, 200)}` });
    }
    const folder = await fr.json();
    // 数一下（根层）音频文件数量
    const q = new URLSearchParams({
      q: `'${id.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const lr = await fetch(`https://www.googleapis.com/drive/v3/files?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    let count = 0;
    if (lr.ok) {
      const data = await lr.json();
      count = (data.files || []).filter((f) => f.mimeType?.startsWith('audio/') || /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(f.name || '')).length;
    }
    res.json({ ok: true, name: folder.name, files: count });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

app.post('/api/unlock', express.json(), (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!config.accessCode) return res.json({ ok: true });
  if (code !== config.accessCode) {
    return res.status(401).json({ ok: false, error: '口令不正确' });
  }
  res.setHeader(
    'Set-Cookie',
    `mc_code=${encodeURIComponent(code)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`
  );
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!config.accessCode) return next();
  const supplied = req.get('x-access-code') || parseCookies(req.headers.cookie).mc_code || req.query.code;
  if (supplied === config.accessCode) return next();
  res.status(401).json({ error: '需要访问口令', needCode: true });
});

/* ---------------- 曲库 ---------------- */

let cache = { at: 0, tracks: [] };
const CACHE_TTL = 60 * 1000;

async function loadTracks(force = false) {
  if (!force && cache.tracks.length && Date.now() - cache.at < CACHE_TTL) return cache.tracks;
  const prov = currentProvider();
  const raw = await prov.listTracks();
  // 并发限制：避免大曲库首刷瞬间打满 Drive API 配额
  const CONCURRENCY = Number(process.env.META_CONCURRENCY || 6);
  const enriched = [];
  let cursor = 0;
  async function worker() {
    while (cursor < raw.length) {
      const t = raw[cursor++];
      const cached = await getTrackMeta(t, prov).catch(() => null);
      const fallback = guessFromName(t.name);
      enriched.push({
        ...t,
        title: cached?.title || fallback.title,
        artist: cached?.artist || fallback.artist,
        album: cached?.album || '',
        duration: cached?.duration || 0,
        hasCover: Boolean(cached?.hasCover),
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, raw.length || 1) }, worker));
  enriched.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN', { numeric: true }));
  cache = { at: Date.now(), tracks: enriched };
  return enriched;
}

app.get('/api/tracks', wrap(async (req, res) => {
  const tracks = await loadTracks(req.query.refresh === '1');
  res.json({
    demo: config.demo,
    count: tracks.length,
    tracks,
  });
}));

app.get('/api/tracks/:id/meta', wrap(async (req, res) => {
  const tracks = await loadTracks();
  const track = tracks.find((t) => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: '曲目不存在' });
  const meta = await getTrackMeta(track, currentProvider());
  res.json(meta);
}));

app.get('/api/tracks/:id/cover', wrap(async (req, res) => {
  const cover = await getCoverFile(req.params.id);
  if (!cover) return res.status(404).end();
  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.end(cover.data);
}));

/* ---------------- 音频流（支持 Range，可拖动进度条） ---------------- */

// 开放式 Range（bytes=0-）改写为有限分段：弱网/代理环境长响应易被掐断，
// 分段 206 让浏览器自动逐段续传，可靠性远高于一次性 12MB 响应
const STREAM_CHUNK = Number(process.env.STREAM_CHUNK || 2 * 1024 * 1024);

function clampRange(rangeHeader, size) {
  if (!rangeHeader) return null; // 无 Range → 下面按全量分段处理
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  let start = m[1] === '' ? 0 : parseInt(m[1], 10);
  let end = m[2] === '' ? -1 : parseInt(m[2], 10);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (end === -1 || end >= size) end = size - 1;
  if (start > end) return 'invalid';
  // 开放式结尾或超长段 → 截断为 CHUNK 大小
  if (m[2] === '' || end - start + 1 > STREAM_CHUNK) end = Math.min(start + STREAM_CHUNK - 1, size - 1);
  return { start, end };
}

app.get('/api/stream/:id', wrap(async (req, res) => {
  const { id } = req.params;
  const prov = currentProvider();
  const info = await prov.getFileInfo(id);
  if (!info) return res.status(404).json({ error: '音频不存在' });

  const size = info.size || 0;
  let range = req.headers.range;
  let start = 0;
  let end = size ? size - 1 : -1;

  const clamped = clampRange(range, size);
  if (clamped === 'invalid') {
    return res.status(416).json({ error: 'Range 超出文件大小' });
  }
  if (clamped) {
    ({ start, end } = clamped);
  } else if (range && !clamped) {
    // 无法解析的 Range 头：忽略，按全量处理
  }

  const isPartial = Boolean(range) && clamped !== null;
  const upstreamRange = `bytes=${start}-${end}`;

  let upstream;
  try {
    upstream = await prov.openMedia(id, upstreamRange);
  } catch (err) {
    console.error(`[stream] ${id} 上游打开失败:`, err.message);
    return res.status(502).json({ error: `上游读取失败：${err.message}` });
  }

  if (upstream.status === 403) {
    console.error(`[stream] ${id} 上游 403：文件夹可能未共享给服务账号`);
    return res.status(502).json({ error: '上游拒绝访问（403）：请在 Google Drive 里把该文件夹共享给服务账号（查看者）' });
  }

  if (!upstream.ok && upstream.status !== 206) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[stream] ${id} 上游错误 ${upstream.status}: ${detail.slice(0, 200)}`);
    return res
      .status(upstream.status === 404 ? 404 : 502)
      .json({ error: `无法读取音频 (${upstream.status})`, detail: detail.slice(0, 300) });
  }

  res.status(isPartial ? 206 : 200);
  res.setHeader('Content-Type', browserMime(info.name, info.mimeType));
  if (isPartial) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
  } else if (size) {
    res.setHeader('Content-Length', String(size));
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (err) => {
    console.error(`[stream] ${id} 流中断:`, err.message);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  res.flushHeaders();
  stream.pipe(res);
}));

/* ---------------- 静态资源 ---------------- */

app.get('/healthz', (req, res) => res.json({ ok: true, demo: config.demo, version: VERSION, configSource }));

app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (/\.(css|js|svg|png|jpg|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (filePath.endsWith('.html')) {
      // HTML 不缓存，避免更新后浏览器拿旧页面调用旧接口
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `接口不存在：${req.method} ${req.path}`, version: VERSION });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  console.log('\n  ♪  Cloud Music 已启动');
  console.log(`     本机访问：${url}`);
  console.log(`     手机访问：http://<这台电脑的局域网IP>:${config.port}`);
  console.log('');
  console.log(describeConfig());
  if (config.demo) {
    console.log('\n  提示：打开网页右上角「设置」，粘贴服务账号 JSON 与文件夹 ID 即可接入 Google Drive（无需重启）。');
  } else if (config.serviceAccountEmail) {
    console.log(`\n  ⚠ 记得把音乐文件夹共享给服务账号：${config.serviceAccountEmail}（查看者权限）`);
  }
  console.log('');
});
