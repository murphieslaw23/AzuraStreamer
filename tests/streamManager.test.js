'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const StreamManager = require('../server/streamManager');

const config = {
  W: 1280,
  H: 720,
  FONT_DISPLAY: '/fonts/display.ttf',
  FONT_DISPLAY_BLK: '/fonts/display-black.ttf',
  FONT_BODY: '/fonts/body.ttf',
  FONT_MONO: '/fonts/mono.ttf',
  BRAND_NAME: 'SYSTEM CORRUPT',
  BRAND_HOME: 'SYCO23.ORG',
  BRAND_TAGLINE: '24/7 UNDERGROUND MIX SETS ONLY',
};

test('buildArgs overwrites an existing live preview without prompting', () => {
  const manager = new StreamManager(config);
  const args = manager.buildArgs({
    listenUrl: 'https://radio.example.test/live.mp3',
    rtmpUrl: 'rtmp://ingest.example.test/live/key',
    dataDir: '/tmp/azurastreamer-test-stream',
    platform: 'youtube',
    template: '5',
  });

  assert.equal(args[0], '-y');
  assert.deepEqual(args.slice(-3), [
    '-update',
    '1',
    '/tmp/azurastreamer-test-stream/preview.jpg',
  ]);
});
