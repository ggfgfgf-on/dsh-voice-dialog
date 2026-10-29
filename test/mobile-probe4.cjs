const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll('*')]
      .map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: String(el.className).slice(0, 40), w: Math.round(r.width), x: Math.round(r.x), text: (el.textContent||'').trim().slice(0, 20) }; })
      .filter(i => i.w > window.innerWidth + 2)
      .sort((a, b) => b.w - a.w).slice(0, 8);
    const toggle = document.querySelector('[aria-label="打开侧边栏"]');
    const box = toggle ? toggle.getBoundingClientRect() : null;
    const voice = document.querySelector('[data-voice-activity]');
    return {
      innerWidth: window.innerWidth, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      toggle: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
      hasVoiceRow: !!voice, voiceBox: voice ? (() => { const r = voice.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      wide,
    };
  });
  console.log(JSON.stringify(metrics, null, 1));
  await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/03-overflow.png' });
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });