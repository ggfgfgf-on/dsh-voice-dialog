const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.message).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  const r = await page.evaluate(() => ({
    mic: document.querySelectorAll('[aria-label="开始语音对话"]').length,
    gear: document.querySelectorAll('[aria-label="语音设置"]').length,
    voiceRow: document.querySelectorAll('.dsh-vd-row').length,
    myCss: [...document.styleSheets].length,
    hasModalCss: !![...document.querySelectorAll('style')].find(s => (s.textContent || '').includes('dsh-vd-modalHead')),
  }));
  console.log(JSON.stringify({ r, errors: errors.slice(0, 6) }, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });