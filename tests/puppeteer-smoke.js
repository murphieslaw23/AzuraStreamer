const puppeteer = require('puppeteer');

(async () => {
  const url = 'http://127.0.0.1:3000/';
  const selectors = ['#station-name-display', '#stream-form', '#btn-start', '#settings-modal', '#toasts'];

  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  const viewports = [
    { name: 'desktop', width: 1200, height: 800 },
    { name: 'mobile', width: 375, height: 800 }
  ];

  const results = [];

  for (const vp of viewports) {
    await page.setViewport({ width: vp.width, height: vp.height });
    const result = { viewport: vp.name, title: '', checks: [] };
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    result.title = await page.title();

    for (const sel of selectors) {
      const handle = await page.$(sel);
      const exists = !!handle;
      let visible = false;
      if (exists) {
        visible = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, sel).catch(() => false);
      }
      result.checks.push({ selector: sel, exists, visible });
    }

    results.push(result);
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();

  const pass = results.every(r => r.checks.every(c => c.exists && c.visible));
  if (!pass) process.exit(2);
  process.exit(0);

})().catch(err => { console.error(err); process.exit(1); });
