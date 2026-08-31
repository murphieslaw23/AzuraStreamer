// render_template.js — render a template to a single PNG for visual inspection.
// Run inside the azurastreamer container:
//   node /app/render_template.js <template_id> <out_path>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEMPLATE = process.argv[2];
const OUT_PATH = process.argv[3] || `/tmp/test_template_${TEMPLATE}.png`;

const StreamManager = require('/app/streamManager');
const DIR = '/tmp/render_test';

// Set up test data dir
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
// 1s of mp3 silence (test audio)
const silent = path.join(DIR, 'silent.mp3');
if (!fs.existsSync(silent)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-c:a', 'libmp3lame', '-b:a', '64k', silent]);
}
// A 320x320 red cover image for templates that need it
const cover = path.join(DIR, 'cover.png');
if (!fs.existsSync(cover)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0xff5533:s=320x320:d=1', '-frames:v', '1', '-update', '1', cover]);
}
const coverRound = path.join(DIR, 'cover_round.png');
if (!fs.existsSync(coverRound)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0xff5533:s=320x320:d=1', '-frames:v', '1', '-update', '1', coverRound]);
}
const bg = path.join(DIR, 'bg.png');
if (!fs.existsSync(bg)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0x0E1118:s=1280x720:d=1', '-frames:v', '1', '-update', '1', bg]);
}
// Test metadata
fs.writeFileSync(path.join(DIR, 'title.txt'),  'Acid Techno Liveset');
fs.writeFileSync(path.join(DIR, 'artist.txt'), 'Zhao');
fs.writeFileSync(path.join(DIR, 'next.txt'),   'NEXT: Fantomas - Live OBK');
// For template 5, also need warehouse-bg.jpg. The build container has
// /app/public/warehouse-bg.jpg, so copy it to the test dir.
const whSrc = '/app/public/warehouse-bg.jpg';
if (fs.existsSync(whSrc)) {
  fs.copyFileSync(whSrc, path.join(DIR, 'warehouse-bg.jpg'));
}
// cover_round is required for template 4
fs.copyFileSync(coverRound, path.join(DIR, 'cover_round.png'));

const sm = new StreamManager({
  STREAMS_DIR: DIR,
  W: 1280, H: 720,
  FONT_DISPLAY:    '/usr/share/fonts/truetype/syco/BarlowCondensed-Bold.ttf',
  FONT_DISPLAY_BLK:'/usr/share/fonts/truetype/syco/BarlowCondensed-Black.ttf',
  FONT_BODY:       '/usr/share/fonts/truetype/syco/Inter-Variable.ttf',
  FONT_MONO:       '/usr/share/fonts/truetype/syco/JetBrainsMono-Variable.ttf',
  BRAND_NAME:    'SYSTEM CORRUPT',
  BRAND_HOME:    'SYCO23.ORG',
  BRAND_TAGLINE: '24/7 UNDGROUND MIX SETS ONLY',
});

const args = sm.buildArgs({
  listenUrl: silent, rtmpUrl: 'rtmp://x', dataDir: DIR, platform: 'youtube',
  template: TEMPLATE,
});
// Replace the listenUrl so the audio source is the silent mp3, and replace
// the RTMP output with a single-frame PNG.
const i = args.indexOf('-i');
args[i + 1] = silent;
// Drop live-stream-only options
const drop = new Set(['-re']);
const skipAfter = new Set(['-thread_queue_size', '-reconnect', '-reconnect_at_eof', '-reconnect_streamed', '-reconnect_delay_max']);
const out = [];
for (let k = 0; k < args.length; k++) {
  if (drop.has(args[k])) continue;
  if (skipAfter.has(args[k])) { k++; continue; }
  out.push(args[k]);
}
// Drop the audio mapping chain and the audio encoder chain from the
// test command — we only need a single video frame as a PNG, no audio.
const drop2 = new Set(['-c:v', 'libx264', '-preset', 'superfast', '-tune', 'stillimage', '-b:v', '3000k', '-maxrate', '3500k', '-bufsize', '12000k', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100']);
const out2 = [];
for (let k = 0; k < out.length; k++) {
  if (drop2.has(out[k])) continue;
  // `-map 0:a` is the audio mapping. Drop `-map` and its `0:a` arg.
  if (out[k] === '-map' && out[k + 1] === '0:a') { k++; continue; }
  out2.push(out[k]);
}
out.splice(0, out.length, ...out2);
args.splice(0, args.length, ...out);
// Drop the RTMP + mjpeg output, replace with single PNG.
let flvIdx = -1;
for (let k = 0; k < args.length; k++) {
  if (args[k] === '-f' && args[k + 1] === 'flv') { flvIdx = k; break; }
}
if (flvIdx > -1) args.splice(flvIdx, args.length - flvIdx);
// After stripping the preview branch, the filter graph ends with
// `[vout]`. Map that (not `[vstream]`) to the libx264 output.
for (let k = args.length - 1; k >= 0; k--) {
  if (args[k] === '-map') { args[k + 1] = '[vout]'; break; }
}
// The ffmpeg arg-list still contains the preview branch
// `[vout]split=2[vstream][vprev_in];[vprev_in]...format=yuvj420p[vprevout]`
// at the end of the filter_complex. With the mjpeg output removed,
// `[vprevout]` is unconnected, which ffmpeg errors on. Strip the
// preview branch — we just want a single broadcast stream output.
const fcIdx = args.indexOf('-filter_complex');
if (fcIdx > -1) {
  let fc = args[fcIdx + 1];
  // Remove everything from the first `[vout]split=2` onward
  fc = fc.replace(/;\[vout\]split=2\[vstream\]\[vprev_in\][^\n]*/g, '');
  args[fcIdx + 1] = fc;
}
args.push('-frames:v', '1', '-f', 'image2', '-update', '1', OUT_PATH);

console.log(`[tpl ${TEMPLATE}] running ffmpeg (${args.length} args)...`);
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  console.log(`OK: ${OUT_PATH} (${fs.statSync(OUT_PATH).size} bytes)`);
} catch (e) {
  console.error('ffmpeg failed:', e.message);
  process.exit(1);
}
