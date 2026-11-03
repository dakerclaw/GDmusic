#!/usr/bin/env node
/**
 * 端到端冒烟测试：模拟浏览器完整链路
 * config → (unlock) → tracks → meta → cover → stream(200) → stream(Range 206)
 * 用法：node scripts/smoke.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:8080';
let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

async function main() {
  console.log(`测试目标：${BASE}\n`);

  // 1. 健康检查
  const health = await fetch(`${BASE}/healthz`).then(r => r.json()).catch(() => null);
  ok('健康检查 /healthz', health?.ok === true);

  // 2. 配置
  const cfg = await fetch(`${BASE}/api/config`).then(r => r.json());
  ok('配置 /api/config', typeof cfg.demo === 'boolean');

  // 3. 曲库
  const list = await fetch(`${BASE}/api/tracks`).then(r => r.json());
  ok(`曲库 /api/tracks（${list.count} 首）`, Array.isArray(list.tracks) && list.count > 0);
  const t = list.tracks[0];
  ok('标签解析（title/artist/duration）', Boolean(t.title) && typeof t.duration === 'number',
    JSON.stringify({ title: t.title, artist: t.artist, duration: t.duration }));

  // 4. 音频流：完整 200
  const full = await fetch(`${BASE}/api/stream/${t.id}`);
  const buf = Buffer.from(await full.arrayBuffer());
  ok(`完整播放 /api/stream（${(buf.length / 1024).toFixed(0)} KB, ${full.status}）`,
    full.status === 200 && buf.length > 10000);
  ok('Accept-Ranges 头', full.headers.get('accept-ranges') === 'bytes');

  // 5. 音频流：Range 206
  const part = await fetch(`${BASE}/api/stream/${t.id}`, { headers: { Range: 'bytes=100-199' } });
  const pbuf = Buffer.from(await part.arrayBuffer());
  ok('Range 请求 206 + Content-Range',
    part.status === 206 && pbuf.length === 100 &&
    /bytes 100-199\/\d+/.test(part.headers.get('content-range') || ''));

  // 6. 无效 ID
  const nf = await fetch(`${BASE}/api/stream/nonexistent-id-xyz`);
  ok('不存在曲目返回 404', nf.status === 404);

  // 7. 静态页面
  const page = await fetch(BASE);
  const html = await page.text();
  ok('首页 HTML', page.status === 200 && html.includes('云音乐') && html.includes('app.js'));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e.message); process.exit(1); });
