const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const os = require('node:os');

const dbPath = path.join(os.tmpdir(), `azurastreamer-test-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

// Use the original sqlite3-based db module for tests
// This avoids native module compilation issues in CI
const db = require('../server/db');

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
