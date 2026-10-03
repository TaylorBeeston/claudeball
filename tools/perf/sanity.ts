/**
 * Puppet size sanity: loads the bench page, and every few frames measures the current world-space bounding box of each puppet's body / clothing meshes
 * (skinning + morph targets + the simplified-geometry swap all included), keeping the largest seen per puppet. A puppet whose clothes balloon shows up as a
 * box far beyond a person's. Exits 1 when any box is out of range. Used as a regression guard (`npm run perf:sanity`) and for bisecting with the A/B flags.
 *
 *   npx tsx tools/perf/sanity.ts [--scenes pitchcam,wide,follow,faces,crowd] [--presets medium,high] [--secs 12] [--extra "nolodgeo"] [--prod] [--no-build]
 *   --prod   build with CB_BASE=/claudeball/ into dist/ (rebuild without it afterwards for the other tools) and serve under that sub-path (what GitHub Pages serves)
 */
import { execFileSync } from 'node:child_process';
import { ROOT, applyDesktopViewport, applyEmulation, build, launchChrome, sleep, startPreview } from './lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const scenes = opt('scenes', 'pitchcam,wide,follow,faces,crowd').split(',');
const presets = opt('presets', 'medium').split(',');
const secs = +opt('secs', '10');
const extra = opt('extra', '');
const prod = argv.includes('--prod');
const play = argv.includes('--play'); // a normal game with the auto director at speed 3 instead of the bench scenes

// limits for one body / clothing mesh's bounding box (metres): a standing or running person incl. arms and a bat swing
const LIMIT = { height: 2.6, width: 2.4, depth: 2.4 };

async function main() {
  let url: string;
  let stop = () => {};
  if (prod) {
    process.env.CB_BASE = '/claudeball/'; // the preview server must see the same base as the build
    if (!argv.includes('--no-build')) execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CB_BASE: '/claudeball/' } });
    const s = await startPreview(undefined, 'dist');
    url = `${s.url}claudeball/`;
    stop = s.stop;
  } else {
    build(argv.includes('--no-build'));
    const s = await startPreview();
    url = s.url;
    stop = s.stop;
  }
  const chrome = await launchChrome({});
  let bad = 0;
  try {
    for (const preset of presets) {
      const page = await chrome.ctx.newPage();
      const cdp = await chrome.ctx.newCDPSession(page);
      const emu = opt('emu', '');
      if (emu) { const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(emu)!; await applyEmulation(cdp, { width: +m[1], height: +m[2], dpr: +m[3], cpu: +opt('cpu', '2') }); } else await applyDesktopViewport(cdp, 1920, 1080);
      await page.addInitScript('window.__name = (f) => f;');
      page.on('console', (m) => (m.type() === 'error' || /\[boot\]/.test(m.text())) && console.log('   [page]', m.text().slice(0, 220)));
      page.on('response', (r) => r.status() >= 400 && console.log('   [http', r.status() + ']', r.url()));
      page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 220)));
      const q = new URLSearchParams({ autostart: '1', noaudio: '1', seed: '15', quality: preset, bench: '1', scenes: scenes.join(','), frames: '100000', warm: '30' });
      if (play) { q.delete('bench'); q.delete('scenes'); q.delete('frames'); q.delete('warm'); }
      for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
      await page.goto(`${url}?${q}`, { waitUntil: 'load' });
      await page.waitForFunction(() => (window as unknown as { __boot?: { tti: number }; __bench?: unknown }).__bench !== undefined || !!(window as unknown as { __boot?: { tti: number } }).__boot?.tti, null, { timeout: 240000 });
      if (play) await page.evaluate(() => { (window as unknown as { engine: { sim: { speed: number } } }).engine.sim.speed = 4; });
      // measure inside the page every 4th frame; per puppet keep the largest box and when / at which tier it happened
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const e = w.engine as { players: { puppets: Map<string, Record<string, unknown>> }; liveState: { time: number } };
        const names = /^(Jersey|Pants|Body_Skin|Head|Shorts|Socks|Undershirt|Gear_Cap|Gear_Helmet)/;
        const worst: Record<string, { h: number; w: number; d: number; mesh: string; tier: number; t: number; role: string }> = {};
        w.__sanity = worst;
        let n = 0;
        const loop = () => {
          requestAnimationFrame(loop);
          if (++n % 4) return;
          for (const [id, p] of e.players.puppets) {
            const meshes = p.meshes as { name: string; visible: boolean; layers: { mask: number }; isSkinnedMesh?: boolean; computeBoundingBox?: () => void; boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null }[] | undefined;
            if (!meshes) continue;
            for (const m of meshes) {
              if (!names.test(m.name) || !m.visible || m.layers.mask !== 1 || !m.isSkinnedMesh || !m.computeBoundingBox) continue;
              m.computeBoundingBox();
              const b = m.boundingBox;
              if (!b) continue;
              const h = b.max.y - b.min.y, wd = b.max.x - b.min.x, d = b.max.z - b.min.z;
              const key = `${id}:${m.name}`;
              const cur = worst[key];
              if (!cur || Math.max(h, wd, d) > Math.max(cur.h, cur.w, cur.d)) worst[key] = { h, w: wd, d, mesh: m.name, tier: p.lodTier as number, t: e.liveState.time, role: id };
            }
          }
        };
        loop();
      });
      const shotEvery = +opt('shots', '0');
      if (shotEvery > 0) {
        const fs = await import('node:fs');
        fs.mkdirSync(`${ROOT}/tools/perf/results/shots`, { recursive: true });
        for (let t = 0, i = 0; t < secs; t += shotEvery, i++) {
          await sleep(shotEvery * 1000);
          const d = ((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })) as { data: string }).data;
          fs.writeFileSync(`${ROOT}/tools/perf/results/shots/sanity-${String(i).padStart(3, '0')}.jpg`, Buffer.from(d, 'base64'));
        }
      } else await sleep(secs * 1000);
      const worst = (await page.evaluate(() => (window as unknown as { __sanity: Record<string, unknown> }).__sanity)) as Record<string, { h: number; w: number; d: number; mesh: string; tier: number; t: number }>;
      const rows = Object.entries(worst).sort((a, b) => Math.max(b[1].h, b[1].w, b[1].d) - Math.max(a[1].h, a[1].w, a[1].d));
      const out = rows.filter(([, v]) => v.h > LIMIT.height || v.w > LIMIT.width || v.d > LIMIT.depth);
      console.log(`[sanity] ${preset}${prod ? ' (prod build, /claudeball/)' : ''}${extra ? ` +${extra}` : ''}: ${rows.length} meshes watched, ${out.length} out of range; largest boxes:`);
      for (const [k, v] of rows.slice(0, 6)) console.log(`   ${k.padEnd(28)} ${v.h.toFixed(2)} x ${v.w.toFixed(2)} x ${v.d.toFixed(2)} m  tier ${v.tier}  game t ${v.t.toFixed(1)}`);
      bad += out.length;
      await page.close();
    }
  } finally {
    await chrome.close();
    stop();
  }
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
