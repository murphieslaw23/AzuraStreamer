'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const session    = require('express-session');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');

const db             = require('./db');
const youtube        = require('./youtube');
const twitch         = require('./twitch');
const AzuraClient    = require('./azuraClient');
const StreamManager  = require('./streamManager');

// ── App Setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── Globals ───────────────────────────────────────────────────────────────────
let azura;
let streamer;
let CFG = {
  PORT              : parseInt(process.env.PORT || '3000', 10),
  STREAMS_DIR       : path.join(__dirname, 'data', 'streams'),
  FONT              : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  FONT_BOLD         : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
};

// ── Middlewares ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'azura-streamer-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

let setupCompleted = false;

const requireAuth = async (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  
  if (!setupCompleted) {
    const settings = await db.getSettings();
    if (settings.ADMIN_PASSWORD) {
      setupCompleted = true;
    } else {
      if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Setup required' });
      return res.redirect('/setup.html');
    }
  }

  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.redirect('/login.html');
};

// Public Assets
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

app.use(async (req, res, next) => {
  const publics = ['/login.html', '/setup.html', '/style.css', '/privacy.html', '/privacy', '/terms.html', '/terms'];
  if (publics.includes(req.path) || req.path.startsWith('/socket.io/')) return next();
  try {
    await requireAuth(req, res, next);
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.io Logic ──────────────────────────────────────────────────────────
io.use((socket, next) => {
  if (socket.request.session?.authenticated) return next();
  next(new Error('Unauthorized'));
});

const sysLog = (entry) => io.emit('log:system', { time: new Date().toLocaleTimeString('en-GB'), ...entry });
const streamLog = (entry) => io.emit('log:stream', { time: new Date().toLocaleTimeString('en-GB'), ...entry });
const broadcast = (event, data) => io.emit(event, data);

// ── Logic: Polling ────────────────────────────────────────────────────────────
async function poll() {
  try {
    const data = await azura.getNowPlaying();
    const transformed = data.map(AzuraClient.transformNowPlaying);
    
    transformed.forEach(meta => broadcast('nowplaying:update', meta));

    // Update running streams
    for (const s of streamer.streams.values()) {
      if (!['live', 'starting', 'reconnecting'].includes(s.status) || s._restarting) continue;

      const np = transformed.find(d => d.stationId === s.stationId);
      if (!np) continue;

      s.listeners = np.listeners;
      s.currentSong = np.nowPlaying;

      const nextText = np.playingNext ? `${np.playingNext.artist} - ${np.playingNext.title}` : '';
      
      await streamer.writeMeta(s.dataDir, {
        artist: np.nowPlaying.artist,
        title:  np.nowPlaying.title,
        next:   nextText,
      });

      if (np.nowPlaying.art && np.nowPlaying.art !== s.currentArtUrl) {
        console.log(`[${s.id}] Art changed, restarting...`);
        await streamer.downloadCover(np.nowPlaying.art, s.dataDir);
        s.currentArtUrl = np.nowPlaying.art;
        await streamer.restartFfmpeg(s);
      }
      broadcast('stream:update', streamer.getSummary(s));
    }
  } catch (err) {
    console.error('[poll] Error:', err.message);
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  const settings = await db.getSettings();
  const hash = settings.ADMIN_PASSWORD;

  if (!hash) {
    return res.status(400).json({ ok: false, error: 'Setup required' });
  }

  const match = await bcrypt.compare(password, hash);
  console.log(`[AUTH] Login attempt. Match: ${match}`);

  if (match) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Invalid password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth-status', async (req, res) => {
  const settings = await db.getSettings();
  res.json({ 
    authenticated: !!req.session?.authenticated,
    setupRequired: !settings.ADMIN_PASSWORD
  });
});

app.post('/api/setup/admin', async (req, res) => {
  const settings = await db.getSettings();
  if (settings.ADMIN_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Setup already completed' });
  }

  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }

  const hash = await bcrypt.hash(password, 10);
  await db.updateSetting('ADMIN_PASSWORD', hash);
  setupCompleted = true;
  
  // Auto-login after setup
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.get('/api/stations', async (req, res) => {
  try { res.json({ ok: true, data: await azura.getStations() }); }
  catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/nowplaying', async (req, res) => {
  try { res.json({ ok: true, data: await azura.getNowPlaying() }); }
  catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/streams', (req, res) => res.json({ ok: true, data: streamer.getAllSummaries() }));

app.post('/api/streams/start', async (req, res) => {
  let { stationId, stationName, stationShortcode, listenUrl, platform, title, description, privacyStatus, template, manualStreamKey } = req.body;
  
  const stationIdInt = parseInt(stationId, 10);
  const existing = streamer.getAllSummaries().find(s => s.stationId === stationIdInt && s.platform === platform && s.status !== 'stopped');
  if (existing) return res.status(409).json({ ok: false, error: 'Station already streaming to this platform' });

  try {
    let streamKey = manualStreamKey;
    let streamUrl = null;

    if (!streamKey) {
      if (platform === 'youtube') {
        const result = await youtube.createBroadcast(title, description, privacyStatus);
        streamKey = result.streamKey;
        streamUrl = `https://youtu.be/${result.broadcastId}`;
      } else {
        const twitchInfo = await twitch.getStreamKey();
        streamKey = twitchInfo.streamKey;
        streamUrl = `https://twitch.tv/${twitchInfo.username}`;
      }
    } else {
      streamUrl = platform === 'youtube' ? 'https://youtube.com/live_dashboard' : 'https://twitch.tv';
    }

    const rtmpBase = platform === 'youtube' ? (await db.getSettings()).YOUTUBE_RTMP_URL : (await db.getSettings()).TWITCH_RTMP_URL;
    const info = await streamer.startStream({
      stationId: stationIdInt, stationName, stationShortcode, listenUrl,
      platform, streamKey, rtmpUrl: `${rtmpBase}/${streamKey}`, template, streamUrl
    });

    // Initial metadata fetch
    const npData = await azura.getNowPlaying();
    const np = npData.find(d => d.station.id === stationIdInt);
    let artUrl = null;
    if (np) {
      const song = np.now_playing?.song || {};
      artUrl = song.art || null;
      info.currentSong = { artist: song.artist, title: song.title };
      const nextSong = np.playing_next?.song;
      await streamer.writeMeta(info.dataDir, {
        artist: song.artist || '', title: song.title || '',
        next: nextSong ? `${nextSong.artist} - ${nextSong.title}` : ''
      });
    }

    await streamer.downloadCover(artUrl, info.dataDir);
    info.currentArtUrl = artUrl;
    await streamer.spawnFfmpeg(info);

    res.json({ ok: true, data: streamer.getSummary(info) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/streams/:id', (req, res) => {
  const ok = streamer.stopStream(req.params.id);
  res.json({ ok });
});

app.get('/api/streams/:id/preview', (req, res) => {
  const s = streamer.streams.get(req.params.id);
  if (!s) return res.status(404).send('Not found');
  const p = path.join(s.dataDir, 'preview.jpg');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('Not ready');
});

app.get('/api/settings', async (req, res) => res.json({ ok: true, data: await db.getSettings() }));

app.post('/api/settings', async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) await db.updateSetting(k, v);
    const settings = await db.getSettings();
    azura.updateConfig({ apiUrl: settings.AZURACAST_API_URL, apiKey: settings.AZURACAST_API_KEY });
    streamer.updateConfig({ 
      apiKey: settings.AZURACAST_API_KEY, 
      W: parseInt(settings.VIDEO_WIDTH), 
      H: parseInt(settings.VIDEO_HEIGHT) 
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  await db.init();
  const settings = await db.getSettings();

  azura = new AzuraClient({ apiUrl: settings.AZURACAST_API_URL, apiKey: settings.AZURACAST_API_KEY });
  streamer = new StreamManager({
    ...CFG,
    apiKey: settings.AZURACAST_API_KEY,
    W: parseInt(settings.VIDEO_WIDTH || '1280'),
    H: parseInt(settings.VIDEO_HEIGHT || '720'),
  });

  // Event bridges
  streamer.on('stream:added', (s) => broadcast('stream:new', s));
  streamer.on('stream:updated', (s) => broadcast('stream:update', s));
  streamer.on('stream:removed', (s) => broadcast('stream:removed', s));
  streamer.on('log:system', (l) => sysLog(l));
  streamer.on('log:stream', (l) => streamLog(l));

  // Polling
  setInterval(poll, parseInt(settings.POLL_MS || '15000'));
  poll();

  server.listen(CFG.PORT, () => console.log(`AzuraStreamer running on port ${CFG.PORT}`));
}

init().catch(console.error);
