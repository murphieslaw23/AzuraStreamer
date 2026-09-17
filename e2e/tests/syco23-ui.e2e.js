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
  settings: { ok: true, data: {
    AZURACAST_API_URL: 'https://radio.example.test/api',
    AZURACAST_API_KEY: 'secret',
    YOUTUBE_RTMP_URL: 'rtmp://youtube.example.test/live2',
    TWITCH_RTMP_URL: 'rtmp://twitch.example.test/app',
    DEFAULT_STREAM_TITLE: 'SYCO23 live transmission',
    DEFAULT_STREAM_DESC: 'Controlled broadcast test',
    DEFAULT_STREAM_VISIBILITY: 'unlisted',
  } },
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
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Settings rejected by test fixture' }));
    }
    if (url.pathname === '/api/auth-status') {
      const isSetup = String(req.headers.referer || '').includes('/setup.html');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ authenticated: false, setupRequired: isSetup }));
    }
    if (url.pathname === '/api/twitch/auth') {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/api/streams/stream-1/preview') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return fs.createReadStream(path.join(publicDir, 'warehouse-bg.jpg')).pipe(res);
    }
    if (apiRoutes.has(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(apiRoutes.get(url.pathname)));
    }
    if (url.pathname === '/socket.io/socket.io.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end("window.__socketHandlers={};window.io=()=>({on:(name,callback)=>{window.__socketHandlers[name]=callback;if(name==='connect')setTimeout(callback,0)}});");
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
    assert.equal(await page.$eval('#connection-badge', el => el.getAttribute('role')), 'status', 'connection state must be announced as status');
    assert.equal(await page.$eval('#connection-badge', el => el.getAttribute('aria-live')), 'polite', 'connection updates must be announced without interrupting the operator');

    await page.evaluate(() => {
      window.__socketHandlers['stream:update']({
        id: 'stream-1', stationId: 23, status: 'live',
        startedAt: new Date(Date.now() - 125000).toISOString(),
        streamUrl: 'https://example.test/live',
        stats: { bitrate: '4012.3kbits/s', fps: '30', speed: '0.998x' },
      });
    });
    assert.equal(
      await page.$eval('.signal-rail small', el => el.textContent.trim()),
      'Output path active',
      'a live transmission must not describe its output path as dormant'
    );

    await page.evaluate(() => {
      window.__socketHandlers['nowplaying:update']({
        stationId: 23, isOnline: true, isLive: false, listeners: 23,
        nowPlaying: { title: 'Untimed signal', artist: 'SYCO23', elapsed: 0, duration: 0, art: '' },
      });
    });
    assert.equal(
      await page.$eval('#np-fill-display', el => el.style.width),
      '0%',
      'an untimed track must clear stale progress from the preceding track'
    );

    await page.evaluate(() => window.__socketHandlers['log:system']({ time: '12:00:00', type: 'info', message: 'Regression log' }));
    assert.ok(await page.$$eval('#log-display .log-line', rows => rows.length) > 1, 'fixture should append a diagnostic row');
    await page.click('.diagnostics > summary');
    assert.ok(await page.$eval('#btn-clear-logs', button => button.getBoundingClientRect().height) >= 44, 'compact controls must retain a 44px target');
    await page.click('#btn-clear-logs');
    assert.equal(
      await page.$$eval('#log-display .log-line', rows => rows.length),
      0,
      'clear diagnostics must remove visible log rows'
    );

    await page.click('[aria-label="Open system settings"]');
    await page.waitForSelector('#settings-modal.active');
    await page.waitForFunction(() => document.querySelector('#settings-modal')?.contains(document.activeElement));
    assert.equal(await page.$eval('#settings-modal', el => el.getAttribute('aria-hidden')), 'false');
    assert.equal(await page.evaluate(() => document.querySelector('#settings-modal').contains(document.activeElement)), true);
    assert.equal(await page.$eval('.site-header', el => el.inert), true, 'settings dialog must make the page header inert');
    assert.equal(await page.$eval('.dashboard', el => el.inert), true, 'settings dialog must make dashboard controls inert');
    assert.equal(await page.$eval('input[name="AZURACAST_API_KEY"]', el => el.type), 'password', 'saved API keys must not be exposed as plain text');
    assert.equal(
      await page.$$eval('#settings-form label', labels => labels.filter(label => label.textContent.trim() === 'Twitch RTMP URL').length),
      1,
      'settings must expose one label for the Twitch RTMP field'
    );
    const copyButtons = await page.$$eval('.btn-copy-uri', buttons => buttons.map(button => ({
      label: button.getAttribute('aria-label'),
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    })));
    assert.ok(copyButtons.every(button => button.label), 'redirect URI copy controls must have accessible names');
    assert.ok(copyButtons.every(button => button.width >= 44 && button.height >= 44), 'redirect URI copy controls must meet the 44px target size');
    await page.screenshot({ path: '/tmp/azura-gui-audit-after-settings-desktop.png' });

    await page.$eval('#settings-form', form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('.toast-message')?.textContent.includes('Settings rejected by test fixture'));
    assert.match(
      await page.$eval('.toast-message', el => el.textContent),
      /Settings rejected by test fixture/,
      'settings API errors must be shown to the operator'
    );
    const toastCloseTarget = await page.$eval('.toast-close', button => ({
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    }));
    assert.ok(toastCloseTarget.width >= 44 && toastCloseTarget.height >= 44, 'toast dismissal must meet the 44px target size');
    await page.click('.toast-close');
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 1500 });

    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#settings-modal', el => el.getAttribute('aria-hidden')), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-settings');
    assert.equal(await page.$eval('.site-header', el => el.inert), false, 'closing settings must restore header controls');
    assert.equal(await page.$eval('.dashboard', el => el.inert), false, 'closing settings must restore dashboard controls');

    await page.click('#chk-manual-key');
    assert.equal(await page.$eval('#manual-key-wrap', el => el.hidden), false);
    await page.click('input[name="platform"][value="twitch"]');
    assert.equal(await page.$eval('#yt-visibility-group', el => el.hidden), true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: '/tmp/azura-gui-audit-after-dashboard-desktop.png' });

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
    const mobileStatsType = await page.evaluate(() => ({
      label: parseFloat(getComputedStyle(document.querySelector('.stat-label')).fontSize),
      value: parseFloat(getComputedStyle(document.querySelector('.stat-value')).fontSize),
    }));
    assert.ok(mobileStatsType.label >= 10, `mobile stat labels are only ${mobileStatsType.label}px`);
    assert.ok(mobileStatsType.value >= 11, `mobile stat values are only ${mobileStatsType.value}px`);
    const statContrast = await page.$eval('.stat-label', label => {
      const parse = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = rgb => {
        const values = rgb.map(channel => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
      };
      const foreground = luminance(parse(getComputedStyle(label).color));
      const background = luminance(parse(getComputedStyle(label.parentElement).backgroundColor));
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    assert.ok(statContrast >= 4.5, `mobile stat label contrast is only ${statContrast.toFixed(2)}:1`);
    await page.screenshot({ path: '/tmp/azura-gui-audit-after-dashboard-mobile.png', fullPage: true });

    await page.click('[aria-label="Open system settings"]');
    await page.waitForSelector('#settings-modal.active');
    const mobileSettingsLayout = await page.evaluate(() => {
      const form = document.querySelector('#settings-form').getBoundingClientRect();
      const save = document.querySelector('.settings-save-bar').getBoundingClientRect();
      return { formBottom: form.bottom, saveTop: save.top, saveBottom: save.bottom, viewportBottom: innerHeight };
    });
    assert.ok(
      mobileSettingsLayout.formBottom <= mobileSettingsLayout.saveTop,
      'mobile settings action must not overlay scrollable fields'
    );
    assert.ok(
      Math.abs(mobileSettingsLayout.saveBottom - mobileSettingsLayout.viewportBottom) <= 1,
      'mobile settings action must remain anchored to the dialog footer'
    );
    await page.screenshot({ path: '/tmp/azura-gui-audit-after-settings-mobile.png' });
    await page.keyboard.press('Escape');

    await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
    const login = await page.evaluate(() => ({
      title: document.title,
      brand: document.querySelector('h1')?.textContent.trim(),
      labelFor: document.querySelector('label')?.htmlFor,
      inputId: document.querySelector('input[type="password"]')?.id,
      cardBackground: getComputedStyle(document.querySelector('.login-card')).backgroundColor,
      cardRadius: getComputedStyle(document.querySelector('.login-card')).borderRadius,
    }));
    assert.equal(login.title, 'Login — SYCO23');
    assert.equal(login.brand, 'SYCO23');
    assert.equal(login.labelFor, login.inputId, 'login password label must name its input');
    assert.notEqual(login.cardBackground, 'rgba(0, 0, 0, 0)', 'login card must have an opaque panel surface');
    assert.equal(login.cardRadius, '0px', 'login card must follow the square SYCO23 panel language');
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.screenshot({ path: '/tmp/azura-gui-audit-after-login.png', fullPage: true });

    await page.goto(`http://127.0.0.1:${port}/setup.html`, { waitUntil: 'domcontentloaded' });
    const setup = await page.evaluate(() => ({
      title: document.title,
      brand: document.querySelector('.logo-text')?.textContent.trim(),
      labels: [...document.querySelectorAll('label')].map(label => ({ target: label.htmlFor, exists: Boolean(document.getElementById(label.htmlFor)) })),
      cardBackground: getComputedStyle(document.querySelector('.setup-card')).backgroundColor,
      cardRadius: getComputedStyle(document.querySelector('.setup-card')).borderRadius,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert.equal(setup.title, 'Setup — SYCO23');
    assert.equal(setup.brand, 'SYCO23');
    assert.ok(setup.labels.every(label => label.target && label.exists), 'setup password labels must name their inputs');
    assert.notEqual(setup.cardBackground, 'rgba(255, 255, 255, 0.03)', 'setup card must use the dashboard panel surface');
    assert.equal(setup.cardRadius, '0px', 'setup card must follow the square SYCO23 panel language');
    assert.ok(setup.overflow <= 0, `setup overflowed by ${setup.overflow}px`);
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.screenshot({ path: '/tmp/azura-gui-audit-after-setup.png', fullPage: true });

    for (const legalPath of ['/privacy.html', '/terms.html']) {
      await page.goto(`http://127.0.0.1:${port}${legalPath}`, { waitUntil: 'domcontentloaded' });
      const unsafeExternalLinks = await page.$$eval('a[target="_blank"]', links => links
        .filter(link => !link.relList.contains('noopener'))
        .map(link => link.href));
      assert.deepEqual(unsafeExternalLinks, [], `${legalPath} external tabs must not retain opener access`);
    }

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#station-name-display')?.textContent === 'SYCO23 Radio');
    await page.click('[aria-label="Open system settings"]');
    assert.deepEqual(
      await page.$$eval('a[target="_blank"]', links => links.filter(link => !link.relList.contains('noopener')).map(link => link.href)),
      [],
      'dashboard external tabs must not retain opener access'
    );
    const twitchRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/twitch/auth');
    await page.click('#btn-connect-tw');
    await twitchRequest;

    process.stdout.write('SYCO23 responsive UI E2E passed\n');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
