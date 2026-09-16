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
const fsp        = fs.promises;
const bcrypt     = require('bcryptjs');

const db             = require('./db');
const streamStats     = require('./streamStats');
const youtube        = require('./youtube');
const twitch         = require('./twitch');
const AzuraClient    = require('./azuraClient');
const StreamManager  = require('./streamManager');
const { validateStreamStart } = require('./validator');
const { createRequireAuth } = require('./auth');
const { streamCreationKey } = require('./rateLimit');

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
  // The redesigned broadcast template stack (added when the templates were
  // redesigned). ffmpeg picks these up via `fontfile=` paths in buildArgs().
  FONT_DISPLAY      : '/usr/share/fonts/truetype/syco/BarlowCondensed-Bold.ttf',
  FONT_DISPLAY_BLK  : '/usr/share/fonts/truetype/syco/BarlowCondensed-Black.ttf',
  FONT_BODY         : '/usr/share/fonts/truetype/syco/Inter-Variable.ttf',
  FONT_MONO         : '/usr/share/fonts/truetype/syco/JetBrainsMono-Variable.ttf',
  // Kept for backward-compat with any caller that still references these.
  FONT              : '/usr/share/fonts/truetype/syco/Inter-Variable.ttf',
  FONT_BOLD         : '/usr/share/fonts/truetype/syco/BarlowCondensed-Bold.ttf',
  // Brand strings inlined in the filter drawtext. Kept here (not in the
  // DB) because they're operator-controlled and rarely change.
  BRAND_NAME        : 'SYSTEM CORRUPT',
  BRAND_HOME        : 'SYCO23.ORG',
  BRAND_TAGLINE     : '24/7 UNDGROUND MIX SETS ONLY',
  // Directory holding static brand images that get copied into each
  // stream's dataDir at start time. Template 5 references
  // `<dataDir>/warehouse-bg.jpg` from its filter graph, so it MUST be
  // present in the stream dir before ffmpeg is spawned — otherwise the
  // filter graph fails immediately with "No such file or directory" and
  // the restart loop burns ~3 minutes retrying the same permanent
  // error. See StreamManager#downloadCover (ensureTemplateAssets).
  BRAND_BG_DIR      : path.join(__dirname, 'public'),
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
  keyGenerator: streamCreationKey,
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

const requireAuth = createRequireAuth(() => db.getSettings());
const publicPaths = new Set([
  '/login.html',
  '/setup.html',
  '/style.css',
  '/privacy.html',
  '/privacy',
  '/terms.html',
  '/terms',
  '/api/auth-status',
  '/api/login',
  '/api/setup/admin',
  '/api/health',
]);

app.use((req, res, next) => {
  if (publicPaths.has(req.path) || req.path.startsWith('/socket.io/')) return next();
  return requireAuth(req, res, next).catch(next);
});

// Public Assets
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

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
io.use((socket, next) => {
  if (socket.request.session?.authenticated) return next();
  return next(new Error('Unauthorized'));
});

const sysLog = (entry) => io.emit('log:system', { time: new Date().toLocaleTimeString('en-GB'), ...entry });
const streamLog = (entry) => io.emit('log:stream', { time: new Date().toLocaleTimeString('en-GB'), ...entry });
const broadcast = (event, data) => io.emit(event, data);

// ── Logic: Polling ────────────────────────────────────────────────────────────
// Defensive helper: a stream whose dataDir has been wiped (e.g. previous
// build stored paths under /tmp, or the volume was remounted) is impossible
// to restart — every ffmpeg spawn will fail with "No such file or
// directory" before the listener ever sees the new cover. Detect this early
// in the poll and mark the stream as errored so the UI surfaces it instead
// of silently burning retries.
async function dataDirIsHealthy(dataDir) {
  if (!dataDir) return false;
  try {
    await fsp.access(dataDir);
  } catch {
    return false;
  }
  // Also verify the static template asset that buildArgs() references by
  // absolute path. A present-but-empty dataDir (race during startup) still
  // produces a permanent ffmpeg failure.
  try {
    await fsp.access(path.join(dataDir, 'warehouse-bg.jpg'));
  } catch {
    return false;
  }
  return true;
}

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

      // Preflight dataDir before any IO. A missing directory means restart
      // would just produce a permanent failure — bail to error instead of
      // burning the art-change path.
      if (!(await dataDirIsHealthy(s.dataDir))) {
        s.status = 'error';
        s.errorMessage = `dataDir missing or template asset missing: ${s.dataDir}`;
        streamer.persistStreamState(s).catch(() => {});
        broadcast('stream:update', streamer.getSummary(s));
        console.error(`[${s.id}] ${s.errorMessage}`);
        continue;
      }

      s.listeners = np.listeners;
      s.currentSong = np.nowPlaying;

      const nextText = np.playingNext ? `${np.playingNext.artist} - ${np.playingNext.title}` : '';

      try {
        await streamer.writeMeta(s.dataDir, {
          artist: np.nowPlaying.artist,
          title:  np.nowPlaying.title,
          next:   nextText,
        });
      } catch (err) {
        // writeMeta hit an unrecoverable IO error (e.g. dataDir was wiped
        // between the preflight above and now). Mark errored so we don't
        // keep retrying a doomed stream on every poll.
        s.status = 'error';
        s.errorMessage = `writeMeta failed: ${err.message}`;
        streamer.persistStreamState(s).catch(() => {});
        broadcast('stream:update', streamer.getSummary(s));
        console.error(`[${s.id}] ${s.errorMessage}`);
        continue;
      }

      if (np.nowPlaying.art && np.nowPlaying.art !== s.currentArtUrl) {
        logger.info(`[${s.id}] Art changed, restarting...`);
        try {
          await streamer.downloadCover(np.nowPlaying.art, s.dataDir);
          s.currentArtUrl = np.nowPlaying.art;
          await streamer.restartFfmpeg(s);
        } catch (err) {
          // The download / restart path itself blew up (rare — usually a
          // network error downloading the cover). Don't lose the stream
          // over it; just skip this art update and try again next poll.
          s.errorMessage = `art-change skipped: ${err.message}`;
          console.error(`[${s.id}] ${s.errorMessage}`);
        }
      }
      broadcast('stream:update', streamer.getSummary(s));
    }
  } catch (err) {
    logger.error('[poll] Error:', err.message);
  }
}

// ── Watchdog ──────────────────────────────────────────────────────────────────────────
// Every WATCHDOG_MS we audit every stream and recover ones that are stuck
// in a transient state too long. Without this, a single AzuraCast outage
// during container startup leaves a stream in "reconnecting" until the
// operator manually restarts it.
//
// Recovery rules:
//   * status === 'starting' for > STARTING_TIMEOUT_MS  → kill the start
//     timeout and force spawnFfmpeg again (the original start may have
//     stalled on a slow upstream that has since come back).
//   * status === 'reconnecting' for > RECONNECTING_TIMEOUT_MS and
//     retryCount >= 3 → reset retryCount and try one more time. The
//     exponential backoff otherwise gives up at 10 retries (~3 minutes),
//     which is too short for AzuraCast restart windows (typically 30-90s
//     during a deploy).
//   * status === 'error' with a known-permanent message AND no ffmpeg
//     process AND dataDir is healthy → clear the error and try once.
//     Catches the case where a permanent failure was logged but the
//     underlying problem (e.g. missing asset) was fixed by an external
//     deploy.
const WATCHDOG_MS              = parseInt(process.env.WATCHDOG_MS              || '30000', 10);
const STARTING_TIMEOUT_MS      = parseInt(process.env.STARTING_TIMEOUT_MS      || '60000', 10);
const RECONNECTING_TIMEOUT_MS  = parseInt(process.env.RECONNECTING_TIMEOUT_MS  || '120000', 10);

async function watchdogTick() {
  const now = Date.now();
  for (const s of streamer.streams.values()) {
    try {
      const ageMs = now - (s.updatedAt ? Date.parse(s.updatedAt) : s.lastStartedAt || now);

      if (s.status === 'starting' && ageMs > STARTING_TIMEOUT_MS) {
        console.warn(`[watchdog] stream ${s.id} stuck in 'starting' for ${ageMs}ms — forcing restart`);
        if (s._ffmpegStartTimeout) { clearTimeout(s._ffmpegStartTimeout); s._ffmpegStartTimeout = null; }
        if (s.process) { try { s.process.kill('SIGKILL'); } catch (_) {} }
        s.process = null;
        s.status = 'reconnecting';
        s.retryCount = (s.retryCount || 0) + 1;
        s.errorMessage = `Watchdog: stuck in 'starting', forcing retry ${s.retryCount}`;
        streamer.persistStreamState(s).catch(() => {});
        broadcast('stream:update', streamer.getSummary(s));
        if (await dataDirIsHealthy(s.dataDir)) {
          await streamer.spawnFfmpeg(s);
        }
      } else if (s.status === 'reconnecting' && ageMs > RECONNECTING_TIMEOUT_MS && (s.retryCount || 0) >= 3) {
        console.warn(`[watchdog] stream ${s.id} reconnecting ${ageMs}ms (retry ${s.retryCount}) — one more shot`);
        s.retryCount = 0;   // reset budget — AzuraCast may have finally recovered
        s.errorMessage = `Watchdog: giving it one more shot`;
        if (s._reconnectTimer) { clearTimeout(s._reconnectTimer); s._reconnectTimer = null; }
        streamer.persistStreamState(s).catch(() => {});
        if (await dataDirIsHealthy(s.dataDir)) {
          await streamer.spawnFfmpeg(s);
        }
      } else if (s.status === 'error' && !s.process) {
        // Only attempt auto-recovery if the dataDir is healthy — otherwise
        // we'd just re-trigger the same permanent failure.
        if (await dataDirIsHealthy(s.dataDir)) {
          console.warn(`[watchdog] stream ${s.id} in 'error' state with healthy dataDir — attempting recovery`);
          s.status = 'reconnecting';
          s.errorMessage = 'Watchdog: auto-recovery attempt';
          s.retryCount = 0;
          streamer.persistStreamState(s).catch(() => {});
          broadcast('stream:update', streamer.getSummary(s));
          await streamer.spawnFfmpeg(s);
        }
      }
    } catch (err) {
      console.error(`[watchdog] error inspecting ${s.id}:`, err.message);
    }
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  const settings = await db.getSettings();
  const hash = settings.ADMIN_PASSWORD;

  if (!hash) return res.status(400).json({ ok: false, error: 'Setup required' });

  if (await bcrypt.compare(String(password || ''), hash)) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Invalid password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth-status', async (req, res) => {
  const settings = await db.getSettings();
  res.json({
    authenticated: Boolean(req.session?.authenticated),
    setupRequired: !settings.ADMIN_PASSWORD,
  });
});

app.post('/api/setup/admin', async (req, res) => {
  const settings = await db.getSettings();
  if (settings.ADMIN_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Setup already completed' });
  }

  const password = String(req.body?.password || '');
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }

  await db.updateSetting('ADMIN_PASSWORD', await bcrypt.hash(password, 10));
  req.session.authenticated = true;
  return res.json({ ok: true });
});

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
  try { res.json({ ok: true, data: await azura.getStations() }); }
  catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    res.json({ ok: true, data: await streamStats.getStatsSummary() });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to get stats' });
  }
});

app.get('/api/nowplaying', async (req, res) => {
  try { res.json({ ok: true, data: await azura.getNowPlaying() }); }
  catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

// ── YouTube OAuth ───────────────────────────────────────────────────────────
// These are the three routes the YouTube connect flow needs:
//   1. GET /api/youtube/auth      → 302 to Google's consent screen
//   2. GET /api/youtube/callback  → exchanges ?code= for tokens, stores the
//                                    refresh token, and bounces back to the UI
//   3. GET /api/youtube/test      → calls testConnection() so the "Test"
//                                    button can confirm a stored refresh token
//                                    still works
app.get('/api/youtube/auth', async (req, res) => {
  try {
    const url = await youtube.getAuthUrl(req);
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect('/?yt_error=' + encodeURIComponent(String(error)));
  }
  if (!code) {
    return res.status(400).send('Missing ?code= from Google OAuth callback');
  }
  try {
    const tokens = await youtube.exchangeCode(String(code), req);
    // Only confirm success to the UI when we actually have something to
    // store. If Google didn't return a refresh_token (e.g. user previously
    // granted the scope and the consent screen was reused), the UI's
    // "YouTube connected" toast used to fire anyway and the next
    // createBroadcast silently failed. Surface the truth here so the user
    // knows to re-authorize with consent forced.
    if (tokens.refresh_token) {
      await db.updateSetting('YT_REFRESH_TOKEN', tokens.refresh_token);
      res.redirect('/?yt_connected=1');
    } else if (tokens.access_token) {
      // We got an access token but no refresh token. We CAN still call
      // createBroadcast for this one operation, but we won't be able to make
      // any future broadcasts because we have no way to refresh the access
      // token. Save the access token + expiry so the user gets a useful
      // error pointing at the real fix (force re-consent in Google Cloud
      // Console or remove the app from https://myaccount.google.com/permissions).
      await db.updateSetting('YT_REFRESH_TOKEN', '');  // explicitly clear
      res.redirect('/?yt_error=' + encodeURIComponent(
        'YouTube did not return a refresh token. Remove this app from your Google account permissions (https://myaccount.google.com/permissions) and click Connect Account again, OR change the OAuth consent screen to "Insecure" / add the user as a test user.'
      ));
    } else {
      res.redirect('/?yt_error=' + encodeURIComponent(
        'Google returned no tokens. The authorization code may be invalid or already used. Try clicking Connect Account again.'
      ));
    }
  } catch (err) {
    res.redirect('/?yt_error=' + encodeURIComponent(err.message));
  }
});

app.get('/api/youtube/test', async (req, res) => {
  try {
    const result = await youtube.testConnection();
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/streams', (req, res) => res.json({ ok: true, data: streamer.getAllSummaries() }));

app.post('/api/streams/start', streamCreationLimiter, async (req, res) => {
  let { stationId, stationName, stationShortcode, listenUrl, platform, title, description, privacyStatus, template, manualStreamKey } = req.body;

  try {
    // 1. INPUT VALIDATION
    validateStreamStart({ stationId, stationName, listenUrl, platform, template, manualStreamKey, title, privacyStatus });

    const stationIdInt = parseInt(stationId, 10);

    // Template resolution: templates 1–4 have been retired; the only
    // supported visual template is "5" (Warehouse). Any incoming value
    // — including the saved DEFAULT_TEMPLATE from the settings DB or a
    // stale value from a form pre-dating this change — is forced to
    // "5". This keeps the public surface uniform: every new broadcast
    // uses the same design.
    if (!template || String(template) !== '5') {
      template = '5';
    }
    
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

        // 6.5 PREFLIGHT: refuse to spawn ffmpeg against a dead upstream.
        // preflightCheck() may rewrite info.listenUrl to a reachable variant
        // (e.g. https://... → http://... if the upstream has a self-signed
        // cert that Node rejects but ffmpeg's gnutls accepts).
        const probe = await streamer.preflightCheck(info);
        if (!probe.ok) {
          info.status = 'error';
          info.errorMessage = `Upstream listenUrl unreachable: ${info.listenUrl}`;
          streamer.emit('stream:updated', streamer.getSummary(info));
          await streamer.deleteStreamDir(info.dataDir);
          streamer.streams.delete(info.id);
          return res.status(502).json({ ok: false, error: 'Upstream stream unreachable' });
        }

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

  // Watchdog: catch streams stuck in 'starting'/'reconnecting'/'error'
  // longer than their respective timeouts and force a recovery. Runs
  // independently of the poll loop so a wedged art-change restart can't
  // starve the watchdog.
  setInterval(watchdogTick, WATCHDOG_MS);
  // Run once shortly after startup to catch streams that were 'live' when
  // the previous process died and are now in a transitional state.
  setTimeout(watchdogTick, 5000);

  // Process-level self-watchdog: if this Node process is unresponsive for
  // SELF_WATCHDOG_MS, force-exit so the container's restart policy brings
  // up a fresh process. Without this, a wedged event loop (e.g. socket.io
  // deadlock) silently kills every active stream because nothing polls.
  const SELF_WATCHDOG_MS = parseInt(process.env.SELF_WATCHDOG_MS || '180000', 10);
  let lastTick = Date.now();
  setInterval(() => { lastTick = Date.now(); }, 30000);
  setInterval(() => {
    if (Date.now() - lastTick > SELF_WATCHDOG_MS + 35000) {
      console.error('[self-watchdog] event loop frozen for > ' + SELF_WATCHDOG_MS + 'ms — exiting');
      process.exit(1);
    }
  }, 60000).unref();
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
