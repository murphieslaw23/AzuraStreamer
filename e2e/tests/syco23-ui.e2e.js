'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('../../server/node_modules/puppeteer');

const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');

const fixture = {
  stations: { ok: true, data: [{ id: 23, name: 'SYCO23 Radio', mounts: [{ id: 1, name: 'Main', is_default: true, url: 'https://example.test/radio.mp3' }] }] },
  nowplaying: { ok: true, data: [{ station: { id: 23 }, is_online: true, live: { is_live: false }, listeners: { total: 23 }, now_playing: { elapsed: 61, duration: 240, song: { title: 'Concrete Memory', artist: 'SYCO23', art: '' } } }] },
  streams: { ok: true, data: [] },
  settings: { ok: true, data: { DEFAULT_STREAM_TITLE: 'SYCO23 live transmission', DEFAULT_STREAM_DESC: 'Controlled broadcast test', DEFAULT_STREAM_VISIBILITY: 'unlisted' } },
};

const apiRoutes = new Map([
  ['/api/stations', fixture.stations],
  ['/api/nowplaying', fixture.nowplaying],
  ['/api/streams', fixture.streams],
  ['/api/settings', fixture.settings],
]);

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (apiRoutes.has(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(apiRoutes.get(url.pathname)));
    }
    if (url.pathname === '/socket.io/socket.io.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end("window.io=()=>({on:(name,callback)=>{if(name==='connect')setTimeout(callback,0)}});");
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404); return res.end('Not found');
    }
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

(async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') || url.includes('gcdn.picsart.com')) request.abort();
      else request.continue();
    });

    await page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#station-name-display')?.textContent === 'SYCO23 Radio');

    const desktop = await page.evaluate(() => ({
      title: document.querySelector('h1')?.textContent.trim(),
      station: document.querySelector('#station-name-display')?.textContent.trim(),
      action: document.querySelector('#btn-start')?.textContent.trim(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebarTop: document.querySelector('.dashboard-sidebar')?.getBoundingClientRect().top,
      stageTop: document.querySelector('.media-viewport')?.getBoundingClientRect().top,
    }));
    assert.equal(desktop.title, 'SYCO23');
    assert.equal(desktop.station, 'SYCO23 Radio');
    assert.match(desktop.action, /Arm transmission/i);
    assert.ok(desktop.overflow <= 0, `desktop overflowed by ${desktop.overflow}px`);
    assert.ok(Math.abs(desktop.sidebarTop - desktop.stageTop) < 180, 'operator rail should begin near the primary signal stack');

    await page.click('[aria-label="Open system settings"]');
    await page.waitForSelector('#settings-modal.active');
    await page.waitForFunction(() => document.querySelector('#settings-modal')?.contains(document.activeElement));
    assert.equal(await page.$eval('#settings-modal', el => el.getAttribute('aria-hidden')), 'false');
    assert.equal(await page.evaluate(() => document.querySelector('#settings-modal').contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#settings-modal', el => el.getAttribute('aria-hidden')), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-settings');

    await page.click('#chk-manual-key');
    assert.equal(await page.$eval('#manual-key-wrap', el => el.hidden), false);
    await page.click('input[name="platform"][value="twitch"]');
    assert.equal(await page.$eval('#yt-visibility-group', el => el.hidden), true);
    await page.screenshot({ path: '/tmp/syco23-desktop.png', fullPage: true });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#station-name-display')?.textContent === 'SYCO23 Radio');
    const mobile = await page.evaluate(() => {
      const stage = document.querySelector('.preview-container').getBoundingClientRect();
      const action = document.querySelector('#action-buttons').getBoundingClientRect();
      const metadata = document.querySelector('.metadata-section').getBoundingClientRect();
      return {
        stageHeight: stage.height,
        actionTop: action.top,
        metadataTop: metadata.top,
        metadataOpen: document.querySelector('.metadata-section').open,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.ok(mobile.stageHeight <= 342, `mobile signal stage is ${mobile.stageHeight}px tall`);
    assert.ok(mobile.actionTop < mobile.metadataTop, 'primary arm action must precede optional metadata on mobile');
    assert.equal(mobile.metadataOpen, false);
    assert.ok(mobile.overflow <= 0, `mobile overflowed by ${mobile.overflow}px`);
    await page.screenshot({ path: '/tmp/syco23-mobile.png', fullPage: true });

    process.stdout.write('SYCO23 responsive UI E2E passed\n');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
