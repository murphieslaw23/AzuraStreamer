'use strict';

/* ── AzuraStreamer — Premium Control Logic ──────────────────────────────────── */

/**
 * State Manager: Simple reactive-like store
 */
const Store = {
  _state: {
    stations: [],
    nowPlaying: {},
    streams: [],
    settings: {},
    connected: false,
  },

  get state() { return this._state; },

  update(diff) {
    this._state = { ...this._state, ...diff };
    this.notify();
  },

  notify() {
    // Trigger global UI updates
    updateDashboard();
  }
};

const uptimeTimers = {};

function clearAllTimers() {
  Object.values(uptimeTimers).forEach(timerId => clearInterval(timerId));
  for (const key in uptimeTimers) delete uptimeTimers[key];
}

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  // No auth redirects — caller handles errors
  return resp;
}

const fmtTime = (sec) => {
  if (!sec || isNaN(sec)) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
};

const fmtUptime = (startedAt) => {
  const secs = Math.floor((Date.now() - new Date(startedAt)) / 1000);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
};

function toast(msg, type = 'info') {
  const titles = { success: 'Success', error: 'System Error', info: 'Information', warning: 'Attention' };
  const icons = {
    success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
    error:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    info:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/></svg>'
  };

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `
    <div class="toast-icon" style="color: var(--${type})">${icons[type]}</div>
    <div class="toast-content">
      <div class="toast-title">${titles[type]}</div>
      <div class="toast-message">${msg}</div>
    </div>
  `;
  
  $('#toasts')?.prepend(el);
  setTimeout(() => { el.classList.add('removing'); setTimeout(() => el.remove(), 300); }, 5000);
}

/* ── UI Components ────────────────────────────────────────────────────────── */

function updateDashboard() {
  const { stations, nowPlaying, streams } = Store.state;
  const station = stations[0];
  if (!station) return;

  const np = nowPlaying[station.id];
  const stream = streams.find(s => s.stationId === station.id && s.status !== 'stopped');
  const song = np?.nowPlaying || {};

  // Station Info (guard elements)
  const stationNameEl = $('#station-name-display'); if (stationNameEl) stationNameEl.textContent = station.name;
  const onlineBadge = $('#station-online-badge'); if (onlineBadge) onlineBadge.hidden = !np?.isOnline;
  const liveBadge = $('#station-live-badge'); if (liveBadge) liveBadge.hidden = !np?.isLive;
  const listenerEl = $('#listener-num-display'); if (listenerEl) listenerEl.textContent = np?.listeners ?? 0;
  const selStation = $('#sel-station'); if (selStation) selStation.value = station.id;

  // Media
  const artImg = $('#art-img-display'); if (artImg && song.art && artImg.src !== song.art) artImg.src = song.art;
  const npTitle = $('#np-title-display'); if (npTitle) npTitle.textContent = song.title || '—';
  const npArtist = $('#np-artist-display'); if (npArtist) npArtist.textContent = song.artist || '—';
  const npFill = $('#np-fill-display'); if (npFill && song.duration > 0) npFill.style.width = `${Math.min(100, (song.elapsed / song.duration) * 100)}%`;
  const npTime = $('#np-time-display'); if (npTime) npTime.textContent = song.duration ? `${fmtTime(song.elapsed)} / ${fmtTime(song.duration)}` : '';

  // Stream UI
  const banner = $('#stream-status-banner');
  const stats = $('#stream-stats-container');
  const preview = $('#preview-overlay');
  const btnStart = $('#btn-start');
  const btnStop = $('#btn-stop');

  if (stream) {
    if (banner) { banner.hidden = false; banner.textContent = stream.status.toUpperCase() + (stream.errorMessage && stream.status !== 'live' ? `: ${stream.errorMessage}` : ''); banner.className = `stream-status-label status--${stream.status}`; }
    if (stats) stats.hidden = false;
    if (preview) preview.hidden = false;
    if (btnStart) btnStart.hidden = true;
    if (btnStop) btnStop.hidden = false;

    const sb = $('#stat-bitrate'); if (sb) sb.textContent = stream.stats?.bitrate || '0k';
    const sf = $('#stat-fps'); if (sf) sf.textContent = stream.stats?.fps || '0';
    const ss = $('#stat-speed'); if (ss) ss.textContent = stream.stats?.speed || '0x';

    const uptimeEl = $('#stat-uptime');
    try { clearInterval(uptimeTimers[station.id]); } catch (e) {}
    if (uptimeEl) { uptimeTimers[station.id] = setInterval(() => { uptimeEl.textContent = fmtUptime(stream.startedAt); }, 1000); uptimeEl.textContent = fmtUptime(stream.startedAt); }

    const previewImg = $('#preview-img-display'); if (previewImg && stream.status === 'live') previewImg.src = `/api/streams/${stream.id}/preview?t=${Date.now()}`;
    const linkStream = $('#link-stream'); if (linkStream) { if (stream.streamUrl && stream.status === 'live') { linkStream.href = stream.streamUrl; linkStream.hidden = false; } else linkStream.hidden = true; }

    if (btnStop) btnStop.onclick = () => stopStream(stream.id);
  } else {
    [banner, stats, preview, $('#link-stream')].forEach(el => el && (el.hidden = true));
    if (btnStart) btnStart.hidden = false;
    if (btnStop) btnStop.hidden = true;
    if (uptimeTimers[station.id]) { clearInterval(uptimeTimers[station.id]); delete uptimeTimers[station.id]; }
  }
}

/* ── API & Actions ─────────────────────────────────────────────────────────── */

async function loadInitialData() {
  try {
    const [stRes, npRes, strRes, setRes] = await Promise.all([
      apiFetch('/api/stations').then(r => r.json()),
      apiFetch('/api/nowplaying').then(r => r.json()),
      apiFetch('/api/streams').then(r => r.json()),
      apiFetch('/api/settings').then(r => r.json())
    ]);

    const npMap = {};
    if (npRes.ok) npRes.data.forEach(item => {
      const song = item.now_playing?.song || {};
      npMap[item.station.id] = {
        stationId: item.station.id,
        isOnline: item.is_online,
        isLive: item.live?.is_live,
        listeners: item.listeners?.total || 0,
        nowPlaying: { ...song, elapsed: item.now_playing?.elapsed, duration: item.now_playing?.duration }
      };
    });

    Store.update({
      stations: stRes.ok ? stRes.data : [],
      nowPlaying: npMap,
      streams: strRes.ok ? strRes.data : [],
      settings: setRes.ok ? setRes.data : {}
    });

    // Sync settings to form
    const s = Store.state.settings;
    if ($('#inp-stream-title')) $('#inp-stream-title').value = s.DEFAULT_STREAM_TITLE || '';
    if ($('#inp-stream-desc')) $('#inp-stream-desc').value = s.DEFAULT_STREAM_DESC || '';
    if ($('#sel-visibility')) $('#sel-visibility').value = s.DEFAULT_STREAM_VISIBILITY || 'public';
    if ($('#sel-template')) $('#sel-template').value = s.DEFAULT_TEMPLATE || '3';

  } catch (err) { toast('Critical load failure', 'error'); }
}

async function stopStream(id) {
  try {
    const res = await apiFetch(`/api/streams/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (res.ok) toast('Stopping stream...', 'info');
  } catch (err) { toast('Stop failed', 'error'); }
}

/* ── Event Handlers ────────────────────────────────────────────────────────── */

$('#stream-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const stationIdValue = $('#sel-station')?.value;
  if (!stationIdValue) return toast('No station selected', 'error');
  const stationId = parseInt(stationIdValue, 10);
  if (isNaN(stationId)) return toast('Invalid station ID', 'error');
  const station = Store.state.stations.find(s => s.id === stationId);
  if (!station) return toast('Station not found', 'error');

  const mount = station.mounts ? (station.mounts.find(m => !(String(m.name || '').toLowerCase().includes('mobile'))) || station.mounts[0]) : null;
  if (!mount) return toast('No mount found', 'error');

  try {
    const res = await apiFetch('/api/streams/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stationId, stationName: station.name, listenUrl: mount.url,
        platform: $('input[name="platform"]:checked')?.value,
        title: $('#inp-stream-title').value?.trim() || '',
        description: $('#inp-stream-desc').value?.trim() || '',
        privacyStatus: $('#sel-visibility').value || 'public',
        template: parseInt($('#sel-template').value, 10) || 3,
        manualStreamKey: $('#chk-manual-key').checked ? $('#inp-manual-key').value?.trim() : null
      })
    }).then(r => r.json());
    if (res.ok) toast('Stream process started!', 'success');
    else throw new Error(res.error);
  } catch (err) { toast(err.message, 'error'); }
});

// Logout disabled (no auth) — refresh state instead
const btnLogout = document.getElementById('btn-logout');
if (btnLogout) btnLogout.onclick = () => { if (confirm('Refresh dashboard?')) window.location.reload(); };

$('#btn-refresh').onclick = loadInitialData;

$('#btn-settings').onclick = () => {
  const host = window.location.host;
  $$('.display-redirect-uri').forEach(el => el.textContent = `${window.location.protocol}//${host}/api/${el.dataset.platform}/callback`);
  const form = $('#settings-form');
  for (const [k, v] of Object.entries(Store.state.settings)) if (form?.elements[k]) form.elements[k].value = v;
  $('#settings-modal').classList.add('active');
};

$$('.btn-close-modal').forEach(btn => btn.onclick = () => $('#settings-modal').classList.remove('active'));

$('#settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    const res = await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json());
    if (res.ok) {
      Store.update({ settings: { ...Store.state.settings, ...data } });
      toast('Settings saved', 'success');
      $('#settings-modal').classList.remove('active');
      loadInitialData();
    }
  } catch (err) { toast('Save failed', 'error'); }
};

/* ── Socket.io ───────────────────────────────────────────────────────────── */

function initSocket() {
  const socket = io();
  socket.on('connect', () => { 
    Store.update({ connected: true }); 
    $('#connection-badge').className = 'badge badge--connected'; 
    $('#connection-badge .badge-text').textContent = 'Connected'; 
  });
  socket.on('disconnect', () => { 
    Store.update({ connected: false }); 
    $('#connection-badge').className = 'badge badge--error'; 
    $('#connection-badge .badge-text').textContent = 'Disconnected'; 
  });

  socket.on('stream:new', (data) => { Store.update({ streams: [...Store.state.streams, data] }); });
  socket.on('stream:update', (data) => {
    const streams = [...Store.state.streams];
    const idx = streams.findIndex(s => s.id === data.id);
    if (idx >= 0) streams[idx] = data; else streams.push(data);
    Store.update({ streams });
  });
  socket.on('stream:removed', ({ id }) => { Store.update({ streams: Store.state.streams.filter(s => s.id !== id) }); });
  socket.on('nowplaying:update', (np) => {
    const nowPlaying = { ...Store.state.nowPlaying, [np.stationId]: np };
    Store.update({ nowPlaying });
  });

  socket.on('log:system', addLogLine);
  socket.on('log:stream', addLogLine);
}

function addLogLine(entry) {
  const container = $('#log-display');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `log-line log-line--${entry.type || 'info'}`;
  el.setAttribute('data-time', entry.time);
  el.textContent = entry.message;
  container.appendChild(el);
  while (container.children.length > 200) container.removeChild(container.firstChild);
  container.scrollTop = container.scrollHeight;
}

/* ── Start ───────────────────────────────────────────────────────────────── */

(async function main() {
  await loadInitialData();
  initSocket();

  // Smooth ticker for local progress
  setInterval(() => {
    const station = Store.state.stations[0];
    if (!station) return;
    const np = Store.state.nowPlaying[station.id]?.nowPlaying;
    if (np && np.duration > 0 && np.elapsed < np.duration) {
      np.elapsed += 1;
      updateDashboard();
    }
  }, 1000);
  
  // Cleanup timers on page unload
  window.addEventListener('beforeunload', clearAllTimers);
})();

const chkManual = $('#chk-manual-key'); if (chkManual) chkManual.onchange = (e) => { const wrap = $('#manual-key-wrap'); if (wrap) wrap.style.display = e.target.checked ? 'block' : 'none'; };
