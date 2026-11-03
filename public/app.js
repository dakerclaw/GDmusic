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
  gate: false,
  demo: true,
  wakeLock: null,
};

const audio = $('#audio');
let dragTimer = null;

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const url = `/api${path}`;
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const saved = localStorage.getItem('cm_code');
  if (saved) headers['x-access-code'] = saved;

  const res = await fetch(url, { method: opts.method || 'GET', headers, body });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.needCode) {
      state.gate = true;
      showGate();
      throw new Error('需要访问口令');
    }
  }
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

/* ---------- 初始化 ---------- */
async function init() {
  try {
    const cfg = await api('/api/config');
    state.demo = cfg.demo;
    $('#mode-badge').hidden = !cfg.demo;

    if (cfg.accessRequired) {
      const saved = localStorage.getItem('cm_code');
      if (saved) {
        try { await api('/api/unlock', { method: 'POST', body: { code: saved } }); }
        catch { state.gate = true; }
      } else {
        state.gate = true;
      }
    }

    if (state.gate) return showGate();

    await loadTracks();
    restoreSession();
    bindEvents();
    bindKeyboard();
    bindTouch();
    bindMediaSession();
    setupWakeLock();
  } catch (err) {
    toast(err.message || '初始化失败，请刷新重试');
  }
}

async function loadTracks() {
  const data = await api('/api/tracks');
  state.tracks = data.tracks || [];
  renderList();
  $('#sheet-count').textContent = `${state.tracks.length} 首`;
  if (!state.tracks.length) {
    $('#empty').hidden = false;
    $('#empty-text').textContent = '曲库里还没有歌';
    $('#empty-hint').textContent = data.demo
      ? '当前是演示模式。请在 .env 中配置 Google Drive 后重启。'
      : '请检查 DRIVE_FOLDER_ID 是否已共享给服务账号。';
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

  $('#list').innerHTML = items
    .map((t) => {
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
          <div class="list-artist">${esc(t.artist || '未知歌手')}</div>
        </div>
        <div class="list-time">${on ? `<div class="playing-bar"><span></span><span></span><span></span></div>` : dur}</div>
      </li>`;
    })
    .join('');
}

/* ---------- 播放逻辑 ---------- */
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

  audio.src = `/api/stream/${track.id}`;
  audio.load();
  audio.play().catch(() => {});

  setCover(null);
  if (track.hasCover) loadCover(track.id);
  updateMeta();
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
}

function setCover(url) {
  const img = $('#cover-img');
  const shell = $('#cover-shell');
  if (!url) {
    img.src = '';
    img.hidden = true;
    const bg = $('#bg');
    const old = bg.querySelector('img');
    if (old) old.remove();
    shell.classList.remove('playing');
    return;
  }
  img.src = url;
  img.onload = () => { img.hidden = false; };
}

function loadCover(id) {
  const img = new Image();
  img.onload = () => {
    $('#cover-img').src = img.src;
    $('#cover-img').hidden = false;
    $('#cover-shell').classList.add('playing');
    // 背景模糊封面
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
    return;
  }
  spin.hidden = true;
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
    $('#cover-shell').classList.add('playing');
    requestWakeLock();
  });
  audio.addEventListener('pause', () => {
    state.playing = false;
    updatePlayBtn();
    $('#cover-shell').classList.remove('playing');
    releaseWakeLock();
  });
  audio.addEventListener('waiting', () => { state.loading = true; updatePlayBtn(); });
  audio.addEventListener('canplay', () => { state.loading = false; updatePlayBtn(); });
  audio.addEventListener('ended', () => next(true));
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
    $('#btn-repeat').querySelector('use').setAttribute('href', use);
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

  grip.addEventListener('click', () => {
    if (isDesktop()) return;
    sheet.classList.toggle('open');
  });
  // 滑动手势展开/收起
  let sy = 0;
  grip.addEventListener('touchstart', (e) => { sy = e.touches[0].clientY; }, { passive: true });
  grip.addEventListener('touchend', (e) => {
    if (isDesktop()) return;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dy) > 40) {
      sheet.classList.toggle('open', dy < 0);
    }
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
      $('#btn-repeat').querySelector('use').setAttribute('href', state.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
    }
    if (s.trackId) {
      const idx = state.tracks.findIndex((t) => t.id === s.trackId);
      if (idx !== -1) {
        playIndex(idx);
        if (s.currentTime) audio.currentTime = s.currentTime;
      }
    }
  } catch {}
}

/* ---------- 口令 ---------- */
function showGate() {
  $('#gate').hidden = false;
  $('#gate-input').focus();
}

$('#gate-submit').addEventListener('click', async () => {
  const code = $('#gate-input').value.trim();
  if (!code) return;
  try {
    await api('/api/unlock', { method: 'POST', body: { code } });
    localStorage.setItem('cm_code', code);
    $('#gate').hidden = true;
    state.gate = false;
    toast('验证成功');
    await loadTracks();
    restoreSession();
  } catch (err) {
    $('#gate-error').hidden = false;
    $('#gate-error').textContent = err.message || '口令不正确';
  }
});

$('#gate-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#gate-submit').click();
});

/* ---------- 工具 ---------- */
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
