'use strict';

const db = require('./db');
const { logger } = require('./logger');

class StreamStats {
  constructor() {
    this.streamStartTimes = new Map(); // streamId -> startTime
  }

  // Record stream start
  recordStreamStart(streamId, stationId, platform) {
    this.streamStartTimes.set(streamId, {
      startTime: Date.now(),
      stationId,
      platform,
    });
    logger.info(`[StreamStats] Stream started: ${streamId} (${platform})`);
  }

  // Record stream stop and save duration
  async recordStreamStop(streamId) {
    const startInfo = this.streamStartTimes.get(streamId);
    if (!startInfo) {
      logger.warn(`[StreamStats] No start time recorded for stream: ${streamId}`);
      return;
    }

    const durationSeconds = Math.floor((Date.now() - startInfo.startTime) / 1000);
    
    try {
      await this.saveStreamStats({
        streamId,
        stationId: startInfo.stationId,
        platform: startInfo.platform,
        durationSeconds,
        startedAt: new Date(startInfo.startTime).toISOString(),
        endedAt: new Date().toISOString(),
      });
      
      logger.info(`[StreamStats] Stream stopped: ${streamId} (${startInfo.platform}) - Duration: ${durationSeconds}s`);
    } catch (err) {
      logger.error(`[StreamStats] Failed to save stats for stream ${streamId}: ${err.message}`);
    }
    
    this.streamStartTimes.delete(streamId);
  }

  // Save stream statistics to database
  async saveStreamStats(stats) {
    const payload = JSON.stringify(stats);
    
    await db.run(`
      INSERT INTO stream_stats (id, payload, createdAt)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `, [stats.streamId, payload]);
  }

  // Get stream statistics for a station
  async getStreamStatsByStation(stationId, limit = 10) {
    const rows = await db.all(`
      SELECT * FROM stream_stats 
      WHERE payload->>'$.stationId' = ? 
      ORDER BY createdAt DESC 
      LIMIT ?
    `, [String(stationId), limit]);
    
    return rows.map(row => JSON.parse(row.payload));
  }

  // Get total streaming time for a station
  async getTotalStreamTimeByStation(stationId) {
    const rows = await db.all(`
      SELECT payload FROM stream_stats 
      WHERE payload->>'$.stationId' = ?
    `, [String(stationId)]);
    
    const totalSeconds = rows.reduce((sum, row) => {
      const stats = JSON.parse(row.payload);
      return sum + (stats.durationSeconds || 0);
    }, 0);
    
    return {
      stationId,
      totalSeconds,
      totalHours: Math.floor(totalSeconds / 3600),
      totalMinutes: Math.floor((totalSeconds % 3600) / 60),
      totalSeconds: totalSeconds % 60,
    };
  }

  // Get statistics summary
  async getStatsSummary() {
    const rows = await db.all(`SELECT payload FROM stream_stats ORDER BY createdAt DESC LIMIT 100`);
    
    const summary = {
      totalStreams: rows.length,
      totalDurationSeconds: 0,
      streamsByPlatform: {},
      streamsByStation: {},
    };
    
    for (const row of rows) {
      const stats = JSON.parse(row.payload);
      summary.totalDurationSeconds += stats.durationSeconds || 0;
      
      // Count by platform
      const platform = stats.platform || 'unknown';
      summary.streamsByPlatform[platform] = (summary.streamsByPlatform[platform] || 0) + 1;
      
      // Count by station
      const stationId = stats.stationId || 'unknown';
      summary.streamsByStation[stationId] = (summary.streamsByStation[stationId] || 0) + 1;
    }
    
    return summary;
  }

  // Initialize database table
  async init() {
    await db.run(`
      CREATE TABLE IF NOT EXISTS stream_stats (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create index for faster queries
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_stream_stats_station ON stream_stats(payload->>'$.stationId')
    `);
    
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_stream_stats_platform ON stream_stats(payload->>'$.platform')
    `);
    
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_stream_stats_created ON stream_stats(createdAt)
    `);
  }
}

module.exports = new StreamStats();
