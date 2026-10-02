/**
 * Headless-Chrome check of the audio layer in the real app (needs `npm run dev` on :5199 and Playwright 1.58 reachable through
 * PLAYWRIGHT_DIR, e.g. `npm i playwright@1.58.2` in a scratch folder).
 *   PLAYWRIGHT_DIR=/path/to/node_modules/playwright node scripts/audio-check.cjs speech 120     fake browser voices: prints what the booth said
 *   PLAYWRIGHT_DIR=... node scripts/audio-check.cjs hd 120                                      HD voices (WebGPU): measures PA/booth overlap, real-time factor
 * Prints JSON-ish summaries; console errors from audio are listed at the end.
 */
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const mode = process.argv[2] || 'speech';
const secs = Number(process.argv[3] || 90);
const base = process.env.URL || 'http://127.0.0.1:5199/';
(async () => {
  const flags = mode === 'hd' ? ['--enable-features=Vulkan', '--enable-unsafe-webgpu'] : [];
  const browser = await chromium.launch({ args: ['--use-angle=vulkan', ...flags, '--ignore-gpu-blocklist', '--disable-vulkan-surface', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/\[elbow\]|content-length|parallel_shader|onnxruntime|Failed to execute 'put'/.test(m.text())) errs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  if (mode === 'speech') {
    await page.addInitScript(() => {
      window.__spoken = [];
      const voices = [{ name: 'Fake David', lang: 'en-US' }, { name: 'Fake Zira', lang: 'en-US' }, { name: 'Fake Alex', lang: 'en-GB' }];
      let cur = null;
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => voices, speak(u) { const t = Math.round(performance.now()); const d = 300 + u.text.length * 45; window.__spoken.push({ t, d, text: u.text, voice: u.voice && u.voice.name, rate: u.rate, pitch: u.pitch, vol: u.volume }); cur = setTimeout(() => u.onend && u.onend(), d); }, cancel() { clearTimeout(cur); }, pause() {}, resume() {} } });
    });
  }
  await page.goto(base + '?quality=low&seed=12' + (process.env.QS || ''));
  await page.waitForFunction(() => window.__audioDebug, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.mouse.click(640, 360);
  await page.waitForTimeout(2000);
  if (mode === 'hd') {
    await page.evaluate(() => window.__audioDebug.controller.hdToggle());
    const t0 = Date.now();
    for (;;) {
      await page.waitForTimeout(2000);
      const st = await page.evaluate(() => window.__audioDebug.controller.hd.state);
      if (st === 'ready' || st === 'error' || Date.now() - t0 > 400000) { console.log('HD', st, Math.round((Date.now() - t0) / 1000) + 's'); break; }
    }
  }
  await page.evaluate(() => {
    window.__ov = [];
    setInterval(() => { const g = window.__audioDebug.controller.gate; window.__ov.push([Math.round(performance.now()), g.busy.field, g.busy.booth]); }, 50);
  });
  await page.waitForTimeout(secs * 1000);
  const out = await page.evaluate(() => {
    const d = window.__audioDebug;
    const ov = window.__ov;
    const both = ov.filter((x) => x[1] > 0 && x[2] > 0).length;
    return { state: d.state.booth, speech: d.state.speech, overlapSamples: both, samples: ov.length, speechLog: d.speechLog.slice(-8), spoken: window.__spoken && window.__spoken.slice(0, 400) };
  });
  console.log(JSON.stringify({ booth: out.state, speech: out.speech, overlap: `${out.overlapSamples}/${out.samples} samples had PA and booth active at once` }, null, 1));
  if (out.spoken) for (const x of out.spoken) console.log(`${(x.t / 1000).toFixed(1).padStart(6)}s ${String(x.voice).padEnd(10)} r${x.rate} p${x.pitch} v${(x.vol || 0).toFixed(2)}  ${x.text}`);
  console.log('ERRORS', JSON.stringify(errs.slice(0, 10)));
  await browser.close();
})();
