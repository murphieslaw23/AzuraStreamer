const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const os = require('node:os');

const dbPath = path.join(os.tmpdir(), `azurastreamer-test-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

// Force use of sqlite3 for tests by temporarily hiding better-sqlite3
const originalRequire = require;
const Module = require('module');
const originalLoad = Module._load;

// Intercept require calls to better-sqlite3 and make them fail
Module._load = function(request, parent) {
  if (request === 'better-sqlite3') {
    throw new Error('better-sqlite3 not available in test environment');
  }
  return originalLoad.apply(this, arguments);
};

// Now require db - it will fall back to sqlite3
const db = require('../server/db');

// Restore original require
Module._load = originalLoad;

test('persists and restores stream records', async () => {
  await db.init();
  await db.clearPersistedStreams();

  const stream = {
    id: 'stream-1',
    stationId: 7,
    stationName: 'Demo Station',
    platform: 'youtube',
    status: 'live',
    startedAt: '2026-07-05T00:00:00.000Z',
    dataDir: '/tmp/demo-stream',
    streamUrl: 'https://youtube.com/live',
    currentSong: { artist: 'Artist', title: 'Title' },
    listeners: 42,
    stats: { fps: 30, bitrate: '2500k', speed: '1.0x' },
    errorMessage: null,
  };

  await db.saveStreamState(stream);
  const rows = await db.getPersistedStreams();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'stream-1');
  assert.equal(rows[0].status, 'live');
  assert.equal(rows[0].stationId, 7);
  assert.equal(rows[0].platform, 'youtube');
  assert.equal(rows[0].payload.currentSong.title, 'Title');

  await db.deletePersistedStream('stream-1');
  const afterDelete = await db.getPersistedStreams();
  assert.equal(afterDelete.length, 0);
});

process.on('exit', () => {
  try { fs.unlinkSync(dbPath); } catch (_) {}
});
