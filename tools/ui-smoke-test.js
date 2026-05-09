const puppeteer = require('puppeteer');

async function checkViewport(page, width, height, label) {
  await page.setViewport({ width, height });
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 15000 });

  const selectors = [
    '#station-name-display',
    '#stream-form',
    '#btn-start',
    '#settings-modal',
    '#toasts'
  ];

  const results = {};
  for (const sel of selectors) {
    results[sel] = await page.$(sel) !== null;
  }

  // Check layout behaviour: grid columns on dashboard
  const gridCols = await page.evaluate(() => {
    const el = document.querySelector('.dashboard');
    if (!el) return null;
    return window.getComputedStyle(el).gridTemplateColumns;
  });

  results['gridTemplateColumns'] = gridCols;
  results['viewport'] = `${label} ${width}x${height}`;
  return results;
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const out = [];
  try {
    out.push(await checkViewport(page, 375, 812, 'mobile'));
    out.push(await checkViewport(page, 1366, 768, 'desktop'));
  } catch (err) {
    console.error('ERROR', err.message);
    await browser.close();
    process.exit(2);
  }

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
