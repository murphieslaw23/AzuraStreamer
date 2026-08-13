'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'server', 'data', 'azurastreamer.db');

class DatabaseManager {
  constructor() {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // Configure database with WAL mode and optimized settings
    this.db = new Database(DB_PATH, {
      verbose: null,
      fileMustExist: false,
    });
    
    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
    // Optimize synchronous behavior (NORMAL is good for most cases)
    this.db.pragma('synchronous = NORMAL');
    // Increase cache size for better performance
    this.db.pragma('cache_size = -20000'); // 20MB cache
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
    
    // Prepare statements for better performance
    this.statements = {};
  }

  prepare(sql) {
    if (!this.statements[sql]) {
      this.statements[sql] = this.db.prepare(sql);
    }
    return this.statements[sql];
  }

  run(sql, params = []) {
    const stmt = this.prepare(sql);
    return stmt.run(...params);
  }

  get(sql, params = []) {
    const stmt = this.prepare(sql);
    return stmt.get(...params);
  }

  all(sql, params = []) {
    const stmt = this.prepare(sql);
    return stmt.all(...params);
  }

  async init() {
    this.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    this.run(`
      CREATE TABLE IF NOT EXISTS stream_state (
        id TEXT PRIMARY KEY,
        stationId INTEGER,
        stationName TEXT,
        platform TEXT,
        status TEXT,
        startedAt TEXT,
        dataDir TEXT,
        streamUrl TEXT,
        payload TEXT,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const defaults = {
      'AZURACAST_API_URL'   : process.env.AZURACAST_API_URL || '',
      'AZURACAST_API_KEY'   : process.env.AZURACAST_API_KEY || '',
      'YOUTUBE_RTMP_URL'    : 'rtmp://a.rtmp.youtube.com/live2',
      'TWITCH_RTMP_URL'     : 'rtmp://live.twitch.tv/app',
      'YT_CLIENT_ID'        : process.env.YT_CLIENT_ID || '',
      'YT_CLIENT_SECRET'    : process.env.YT_CLIENT_SECRET || '',
      'YT_REFRESH_TOKEN'    : process.env.YT_REFRESH_TOKEN || '',
      'TWITCH_CLIENT_ID'    : process.env.TWITCH_CLIENT_ID || '',
      'TWITCH_CLIENT_SECRET': process.env.TWITCH_CLIENT_SECRET || '',
      'TWITCH_REFRESH_TOKEN': process.env.TWITCH_REFRESH_TOKEN || '',
      'TWITCH_STREAM_KEY'   : process.env.TWITCH_STREAM_KEY || '',
      'POLL_MS'             : '15000',
      'VIDEO_WIDTH'         : '1280',
      'VIDEO_HEIGHT'        : '720',
      'MAX_CONCURRENT_STREAMS': '3',
      'DEFAULT_STREAM_TITLE'  : 'AzuraStreamer Live',
      'DEFAULT_STREAM_DESC'   : 'Live stream from AzuraCast via AzuraStreamer',
      'DEFAULT_STREAM_VISIBILITY': 'public',
      'DEFAULT_TEMPLATE': '3'
    };

    for (const [key, val] of Object.entries(defaults)) {
      this.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, val]);
    }
  }

  getSettings() {
    const rows = this.all(`SELECT * FROM settings`);
    return rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  }

  updateSetting(key, value) {
    this.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, String(value)]);
  }

  saveStreamState(stream) {
    const payload = JSON.stringify({
      stationId: stream.stationId,
      stationName: stream.stationName,
      stationShortcode: stream.stationShortcode,
      listenUrl: stream.listenUrl,
      platform: stream.platform,
      streamKey: stream.streamKey,
      rtmpUrl: stream.rtmpUrl,
      dataDir: stream.dataDir,
      template: stream.template,
      streamUrl: stream.streamUrl,
      status: stream.status,
      startedAt: stream.startedAt,
      errorMessage: stream.errorMessage,
      currentSong: stream.currentSong,
      listeners: stream.listeners,
      currentArtUrl: stream.currentArtUrl,
      stats: stream.stats,
      retryCount: stream.retryCount,
      lastStartedAt: stream.lastStartedAt,
    });

    this.run(`
      INSERT INTO stream_state (id, stationId, stationName, platform, status, startedAt, dataDir, streamUrl, payload, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        stationId=excluded.stationId,
        stationName=excluded.stationName,
        platform=excluded.platform,
        status=excluded.status,
        startedAt=excluded.startedAt,
        dataDir=excluded.dataDir,
        streamUrl=excluded.streamUrl,
        payload=excluded.payload,
        updatedAt=CURRENT_TIMESTAMP
    `, [stream.id, stream.stationId ?? null, stream.stationName ?? null, stream.platform ?? null, stream.status ?? null, stream.startedAt ?? null, stream.dataDir ?? null, stream.streamUrl ?? null, payload]);
  }

  getPersistedStreams() {
    const rows = this.all(`SELECT * FROM stream_state ORDER BY updatedAt DESC`);
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  }

  deletePersistedStream(id) {
    this.run(`DELETE FROM stream_state WHERE id = ?`, [id]);
  }

  clearPersistedStreams() {
    this.run(`DELETE FROM stream_state`);
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new DatabaseManager();
