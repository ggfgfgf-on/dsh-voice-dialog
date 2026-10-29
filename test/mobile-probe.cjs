const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);
  const info = await page.evaluate(() => ({
    title: document.title, href: location.href, textLen: (document.body.innerText||'').length,
    text: (document.body.innerText||'').slice(0, 400),
    controls: [...document.querySelectorAll('button,a,[role="button"],[role="tab"]')]
      .map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30))
      .filter(Boolean).slice(0, 40),
  }));
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/01-app.png' });
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });