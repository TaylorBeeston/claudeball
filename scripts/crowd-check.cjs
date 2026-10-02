/**
 * Headless-Chrome check of the crowd in the real app (needs `npm run dev` and Playwright 1.58 via PLAYWRIGHT_DIR): plays a game at 1x,
 * samples the crowd level and the reactions the model asked for, and prints what was played, the cost of the audio tick and any errors.
 *   URL=http://127.0.0.1:5199/ PLAYWRIGHT_DIR=.../node_modules/playwright node scripts/crowd-check.cjs 120 [lowpower]
 */
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const secs = Number(process.argv[2] || 90);
const base = process.env.URL || 'http://127.0.0.1:5199/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--disable-vulkan-surface', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/\[elbow\]|content-length|parallel_shader|onnxruntime|Failed to execute 'put'/.test(m.text())) errs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(base + '?quality=low&seed=12' + (process.argv[3] === 'lowpower' ? '&lowpower=1' : ''));
  await page.waitForFunction(() => window.__audioDebug, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.mouse.click(640, 360);
  const series = [];
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    await page.waitForTimeout(500);
    series.push(await page.evaluate(() => { const d = window.__audioDebug; const c = d.controller; return { t: Math.round(performance.now() / 100) / 10, level: +c.crowd.level.toFixed(2), energy: +c.crowd.energy.toFixed(2), ambience: c.ambience.gains, voices: c.mixer.voiceCount, tickMs: +d.controller.debug.tickMs.toFixed(3), rms: +c.mixer.level().rms.toFixed(3) }; }));
  }
  const out = await page.evaluate(() => { const c = window.__audioDebug.controller; return { music: { tracks: c.music.manifest.tracks.length, stats: c.music.stats, log: c.music.director.log.slice(-20) }, fx: c.fx.played.slice(-10), played: Object.fromEntries(Object.entries(c.mixer.played).filter(([k]) => k.startsWith('crowd:'))), log: c.crowd.log.slice(-25), lowPower: c.lowPower, ctx: c.mixer.state, ready: c.mixer.ready }; });
  const maxLevel = Math.max(...series.map((s) => s.level));
  console.log(JSON.stringify({ lowPower: out.lowPower, ctx: out.ctx, ready: out.ready, maxLevel, minLevel: Math.min(...series.map((s) => s.level)), maxVoices: Math.max(...series.map((s) => s.voices)), tickMsAvg: +(series.reduce((a, s) => a + s.tickMs, 0) / series.length).toFixed(3), played: out.played }, null, 1));
  console.log('music:', JSON.stringify(out.music), 'fx:', JSON.stringify(out.fx));
  console.log('last reactions:', JSON.stringify(out.log));
  console.log('level timeline:', series.filter((_, i) => i % 6 === 0).map((s) => `${s.t}:${s.level}/${s.ambience.roar.toFixed(2)}`).join(' '));
  console.log('ERRORS', JSON.stringify(errs.slice(0, 10)));
  await browser.close();
})();
