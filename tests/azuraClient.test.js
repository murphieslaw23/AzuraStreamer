const test = require('node:test');
const assert = require('node:assert/strict');

const azuraClient = require('../server/azuraClient');

test('AzuraClient constructor sets config', () => {
  const client = new azuraClient({
    apiUrl: 'https://test.com/api',
    apiKey: 'test-key'
  });
  
  assert.equal(client.apiUrl, 'https://test.com/api');
  assert.equal(client.apiKey, 'test-key');
  assert.equal(client.timeout, 10000);
});

test('AzuraClient updateConfig updates config', () => {
  const client = new azuraClient({
    apiUrl: 'https://test.com/api',
    apiKey: 'test-key'
  });
  
  client.updateConfig({
    apiUrl: 'https://new-test.com/api',
    apiKey: 'new-key'
  });
  
  assert.equal(client.apiUrl, 'https://new-test.com/api');
  assert.equal(client.apiKey, 'new-key');
});

test('AzuraClient request throws error when not configured', async () => {
  const client = new azuraClient();
  
  await assert.rejects(
    client.request('/stations'),
    /AzuraCast API not configured/
  );
});

test('AzuraClient transformNowPlaying transforms data correctly', () => {
  const rawData = {
    station: { id: 1, name: 'Test Station' },
    listeners: { total: 42 },
    is_online: true,
    live: { is_live: false },
    now_playing: {
      song: {
        artist: 'Test Artist',
        title: 'Test Title',
        album: 'Test Album',
        genre: 'Test Genre',
        art: 'https://test.com/art.jpg',
        text: 'Test text'
      },
      elapsed: 120,
      duration: 180,
      remaining: 60
    },
    playing_next: {
      song: {
        artist: 'Next Artist',
        title: 'Next Title'
      }
    },
    song_history: [
      {
        played_at: '2024-01-01T00:00:00Z',
        song: { artist: 'History Artist', title: 'History Title' }
      }
    ]
  };
  
  const transformed = azuraClient.transformNowPlaying(rawData);
  
  assert.equal(transformed.stationId, 1);
  assert.equal(transformed.stationName, 'Test Station');
  assert.equal(transformed.listeners, 42);
  assert.equal(transformed.isLive, false);
  assert.equal(transformed.isOnline, true);
  assert.equal(transformed.nowPlaying.artist, 'Test Artist');
  assert.equal(transformed.nowPlaying.title, 'Test Title');
  assert.equal(transformed.nowPlaying.art, 'https://test.com/art.jpg');
  assert.equal(transformed.playingNext.artist, 'Next Artist');
  assert.equal(transformed.playingNext.title, 'Next Title');
  assert.equal(transformed.history.length, 1);
  assert.equal(transformed.history[0].artist, 'History Artist');
});

test('AzuraClient transformNowPlaying handles missing data', () => {
  const rawData = {
    station: { id: 1, name: 'Test Station' },
    listeners: { total: 0 },
    is_online: false,
    live: {},
    now_playing: null,
    playing_next: null,
    song_history: []
  };
  
  const transformed = azuraClient.transformNowPlaying(rawData);
  
  assert.equal(transformed.stationId, 1);
  assert.equal(transformed.listeners, 0);
  assert.equal(transformed.isLive, false);
  assert.equal(transformed.nowPlaying.artist, '');
  assert.equal(transformed.nowPlaying.title, '');
  assert.equal(transformed.playingNext, null);
  assert.equal(transformed.history.length, 0);
});
