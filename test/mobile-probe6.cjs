const { chromium } = require('D:/deepseek-harness-dsh-v0.2.1rc2/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(7000);
  const gear = page.locator('[aria-label="语音设置"]').first();
  const gearCount = await gear.count();
  let clicked = false;
  if (gearCount) { await gear.evaluate(el => el.click()); clicked = true; }
  await page.waitForTimeout(1500);
  const report = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const body = document.querySelector('.dsh-vd-modalBody');
    const settings = document.querySelector('.dsh-vd-settings');
    const pause = document.querySelector('.dsh-vd-pauseRow');
    const sections = [...document.querySelectorAll('.dsh-vd-settings > section')].map(el => {
      const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const small = [...document.querySelectorAll('.dsh-vd-settings button, .dsh-vd-settings select, .dsh-vd-settings input, .dsh-vd-modalClose')]
      .map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, type: el.type || '', h: Math.round(r.height), w: Math.round(r.width) }; })
      .filter(i => i.h > 0 && i.h < 40);
    return {
      dialog: box(dlg), body: box(body), settings: box(settings), pauseRow: box(pause),
      bodyScrollable: body ? body.scrollHeight > body.clientHeight + 2 : false,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      sections, under40: small.slice(0, 8),
      hasPauseLabel: !!pause && /毫秒/.test(pause.textContent || ''),
      titleText: dlg ? (dlg.getAttribute('aria-label') || '') : '',
      columns: sections.map(s => s.w),
    };
  });
  console.log(JSON.stringify({ gearCount, clicked, report }, null, 1));
  await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/04-settings-sheet.png' });
  await page.evaluate(() => { const b = document.querySelector('.dsh-vd-modalBody'); if (b) b.scrollTop = 520; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'D:/DSHwork/dsh-voice-dialog/test/.mobile/05-settings-sheet-scrolled.png' });
  await browser.close();
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });