/**
 * The crowd atlas (see src/engine/crowdAtlas.ts).
 *   npx tsx tools/visual/atlas.ts OUT.png [--no-build] [--poses JSON]   dump the atlas the engine renders for seed 15's teams (dev)
 *   npx tsx tools/visual/atlas.ts --bake [--no-build]                   render the team-neutral atlas + mask from the current player model and write
 *                                                                        public/crowd/crowd_atlas.webp (2048), crowd_atlas_1k.webp, crowd_mask.webp (1024)
 *                                                                        and crowd_atlas.json. Re-run after the player model changes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, build, launchChrome, startPreview } from '../perf/lib';

const argv = process.argv.slice(2);
const bake = argv.includes('--bake');
const out = bake ? '' : argv[0] ?? 'atlas.png';
async function main() {
  build(argv.includes('--no-build'));
  const s = await startPreview();
  const chrome = await launchChrome({});
  try {
    const page = await chrome.ctx.newPage();
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('   [page]', m.text().slice(0, 400)));
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 400)));
    await page.goto(`${s.url}?autostart&noaudio&seed=15&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__boot?.tti, null, { timeout: 240000 });
    const poses = argv.includes('--poses') ? JSON.parse(argv[argv.indexOf('--poses') + 1]) : null;
    const r = await page.evaluate(async ({ poses, bake }) => {
      if (poses) (globalThis as any).__crowdPoses = poses;
      const e = (window as any).engine;
      const t0 = performance.now();
      const ok = await e.refreshCrowdAtlas({ render: true, neutral: bake });
      const a = e.crowdAtlas;
      return { ok, ms: performance.now() - t0, color: e.crowdAtlasPng('color'), mask: bake ? e.crowdAtlasPng('mask') : null, layout: a && { cols: a.cols, rows: a.rows, people: a.people, poses: a.poses, cellU: a.cellU, cellV: a.cellV } };
    }, { poses, bake });
    console.log(`atlas ${r.ok} ${Math.round(r.ms)} ms`);
    if (!r.color) throw new Error('no atlas');
    if (!bake) {
      fs.writeFileSync(out, Buffer.from(r.color.split(',')[1], 'base64'));
      console.log('wrote', out);
      return;
    }
    const dir = path.join(ROOT, 'public/crowd');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbatlas-'));
    fs.writeFileSync(path.join(tmp, 'c.png'), Buffer.from(r.color.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(tmp, 'm.png'), Buffer.from(r.mask!.split(',')[1], 'base64'));
    const magick = (...a: string[]) => execFileSync('magick', a, { stdio: 'inherit' });
    magick(path.join(tmp, 'c.png'), '-define', 'webp:alpha-quality=100', '-quality', '90', path.join(dir, 'crowd_atlas.webp'));
    magick(path.join(tmp, 'c.png'), '-resize', '1024x1024', '-define', 'webp:alpha-quality=100', '-quality', '90', path.join(dir, 'crowd_atlas_1k.webp'));
    magick(path.join(tmp, 'm.png'), '-alpha', 'off', '-colorspace', 'gray', '-resize', '1024x1024', '-quality', '90', path.join(dir, 'crowd_mask.webp'));
    fs.writeFileSync(path.join(dir, 'crowd_atlas.json'), JSON.stringify(r.layout, null, 1) + '\n');
    for (const f of fs.readdirSync(dir)) console.log(`  public/crowd/${f}  ${(fs.statSync(path.join(dir, f)).size / 1024).toFixed(0)} KB`);
  } finally {
    await chrome.close();
    s.stop();
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
