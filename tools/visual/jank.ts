/**
 * Jank probe: run the real game (production build, headed Chrome on the real GPU, fixed 1/60 s step) to given game times, dump what every
 * puppet is doing and frame chosen players' whole bodies, so a glitch seen in the broadcast can be pinned to sim data vs engine vs asset.
 *
 *   npx tsx tools/visual/jank.ts --out DIR --at 6,26 [--seed 15] [--cams body:ump-1b,body:catcher:2.5,face:batter,<look.ts spec>]
 *                                [--dump] [--eval "<js run at every stop, result printed>"] [--until "<js condition>"] [--variants "js1;;js2"]
 *                                [--no-build] [--dist DIR] [--quality high]
 *
 * cams: `body:<id|role>[:dist[:yawDeg]]` = the whole player from in front (yaw rotates around him), `face:<id|role>[:dist]` = his head,
 *       `hand:<id|role>[:bone[:dist]]` = a bone (default RightHand) from in front, or any `name:px/py/pz:tx/ty/tz:fov` spec.
 * --dump writes `<t>-state.json`: id, role, position, velocity, facing, the sim's hint and the clip the puppet actually plays.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, applyDesktopViewport, build, launchChrome, startPreview } from '../perf/lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);
const out = path.resolve(opt('out', path.join(ROOT, 'tools/visual/out/jank')));
const times = opt('at', '6').split(',').map(Number);
const cams = opt('cams', '').split(',').filter(Boolean);
const [w, h] = opt('size', '1600x900').split('x').map(Number);

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const dist = opt('dist', '');
  if (!dist) build(flag('no-build'));
  const s = await startPreview(undefined, dist || 'dist');
  const chrome = await launchChrome({ width: w, height: h });
  try {
    const page = await chrome.ctx.newPage();
    const cdp = await chrome.ctx.newCDPSession(page);
    await applyDesktopViewport(cdp, w, h);
    await page.addInitScript('window.__name = (f) => f;');
    page.on('console', (m) => (m.type() === 'error' || m.text().startsWith('[jank]')) && console.log('   [page]', m.text().slice(0, 300)));
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 300)));
    const q = new URLSearchParams({ autostart: '1', noaudio: '1', seed: opt('seed', '15'), tempo: opt('tempo', 'standard'), quality: opt('quality', 'high'), tod: opt('tod', 'day') });
    for (const [k, v] of new URLSearchParams(opt('extra', ''))) q.set(k, v);
    await page.goto(`${s.url}?${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__boot?.tti, null, { timeout: 240000 });
    await page.evaluate((broll) => {
      const e = (window as any).engine;
      e.fixedDt = 1 / 60;
      e.sim.stepBudgetMs = 1e9;
      e.adaptive.enabled = false;
      e.adaptive.scale = 1;
      e.resize();
      e.director.replaysEnabled = false;
      e.director.brollEnabled = broll;
    }, !flag('nobroll'));
    const frames = (n: number) => page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    for (const t of times) {
      // --until "<js expression>": after time t, keep going until it is true (e.g. "engine.sim.sim._world.phase === 'windup'")
      await page.evaluate(([target, until]) => new Promise<void>((res) => {
        const e = (window as any).engine;
        e.sim.paused = false;
        e.director.bench = null;
        const cond = until ? new Function(`return (${until});`) : () => true;
        const f = () => (e.liveState.time >= target && (cond() || e.liveState.time > target + 120) ? ((e.sim.paused = true), res()) : requestAnimationFrame(f));
        f();
      }), [t, opt('until', '')] as [number, string]);
      const now = await page.evaluate(() => (window as any).engine.liveState.time as number);
      const tag = `t${now.toFixed(1).padStart(6, '0')}`;
      if (flag('dump')) {
        const st = await page.evaluate(() => {
          const e = (window as any).engine;
          const pm = e.players;
          return e.liveState.players.map((p: any) => {
            const pu = pm.puppets.get(p.id);
            return { id: p.id, role: p.role, pos: [+p.pos.x.toFixed(2), +p.pos.y.toFixed(2), +p.pos.z.toFixed(2)], vel: +Math.hypot(p.vel.x, p.vel.z).toFixed(2), facing: +p.facing.toFixed(2), anim: p.anim, clip: pu?.currentName ?? null };
          });
        });
        fs.writeFileSync(path.join(out, `${tag}-state.json`), JSON.stringify(st, null, 1));
      }
      const ev = opt('eval', '');
      if (ev) console.log(`   [${tag}] eval:`, JSON.stringify(await page.evaluate(ev)));
      await frames(4);
      // --variants "js1;;js2": run each script (e.g. show a different hand mesh) and shoot every camera again, file names suffixed v0, v1, ...
      const variants = opt('variants', '').split(';;').filter(Boolean);
      for (let vi = 0; vi < Math.max(1, variants.length); vi++) {
      if (variants.length) console.log(`   [${tag}] v${vi}:`, JSON.stringify(await page.evaluate(variants[vi])));
      for (const c of cams) {
        const ok = await page.evaluate((spec) => {
          const e = (window as any).engine;
          const V = e.camera.position.constructor;
          const parts = spec.split(':');
          const find = (who: string) => e.liveState.players.find((q: any) => q.id === who) ?? e.liveState.players.find((q: any) => q.role === who);
          let cam: any = null;
          if (parts[0] === 'body' || parts[0] === 'face' || parts[0] === 'hand') {
            const p = find(parts[1]);
            if (!p) return false;
            const pu = e.players.puppets.get(p.id);
            const yaw = p.facing + ((parts[0] === 'body' ? +(parts[3] ?? 0) : 0) * Math.PI) / 180;
            const fwd = new V(Math.sin(yaw), 0, Math.cos(yaw));
            const tgt = new V(p.pos.x, p.pos.y + 0.95, p.pos.z);
            let dist = +(parts[2] ?? 4);
            if (parts[0] === 'face') {
              e.players.faceOf(p.id, tgt);
              dist = +(parts[2] ?? 1.6);
            }
            if (parts[0] === 'hand') {
              const b = pu?.bones?.[parts[2] || 'RightHand'];
              if (b) b.getWorldPosition(tgt);
              dist = +(parts[3] ?? 0.9);
            }
            const pos = tgt.clone().addScaledVector(fwd, dist);
            pos.y += parts[0] === 'body' ? 0.25 : 0.05;
            const span = parts[0] === 'body' ? 2.3 : parts[0] === 'face' ? 0.45 : 0.35;
            cam = { pos, tgt, fov: (2 * Math.atan(span / 2 / dist) * 180) / Math.PI, aperture: 0 };
          } else {
            const [, pp, tt, fov] = parts;
            cam = { pos: new V(...pp.split('/').map(Number)), tgt: new V(...tt.split('/').map(Number)), fov: +fov, aperture: 0 };
          }
          e.director.bench = cam;
          return true;
        }, c);
        if (!ok) {
          console.log(`   ${tag} ${c}: no such player`);
          continue;
        }
        await frames(12);
        const d = ((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 })) as { data: string }).data;
        const file = `${tag}-${c.replace(/[:/]/g, '_')}${variants.length ? `-v${vi}` : ''}.jpg`;
        fs.writeFileSync(path.join(out, file), Buffer.from(d, 'base64'));
        console.log('   ', file);
      }
      }
    }
  } finally {
    await chrome.close();
    s.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
