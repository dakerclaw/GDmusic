import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import compression from 'compression';
import { config, ROOT, describeConfig } from './config.js';
import * as drive from './drive.js';
import * as local from './local.js';
import { getTrackMeta, getCoverFile, guessFromName } from './meta.js';

const provider = config.demo ? local : drive;

const app = express();
app.disable('x-powered-by');
app.use(compression({ filter: (req, res) => res.getHeader('Content-Type')?.toString().startsWith('audio/') ? false : compression.filter(req, res) }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
  });
});

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
  const raw = await provider.listTracks();
  const enriched = await Promise.all(
    raw.map(async (t) => {
      const cached = await getTrackMeta(t, provider).catch(() => null);
      const fallback = guessFromName(t.name);
      return {
        ...t,
        title: cached?.title || fallback.title,
        artist: cached?.artist || fallback.artist,
        album: cached?.album || '',
        duration: cached?.duration || 0,
        hasCover: Boolean(cached?.hasCover),
      };
    })
  );
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
  const meta = await getTrackMeta(track, provider);
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

app.get('/api/stream/:id', wrap(async (req, res) => {
  const { id } = req.params;
  const info = await provider.getFileInfo(id);
  if (!info) return res.status(404).json({ error: '音频不存在' });

  const range = req.headers.range;
  let upstream;
  try {
    upstream = await provider.openMedia(id, range);
  } catch (err) {
    return res.status(502).json({ error: `上游读取失败：${err.message}` });
  }

  if (!upstream.ok && upstream.status !== 206) {
    const detail = await upstream.text().catch(() => '');
    return res
      .status(upstream.status === 404 ? 404 : 502)
      .json({ error: `无法读取音频 (${upstream.status})`, detail: detail.slice(0, 300) });
  }

  res.status(upstream.status);
  const pass = ['content-type', 'content-length', 'content-range', 'last-modified', 'etag'];
  for (const key of pass) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', info.mimeType || 'audio/mpeg');
  if (!res.getHeader('Content-Length') && upstream.status === 200 && info.size) {
    res.setHeader('Content-Length', String(info.size));
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}));

/* ---------------- 静态资源 ---------------- */

app.get('/healthz', (req, res) => res.json({ ok: true, demo: config.demo }));

app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (/\.(css|js|svg|png|jpg|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
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
    console.log('\n  提示：在 .env 里填好服务账号密钥与 DRIVE_FOLDER_ID 后重启，即切换到 Google Drive 曲库。');
  } else if (config.serviceAccountEmail) {
    console.log(`\n  ⚠ 记得把音乐文件夹共享给服务账号：${config.serviceAccountEmail}（查看者权限）`);
  }
  console.log('');
});
