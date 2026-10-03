/** Dump the crowd atlas the engine renders (dev): npx tsx tools/visual/atlas.ts OUT.png [--no-build] [--quality high] */
import fs from 'node:fs';
import { build, launchChrome, startPreview } from '../perf/lib';

const out = process.argv[2] ?? 'atlas.png';
async function main() {
  build(process.argv.includes('--no-build'));
  const s = await startPreview();
  const chrome = await launchChrome({});
  try {
    const page = await chrome.ctx.newPage();
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('   [page]', m.text().slice(0, 400)));
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 400)));
    await page.goto(`${s.url}?autostart&noaudio&seed=15&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__boot?.tti, null, { timeout: 240000 });
    const poses = process.argv.includes('--poses') ? JSON.parse(process.argv[process.argv.indexOf('--poses') + 1]) : null;
    const url = await page.evaluate((poses) => {
      if (poses) (globalThis as any).__crowdPoses = poses;
      const e = (window as any).engine;
      const t0 = performance.now();
      e.crowdAtlas = null;
      const ok = e.refreshCrowdAtlas();
      console.error('atlas', ok, (performance.now() - t0).toFixed(0), 'ms');
      return e.crowdAtlasPng();
    }, poses);
    if (url) fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote', out);
  } finally {
    await chrome.close();
    s.stop();
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
