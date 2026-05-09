'use strict';

const axios = require('axios');

class AzuraClient {
  constructor(config = {}) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.timeout = 10000;
  }

  updateConfig(config) {
    this.apiUrl = config.apiUrl || this.apiUrl;
    this.apiKey = config.apiKey || this.apiKey;
  }

  async request(endpoint) {
    if (!this.apiUrl || !this.apiKey) {
      throw new Error('AzuraCast API not configured');
    }
    const response = await axios.get(`${this.apiUrl}${endpoint}`, {
      headers: { 'X-API-Key': this.apiKey },
      timeout: this.timeout,
    });
    return response.data;
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
      return { ok: true, message: 'AzuraCast connection successful!' };
    } catch (err) {
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
}

module.exports = AzuraClient;
