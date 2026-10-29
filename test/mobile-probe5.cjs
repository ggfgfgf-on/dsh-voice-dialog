const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  const out = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth; };
    const items = [...document.querySelectorAll('button,[role="button"],a')].map(el => {
      const r = el.getBoundingClientRect();
      return { label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), cls: String(el.className).slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), visible: vis(el) };
    }).filter(i => i.w > 0);
    return { total: items.length, visible: items.filter(i => i.visible).slice(0, 25), offscreen: items.filter(i => !i.visible).slice(0, 12) };
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });