const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const logs = [];
  page.on('console', m => { const t = m.text(); if (t.includes('dsh-voice-dialog')) logs.push(t.slice(0, 1200)); });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  console.log(logs.join('\n=====\n').slice(0, 3000));
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });