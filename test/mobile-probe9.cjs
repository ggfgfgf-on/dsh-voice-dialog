const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  const r = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const gear = document.querySelector('[aria-label="语音设置"]');
    const mic = document.querySelector('[aria-label="开始语音对话"]');
    return { gear: box(gear), mic: box(mic), row: box(document.querySelector('.dsh-vd-row')) };
  });
  await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/07-composer-gear.png', clip: { x: 0, y: 440, width: 390, height: 120 } });
  await page.locator('[aria-label="语音设置"]').first().evaluate(el => el.click());
  await page.waitForTimeout(1200);
  const inner = await page.evaluate(() => {
    const hs = [...document.querySelectorAll('.dsh-vd-check')].map(el => Math.round(el.getBoundingClientRect().height));
    const btn = [...document.querySelectorAll('.dsh-vd-button')].map(el => Math.round(el.getBoundingClientRect().height));
    const sel = [...document.querySelectorAll('.dsh-vd-settings select')].map(el => Math.round(el.getBoundingClientRect().height));
    const num = [...document.querySelectorAll('.dsh-vd-settings input[type=number]')].map(el => Math.round(el.getBoundingClientRect().height));
    const min = (a) => a.length ? Math.min(...a) : null;
    return { checkRowsMin: min(hs), buttonsMin: min(btn), selectsMin: min(sel), numberMin: min(num), counts: { check: hs.length, btn: btn.length, sel: sel.length, num: num.length } };
  });
  console.log(JSON.stringify({ row: r, inner }, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });