'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { validateDiskSpace } = require('./diskUtils');

class StreamManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.streams = new Map();
    this.config = config; // Contains PORT, STREAMS_DIR, FONT, etc.
    this.maxConcurrentStreams = config.maxConcurrentStreams || 3;
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
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
    this.emit('stream:added', this.getSummary(info));

    return info;
  }

  stopStream(id) {
    const s = this.streams.get(id);
    if (!s) return false;
    
    s.status = 'stopped';
    if (s.process) {
      try { s.process.kill('SIGTERM'); } catch(_) {}
      setTimeout(() => { if (s.process) try { s.process.kill('SIGKILL'); } catch(_) {} }, 3000);
    }
    
    this.emit('stream:updated', this.getSummary(s));
    this.cleanupStream(s, 5000);
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
        this.emit('stream:updated', this.getSummary(info));
        if (proc) proc.kill('SIGTERM');
      }
    }, 30000);

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
      
      if ((info.status === 'starting' || info.status === 'reconnecting') && stderrBuf.includes('fps=')) {
        info.status = 'live';
        info.retryCount = 0;
        if (info._ffmpegStartTimeout) clearTimeout(info._ffmpegStartTimeout);
        this.emit('stream:updated', this.getSummary(info));
      }

      const statsMatch = s.match(/frame=\s*\d+\s+fps=\s*([\d\.]+)\s+.*time=(\d{2}:\d{2}:\d{2})\.\d{2}\s+bitrate=\s*([\d\.]+\w+\/s)\s+speed=\s*([\d\.]x)/);
      if (statsMatch) {
        info.stats = {
          fps: Math.round(parseFloat(statsMatch[1])),
          time: statsMatch[2],
          bitrate: statsMatch[3],
          speed: statsMatch[4]
        };

        const now = Date.now();
        if (!info._lastStatBroadcast || now - info._lastStatBroadcast > 3000) {
          info._lastStatBroadcast = now;
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

      // Reconnection Logic
      info.retryCount = (info.retryCount || 0) + 1;
      const maxRetries = 10;
      
      if (info.retryCount <= maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, info.retryCount - 1), 30000);
        info.status = 'reconnecting';
        info.errorMessage = `Connection lost. Retrying... (${info.retryCount}/${maxRetries})`;
        this.emit('stream:updated', this.getSummary(info));

        setTimeout(() => {
          if (info.status === 'reconnecting') this.spawnFfmpeg(info);
        }, delay);
      } else {
        info.status = 'error';
        info.errorMessage = `Max retries reached. ${stderrBuf.slice(-200)}`;
        this.emit('stream:updated', this.getSummary(info));
        this.cleanupStream(info, 60000);
      }
    });

    proc.on('error', (err) => {
      info.status = 'error';
      info.errorMessage = err.message;
      this.emit('stream:updated', this.getSummary(info));
    });
  }

  async restartFfmpeg(info) {
    if (!info.process) return;
    info._restarting = true;
    info.status = 'starting';
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

  async writeMeta(dataDir, meta) {
    const sanitize = (t) => String(t || '').replace(/[^\w\s\-\.\(\)\[\]\!\?\&\,\'\"]/gi, ' ').replace(/\s+/g, ' ').trim();
    const pairs = [
      ['artist.txt', meta.artist || ''],
      ['title.txt',  meta.title  || ''],
      ['next.txt',   meta.next   || ''],
    ];
    await Promise.all(pairs.map(([f, v]) =>
      fsp.writeFile(path.join(dataDir, f), sanitize(v), 'utf8')
    ));
  }

  async downloadCover(artUrl, dataDir) {
    const coverPath = path.join(dataDir, 'cover.png');
    const bgPath    = path.join(dataDir, 'bg.png');
    const roundPath = path.join(dataDir, 'cover_round.png');
    const { W, H } = this.config;

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

  // ──────────────────────────────────────────────────────────────────────────

  buildArgs(s) {
    const { listenUrl, rtmpUrl, dataDir, platform, template } = s;
    const { W, H, FONT, FONT_BOLD } = this.config;
    const COVER_SIZE = 360;
    const COVER_X = 80;
    const tf = (f) => path.join(dataDir, f);
    const waveColor = platform === 'youtube' ? '0xCC2222@0.6' : '0x7B3FBF@0.6';

    const inputArgs = [
      '-re', '-thread_queue_size', '1024',
      '-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', listenUrl,
      '-loop', '1', '-i', path.join(dataDir, 'bg.png'),
      '-loop', '1', '-i', template === '4' ? path.join(dataDir, 'cover_round.png') : path.join(dataDir, 'cover.png'),
    ];

    let filterComplex = '';

    if (template === '1') {
      const covSize = Math.floor(H * 0.25), marginX = Math.floor(W * 0.05), marginY = Math.floor(H * 0.08);
      const textX = marginX + covSize + 30, textY = H - marginY - covSize + 20;
      filterComplex = [
        `[1:v]format=yuv420p[bg]`,
        `[2:v]format=yuv420p,scale=${covSize}:${covSize}[cov]`,
        `[bg][cov]overlay=x=${marginX}:y=${H - marginY - covSize}:format=yuv420[v1]`,
        `[v1]drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_BOLD}':fontsize=32:fontcolor=white:x=${textX}:y=${textY},drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT}':fontsize=24:fontcolor=0xAAAAAA:x=${textX}:y=${textY+45}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        `[vprev_in]fps=1/10,scale=480:-1:force_original_aspect_ratio=decrease,format=yuvj420p[vprevout]`
      ].join(';');
    } 
    else if (template === '2') {
      const covSize = Math.floor(H * 0.5), covX = (W - covSize) / 2, covY = (H - covSize) / 2 - 60;
      filterComplex = [
        `[1:v]format=yuv420p[bg]`,
        `[2:v]format=yuv420p,scale=${covSize}:${covSize}[cov]`,
        `[bg][cov]overlay=x=${covX}:y=${covY}:format=yuv420[v1]`,
        `[v1]drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_BOLD}':fontsize=42:fontcolor=white:x=(w-text_w)/2:y=${covY+covSize+40}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        `[vprev_in]fps=1/10,scale=480:-1:force_original_aspect_ratio=decrease,format=yuvj420p[vprevout]`
      ].join(';');
    }
    else if (template === '4') {
      filterComplex = [
        `[1:v]format=yuv420p[bg]`,
        `[2:v]format=yuv420p,rotate=a=t*PI/2:c=none[spinning]`,
        `[bg][spinning]overlay=x=${COVER_X}:y=(H-360)/2:format=yuv420[v1]`,
        `[v1]drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_BOLD}':fontsize=36:fontcolor=white:x=${COVER_X+420}:y=(H-360)/2+140[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        `[vprev_in]fps=1/10,scale=480:-1:force_original_aspect_ratio=decrease,format=yuvj420p[vprevout]`
      ].join(';');
    }
    else {
      const cY = (H - COVER_SIZE) / 2, TEXT_X = COVER_X + COVER_SIZE + 60;
      filterComplex = [
        `[0:a]showwaves=s=${W}x100:mode=cline:colors=${waveColor}:scale=sqrt:rate=30,format=yuv420p[waves]`,
        `[1:v]format=yuv420p[bg]`,
        `[2:v]format=yuv420p[cov]`,
        `[bg][cov]overlay=x=${COVER_X}:y=${cY}:format=yuv420[v1]`,
        `[v1][waves]overlay=x=0:y=H-100:format=yuv420[v2]`,
        `[v2]drawtext=textfile='${tf('artist.txt')}':reload=1:fontfile='${FONT}':fontsize=20:fontcolor=0xAAAAAA:x=${TEXT_X}:y=${cY+100},drawtext=textfile='${tf('title.txt')}':reload=1:fontfile='${FONT_BOLD}':fontsize=36:fontcolor=white:x=${TEXT_X}:y=${cY+140}[vout]`,
        `[vout]split=2[vstream][vprev_in]`,
        `[vprev_in]fps=1/10,scale=480:-1:force_original_aspect_ratio=decrease,format=yuvj420p[vprevout]`
      ].join(';');
    }

    return [
      ...inputArgs, '-filter_complex', filterComplex, '-map', '[vstream]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'stillimage', '-b:v', '3000k', '-maxrate', '3500k', '-bufsize', '12000k',
      '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
      '-f', 'flv', rtmpUrl, '-map', '[vprevout]', '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', '-f', 'image2', '-update', '1', path.join(dataDir, 'preview.jpg')
    ];
  }
}

module.exports = StreamManager;
