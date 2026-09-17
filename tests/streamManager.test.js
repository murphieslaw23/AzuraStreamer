'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
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

test('warehouse renderer uses SYCO23 tokens, fitted metadata, and safe-area alignment', () => {
  const manager = new StreamManager(config);
  const args = manager.buildArgs({
    listenUrl: 'https://radio.example.test/live.mp3',
    rtmpUrl: 'rtmp://ingest.example.test/live/key',
    dataDir: '/tmp/azurastreamer-test-stream',
    platform: 'youtube',
    template: '5',
  });
  const filter = args[args.indexOf('-filter_complex') + 1];

  assert.match(filter, /title_display\.txt/);
  assert.match(filter, /fontcolor=0xE8E0CF/);
  assert.match(filter, /fontcolor=0xA29B8D/);
  assert.match(filter, /fontcolor=0x9E1F19/);
  assert.match(filter, /LIVE \/ SIGNAL ACTIVE/);
  assert.match(filter, /x=w-text_w-40/);
  assert.match(filter, /x=40:y=h-text_h-40/);
});

test('warehouse output is explicit 720p30 Rec.709 CBR with two-second GOP', () => {
  const manager = new StreamManager(config);
  const args = manager.buildArgs({
    listenUrl: 'https://radio.example.test/live.mp3',
    rtmpUrl: 'rtmp://ingest.example.test/live/key',
    dataDir: '/tmp/azurastreamer-test-stream',
    platform: 'youtube',
    template: '5',
  });

  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter('-r'), '30');
  assert.equal(valueAfter('-g'), '60');
  assert.equal(valueAfter('-keyint_min'), '60');
  assert.equal(valueAfter('-profile:v'), 'high');
  assert.equal(valueAfter('-minrate'), '4000k');
  assert.equal(valueAfter('-maxrate'), '4000k');
  assert.equal(valueAfter('-color_primaries'), 'bt709');
  assert.equal(valueAfter('-color_trc'), 'bt709');
  assert.equal(valueAfter('-colorspace'), 'bt709');
});

test('writeMeta creates a bounded two-line broadcast title without trusting source newlines', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'azura-meta-'));
  const manager = new StreamManager(config);
  try {
    await manager.writeMeta(dir, {
      title: 'SYSTEM CORRUPT PRESENTS — LIVE FROM THE CONCRETE PRESSURE CHAMBER 173 BPM WITH A TITLE THAT MUST NOT LEAVE THE FRAME',
      artist: 'Murphies\\Law\nInjected line',
      next: '',
    });
    const display = await fsp.readFile(path.join(dir, 'title_display.txt'), 'utf8');
    const artist = await fsp.readFile(path.join(dir, 'artist.txt'), 'utf8');
    assert.ok(display.split('\n').length <= 2);
    assert.match(display, /…$/);
    assert.equal(artist, 'Murphies Law Injected line');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('runtime image ships the custom SYCO font bundle', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --from=builder \/usr\/share\/fonts\/truetype\/syco \/usr\/share\/fonts\/truetype\/syco/);
});

test('preview freshness rejects missing, empty, and stale broadcast frames', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'azura-preview-'));
  const manager = new StreamManager(config);
  const preview = path.join(dir, 'preview.jpg');
  try {
    assert.equal(await manager.isPreviewFresh(dir, 35000), false);

    await fsp.writeFile(preview, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.equal(await manager.isPreviewFresh(dir, 35000), true);

    const staleAt = new Date(Date.now() - 60000);
    await fsp.utimes(preview, staleAt, staleAt);
    assert.equal(await manager.isPreviewFresh(dir, 35000), false);

    await fsp.truncate(preview, 0);
    assert.equal(await manager.isPreviewFresh(dir, 35000), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('ffmpeg progress parsing accepts the decimal speed values emitted by live broadcasts', () => {
  const progress = [
    'frame=    0 fps=0.0 q=0.0 size=       0kB time=N/A bitrate=N/A speed=N/A',
    'frame=  424 fps=29.9 q=23.0 size=    6924kB time=00:00:14.13 bitrate=4012.3kbits/s speed=0.998x',
  ].join('\r');

  assert.deepEqual(StreamManager.parseFfmpegProgress(progress), {
    fps: 30,
    time: '00:00:14',
    bitrate: '4012.3kbits/s',
    speed: '0.998x',
  });
});
