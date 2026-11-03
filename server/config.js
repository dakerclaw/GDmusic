import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

function readServiceAccount() {
  // 1) 直接内联的 JSON 字符串（适合部署到云平台的环境变量）
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 不是合法的 JSON，请检查是否完整粘贴了密钥内容');
    }
  }

  // 2) Base64 编码的 JSON（避免换行被环境变量截断）
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64 && b64.trim()) {
    return JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  }

  // 3) 密钥文件路径
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      throw new Error(`找不到服务账号密钥文件：${abs}`);
    }
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }

  return null;
}

const credentials = readServiceAccount();
const folderIds = (process.env.DRIVE_FOLDER_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  credentials,
  folderIds,
  recursive: String(process.env.RECURSIVE ?? 'true') !== 'false',
  maxDepth: Number(process.env.MAX_DEPTH || 6),
  accessCode: (process.env.ACCESS_CODE || '').trim(),
  cacheDir: path.join(ROOT, process.env.CACHE_DIR || '.cache'),
  // 没有配置凭证时自动进入演示模式（播放内置示例曲目）
  get demo() {
    if (process.env.DEMO === 'true') return true;
    if (process.env.DEMO === 'false') return false;
    return !this.credentials || this.folderIds.length === 0;
  },
  serviceAccountEmail: credentials?.client_email || null,
};

export function describeConfig() {
  const lines = [];
  if (config.demo) {
    lines.push('运行模式：演示模式（本地示例曲目，未连接 Google Drive）');
    if (!config.credentials) lines.push('  · 未检测到服务账号凭证');
    if (config.credentials && !config.folderIds.length) lines.push('  · 未设置 DRIVE_FOLDER_ID');
  } else {
    lines.push('运行模式：Google Drive');
    lines.push(`  · 服务账号：${config.serviceAccountEmail}`);
    lines.push(`  · 音乐文件夹：${config.folderIds.join(', ')}`);
    lines.push(`  · 递归子目录：${config.recursive ? '是' : '否'}`);
  }
  if (config.accessCode) lines.push('  · 访问口令：已启用');
  return lines.join('\n');
}
