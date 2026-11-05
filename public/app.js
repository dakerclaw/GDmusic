/* ================================
   Cloud Music — 前端播放控制
================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  tracks: [],
  index: -1,
  playing: false,
  loading: false,
  shuffle: false,
  repeat: 'off', // 'off' | 'one' | 'all'
  demo: true,
  settingsLocked: false,
  /** 设置页口令：只存在内存里，关闭设置即清空（不写 localStorage / Cookie） */
  settingsCode: '',
  /** 播放列表里被折叠的文件夹（内存态，刷新恢复全部展开） */
  collapsedFolders: new Set(),
  wakeLock: null,
};

const audio = $('#audio');
let dragTimer = null;

/* ---------- API ---------- */
async function api(path, opts = {}) {
  // path 兼容带或不带 /api 前缀，避免拼接出 /api/api/...
  const url = path.startsWith('/api/') ? path : `/api${path}`;
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) };
  if (state.settingsCode) headers['x-access-code'] = state.settingsCode;

  const res = await fetch(url, { method: opts.method || 'GET', headers, body });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `请求失败 (${res.status})`);
    if (res.status === 401 && data.needCode) err.needCode = true;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ---------- 初始化 ---------- */
async function init() {
  // 旧版本把口令存在 localStorage 里；这里主动清掉，避免浏览器残留自动解锁
  try { localStorage.removeItem('cm_code'); } catch { /* 隐私模式可能不可用 */ }
  try {
    const cfg = await api('/config');
    state.demo = cfg.demo;
    $('#mode-badge').hidden = !cfg.demo;

    // 演示模式：显示设置入口引导
    if (cfg.demo && cfg.configSource !== 'env') {
      $('#setup-banner').hidden = false;
      $('#setup-banner').addEventListener('click', () => $('#btn-setup').click());
    }

    // 口令只保护设置页；听歌不需要口令，直接加载曲库
    state.settingsLocked = Boolean(cfg.settingsLocked);

    await loadTracks();
    bindEvents();
    bindKeyboard();
    bindTouch();
    bindMediaSession();
    setupWakeLock();
    restoreSession();
  } catch (err) {
    toast(err.message || '初始化失败，请刷新重试');
  }
}

async function loadTracks(force = false) {
  const data = await api('/tracks' + (force ? '?refresh=1' : ''));
  state.tracks = data.tracks || [];
  state.demo = data.demo;
  $('#mode-badge').hidden = !data.demo;
  renderList();
  $('#sheet-count').textContent = `${state.tracks.length} 首`;
  if (!state.tracks.length) {
    $('#empty').hidden = false;
    $('#empty-text').textContent = '曲库里还没有歌';
    $('#empty-hint').textContent = data.demo
      ? '当前是演示模式。点右上角 ⚙ 设置连接 Google Drive。'
      : '请检查文件夹是否已共享给服务账号，或点 ⚙ 设置重新保存。';
    $('#list').innerHTML = '';
  } else {
    $('#empty').hidden = true;
  }
}

/* ---------- 播放列表 ---------- */
function renderList(filter = '') {
  const term = filter.trim().toLowerCase();
  const items = term
    ? state.tracks.filter((t) =>
        `${t.title || ''} ${t.artist || ''} ${t.name || ''}`.toLowerCase().includes(term)
      )
    : state.tracks;

  if (!items.length && state.tracks.length) {
    $('#empty').hidden = false;
    $('#empty-text').textContent = '没有匹配的曲目';
    $('#empty-hint').textContent = '换个关键词试试';
    $('#list').innerHTML = '';
    return;
  }
  if (state.tracks.length) $('#empty').hidden = true;

  const activeId = state.index >= 0 ? state.tracks[state.index]?.id : null;

  // 按文件夹分组（保持曲库原有顺序）
  const groups = [];
  const byFolder = new Map();
  for (const t of items) {
    const key = t.folder || '';
    if (!byFolder.has(key)) {
      const g = { key, tracks: [] };
      byFolder.set(key, g);
      groups.push(g);
    }
    byFolder.get(key).tracks.push(t);
  }
  // 始终显示分组头（即使只有一个分组，也标明歌曲所属文件夹）
  const showHeaders = true;

  const trackHtml = (t) => {
    const on = t.id === activeId;
    const dur = formatTime(t.duration || 0);
    const cover = t.hasCover ? `/api/tracks/${t.id}/cover` : '';
    const thumb = cover
      ? `<img src="${cover}" alt="" loading="lazy" onerror="this.parentElement.querySelector('svg').style.display='block';this.style.display='none'">`
      : '';
    const svg = `<svg style="display:${cover ? 'none' : 'block'}"><use href="#i-music"/></svg>`;

    return `
      <li class="${on ? 'on' : ''}" data-id="${t.id}">
        <div class="list-thumb">${thumb}${svg}</div>
        <div class="list-info">
          <div class="list-name">${esc(t.title || t.name)}</div>
          <div class="list-artist">${esc(t.artist || '未知歌手')}${t.folder ? `<span class="list-folder"> · ${esc(t.folder)}</span>` : ''}</div>
        </div>
        <div class="list-time">${on ? `<div class="playing-bar"><span></span><span></span><span></span></div>` : dur}</div>
      </li>`;
  };

  $('#list').innerHTML = groups
    .map((g) => {
      // 搜索时不折叠，保证命中项全部可见
      const closed = showHeaders && !term && state.collapsedFolders.has(g.key);
      const head = showHeaders
        ? `
      <li class="group-head${closed ? ' closed' : ''}" data-group="${esc(g.key)}" role="button" aria-expanded="${closed ? 'false' : 'true'}">
        <svg class="group-icon"><use href="#i-folder"/></svg>
        <span class="group-name">${esc(g.key || '未分类')}</span>
        <span class="group-count">${g.tracks.length} 首</span>
        <svg class="group-chevron"><use href="#i-chevron"/></svg>
      </li>`
        : '';
      return head + (closed ? '' : g.tracks.map(trackHtml).join(''));
    })
    .join('');
}

/* ---------- 播放逻辑 ---------- */
let switching = false; // 切歌瞬间抑制旧 audio 的 error 误报

function playId(id) {
  const idx = state.tracks.findIndex((t) => t.id === id);
  if (idx !== -1) playIndex(idx);
}

function playIndex(idx) {
  if (idx < 0 || idx >= state.tracks.length) return;
  state.index = idx;
  const track = state.tracks[idx];
  state.loading = true;
  state.playing = false;
  updatePlayBtn();

  // 清掉旧播放任务，避免切歌竞态误报 error
  switching = true;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  setTimeout(() => { switching = false; }, 50);

  const url = `/api/stream/${track.id}${track.accountId ? `?acc=${encodeURIComponent(track.accountId)}` : ''}`;
  audio.src = url;
  audio.load();
  armLoadTimeout();
  audio.play().catch(() => { /* 自动播放限制：等用户点播放键 */ });

  setCover(null);
  if (track.hasCover) loadCover(track.id);
  // 立即刷新所有 UI（歌名/列表高亮/锁屏信息），不等音频事件
  updateMeta();
  updateSeekUI(0);
  updateMediaSessionMeta();
  renderList($('#search').value);
  saveSession();
}

function togglePlay() {
  if (!audio.src && state.tracks.length) {
    playIndex(0);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function next(auto = false) {
  if (!state.tracks.length) return;
  if (auto && state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let order;
  if (state.shuffle) order = buildShuffleOrder();
  else order = state.tracks.map((_, i) => i);

  const pos = order.indexOf(state.index);
  let nextPos = pos + 1;
  if (nextPos >= order.length) {
    if (state.repeat === 'all') nextPos = 0;
    else { state.playing = false; updatePlayBtn(); return; }
  }
  playIndex(order[nextPos]);
}

function prev() {
  if (!state.tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let order;
  if (state.shuffle) order = buildShuffleOrder();
  else order = state.tracks.map((_, i) => i);
  const pos = order.indexOf(state.index);
  const prevPos = Math.max(0, pos - 1);
  playIndex(order[prevPos]);
}

function buildShuffleOrder() {
  const arr = state.tracks.map((_, i) => i).filter((i) => i !== state.index);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return [state.index, ...arr];
}

/* ---------- UI 更新 ---------- */
function updateMeta() {
  const track = state.tracks[state.index];
  if (!track) {
    $('#title').textContent = '还没有播放';
    $('#subtitle').textContent = '从下面的列表里选一首开始';
    return;
  }
  $('#title').textContent = track.title || track.name;
  $('#subtitle').textContent = track.artist || '未知歌手';
  document.title = `${track.title || track.name} — 云音乐`;
  // 同步锁屏/通知栏（切歌时立即更新，不等 play 事件）
  updateMediaSessionMeta();
}

function setCover(url) {
  // 封面区块已移除；保留函数避免调用处报错。背景图清理仍执行。
  if (!url) {
    const bg = $('#bg');
    const old = bg.querySelector('img');
    if (old) old.remove();
  }
}

function loadCover(id) {
  // 封面区块已移除：仅更新背景模糊图（若需要），不再操作封面元素
  const img = new Image();
  img.onload = () => {
    const bg = $('#bg');
    let bgImg = bg.querySelector('.bg-img');
    if (!bgImg) { bgImg = document.createElement('img'); bgImg.className = 'bg-img'; }
    bgImg.src = img.src;
    bgImg.alt = '';
    bgImg.style.cssText = 'position:absolute;inset:-10%;width:120%;height:120%;object-fit:cover;filter:blur(72px) brightness(.35) saturate(1.2);opacity:.5;transition:opacity .8s;pointer-events:none';
    if (!bgImg.parentElement) bg.appendChild(bgImg);
  };
  img.src = `/api/tracks/${id}/cover`;
}

function updatePlayBtn() {
  const btn = $('#btn-play');
  const spin = btn.querySelector('.spinner');
  const iconPlay = btn.querySelector('.icon-play');
  const iconPause = btn.querySelector('.icon-pause');

  if (state.loading) {
    spin.hidden = false;
    iconPlay.hidden = true;
    iconPause.hidden = true;
    btn.dataset.state = 'loading';
    return;
  }
  spin.hidden = true;
  // 状态可视化：播放中=呼吸光环亮色；暂停=图标+暗色即可区分
  btn.dataset.state = state.playing ? 'playing' : 'paused';
  if (state.playing) {
    iconPlay.hidden = true;
    iconPause.hidden = false;
  } else {
    iconPlay.hidden = false;
    iconPause.hidden = true;
  }
}

function updateSeekUI(p) {
  const pct = Math.round(p * 1000) / 10;
  const seek = $('#seek');
  seek.value = Math.round(p * 1000);
  seek.style.setProperty('--p', `${pct}%`);
  $('#time-cur').textContent = formatTime(audio.currentTime || 0);
  $('#time-dur').textContent = formatTime(audio.duration || 0);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 音频事件
  audio.addEventListener('play', () => {
    state.playing = true;
    state.loading = false;
    updatePlayBtn();
    requestWakeLock();
  });
  audio.addEventListener('pause', () => {
    state.playing = false;
    updatePlayBtn();
    releaseWakeLock();
  });
  audio.addEventListener('waiting', () => { state.loading = true; updatePlayBtn(); armLoadTimeout(); });
  audio.addEventListener('canplay', () => { state.loading = false; updatePlayBtn(); clearLoadTimeout(); });
  audio.addEventListener('playing', () => { state.loading = false; updatePlayBtn(); clearLoadTimeout(); });
  audio.addEventListener('ended', () => next(true));
  // 只对「已设置 src 且非空切换」报错；src 清空/替换瞬间的误报忽略
  let errorStreak = 0; // 连续失败计数（自动跳歌用，避免整张不支持的列表无限循环）
  audio.addEventListener('error', () => {
    if (switching || !audio.src) return;
    state.loading = false;
    state.playing = false;
    updatePlayBtn();
    clearLoadTimeout();
    const code = audio.error?.code;
    // 解码失败（格式不支持）→ 自动跳下一首；其他错误 → 报错停住
    if (code === 4) {
      errorStreak++;
      const skipMsg = `格式不支持，已跳过：${state.tracks[state.index]?.title || state.tracks[state.index]?.name || '未知曲目'}`;
      toast(skipMsg);
      console.warn('[audio]', skipMsg, '| 连续第', errorStreak, '首');
      if (errorStreak >= state.tracks.length) {
        toast('整个曲库的格式都无法在此浏览器播放，已停止');
        errorStreak = 0;
        return;
      }
      setTimeout(() => next(true), 600); // 稍等让 toast 显示
      return;
    }
    errorStreak = 0;
    probeStreamError(audio.src);
  });
  // 成功起播时清零连续失败计数
  audio.addEventListener('playing', () => { errorStreak = 0; });
  audio.addEventListener('timeupdate', () => {
    if (dragTimer) return;
    const p = audio.duration ? audio.currentTime / audio.duration : 0;
    updateSeekUI(p);
  });
  audio.addEventListener('loadedmetadata', () => {
    const t = state.tracks[state.index];
    if (t && !t.duration && audio.duration) {
      t.duration = audio.duration;
      renderList($('#search').value);
    }
    // 新歌时长就位后刷新进度显示（避免显示上一首的时长）
    updateSeekUI(0);
  });

  // 控制按钮
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', prev);
  $('#btn-next').addEventListener('click', () => next(false));

  $('#btn-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('#btn-shuffle').classList.toggle('on', state.shuffle);
    toast(state.shuffle ? '已开启随机播放' : '已关闭随机播放');
    saveSession();
  });

  $('#btn-repeat').addEventListener('click', () => {
    const modes = ['off', 'all', 'one'];
    const idx = (modes.indexOf(state.repeat) + 1) % modes.length;
    state.repeat = modes[idx];
    const use = state.repeat === 'one' ? '#i-repeat-one' : '#i-repeat';
    setUseHref($('#btn-repeat'), use);
    $('#btn-repeat').classList.toggle('on', state.repeat !== 'off');
    const labels = { off: '列表播放', all: '列表循环', one: '单曲循环' };
    toast(labels[state.repeat]);
    saveSession();
  });

  // 进度条
  $('#seek').addEventListener('input', () => {
    const v = $('#seek').value / 1000;
    $('#seek').style.setProperty('--p', `${v * 100}%`);
    $('#time-cur').textContent = formatTime((audio.duration || 0) * v);
    dragTimer = 1;
  });
  $('#seek').addEventListener('change', () => {
    const v = $('#seek').value / 1000;
    if (audio.duration) audio.currentTime = audio.duration * v;
    dragTimer = null;
    saveSession();
  });

  // 搜索
  const onSearch = () => {
    renderList($('#search').value);
    $('#btn-clear').hidden = !$('#search').value;
  };
  $('#search').addEventListener('input', onSearch);
  $('#btn-clear').addEventListener('click', () => {
    $('#search').value = '';
    onSearch();
  });

  // 列表点击（事件委托）
  $('#list').addEventListener('click', (e) => {
    const head = e.target.closest('li.group-head');
    if (head) {
      const key = head.dataset.group;
      if (state.collapsedFolders.has(key)) state.collapsedFolders.delete(key);
      else state.collapsedFolders.add(key);
      renderList($('#search').value);
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    playId(li.dataset.id);
  });

  // 刷新
  $('#btn-refresh').addEventListener('click', async () => {
    toast('正在刷新…');
    await loadTracks();
    toast(`已刷新，共 ${state.tracks.length} 首`);
  });

  // Sheet 展开/收起（仅移动端）
  const sheet = $('#sheet');
  const grip = $('#sheet-grip');
  const isDesktop = () => window.matchMedia('(min-width:980px)').matches;

  const openSheet = (open) => {
    sheet.classList.toggle('open', open);
    $('#btn-list').classList.toggle('on', open);
    // 桌面端：列表收起 = .app 加 list-hidden 类（grid 列宽归零）
    if (window.matchMedia('(min-width:980px)').matches) {
      $('.app').classList.toggle('list-hidden', !open);
    }
  };
  // 顶部列表按钮：手机=开合底部浮层；桌面=收起/展开右侧常驻列表
  $('#btn-list').addEventListener('click', () => openSheet(!sheet.classList.contains('open')));
  grip.addEventListener('click', () => { if (!isDesktop()) openSheet(false); });
  // 滑动手势：浮层内下滑收起
  let sy = 0;
  grip.addEventListener('touchstart', (e) => { sy = e.touches[0].clientY; }, { passive: true });
  grip.addEventListener('touchend', (e) => {
    if (isDesktop()) return;
    const dy = e.changedTouches[0].clientY - sy;
    if (dy > 40) openSheet(false); // 下滑收起
  }, { passive: true });

  // 键盘
  bindKeyboard();
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        next(false);
        break;
      case 'ArrowLeft':
        prev();
        break;
    }
  });
}

function bindTouch() {
  let sx = 0;
  let sy = 0;
  let started = false;
  const stage = $('.stage');
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    started = true;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!started) return;
    started = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < Math.abs(dy)) return; // 垂直滑动忽略
    if (Math.abs(dx) < 60) return;
    if (dx < 0) next(false);
    else prev();
  }, { passive: true });
}

/* ---------- MediaSession ---------- */
function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 10); });
  audio.addEventListener('play', updateMediaSessionMeta);
}

function updateMediaSessionMeta() {
  if (!('mediaSession' in navigator)) return;
  const t = state.tracks[state.index];
  if (!t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title || t.name,
    artist: t.artist || '未知歌手',
    album: t.album || '',
    artwork: t.hasCover ? [{ src: `/api/tracks/${t.id}/cover`, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
  const dur = audio.duration || (t.duration || 0);
  if (dur) {
    navigator.mediaSession.setPositionState?.({
      duration: dur,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime || 0, dur),
    });
  }
}

/* ---------- Wake Lock（屏幕常亮） ---------- */
function setupWakeLock() {
  audio.addEventListener('play', requestWakeLock);
  audio.addEventListener('pause', releaseWakeLock);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* ignore */ }
}
function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}

/* ---------- 会话持久化 ---------- */
function saveSession() {
  try {
    const t = state.tracks[state.index];
    localStorage.setItem('cm_state', JSON.stringify({
      trackId: t?.id || null,
      index: state.index,
      currentTime: audio.currentTime || 0,
      volume: audio.volume,
      shuffle: state.shuffle,
      repeat: state.repeat,
    }));
  } catch {}
}

function restoreSession() {
  try {
    const raw = localStorage.getItem('cm_state');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (typeof s.volume === 'number') audio.volume = s.volume;
    if (s.shuffle) { state.shuffle = true; $('#btn-shuffle').classList.add('on'); }
    if (s.repeat) {
      state.repeat = s.repeat;
      $('#btn-repeat').classList.toggle('on', state.repeat !== 'off');
      setUseHref($('#btn-repeat'), state.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
    }
    if (s.trackId) {
      const idx = state.tracks.findIndex((t) => t.id === s.trackId);
      if (idx !== -1) {
        // 只恢复选中与封面，不自动起播（浏览器会拦自动播放，且避免误触流请求）
        state.index = idx;
        updateMeta();
        renderList($('#search').value);
      }
    }
  } catch {}
}

/* ---------- 口令（仅保护设置页） ---------- */
function showGate() {
  $('#gate').hidden = false;
  $('#gate-error').hidden = true;
  $('#gate-input').value = '';
  setTimeout(() => $('#gate-input').focus(), 30);
}

/* ---------- 加载超时兜底：流挂起时 spinner 不该永远转 ---------- */
const LOAD_TIMEOUT_MS = 30000;
let loadTimer = null;

function armLoadTimeout() {
  clearLoadTimeout();
  loadTimer = setTimeout(() => {
    loadTimer = null;
    if (!state.loading) return;
    state.loading = false;
    state.playing = false;
    updatePlayBtn();
    toast('加载超时：网络或上游响应慢，请点播放重试');
    console.error('[audio] load timeout, src:', audio.src);
    probeStreamError(audio.src);
  }, LOAD_TIMEOUT_MS);
}

function clearLoadTimeout() {
  if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
}

/** 流播放失败时回读接口，显示服务器返回的真实错误 */
async function probeStreamError(src) {
  let msg = '播放失败：无法读取音频';
  try {
    const res = await fetch(src, { headers: { Range: 'bytes=0-1' } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      msg = `播放失败 (${res.status})：${data.error || res.statusText}`;
      if (data.detail) console.error('[stream detail]', data.detail);
    } else {
      const type = res.headers.get('content-type') || '';
      if (!type.startsWith('audio/')) {
        msg = `播放失败：服务器返回 ${type || '未知类型'} 而非音频`;
      } else {
        msg = `播放失败：音频流中断（${type}）`;
      }
    }
  } catch { /* 网络层失败保持默认消息 */ }
  toast(msg);
  console.error('[audio]', msg, '| src:', src);
}

$('#gate-submit').addEventListener('click', async () => {
  const code = $('#gate-input').value.trim();
  if (!code) return;
  try {
    await api('/unlock', { method: 'POST', body: { code } });
    // 只存在内存里：关闭设置后自动失效，下次进入需重新输入
    state.settingsCode = code;
    $('#gate').hidden = true;
    state.settingsLocked = true;
    toast('验证成功');
    showSetup();
  } catch (err) {
    $('#gate-error').hidden = false;
    $('#gate-error').textContent = err.message || '口令不正确';
  }
});

$('#gate-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#gate-submit').click();
});

$('#gate-cancel').addEventListener('click', () => {
  $('#gate').hidden = true;
  $('#gate-input').value = '';
  $('#gate-error').hidden = true;
  state.settingsCode = '';
});

/* ---------- 设置（先安装后配置，多组配置） ---------- */
function openSettings() {
  if (!state.settingsLocked) return showSetup();
  // 不做任何自动解锁：每次都重新输入口令（关闭设置时内存里的口令已清空）
  state.settingsCode = '';
  showGate();
}

async function showSetup() {
  $('#setup').hidden = false;
  $('#setup-accounts').innerHTML = '';
  $('#setup-status').hidden = true;
  try {
    const s = await api('/setup/status');
    state.settingsLocked = Boolean(s.accessRequired);
    renderAccountRows(s.accounts || []);
    $('#setup-recursive').checked = s.recursive !== false;
    $('#setup-code').value = '';
    $('#setup-code-clear').checked = false;
    $('#setup-code-clear-row').hidden = !s.accessRequired;
    $('#setup-code').placeholder = s.accessRequired ? '已启用（留空则不修改）' : '不启用';
    if (s.accounts?.length) {
      $('#setup-status').hidden = false;
      $('#setup-status').textContent = `当前已配置 ${s.accounts.length} 组；已配置的组留空 JSON 表示不修改密钥。`;
    }
  } catch (err) {
    if (err.needCode) {
      $('#setup').hidden = true;
      state.settingsCode = '';
      state.settingsLocked = true;
      return showGate();
    }
    toast(err.message || '读取设置失败');
  }
}

const parseFolderIds = (value) => String(value || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

function accountRowHtml(acc, index) {
  const hasKey = Boolean(acc.hasKey);
  return `
    <div class="acc-row" data-id="${esc(acc.id || '')}">
      <div class="acc-head">
        <span class="acc-index">配置 ${index + 1}</span>
        <button class="acc-del" type="button" title="删除这组配置">删除</button>
      </div>
      <label class="setup-label">服务账号</label>
      <input class="acc-email" type="text" value="${esc(acc.email || '')}" placeholder="粘贴 JSON 后自动识别" spellcheck="false">
      <label class="setup-label">JSON 密钥 <span class="acc-state ${hasKey ? '' : 'warn'}">${hasKey ? '已配置（留空则不修改）' : '未配置'}</span></label>
      <textarea class="acc-json" rows="3" placeholder='{"type":"service_account", ...}' spellcheck="false"></textarea>
      <label class="setup-label">文件夹 ID（多个用逗号分隔）</label>
      <input class="acc-folders" type="text" value="${esc((acc.folderIds || []).join(', '))}" placeholder="1AbC..., 2DeF..." spellcheck="false">
      <button class="acc-test ghost" type="button">测试这组文件夹</button>
    </div>`;
}

function renderAccountRows(accounts) {
  const host = $('#setup-accounts');
  const list = accounts.length ? accounts : [{}];
  host.innerHTML = list.map(accountRowHtml).join('');
  bindAccountRows();
}

function addAccountRow() {
  const host = $('#setup-accounts');
  host.insertAdjacentHTML('beforeend', accountRowHtml({}, host.children.length));
  bindAccountRows();
}

function reindexAccounts() {
  $$('.acc-row').forEach((row, i) => {
    row.querySelector('.acc-index').textContent = `配置 ${i + 1}`;
  });
}

function bindAccountRows() {
  reindexAccounts();
  $$('.acc-row').forEach((row) => {
    if (row.dataset.bound) return;
    row.dataset.bound = '1';
    row.querySelector('.acc-del').addEventListener('click', () => {
      row.remove();
      if (!$('.acc-row')) addAccountRow();
      reindexAccounts();
    });
    row.querySelector('.acc-json').addEventListener('input', () => {
      const text = row.querySelector('.acc-json').value.trim();
      if (!text) return;
      try {
        const data = JSON.parse(text);
        if (data.client_email) {
          row.querySelector('.acc-email').value = data.client_email;
          const stateEl = row.querySelector('.acc-state');
          stateEl.textContent = '待保存';
          stateEl.classList.remove('warn');
        }
      } catch { /* 还没粘完整，忽略 */ }
    });
    row.querySelector('.acc-test').addEventListener('click', () => testAccountRow(row));
  });
}

async function testAccountRow(row) {
  const sa = row.querySelector('.acc-json').value.trim();
  const folderId = parseFolderIds(row.querySelector('.acc-folders').value)[0];
  if (!folderId) return toast('请先填写这组的文件夹 ID');
  toast('正在测试…');
  try {
    const data = await api('/setup/test', {
      method: 'POST',
      body: {
        serviceAccountJson: sa || undefined,
        folderId,
        accountId: row.dataset.id || undefined,
      },
    });
    toast(`✓ ${data.name}（根层 ${data.files} 个音频）`);
  } catch (err) {
    if (err.needCode) return openSettings();
    toast(err.message || '测试失败');
  }
}

function hideSetup() {
  $('#setup').hidden = true;
  // 关闭设置即丢弃口令：下次点设置必须重新验证
  state.settingsCode = '';
  $('#gate-input').value = '';
  $('#gate-error').hidden = true;
}

$('#btn-setup').addEventListener('click', openSettings);
$('#setup-close').addEventListener('click', hideSetup);
$('#setup-add').addEventListener('click', addAccountRow);

$('#setup-save').addEventListener('click', async () => {
  const accounts = $$('.acc-row').map((row) => ({
    id: row.dataset.id || undefined,
    serviceAccountJson: row.querySelector('.acc-json').value.trim() || undefined,
    folderIds: row.querySelector('.acc-folders').value,
  }));
  // 口令框：有输入 = 设置新口令；勾选清除 = 删除；原本已启用且留空 = 不修改
  const codeInput = $('#setup-code').value.trim();
  let accessCode;
  if (codeInput) accessCode = codeInput;
  else if ($('#setup-code-clear').checked) accessCode = '';
  else if (!state.settingsLocked) accessCode = '';
  else accessCode = undefined;

  const btn = $('#setup-save');
  btn.disabled = true;
  try {
    const data = await api('/setup', {
      method: 'POST',
      body: { accounts, accessCode, recursive: $('#setup-recursive').checked },
    });
    if (accessCode) state.settingsCode = accessCode;
    if (accessCode === '') state.settingsCode = '';
    state.settingsLocked = Boolean(data.settingsLocked);
    toast('已保存，正在重新加载曲库…');
    hideSetup();
    $('#mode-badge').hidden = !data.demo;
    try {
      await loadTracks(true);
      toast(`已连接，共 ${state.tracks.length} 首`);
    } catch (loadErr) {
      toast(`已保存，但曲库加载失败：${loadErr.message}`);
    }
  } catch (err) {
    if (err.needCode) {
      hideSetup();
      state.settingsLocked = true;
      return showGate();
    }
    toast(err.message || '保存失败');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 工具 ---------- */
function setUseHref(el, id) {
  const use = el.querySelector('use');
  if (!use) return;
  use.setAttribute('href', id);
}
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function esc(s) {
  const el = document.createElement('div');
  el.textContent = s;
  return el.innerHTML;
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- 启动 ---------- */
init();
