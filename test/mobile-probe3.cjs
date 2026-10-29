const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: '打开侧边栏' }).first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  const shot = 'D:/DSHwork/dsh-voice-dialog/test/.mobile/02-sidebar.png';
  await page.screenshot({ path: shot });
  const info = await page.evaluate(() => ({
    text: (document.body.innerText||'').slice(0, 800),
    controls: [...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"]')]
      .map(el => ({
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
        box: (() => { const r = el.getBoundingClientRect(); return r.width > 0 ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; })(),
      })).filter(item => item.label && item.box).slice(0, 40),
  }));
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });