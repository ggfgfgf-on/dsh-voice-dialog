const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
const step = async (page, name) => { await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/' + name + '.png' }); };
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  const out = {};
  // 1. open plugins page
  await page.getByRole('button', { name: '插件' }).first().click({ timeout: 20000 }).catch(async e => { out.pluginsClickError = e.message.slice(0,120); });
  await page.waitForTimeout(2500);
  await step(page, '02-plugins');
  out.afterPlugins = await page.evaluate(() => ({
    text: (document.body.innerText||'').slice(0, 900),
    hasVoiceDialog: (document.body.innerText||'').includes('dsh-voice-dialog'),
    hasPauseLabel: (document.body.innerText||'').includes('停顿多久算说完'),
  }));
  // 2. open our package card if listed
  const card = page.locator('text=dsh-voice-dialog').first();
  if (await card.count()) {
    await card.click({ timeout: 20000 }).catch(e => { out.cardError = e.message.slice(0,120); });
    await page.waitForTimeout(2500);
    await step(page, '03-detail');
    out.afterCard = await page.evaluate(() => ({
      text: (document.body.innerText||'').slice(0, 1200),
      configSection: !!document.querySelector('[data-plugin-config]'),
      hasPauseLabel: (document.body.innerText||'').includes('停顿多久算说完'),
      hasCustomMs: (document.body.innerText||'').includes('毫秒'),
    }));
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });