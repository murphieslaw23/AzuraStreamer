'use strict';

const express    = require('express');
const { logger, httpLogger } = require('./logger');
const { getMetrics, updateStreamMetrics, recordApiRequest, recordError } = require('./metrics');
const rateLimit = require('express-rate-limit');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const session    = require('express-session');
const fs         = require('fs');
// bcrypt handled in auth module

const db             = require('./db');
const streamStats     = require('./streamStats');
const youtube        = require('./youtube');
const twitch         = require('./twitch');
const AzuraClient    = require('./azuraClient');
const StreamManager  = require('./streamManager');
const { validateStreamStart } = require('./validator');

// ── Deployment Topology ───────────────────────────────────────────────────────
// The UI is served from this process in the all-in-one Docker deployment, and
// from a separate static host in the split deployment. In the split case the
// REST surface is reached through a same-origin proxy rewrite, but the Socket.io
// connection is made cross-origin directly to this process — so the browser
// origin has to be named here and the session cookie has to survive a
// cross-site request.
const PUBLIC_APP_ORIGINS = (process.env.PUBLIC_APP_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const IS_PRODUCTION  = process.env.NODE_ENV === 'production';
const CROSS_SITE_UI  = PUBLIC_APP_ORIGINS.length > 0;

// ── App Setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  // Same-origin only unless the UI is deployed elsewhere, in which case exactly
  // those origins are allowed — never a wildcard, because the handshake carries
  // the session cookie.
  cors: CROSS_SITE_UI
    ? { origin: PUBLIC_APP_ORIGINS, credentials: true }
    : { origin: false }
});

// ── Globals ───────────────────────────────────────────────────────────────────
let azura;
let streamer;
let settings = {};  // Cached settings
let streamCreationLock = new Map(); // For atomic duplicate checking
let CFG = {
  PORT              : parseInt(process.env.PORT || '3000', 10),
  STREAMS_DIR       : path.join(__dirname, 'data', 'streams'),
  FONT              : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  FONT_BOLD         : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
};

// ── Middlewares ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { ok: false, error: 'Too many requests, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for stream creation endpoints
const streamCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 stream creations per hour
  message: { ok: false, error: 'Too many stream creations, please try again after 1 hour' },
  keyGenerator: (req) => req.ip + (req.body.stationId || ''),
  skip: (req) => process.env.DISABLE_RATE_LIMIT === 'true',
});
app.use(express.json());
app.use(httpLogger);

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in all environments');
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // A cross-site UI can only send the cookie with SameSite=None, which browsers
    // accept only over HTTPS. Same-origin deployments keep the stricter default.
    sameSite: CROSS_SITE_UI ? 'none' : 'lax',
    secure: CROSS_SITE_UI || IS_PRODUCTION,
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Dashboard data is live and per-session. Saying so explicitly keeps any proxy
// or CDN in front of this process — including the static host's rewrite in the
// split deployment — from serving one operator a cached view of another's.
app.use('/api', apiLimiter, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// auth.requireAuth used later in middleware

// Public Assets
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// No authorization: serve *** files and APIs without auth checks

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Serve index at root. `public` sits beside the server sources in the image, so
// this resolves the same way as the static middleware above.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Mock endpoints (for local testing without AzuraCast) ───────────────────
app.get('/mock/azura/stations', (req, res) => {
  return res.json([
    { id: 1, name: 'Test Station', mounts: [{ name: 'Default', url: 'http://example.local/stream' }] }
  ]);
});

app.get('/mock/azura/nowplaying', (req, res) => {
  return res.json([
    {
      station: { id: 1, name: 'Test Station' },
      listeners: { total: 3 },
      is_online: true,
      live: { is_live: false },
      now_playing: { song: { artist: 'Demo Artist', title: 'Demo Title', album: '', genre: '', art: '' }, elapsed: 12, duration: 180 },
      playing_next: { song: { artist: 'Next Artist', title: 'Next Title' } },
      song_history: []
    }
  ]);
});

// ── Socket.io Logic ──────────────────────────────────────────────────────────
io.use((socket, next) => next());

const sysLog = (entry) => io.emit('log:system', { time: new Date().toLocaleTimeString('en-GB'), ...entry });
const streamLog = (entry) => io.emit('log:stream', { time: new Date().toLocaleTimeString('en-GB'), ...entry });
const broadcast = (event, data) => io.emit(event, data);

// ── Logic: Polling ────────────────────────────────────────────────────────────
async function poll() {
  updateStreamMetrics(streamer.streams.values());
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
        logger.info(`[${s.id}] Art changed, restarting...`);
        await streamer.downloadCover(np.nowPlaying.art, s.dataDir);
        s.currentArtUrl = np.nowPlaying.art;
        await streamer.restartFfmpeg(s);
      }
      broadcast('stream:update', streamer.getSummary(s));
    }
  } catch (err) {
    logger.error('[poll] Error:', err.message);
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Authentication removed: login/setup endpoints disabled

// Liveness for orchestrators and the deployment rollout gate. Deliberately does
// not touch AzuraCast: an unreachable or unconfigured upstream is an operational
// condition to surface in the UI, not a reason to declare this process dead and
// trigger a rollback.
app.get('/api/metrics', getMetrics);
app.get('/api/health', (req, res) => res.json({
  ok: true,
  data: {
    uptime: process.uptime(),
    azuracastConfigured: Boolean(settings.AZURACAST_API_URL),
    timestamp: new Date().toISOString()
  }
}));

app.get('/api/stations', async (req, res) => {
  try { res.json({ ok: true, data: await azura.getStations() })

app.get('/api/stats', async (req, res) => {
  try {
    const summary = await streamStats.getStatsSummary();

    res.json({ ok: true, data: summary });

  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to get stats' });

  }
});
; }
  catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/nowplaying', async (req, res) => {
  try { res.json({ ok: true, data: await azura.getNowPlaying() }); }
  catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/streams', (req, res) => res.json({ ok: true, data: streamer.getAllSummaries() }));

app.post('/api/streams/start', streamCreationLimiter, async (req, res) => {
  let { stationId, stationName, stationShortcode, listenUrl, platform, title, description, privacyStatus, template, manualStreamKey } = req.body;
  
  try {
    // 1. INPUT VALIDATION
    validateStreamStart({ stationId, stationName, listenUrl, platform, template, manualStreamKey, title, privacyStatus });

    const stationIdInt = parseInt(stationId, 10);
    
    // 2. ATOMIC DUPLICATE CHECK (prevent race condition)
    const lockKey = `${stationIdInt}:${platform}`;
    if (streamCreationLock.has(lockKey)) {
      return res.status(409).json({ ok: false, error: 'Stream creation in progress for this platform' });
    }
    
    const existing = streamer.getAllSummaries().find(s => s.stationId === stationIdInt && s.platform === platform && s.status !== 'stopped');
    if (existing) return res.status(409).json({ ok: false, error: 'Station already streaming to this platform' });
    
    // Acquire lock
    streamCreationLock.set(lockKey, true);

    try {
      let streamKey = manualStreamKey;
      let streamUrl = null;

      // 3. GET PLATFORM CREDENTIALS (with timeout)
      if (!streamKey) {
        try {
          if (platform === 'youtube') {
            const result = await Promise.race([
              youtube.createBroadcast(title, description, privacyStatus),
              new Promise((_, reject) => setTimeout(() => reject(new Error('YouTube API timeout')), 15000))
            ]);
            streamKey = result.streamKey;
            streamUrl = `https://youtu.be/${result.broadcastId}`;
          } else {
            const twitchInfo = await Promise.race([
              twitch.getStreamKey(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Twitch API timeout')), 15000))
            ]);
            streamKey = twitchInfo.streamKey;
            streamUrl = `https://twitch.tv/${twitchInfo.username}`;
          }
        } catch (apiErr) {
          return res.status(502).json({ ok: false, error: `Platform API error: ${apiErr.message}` });
        }
      } else {
        streamUrl = platform === 'youtube' ? 'https://youtube.com/live_dashboard' : 'https://twitch.tv';
      }

      // 4. CREATE STREAM ENTRY (atomic)
      const rtmpBase = platform === 'youtube' ? settings.YOUTUBE_RTMP_URL : settings.TWITCH_RTMP_URL;
      const info = await streamer.startStream({
        stationId: stationIdInt, stationName, stationShortcode, listenUrl,
        platform, streamKey, rtmpUrl: `${rtmpBase}/${streamKey}`, template, streamUrl
      });

      // 5. INITIALIZE METADATA (with error handling and rollback)
      try {
        const npData = await Promise.race([
          azura.getNowPlaying(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AzuraCast API timeout')), 10000))
        ]);
        
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

        // 6. DOWNLOAD COVER
        await streamer.downloadCover(artUrl, info.dataDir);
        info.currentArtUrl = artUrl;

        // 7. SPAWN FFMPEG (with failure rollback)
        await streamer.spawnFfmpeg(info);

      } catch (initErr) {
        // Rollback: mark error and cleanup
        info.status = 'error';
        info.errorMessage = `Initialization failed: ${initErr.message}`;
        streamer.emit('stream:updated', streamer.getSummary(info));
        await streamer.deleteStreamDir(info.dataDir);
        streamer.streams.delete(info.id);
        
        return res.status(500).json({ ok: false, error: 'Failed to initialize stream' });
      }

      res.json({ ok: true, data: streamer.getSummary(info) });
      
    } finally {
      // Release lock
      streamCreationLock.delete(lockKey);
    }

  } catch (err) {
    // Handle validation errors
    if (err.validationErrors) {
      const messages = err.validationErrors.map(e => e.message).join('; ');
      return res.status(400).json({ ok: false, error: `Validation error: ${messages}` });
    }
    
    // Sanitize error message
    const sanitizedMsg = err.message.length > 200 ? err.message.substring(0, 200) : err.message;
    res.status(500).json({ ok: false, error: 'Stream creation failed' });
    logger.error('[/api/streams/start] Error:', err);
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
    
    // Refresh cached settings
    settings = await db.getSettings();
    
    azura.updateConfig({ apiUrl: settings.AZURACAST_API_URL, apiKey: settings.AZURACAST_API_KEY });
    streamer.updateConfig({ 
      apiKey: settings.AZURACAST_API_KEY, 
      W: parseInt(settings.VIDEO_WIDTH), 
      H: parseInt(settings.VIDEO_HEIGHT) 
    });
    res.json({ ok: true });
  } catch (err) { 
    res.status(500).json({ ok: false, error: 'Settings update failed' });
    logger.error('[/api/settings POST] Error:', err);
  }
});

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  await db.init();
  await streamStats.init();
  settings = await db.getSettings();  // Cache settings at startup

  azura = new AzuraClient({ apiUrl: settings.AZURACAST_API_URL, apiKey: settings.AZURACAST_API_KEY });
  streamer = new StreamManager({
    ...CFG,
    apiKey: settings.AZURACAST_API_KEY,
    W: parseInt(settings.VIDEO_WIDTH || '1280'),
    H: parseInt(settings.VIDEO_HEIGHT || '720'),
    maxConcurrentStreams: parseInt(settings.MAX_CONCURRENT_STREAMS || '3'),
  });

  // Event bridges
  streamer.on('stream:added', (s) => broadcast('stream:new', s));
  streamer.on('stream:updated', (s) => broadcast('stream:update', s));
  streamer.on('stream:removed', (s) => broadcast('stream:removed', s));
  streamer.on('log:system', (l) => sysLog(l));
  streamer.on('log:stream', (l) => streamLog(l));

  await streamer.restorePersistedStreams();

  // Polling
  setInterval(poll, parseInt(settings.POLL_MS || '15000'));
  poll();

  server.listen(CFG.PORT, () => logger.info(`AzuraStreamer running on port ${CFG.PORT}`));
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  logger.info('Shutting down gracefully...');
  
  if (streamer) await streamer.shutdown();
  io.removeAllListeners();
  io.close();
  server.close();
  
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

init().catch(console.error);
