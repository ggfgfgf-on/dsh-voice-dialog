const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  const out = { mic: await page.locator('[aria-label="开始语音对话"]').count(), gear: await page.locator('[aria-label="语音设置"]').count(), nav: 0, card: 0, settings: 0, pause: 0 };
  const nav = page.locator('[aria-label="插件"], [role="button"]:has-text("插件")').first();
  if (await nav.count()) { await nav.evaluate(el => el.click()); out.nav = 1; await page.waitForTimeout(2500); }
  const text = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  out.hasVoiceCard = /dsh-voice-dialog|语音对话/.test(text);
  const card = page.locator('text=dsh-voice-dialog').first();
  if (await card.count()) { await card.evaluate(el => el.click()); out.card = 1; await page.waitForTimeout(2500); }
  out.settings = await page.locator('.dsh-vd-settings').count();
  out.pause = await page.locator('.dsh-vd-pauseRow').count();
  console.log(JSON.stringify({ out, errs: errs.filter(e => /voice-dialog/.test(e)).slice(0, 4) }, null, 1));
  await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/06-desktop-plugin-page.png', fullPage: false });
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });