'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'azurastreamer.db');

class Database {
  constructor() {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new sqlite3.Database(DB_PATH);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async init() {
    await this.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    await this.run(`
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
      await this.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, val]);
    }
  }

  async getSettings() {
    const rows = await this.all(`SELECT * FROM settings`);
    return rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  }

  async updateSetting(key, value) {
    await this.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, String(value)]);
  }

  async saveStreamState(stream) {
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

    await this.run(`
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

  async getPersistedStreams() {
    const rows = await this.all(`SELECT * FROM stream_state ORDER BY updatedAt DESC`);
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload || '{}') }));
  }

  async deletePersistedStream(id) {
    await this.run(`DELETE FROM stream_state WHERE id = ?`, [id]);
  }

  async clearPersistedStreams() {
    await this.run(`DELETE FROM stream_state`);
  }
}

module.exports = new Database();
