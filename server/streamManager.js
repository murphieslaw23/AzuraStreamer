'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { validateDiskSpace } = require('./diskUtils');
const db = require('./db');
const streamStats = require('./streamStats');

const sanitizeBroadcastText = (value) => String(value || '')
  .replace(/[\0\n\r\\]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const glyphUnits = (char) => {
  if (/\s/.test(char)) return 0.5;
  if (/[ilI1.,'`|:;]/.test(char)) return 0.5;
  if (/[MW@%&]/.test(char)) return 1.4;
  if (/[\-\u2013\u2014]/.test(char)) return 0.75;
  return 1;
};

const textUnits = (value) => Array.from(value).reduce((total, char) => total + glyphUnits(char), 0);

function fitBroadcastLine(value, maxUnits) {
  const chars = Array.from(value);
  let used = 0;
  let lastSpace = -1;
  let index = 0;

  for (; index < chars.length; index += 1) {
    const next = used + glyphUnits(chars[index]);
    if (next > maxUnits) break;
    used = next;
    if (/\s/.test(chars[index])) lastSpace = index;
  }

  if (index === chars.length) return [value.trim(), ''];
  const cutAt = lastSpace > 0 ? lastSpace : Math.max(index, 1);
  return [chars.slice(0, cutAt).join('').trim(), chars.slice(cutAt).join('').trim()];
}

function trimBroadcastLine(value, maxUnits) {
  const chars = Array.from(value);
  let used = 0;
  let index = 0;
  for (; index < chars.length; index += 1) {
    const next = used + glyphUnits(chars[index]);
    if (next > maxUnits) break;
    used = next;
  }
  return chars.slice(0, index).join('').trimEnd();
}

function formatBroadcastTitle(value, maxUnits = 38, maxLines = 2) {
  let remaining = sanitizeBroadcastText(value);
  if (!remaining) return '';

  const lines = [];
  while (remaining && lines.length < maxLines) {
    const [line, rest] = fitBroadcastLine(remaining, maxUnits);
    lines.push(line);
    remaining = rest;
  }

  if (remaining) {
    const last = lines.length - 1;
    lines[last] = `${trimBroadcastLine(lines[last], maxUnits - textUnits('…'))}…`;
  }
  return lines.join('\n');
}

class StreamManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.streams = new Map();
    this.config = config; // Contains PORT, STREAMS_DIR, FONT, etc.
    this.maxConcurrentStreams = config.maxConcurrentStreams || 3;
  }

  // Classify an ffmpeg exit + stderr buffer into a failure kind. The
  // restart loop uses this to decide between "retry with backoff" and
  // "fail fast, no point retrying" — a missing input file, a malformed
  // filter graph, or a bad stream key will never succeed on retry, so
  // burning 10 attempts × backoff = 3 minutes of confusion is hostile
  // UX. Returns one of:
  //   'permanent' — config/argument error; do NOT retry
  //   'transient' — network/RTMP drop; safe to retry with backoff
  //   'unknown'   — could be either; retry once, then treat as permanent
  static classifyFailure(stderrBuf, exitCode) {
    const hay = (stderrBuf || '').toLowerCase();
    // Exit 0 = success (shouldn't reach here, but defensive).
    if (exitCode === 0) return 'transient';
    // Permanent ffmpeg / config errors — same root cause every retry.
    if (/no such file or directory/.test(hay))         return 'permanent';
    if (/invalid argument/.test(hay))                 return 'permanent';
    if (/option not found/.test(hay))                 return 'permanent';
    if (/no such filter/.test(hay))                   return 'permanent';
    if (/error initializing complex filters/.test(hay)) return 'permanent';
    if (/protocol not found/.test(hay))               return 'permanent';
    if (/unknown encoder/.test(hay))                  return 'permanent';
    if (/unknown format/.test(hay))                   return 'permanent';
    if (/error parsing options/.test(hay))            return 'permanent';
    if (/unrecognized option/.test(hay))              return 'permanent';
    if (/bad request|invalid stream key|auth/i.test(hay)) return 'permanent';
    // Transient — network / ingest / source issues.
    if (/connection (refused|reset|timed out)/.test(hay)) return 'transient';
    if (/network is unreachable/.test(hay))           return 'transient';
    if (/i\/o error/.test(hay))                       return 'transient';
    if (/rtmp_/.test(hay))                            return 'transient';
    if (/server closed connection/.test(hay))         return 'transient';
    if (/404 not found|503|504/.test(hay))            return 'transient';
    if (/operation timed out/.test(hay))              return 'transient';
    if (/broken pipe/.test(hay))                      return 'transient';
    return 'unknown';
  }

  static parseFfmpegProgress(stderrBuf) {
    const lines = String(stderrBuf || '').split(/[\r\n]+/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!/frame=\s*\d+/.test(line)) continue;

      const fps = line.match(/(?:^|\s)fps=\s*([\d.]+)/)?.[1];
      const time = line.match(/(?:^|\s)time=(\d{2}:\d{2}:\d{2})(?:\.\d+)?/)?.[1];
      const bitrate = line.match(/(?:^|\s)bitrate=\s*([\d.]+[A-Za-z]+\/s)/)?.[1];
      const speed = line.match(/(?:^|\s)speed=\s*([\d.]+x)/)?.[1];
      if (!fps || !time || !bitrate || !speed) continue;

      return {
        fps: Math.round(parseFloat(fps)),
        time,
        bitrate,
        speed,
      };
    }
    return null;
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  async persistStreamState(info) {
    if (!info || !info.id) return;
    try {
      await db.saveStreamState(info);
    } catch (err) {
      console.error('[StreamManager] Failed to persist stream state:', err.message);
    }
  }

  async removePersistedStream(info) {
    if (!info || !info.id) return;
    try {
      await db.deletePersistedStream(info.id);
    } catch (err) {
      console.error('[StreamManager] Failed to remove persisted stream state:', err.message);
    }
  }

  async restorePersistedStreams() {
    const rows = await db.getPersistedStreams();
    for (const row of rows) {
      const info = {
        ...row.payload,
        id: row.id,
        stationId: row.stationId ?? row.payload.stationId,
        stationName: row.stationName ?? row.payload.stationName,
        platform: row.platform ?? row.payload.platform,
        startedAt: row.startedAt ?? row.payload.startedAt,
        dataDir: row.dataDir ?? row.payload.dataDir,
        streamUrl: row.streamUrl ?? row.payload.streamUrl,
        process: null,
        _restarting: false,
        _ffmpegStartTimeout: null,
        stats: row.payload.stats || { fps: 0, bitrate: '0k', speed: '0x', time: '00:00:00' },
        currentSong: row.payload.currentSong || null,
        listeners: row.payload.listeners || 0,
        currentArtUrl: row.payload.currentArtUrl || null,
        errorMessage: row.payload.errorMessage || null,
        retryCount: row.payload.retryCount || 0,
      };

      if (!info.dataDir) continue;

      // Migration: drop persisted streams whose dataDir no longer exists
      // (e.g. previous version stored paths under /tmp, which is wiped on
      // container restart, while the sqlite DB on the bind-mounted volume
      // survives). Loading such a row just produces a permanent ffmpeg
      // failure on every spawn — better to delete the DB row up front so
      // the UI doesn't show a zombie stream.
      const dirOk = await (async () => {
        try { await require('fs').promises.access(info.dataDir); return true; }
        catch { return false; }
      })();
      if (!dirOk) {
        console.warn(`[StreamManager] dropping persisted stream ${info.id}: dataDir ${info.dataDir} is gone`);
        await db.deletePersistedStream(info.id).catch(() => {});
        continue;
      }

      this.streams.set(info.id, info);
      this.emit('stream:added', this.getSummary(info));

      if (['live', 'starting', 'reconnecting'].includes(info.status)) {
        // Probe listenUrl before spawning ffmpeg so a dead AzuraCast mount is
        // surfaced immediately instead of burning the 30s startup timeout.
        // preflightCheck() may rewrite info.listenUrl to a reachable variant
        // (e.g. https://... → http://... if the upstream has a self-signed
        // cert that Node rejects but ffmpeg's gnutls accepts).
        const probe = await this.preflightCheck(info);
        if (probe.ok) {
          await this.spawnFfmpeg(info);
        } else {
          info.status = 'error';
          info.errorMessage = `Upstream listenUrl unreachable: ${info.listenUrl}`;
          this.persistStreamState(info).catch(() => {});
          this.emit('stream:updated', this.getSummary(info));
          this.emit('log:system', {
            message: `[${info.platform}] Preflight failed: ${info.errorMessage}`,
            type: 'error',
          });
        }
      }
    }

    return rows;
  }

  // Probe listenUrl with a bounded GET before spawning ffmpeg. The probe
  // tries the URL the UI supplied first (preserving any protocol the
  // operator explicitly chose) and falls back to the other scheme on
  // TLS/connection failures. This matters because:
  //   * AzuraCast typically serves its :8000 mount over plain HTTP, but
  //     exposes the same URL as https:// when the deployment has a
  //     self-signed cert in front of port 8000 (e.g. an IONOS default
  //     page). Node's strict TLS verification rejects self-signed certs
  //     and would block every stream start against such a deployment.
  //   * ffmpeg's gnutls stack is more permissive and would have worked,
  //     so the preflight was the only thing standing in the way.
  //
  // Returns { ok, url } where `url` is the canonical form that worked
  // (callers should use it for the actual ffmpeg spawn).
  async preflightCheck(info) {
    if (!info.listenUrl) return { ok: false, url: null };
    const original = info.listenUrl;

    // Build both candidates: original-protocol first, other-protocol second.
    const candidates = [];
    try {
      const u = new URL(original);
      if (u.protocol === 'https:') {
        candidates.push(original);
        candidates.push(`http://${u.host}${u.pathname}${u.search}`);
      } else if (u.protocol === 'http:') {
        candidates.push(original);
        candidates.push(`https://${u.host}${u.pathname}${u.search}`);
      } else {
        return { ok: false, url: null };
      }
    } catch (_) {
      return { ok: false, url: null };
    }

    for (const url of candidates) {
      const result = await this._probeOnce(url);
      if (result.ok) {
        if (url !== original) {
          // We fell back. Update the info record so the ffmpeg spawn uses
          // the same URL we just verified reachable.
          info.listenUrl = url;
        }
        return { ok: true, url };
      }
    }
    return { ok: false, url: null };
  }

  // One bounded probe. For a live audio stream the response never ends, so
  // we resolve on the FIRST of:
  //   • response headers received (status code 2xx/3xx → reachable)
  //   • first chunk of body received (definitely live — 200 with bytes flowing)
  //   • request error / timeout
  // The 5s timeout caps the worst case; in practice we resolve in <500ms.
  _probeOnce(url) {
    return new Promise((resolve) => {
      let parsed;
      try { parsed = new URL(url); } catch (_) { return resolve({ ok: false }); }
      const lib = parsed.protocol === 'https:' ? require('https') : require('http');
      let settled = false;
      const settle = (ok) => { if (!settled) { settled = true; resolve({ ok }); } };
      const req = lib.request(url, {
        method: 'GET',
        timeout: 5000,
        headers: {
          'User-Agent': 'AzuraStreamer-preflight/1.0',
          'Icy-MetaData': '1',
          'Accept': '*/*'
        }
      }, (res) => {
        const code = res.statusCode;
        if (code >= 200 && code < 400) {
          // Headers are good. Resolve now; we don't need any audio bytes.
          // Detach the response so we don't leak sockets on long-running streams.
          settle(true);
          // Keep draining briefly to avoid RST on a still-open socket, then close.
          res.on('data', () => {});
          setTimeout(() => { try { res.destroy(); } catch (_) {} try { req.destroy(); } catch (_) {} }, 200);
        } else {
          // 4xx/5xx — upstream is alive but the URL is wrong. Resolve false.
          settle(false);
          res.resume();
          setTimeout(() => { try { res.destroy(); } catch (_) {} try { req.destroy(); } catch (_) {} }, 200);
        }
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} settle(false); });
      req.on('error',   () => settle(false));
      req.end();
    });
  }

  async startStream(params) {
    const { 
      stationId, stationName, stationShortcode, listenUrl,
      platform, streamKey, rtmpUrl, template, streamUrl 
    } = params;

    // Check concurrent stream limit
    const activeStreams = Array.from(this.streams.values()).filter(s => 
      ['live', 'starting', 'reconnecting'].includes(s.status)
    ).length;
    
    if (activeStreams >= this.maxConcurrentStreams) {
      throw new Error(`Maximum concurrent streams (${this.maxConcurrentStreams}) reached`);
    }

    const id = uuidv4();
    const dataDir = path.join(this.config.STREAMS_DIR, id);
    
    // Validate disk space before creating directory
    try {
      validateDiskSpace(this.config.STREAMS_DIR);
    } catch (err) {
      throw new Error(`Disk space check failed: ${err.message}`);
    }

    try {
      await fsp.mkdir(dataDir, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to create stream directory: ${err.message}`);
    }

    const info = {
      id, stationId, stationName, stationShortcode, listenUrl,
      platform, streamKey, rtmpUrl, dataDir, template, streamUrl,
      process: null,
      startedAt: new Date().toISOString(),
      status: 'starting',
      errorMessage: null,
      currentSong: null,
      listeners: 0,
      currentArtUrl: null,
      _restarting: false,
      _ffmpegStartTimeout: null,
      stats: { fps: 0, bitrate: '0k', speed: '0x', time: '00:00:00' }
    };

    this.streams.set(id, info);
    streamStats.recordStreamStart(id, stationId, platform);
    await this.persistStreamState(info);
    this.emit('stream:added', this.getSummary(info));

    return info;
  }

  async stopStream(id) {
    const s = this.streams.get(id);
    if (!s) return false;

    // Cancel any pending reconnect timer BEFORE setting status, so the
    // timer's own status check (=== 'reconnecting') doesn't race and
    // re-spawn ffmpeg after the user asked to stop.
    if (s._reconnectTimer) { clearTimeout(s._reconnectTimer); s._reconnectTimer = null; }
    if (s._ffmpegStartTimeout) { clearTimeout(s._ffmpegStartTimeout); s._ffmpegStartTimeout = null; }

    s.status = 'stopped';
    if (s.process) {
      try { s.process.kill('SIGTERM'); } catch(_) {}
      setTimeout(() => { if (s.process) try { s.process.kill('SIGKILL'); } catch(_) {} }, 3000);
    }

    await this.persistStreamState(s);
    this.emit('stream:updated', this.getSummary(s));
    this.cleanupStream(s, 5000);
    await streamStats.recordStreamStop(id);
    return true;
  }

  getSummary(s) {
    // Create immutable snapshot of stream info for emission
    return Object.freeze({
      id: s.id,
      stationId: s.stationId,
      stationName: s.stationName,
      platform: s.platform,
      rtmpUrl: s.rtmpUrl,
      startedAt: s.startedAt,
      status: s.status,
      errorMessage: s.errorMessage,
      currentSong: s.currentSong ? Object.freeze({ ...s.currentSong }) : null,
      listeners: s.listeners,
      stats: Object.freeze({ ...s.stats }),
      streamUrl: s.streamUrl,
    });
  }

  getAllSummaries() {
    return Array.from(this.streams.values()).map(s => this.getSummary(s));
  }

  async spawnFfmpeg(info) {
    // Clear any previous timeout
    if (info._ffmpegStartTimeout) clearTimeout(info._ffmpegStartTimeout);

    this.assertRenderFonts();

    const args = this.buildArgs(info);
    const safeArgs = args.map(a => a.includes('rtmp://') ? 'rtmp://[REDACTED]' : a);
    
    this.emit('log:system', { 
      message: `[${info.platform}] Starting ffmpeg: ffmpeg ${safeArgs.join(' ')}`, 
      type: 'info' 
    });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    info.process = proc;
    info.lastStartedAt = Date.now();

    // Set 30-second timeout for ffmpeg to reach live status
    info._ffmpegStartTimeout = setTimeout(() => {
      if (info.status === 'starting') {
        info.status = 'error';
        info.errorMessage = 'ffmpeg startup timeout (30s)';
        this.persistStreamState(info).catch(() => {});
        this.emit('stream:updated', this.getSummary(info));
        if (proc) proc.kill('SIGTERM');
      }
    }, 30000);

    // Stash the most recent stderr on `info` so the close handler can
    // classify the failure (and so a follow-up tool can read it). Bound
    // it to 4 KB to keep memory in check across long-lived streams.
    info._lastStderr = '';
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
      info._lastStderr = stderrBuf;
      
      if ((info.status === 'starting' || info.status === 'reconnecting') && stderrBuf.includes('fps=')) {
        info.status = 'live';
        info.retryCount = 0;
        if (info._ffmpegStartTimeout) clearTimeout(info._ffmpegStartTimeout);
        this.persistStreamState(info).catch(() => {});
        this.emit('stream:updated', this.getSummary(info));
      }

      const stats = StreamManager.parseFfmpegProgress(stderrBuf);
      if (stats) {
        info.stats = stats;

        const now = Date.now();
        if (!info._lastStatBroadcast || now - info._lastStatBroadcast > 3000) {
          info._lastStatBroadcast = now;
          this.persistStreamState(info).catch(() => {});
          this.emit('stream:updated', this.getSummary(info));
        }
      }

      // Stream log
      if (!s.includes('frame=') || !s.includes('fps=')) {
        this.emit('log:stream', { id: info.id, message: s.trim() });
      }
    });

    proc.on('close', async (code) => {
      this.emit('log:system', {
        message: `[${info.platform}] ffmpeg exited with code ${code}`,
        type: code === 0 ? 'info' : 'error'
      });

      info.process = null;

      if (info._restarting) {
        info._restarting = false;
        return;
      }

      if (info.status === 'stopped') {
        this.cleanupStream(info);
        return;
      }

      // Classify the failure to decide whether retrying makes sense.
      // A missing file / bad filter graph / wrong stream key will never
      // succeed on retry — fail fast so the operator sees a clear error
      // instead of "Max retries reached" 3 minutes later.
      const failureKind = StreamManager.classifyFailure(info._lastStderr || stderrBuf, code);
      const lastStderr = (info._lastStderr || stderrBuf || '').slice(-300);

      if (failureKind === 'permanent') {
        this.emit('log:system', {
          message: `[${info.platform}] ffmpeg failed permanently (no retry): ${lastStderr}`,
          type: 'error',
        });
        info.status = 'error';
        info.errorMessage = `Permanent ffmpeg error: ${lastStderr}`;
        // Cancel any pending reconnect from a previous close.
        if (info._reconnectTimer) { clearTimeout(info._reconnectTimer); info._reconnectTimer = null; }
        this.persistStreamState(info).catch(() => {});
        this.emit('stream:updated', this.getSummary(info));
        this.cleanupStream(info, 60000);
        return;
      }

      // Reconnection Logic (transient / unknown)
      info.retryCount = (info.retryCount || 0) + 1;
      const maxRetries = 10;

      if (info.retryCount <= maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, info.retryCount - 1), 30000);
        info.status = 'reconnecting';
        info.errorMessage = `Connection lost. Retrying... (${info.retryCount}/${maxRetries})`;
        this.persistStreamState(info).catch(() => {});
        this.emit('stream:updated', this.getSummary(info));

        // Guard against overlapping reconnect timers. Without this, two
        // close events fired back-to-back (or a manual stop racing with
        // a retry) could leave two pending setTimeouts, each spawning
        // a fresh ffmpeg and corrupting the lifecycle.
        if (info._reconnectTimer) clearTimeout(info._reconnectTimer);
        info._reconnectTimer = setTimeout(() => {
          info._reconnectTimer = null;
          if (info.status === 'reconnecting') this.spawnFfmpeg(info);
        }, delay);
      } else {
        this.emit('log:system', {
          message: `[${info.platform}] ffmpeg gave up after ${maxRetries} retries: ${lastStderr}`,
          type: 'error',
        });
        info.status = 'error';
        info.errorMessage = `Max retries reached. ${lastStderr}`;
        if (info._reconnectTimer) { clearTimeout(info._reconnectTimer); info._reconnectTimer = null; }
        this.persistStreamState(info).catch(() => {});
        this.emit('stream:updated', this.getSummary(info));
        this.cleanupStream(info, 60000);
      }
    });

    proc.on('error', (err) => {
      info.status = 'error';
      info.errorMessage = err.message;
      this.persistStreamState(info).catch(() => {});
      this.emit('stream:updated', this.getSummary(info));
    });
  }

  assertRenderFonts() {
    const fontKeys = ['FONT_DISPLAY', 'FONT_DISPLAY_BLK', 'FONT_BODY', 'FONT_MONO'];
    for (const key of fontKeys) {
      const fontPath = this.config[key];
      if (!fontPath || !fs.existsSync(fontPath)) {
        throw new Error(`Required broadcast font is unavailable (${key}): ${fontPath || 'not configured'}`);
      }
    }
  }

  async restartFfmpeg(info) {
    if (!info.process) return;
    info._restarting = true;
    info.status = 'starting';
    await this.persistStreamState(info);
    this.emit('stream:updated', this.getSummary(info));

    try { info.process.kill('SIGTERM'); } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
    if (info.process) {
      try { info.process.kill('SIGKILL'); } catch (_) {}
      await new Promise(r => setTimeout(r, 500));
    }
    await this.spawnFfmpeg(info);
  }

  cleanupStream(info, delay = 5000) {
    // Clear timeout if exists
    if (info._ffmpegStartTimeout) clearTimeout(info._ffmpegStartTimeout);
    
    setTimeout(() => {
      if (this.streams.has(info.id) && (info.status === 'stopped' || info.status === 'error')) {
        this.streams.delete(info.id);
        this.removePersistedStream(info).catch(() => {});
        fsp.rm(info.dataDir, { recursive: true, force: true }).catch(() => {});
        this.emit('stream:removed', { id: info.id });
      }
    }, delay);
  }

  async deleteStreamDir(dataDir) {
    try {
      await fsp.rm(dataDir, { recursive: true, force: true });
    } catch (err) {
      console.error('[StreamManager] Failed to cleanup directory:', err.message);
    }
  }

  async shutdown() {
    console.log('[StreamManager] Shutting down...');
    
    // Stop all active streams
    for (const info of this.streams.values()) {
      if (info.process) {
        try {
          info.process.kill('SIGTERM');
        } catch (_) {}
      }
      if (info._ffmpegStartTimeout) {
        clearTimeout(info._ffmpegStartTimeout);
      }
    }
    
    // Wait a bit for graceful shutdown
    await new Promise(r => setTimeout(r, 2000));
    
    // Force kill any remaining processes
    for (const info of this.streams.values()) {
      if (info.process) {
        try {
          info.process.kill('SIGKILL');
        } catch (_) {}
      }
    }
    
    this.removeAllListeners();
  }

  // ── Asset Management ───────────────────────────────────────────────────────

  // Sanitize artist/title/next text for ffmpeg's drawtext filter. The text
  // is written to a file and read back via `textfile=...:text=...` — ffmpeg
  // reads the file as UTF-8 and draws whatever bytes are in it, so the
  // only characters we need to strip are those that would break the file
  // path or ffmpeg's text parsing:
  //   • newlines (\n, \r) — would split the title into multiple lines and
  //     break the drawtext textfile parser
  //   • null byte (\0) — would truncate the file
  //   • backslash (\) — drawtext treats this as an escape char; a stray
  //     backslash inside a title could change the visual output
  // Everything else (including @, #, :, /, accented Latin, CJK, emoji)
  // passes through. The previous whitelist ([\w\s\-\.\(\)\[\]\!\?\&\,\'\"])
  // was too restrictive and silently corrupted real titles — for example
  // "Live@Obk Dfk" became "Live Obk Dfk" because @ wasn't in the set.
  async writeMeta(dataDir, meta) {
    const pairs = [
      ['artist.txt', meta.artist || ''],
      ['title.txt',  meta.title  || ''],
      ['title_display.txt', formatBroadcastTitle(meta.title)],
      ['next.txt',   meta.next   || ''],
    ];
    await Promise.all(pairs.map(([fileName, value]) => {
      const text = fileName === 'title_display.txt'
        ? value.split('\n').map(sanitizeBroadcastText).join('\n')
        : sanitizeBroadcastText(value);
      return fsp.writeFile(path.join(dataDir, fileName), text, 'utf8');
    }));
  }

  async isPreviewFresh(dataDir, maxAgeMs = 35000) {
    try {
      const stat = await fsp.stat(path.join(dataDir, 'preview.jpg'));
      return stat.isFile() && stat.size > 0 && Date.now() - stat.mtimeMs <= maxAgeMs;
    } catch (_) {
      return false;
    }
  }

  async downloadCover(artUrl, dataDir) {
    const coverPath = path.join(dataDir, 'cover.png');
    const bgPath    = path.join(dataDir, 'bg.png');
    const roundPath = path.join(dataDir, 'cover_round.png');
    const { W, H } = this.config;

    // Template-specific static assets MUST exist in dataDir before ffmpeg
    // is spawned (the filter graph references them by absolute path).
    // Failing to copy warehouse-bg.jpg here is what caused the
    // "restart loop" symptom in the August 30 incident — every retry hit
    // the same permanent "No such file or directory" error for 3 minutes
    // before the loop gave up.
    await this.ensureTemplateAssets(dataDir);

    if (!artUrl) {
      await this.generatePlaceholders(dataDir);
      return true;
    }

    try {
      const resp = await axios.get(artUrl, {
        responseType: 'arraybuffer',
        timeout: 8000,
        headers: { 'X-API-Key': this.config.apiKey },
      });
      const tmpPath = path.join(dataDir, 'cover_raw');
      await fsp.writeFile(tmpPath, resp.data);

      const COVER_SIZE = 360;
      const ffmpegCmds = [
        `ffmpeg -y -i "${tmpPath}" -vf "scale=${COVER_SIZE}:${COVER_SIZE}:force_original_aspect_ratio=decrease,pad=${COVER_SIZE}:${COVER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0a" "${coverPath}"`,
        `ffmpeg -y -i "${tmpPath}" -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:5,drawbox=w=${W}:h=${H}:t=fill:color=black@0.85" "${bgPath}"`,
        `ffmpeg -y -i "${coverPath}" -vf "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(pow(X-W/2,2)+pow(Y-H/2,2),pow(min(W/2,H/2),2)),255,0)'" "${roundPath}"`
      ];

      for (const cmd of ffmpegCmds) {
        execSync(cmd, { timeout: 15000, stdio: 'ignore' });
      }

      await fsp.unlink(tmpPath).catch(() => {});
      return true;
    } catch (err) {
      console.error('[streamManager] Cover processing failed:', err.message);
      await this.generatePlaceholders(dataDir);
      return false;
    }
  }

  async generatePlaceholders(dataDir) {
    const { W, H } = this.config;
    const COVER_SIZE = 360;
    const cmds = [
      `ffmpeg -y -f lavfi -i "color=c=0x151518:s=${COVER_SIZE}x${COVER_SIZE}:d=1" -frames:v 1 "${path.join(dataDir, 'cover.png')}"`,
      `ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=1" -frames:v 1 "${path.join(dataDir, 'bg.png')}"`,
      `ffmpeg -y -f lavfi -i "color=c=0x00000000:s=${COVER_SIZE}x${COVER_SIZE}:d=1" -frames:v 1 "${path.join(dataDir, 'cover_round.png')}"`
    ];
    cmds.forEach(cmd => { try { execSync(cmd, { timeout: 5000, stdio: 'ignore' }); } catch(e) {} });
  }

  // Copy template-specific static brand assets (warehouse background,
  // future additions) from BRAND_BG_DIR into the stream's dataDir. These
  // files are referenced as absolute paths in the ffmpeg filter graph,
  // so a missing file kills ffmpeg in milliseconds and the restart loop
  // burns 3 minutes retrying the same permanent error.
  //
  // Idempotent: if the destination already exists, the copy is skipped.
  // If the source is missing, a clear error is logged (and the stream
  // will fail fast at spawn time, which is the desired behavior).
  async ensureTemplateAssets(dataDir) {
    const { BRAND_BG_DIR } = this.config;
    if (!BRAND_BG_DIR) {
      // Older deployment without BRAND_BG_DIR configured — fall through,
      // the existing failure mode (spawn → "No such file") still happens
      // but at least we don't crash here.
      this.emit('log:system', {
        message: '[StreamManager] ensureTemplateAssets: BRAND_BG_DIR not set; template static assets may be missing',
        type: 'warn',
      });
      return;
    }

    const assets = [
      // [sourceFile, destFile, requiredForTemplate]
      { src: 'warehouse-bg.jpg', dest: 'warehouse-bg.jpg', requiredFor: '5' },
      // Add more here as templates are added.
    ];

    for (const { src, dest } of assets) {
      const srcPath  = path.join(BRAND_BG_DIR, src);
      const destPath = path.join(dataDir, dest);
      try {
        const [st] = await Promise.all([fsp.stat(srcPath)]);
        if (!st.isFile()) throw new Error('not a regular file');
        // Skip if already present and non-empty (idempotent across retries).
        try {
          const dst = await fsp.stat(destPath);
          if (dst.isFile() && dst.size > 0) continue;
        } catch (_) { /* missing — proceed to copy */ }
        await fsp.copyFile(srcPath, destPath);
      } catch (err) {
        this.emit('log:system', {
          message: `[StreamManager] ensureTemplateAssets: cannot copy ${src} from ${srcPath} — ${err.message}`,
          type: 'warn',
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  buildArgs(s) {
    const { listenUrl, rtmpUrl, dataDir, platform, template } = s;
    const {
      W, H,
      FONT_DISPLAY, FONT_DISPLAY_BLK, FONT_BODY, FONT_MONO,
      BRAND_NAME, BRAND_HOME, BRAND_TAGLINE,
    } = this.config;
    const tf = (f) => path.join(dataDir, f);

    // ── SYCO23 brand color tokens ──────────────────────────────────────
    // Single source of truth for the live stream palette. One accent,
    // one ink, one dim ink. Sharp contrast only — underground station,
    // not Spotify.
    //
    //   SYCO23_BLOOD — the brand red. Deep dried-blood, desaturated and
    //   pushed away from pink to read as a visceral / arterial tone on a
    //   dark photo background. Replaces the older #C8102E "signal red"
    //   which read as slightly pinky on warehouse / dark templates.
    //   Use this token anywhere red appears in the stream.
    const SYCO23_BLOOD = '0x9E1F19';
    const INK           = '0xE8E0CF';
    const INK_DIM       = '0xA29B8D';
    const RED           = SYCO23_BLOOD;
    const RED_S         = SYCO23_BLOOD + '@0.6';
    const RED_F         = SYCO23_BLOOD + '@0.18';
    const BG            = '0x080807';

    // Fragments reused across all templates
    const coverFile = template === '4' ? 'cover_round.png' : 'cover.png';
    // Left-aligned (templates 1-4): original chip and brand mark
    const onAirChip = `drawtext=text='// ON AIR   ${BRAND_NAME}':fontfile='${FONT_MONO}':fontsize=12:fontcolor=${INK}@0.85:x=22:y=26,drawtext=text='SYCO':fontfile='${FONT_DISPLAY_BLK}':fontsize=14:fontcolor=${RED}@0.9:x=22:y=46`;
    const brandMark = `drawtext=text='${BRAND_HOME}':fontfile='${FONT_DISPLAY}':fontsize=24:fontcolor=${RED}:x=w-text_w-40:y=40,drawtext=text='LIVE / SIGNAL ACTIVE':fontfile='${FONT_MONO}':fontsize=14:fontcolor=${INK}:x=w-text_w-40:y=76,drawtext=text='${BRAND_TAGLINE}':fontfile='${FONT_MONO}':fontsize=16:fontcolor=${INK_DIM}:x=40:y=h-text_h-40`;
    const previewBranch = `[vprev_in]fps=1/10,scale=480:-1:force_original_aspect_ratio=decrease,format=yuvj420p[vprevout]`;

    let filterComplex = '';
    let prevLabel = '[vout]';

    if (template === '1') {
      // FREQUENCY — engineering / spectrum analyzer. Cover in the lower
      // left at 280×280 with a thin red border. A red carrier line at
      // y=420 with 9 vertical tick marks reads as a "spectrum analyzer
      // grid." Title + artist below the carrier, with an upcoming-track
      // line in mono.
      const covSize = 280, covX = 70, covY = 380;
      let ticks = '';
      for (let i = 1; i < 10; i++) {
        const x = Math.round((W / 10) * i);
        ticks += `,drawbox=x=${x - 1}:y=410:w=2:h=20:color=${RED}@0.55:t=fill`;
      }
      filterComplex = [
        `[0:a]showfreqs=s=560x56:mode=bar:colors=${RED_S}:fscale=log:rate=30,format=yuv420p[freq]`,
        `[1:v]format=yuv420p,boxblur=20:1[bgblur]`,
        `[bgblur]drawbox=x=0:y=0:w=${W}:h=${H}:color=${BG}@0.6:t=fill[bg]`,
        `[bg][freq]overlay=x=${W - 580}:y=70[v0]`,
        `[v0]${onAirChip.replace(/drawtext/g, 'drawtext').replace('x=22:y=26', 'x=22:y=160')}[v1]`,
        `[2:v]format=yuv420p,scale=${covSize}:${covSize},drawbox=x=4:y=4:w=${covSize - 8}:h=${covSize - 8}:color=${RED}@0.9:t=2[cov]`,
        `[v1][cov]overlay=x=${covX}:y=${covY}[v2]`,
        `[v2]drawbox=x=0:y=420:w=${W}:h=2:color=${RED}:t=fill${ticks}[v3]`,
        `[v3]drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_DISPLAY}':fontsize=40:fontcolor=${INK}:x=${covX + covSize + 40}:y=${covY + 30},drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT_BODY}':fontsize=22:fontcolor=${INK_DIM}@0.85:x=${covX + covSize + 42}:y=${covY + 86},drawtext=textfile='${tf('next.txt')}':reload=1:fontfile='${FONT_MONO}':fontsize=12:fontcolor=${INK_DIM}@0.5:x=${covX + covSize + 42}:y=${covY + 124}[v4]`,
        `[v4]${brandMark}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        previewBranch
      ].join(';');
    }
    else if (template === '2') {
      // MONOLITH — centered, poster-like. 360×360 cover centered, with
      // a huge Barlow Condensed title below it, prefixed by a `//` accent.
      // A 4px red carrier at y=620 frames the bottom.
      const covSize = 360, covX = (W - covSize) / 2, covY = 100;
      filterComplex = [
        `[1:v]format=yuv420p,boxblur=24:1[bgblur]`,
        `[bgblur]drawbox=x=0:y=0:w=${W}:h=${H}:color=${BG}@0.7:t=fill[bg]`,
        `[2:v]format=yuv420p,scale=${covSize}:${covSize},drawbox=x=4:y=4:w=${covSize - 8}:h=${covSize - 8}:color=${RED}:t=2[cov]`,
        `[bg][cov]overlay=x=${covX}:y=${covY}[v1]`,
        `[v1]${onAirChip}[v2]`,
        `[v2]drawtext=text='//':fontfile='${FONT_DISPLAY}':fontsize=80:fontcolor=${RED}@0.9:x=70:y=478,drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_DISPLAY}':fontsize=56:fontcolor=${INK}:x=160:y=510,drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT_BODY}':fontsize=18:fontcolor=${INK_DIM}@0.85:x=162:y=572,drawtext=textfile='${tf('next.txt')}':reload=1:fontfile='${FONT_MONO}':fontsize=12:fontcolor=${INK_DIM}@0.5:x=162:y=604[v3]`,
        `[v3]drawbox=x=0:y=620:w=${W}:h=4:color=${RED}:t=fill[v4]`,
        `[v4]${brandMark}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        previewBranch
      ].join(';');
    }
    else if (template === '3') {
      // WAVEFORM — the new "industrial default." A live waveform band
      // across the top (the actual audio in showwaves), then a red
      // carrier at y=240. Cover upper-right, 240×240, with red border.
      // Title + artist in lower-left.
      const covSize = 240, covX = W - covSize - 70, covY = 290;
      filterComplex = [
        `[0:a]showwaves=s=${W}x140:mode=cline:colors=${RED}:scale=lin:rate=30,format=yuv420p[wave]`,
        `[1:v]format=yuv420p,boxblur=20:1[bgblur]`,
        `[bgblur]drawbox=x=0:y=0:w=${W}:h=${H}:color=${BG}@0.6:t=fill[bg]`,
        `[bg][wave]overlay=x=0:y=60[v1]`,
        `[v1]drawbox=x=0:y=240:w=${W}:h=2:color=${RED}:t=fill[v2]`,
        `[2:v]format=yuv420p,scale=${covSize}:${covSize},drawbox=x=4:y=4:w=${covSize - 8}:h=${covSize - 8}:color=${RED}@0.85:t=2[cov]`,
        `[v2][cov]overlay=x=${covX}:y=${covY}[v3]`,
        `[v3]${onAirChip}[v4]`,
        `[v4]drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_DISPLAY}':fontsize=42:fontcolor=${INK}:x=70:y=470,drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT_BODY}':fontsize=22:fontcolor=${INK_DIM}@0.85:x=72:y=520,drawtext=textfile='${tf('next.txt')}':reload=1:fontfile='${FONT_MONO}':fontsize=12:fontcolor=${INK_DIM}@0.5:x=72:y=558[v5]`,
        `[v5]${brandMark}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        previewBranch
      ].join(';');
    }
    else if (template === '4') {
      // TURNTABLE — the spinning vinyl, redesigned. 320×320 round disc
      // at (90, 200) spinning at 1 rev per 8s (a=t*PI/4 — half the speed
      // of the old design, more like a real vinyl). A red center label
      // with "SYCO" inside the disc gives it identity. Carrier line at
      // y=560 cuts the lower half of the disc. Title/artist in a column
      // to the right of the disc.
      const covSize = 320, covX = 90, covY = 200;
      const lblX = covX + covSize / 2, lblY = covY + covSize / 2;
      filterComplex = [
        `[1:v]format=yuv420p,boxblur=24:1[bgblur]`,
        `[bgblur]drawbox=x=0:y=0:w=${W}:h=${H}:color=${BG}@0.7:t=fill[bg]`,
        `[2:v]format=yuv420p,rotate=a=t*PI/4:c=none[spinning]`,
        `[bg][spinning]overlay=x=${covX}:y=${covY}[v1]`,
        // Center label: a red disc with the white "SYCO" carved out.
        `[v1]drawbox=x=${lblX - 50}:y=${lblY - 50}:w=100:h=100:color=${RED}:t=fill[label_bg]`,
        `[label_bg]drawtext=text='SYCO':fontfile='${FONT_DISPLAY_BLK}':fontsize=22:fontcolor=${INK}:x=${lblX - 32}:y=${lblY - 16}[label_out]`,
        `[v1][label_out]overlay=x=0:y=0[v2]`,
        `[v2]${onAirChip}[v3]`,
        // Right-side metadata column
        `[v3]drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_DISPLAY}':fontsize=44:fontcolor=${INK}:x=${covX + covSize + 60}:y=240,drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT_BODY}':fontsize=22:fontcolor=${INK_DIM}@0.85:x=${covX + covSize + 60}:y=300,drawtext=textfile='${tf('next.txt')}':reload=1:fontfile='${FONT_MONO}':fontsize=12:fontcolor=${INK_DIM}@0.5:x=${covX + covSize + 60}:y=336[v4]`,
        `[v4]drawbox=x=0:y=560:w=${W}:h=2:color=${RED}:t=fill[v5]`,
        `[v5]${brandMark}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        previewBranch
      ].join(';');
    }
    else if (template === '5') {
      // WAREHOUSE — a restrained broadcast plate over the soundsystem
      // photograph. Every element shares a 40px safe-area grid. The title
      // is pre-fitted to two lines by writeMeta(), and the only saturated
      // accent is the SYCO23 wordmark.
      const safe = 40;
      filterComplex = [
        `[1:v]format=yuv420p,boxblur=2:1[bgblur]`,
        `[bgblur]drawbox=x=0:y=0:w=${W}:h=${H}:color=${BG}@0.42:t=fill[bg]`,
        `[bg]drawbox=x=24:y=470:w=900:h=158:color=${BG}@0.58:t=fill[plate]`,
        `[plate]drawtext=textfile='${tf('title_display.txt')}':reload=1:fontfile='${FONT_DISPLAY}':fontsize=40:line_spacing=3:fontcolor=${INK}:x=${safe}:y=488[title]`,
        `[title]drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT_DISPLAY}':fontsize=22:fontcolor=${INK_DIM}:x=${safe}:y=590[artist]`,
        `[artist]${brandMark}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        previewBranch
      ].join(';');
    }

    // Background input — warehouse image for template 5, plain bg.png
    // for all others. Template 5 has no cover (per user request), so
    // we synthesise a 320×320 black image as the cover input to keep
    // the [2:v] filter reference valid (ffmpeg complains if a referenced
    // input has no output stream).
    const bgFile = template === '5'
      ? path.join(dataDir, 'warehouse-bg.jpg')
      : path.join(dataDir, 'bg.png');
    const coverInput = template === '5'
      ? ['-f', 'lavfi', '-i', 'color=c=black:s=320x320:r=30:d=1']
      : ['-loop', '1', '-framerate', '30', '-i', path.join(dataDir, coverFile)];

    const inputArgs = [
      '-re', '-thread_queue_size', '1024',
      '-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', listenUrl,
      '-loop', '1', '-framerate', '30', '-i', bgFile,
      ...coverInput,
    ];

    const isYouTube = String(platform || '').toLowerCase() === 'youtube';
    const videoBitrate = isYouTube ? '4000k' : '3000k';
    const videoBuffer = isYouTube ? '8000k' : '6000k';
    const audioBitrate = isYouTube ? '128k' : '160k';

    return [
      // The preview output is intentionally reused by the UI. FFmpeg otherwise
      // prompts when preview.jpg already exists; with stdin ignored by spawn,
      // that prompt immediately ends the entire multi-output broadcast process.
      '-y', '-nostdin', ...inputArgs, '-filter_complex', filterComplex, '-map', '[vstream]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '3.1', '-bf', '2',
      '-b:v', videoBitrate, '-minrate', videoBitrate, '-maxrate', videoBitrate, '-bufsize', videoBuffer,
      '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-r', '30', '-pix_fmt', 'yuv420p',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-b:a', audioBitrate, '-ar', '44100',
      '-f', 'flv', rtmpUrl, '-map', '[vprevout]', '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', '-f', 'image2', '-update', '1', path.join(dataDir, 'preview.jpg')
    ];
  }
}

module.exports = StreamManager;
