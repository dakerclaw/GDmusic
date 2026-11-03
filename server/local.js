import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ROOT } from './config.js';

/**
 * 演示模式数据源：读取本地 demo-music 目录，接口与 drive.js 完全一致。
 * 没有配置 Google 凭证时自动启用，方便先把界面跑起来看效果。
 */
const DEMO_DIR = path.join(ROOT, 'demo-music');
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|weba|webm)$/i;

const encodeId = (rel) => Buffer.from(rel, 'utf8').toString('base64url');
const decodeId = (id) => {
  const rel = Buffer.from(id, 'base64url').toString('utf8');
  const abs = path.resolve(DEMO_DIR, rel);
  // 防止路径穿越
  if (!abs.startsWith(path.resolve(DEMO_DIR))) throw new Error('非法的文件标识');
  return abs;
};

function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (AUDIO_EXT.test(entry.name)) out.push(rel);
  }
  return out;
}

export async function listTracks() {
  const files = walk(DEMO_DIR).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const out = [];
  for (const rel of files) {
    const stat = await fsp.stat(path.join(DEMO_DIR, rel));
    out.push({
      id: encodeId(rel),
      name: path.basename(rel),
      size: stat.size,
      mimeType: 'audio/wav',
      modifiedTime: stat.mtime.toISOString(),
      folder: rel.includes('/') ? path.dirname(rel) : null,
    });
  }
  return out;
}

export async function getFileInfo(id) {
  const abs = decodeId(id);
  try {
    const stat = await fsp.stat(abs);
    return {
      id,
      name: path.basename(abs),
      size: stat.size,
      mimeType: 'audio/wav',
      modifiedTime: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function openMedia(id, range) {
  const abs = decodeId(id);
  const stat = await fsp.stat(abs);
  const size = stat.size;
  const baseHeaders = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (Number.isNaN(start) || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      const stream = Readable.toWeb(fs.createReadStream(abs, { start, end }));
      return new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
  }

  const stream = Readable.toWeb(fs.createReadStream(abs));
  return new Response(stream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) },
  });
}

export async function readHead(id, bytes = 1536 * 1024) {
  const abs = decodeId(id);
  const fd = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}
