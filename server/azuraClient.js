'use strict';

const axios = require('axios');
const { logger } = require('./logger');

class AzuraClient {
  constructor(config = {}) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.timeout = parseInt(config.timeout) || 10000;
    this.retryDelay = parseInt(config.retryDelay) || 5000; // 5 seconds
    this.maxRetries = parseInt(config.maxRetries) || 3;
    this.isConnected = false;
    this.retryTimeout = null;
  }

  updateConfig(config) {
    this.apiUrl = config.apiUrl || this.apiUrl;
    this.apiKey = config.apiKey || this.apiKey;
    if (config.timeout !== undefined) this.timeout = parseInt(config.timeout) || this.timeout;
    if (config.retryDelay !== undefined) this.retryDelay = parseInt(config.retryDelay) || this.retryDelay;
    if (config.maxRetries !== undefined) this.maxRetries = parseInt(config.maxRetries) || this.maxRetries;
  }

  async request(endpoint, retries = 0) {
    if (!this.apiUrl || !this.apiKey) {
      throw new Error('AzuraCast API not configured');
    }

    try {
      const response = await axios.get(`${this.apiUrl}${endpoint}`, {
        headers: { 'X-API-Key': this.apiKey },
        timeout: this.timeout,
      });
      
      this.isConnected = true;
      if (this.retryTimeout) {
        clearTimeout(this.retryTimeout);
        this.retryTimeout = null;
      }
      
      return response.data;
    } catch (err) {
      this.isConnected = false;
      logger.error(`[AzuraClient] Request failed: ${err.message}`);
      
      if (retries < this.maxRetries) {
        logger.info(`[AzuraClient] Retrying in ${this.retryDelay}ms (attempt ${retries + 1}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.request(endpoint, retries + 1);
      }
      
      // If we've exhausted retries, schedule a background reconnect
      if (!this.retryTimeout) {
        logger.info(`[AzuraClient] Scheduling reconnect in ${this.retryDelay}ms`);
        this.retryTimeout = setTimeout(() => {
          this.retryTimeout = null;
          this.request(endpoint, 0).catch(() => {}); // Silent retry
        }, this.retryDelay);
      }
      
      throw new Error(`AzuraCast API request failed after ${this.maxRetries} retries: ${err.message}`);
    }
  }

  async getStations() {
    return this.request('/stations');
  }

  async getNowPlaying() {
    return this.request('/nowplaying');
  }

  async getStationHistory(stationId) {
    return this.request(`/station/${stationId}/history`);
  }

  async testConnection() {
    try {
      await this.getStations();
      this.isConnected = true;
      return { ok: true, message: 'AzuraCast connection successful!' };
    } catch (err) {
      this.isConnected = false;
      throw new Error('AzuraCast Error: ' + err.message);
    }
  }

  /**
   * Transforms raw AzuraCast nowplaying data into a unified format for the UI.
   */
  static transformNowPlaying(np) {
    const song = np.now_playing?.song || {};
    return {
      stationId: np.station.id,
      stationName: np.station.name,
      listeners: np.listeners?.total ?? 0,
      isLive: np.live?.is_live ?? false,
      isOnline: np.is_online,
      nowPlaying: {
        artist: song.artist || '',
        title: song.title || '',
        album: song.album || '',
        genre: song.genre || '',
        art: song.art || null,
        text: song.text || '',
        elapsed: np.now_playing?.elapsed ?? 0,
        duration: np.now_playing?.duration ?? 0,
        remaining: np.now_playing?.remaining ?? 0,
      },
      playingNext: np.playing_next?.song ? {
        artist: np.playing_next.song.artist || '',
        title: np.playing_next.song.title || '',
      } : null,
      history: (np.song_history || []).slice(0, 5).map(h => ({
        artist: h.song?.artist || '',
        title: h.song?.title || '',
        playedAt: h.played_at,
      })),
    };
  }

  // Clean up on shutdown
  cleanup() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }
}

module.exports = AzuraClient;
