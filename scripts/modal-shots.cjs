/**
 * Screenshots of the in-game pause menu and settings panel at the five reference viewports (needs `npm run dev` on :5199).
 *   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node scripts/modal-shots.cjs OUT_DIR
 */
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const out = process.argv[2] || '.';
const base = process.env.URL || 'http://127.0.0.1:5199/';
const sizes = ['390x844', '844x390', '768x1024', '1280x720', '1920x1080'];
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--disable-vulkan-surface'] });
  for (const size of sizes) {
    const [w, h] = size.split('x').map(Number);
    const touch = Math.min(w, h) < 800;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    await page.goto(base + '?quality=low&seed=12');
    await page.waitForFunction(() => window.__audioDebug, null, { timeout: 90000 });
    await page.waitForTimeout(6000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${size}_pause.png` });
    const btn = page.getByText('Settings', { exact: true }).first();
    await btn.click().catch(() => {});
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${size}_settings_top.png` });
    await page.evaluate(() => { const p = document.querySelector('.cb-ui.modal .cb-panel'); if (p) p.scrollTop = p.scrollHeight; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${size}_settings_bottom.png` });
    const fits = await page.evaluate(() => { const p = document.querySelector('.cb-ui.modal .cb-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrolls: p.scrollHeight > p.clientHeight }; });
    console.log(size, JSON.stringify(fits));
    await ctx.close();
  }
  await browser.close();
})();
