/**
 * Visual review screenshots in a real headed Chrome on the real GPU (same launcher as tools/perf), for art-direction passes and A/B checks.
 *
 *   npx tsx tools/visual/look.ts --out DIR [--mode static|play] [--tod day,dusk,night] [--quality high] [--seed 15] [--size 1920x1080]
 *                                [--emu 390x844@3] [--at 38] [--cams pitchcam,wide,...] [--every 2.5] [--count 40] [--speed 1]
 *                                [--extra "k=v&k2"] [--no-build] [--url http://host/path/] [--sheet]
 *
 * static: the game runs with a fixed 1/60 s step to game time `--at` (deterministic, so two builds show the same frame), is paused, and every camera
 *         in `--cams` (CAMS below, or a `name:px/py/pz:tx/ty/tz:fov` spec) is shot for every time of day.
 * play:   the auto director runs the game (B-roll, replays, cards) and a picture is taken every `--every` seconds of game time (the sim is paused for it);
 *         the file name carries the director's shot.
 * --dist DIR serves another build (a saved copy of an older dist/) for before / after pictures.
 * --sheet writes a labelled contact sheet (`_sheet.jpg`, ImageMagick montage) next to the shots.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { apertureFor } from '../../src/engine/autofocus';
import { ROOT, applyDesktopViewport, applyEmulation, build, launchChrome, sleep, startPreview, systemLoad } from '../perf/lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);

type V3 = [number, number, number];
/** named static cameras: position, target, vertical fov (deg); `face:<role>` frames that player's face */
export const CAMS: Record<string, { p: V3; t: V3; fov: number; face?: string; slab?: number; crowd?: number; dugout?: number }> = {
  pitchcam: { p: [-2.6, 10.5, 121], t: [0, 1.4, 4], fov: 9, slab: 5 },
  wide: { p: [0, 28, -45], t: [0, 3, 45], fov: 42 },
  follow: { p: [0, 17, -26], t: [0, 6, 70], fov: 38 },
  stadium: { p: [0, 32, 150], t: [0, 18, -20], fov: 55 },
  aerial: { p: [60, 95, -70], t: [0, 0, 50], fov: 50 },
  batterface: { p: [0, 0, 0], t: [0, 0, 0], fov: 26, face: 'batter' },
  pitcherface: { p: [0, 0, 0], t: [0, 0, 0], fov: 26, face: 'pitcher' },
  pitchermouth: { p: [0, 0, 0], t: [0, 0, 0], fov: 8, face: 'pitcher' },
  battermouth: { p: [0, 0, 0], t: [0, 0, 0], fov: 8, face: 'batter' },
  catcher: { p: [-4, 1.4, 4], t: [0, 0.8, -0.6], fov: 30, slab: 2 },
  mound: { p: [6, 2.2, 12], t: [0, 0.8, 18.4], fov: 34, slab: 4 },
  plate: { p: [2.5, 1.5, 3], t: [0, 0.1, 0], fov: 40, slab: 3 },
  firstbase: { p: [-14, 2.0, 12], t: [-19.4, 0.5, 19.4], fov: 40, slab: 5 },
  outfield: { p: [-12, 2.2, 60], t: [-30, 1.0, 90], fov: 38, slab: 12 },
  wall: { p: [-20, 3, 85], t: [-40, 2, 110], fov: 45, slab: 15 },
  foulpole: { p: [-30, 4, 60], t: [-71, 10, 71], fov: 40 },
  crowd0: { p: [0, 0, 0], t: [0, 0, 0], fov: 30, crowd: 0, slab: 7 },
  crowd2: { p: [0, 0, 0], t: [0, 0, 0], fov: 30, crowd: 2, slab: 7 },
  crowdfar: { p: [-10, 4, 30], t: [-60, 14, 0], fov: 40 },
  dugout: { p: [0, 0, 0], t: [0, 0, 0], fov: 34, dugout: 0, slab: 4 },
  behindhome: { p: [0, 2.2, -14], t: [0, 1.4, 18], fov: 30, slab: 6 },
  lights: { p: [0, 10, 20], t: [-90, 45, 40], fov: 50 },
};

const out = path.resolve(opt('out', path.join(ROOT, 'tools/visual/out', new Date().toISOString().replace(/[:.]/g, '-'))));
const mode = opt('mode', 'static');
const tods = opt('tod', 'day').split(',');
const quality = opt('quality', 'high');
const seed = opt('seed', '15');
const at = +opt('at', '38');
const every = +opt('every', '2.5');
const count = +opt('count', '40');
const speed = +opt('speed', '1');
const extra = opt('extra', '');
const size = opt('size', '1920x1080');
const emu = opt('emu', '');

function camSpecs(): ({ name: string; p: V3; t: V3; fov: number; face?: string; slab?: number; crowd?: number; dugout?: number; aperture?: number })[] {
  const list = opt('cams', 'pitchcam,wide,follow,stadium,aerial,batterface,pitcherface,catcher,mound,plate,wall,crowd0,crowd2,crowdfar,dugout,behindhome');
  return list.split(',').map((s) => {
    // `id:<player id>`: that player's face from the front, telephoto
    if (s.startsWith('id:')) return { name: s.replace(':', '-'), p: [0, 0, 0] as V3, t: [0, 0, 0] as V3, fov: 9, face: s.slice(3), aperture: 1.2 };
    if (CAMS[s]) {
      const c = CAMS[s];
      const d = Math.hypot(c.p[0] - c.t[0], c.p[1] - c.t[1], c.p[2] - c.t[2]);
      // the director's deep-focus rule: no slab = everything sharp (wide shots), else the aperture that keeps the slab sharp
      return { name: s, ...c, aperture: c.face ? 1.2 : c.slab ? apertureFor(c.crowd !== undefined || c.dugout !== undefined ? 18 : d, c.slab) : 0 };
    }
    const [name, p, t, fov] = s.split(':');
    return { name, p: p.split('/').map(Number) as V3, t: t.split('/').map(Number) as V3, fov: +fov };
  });
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  let url = opt('url', '');
  let stop = () => {};
  if (!url) {
    // --dist DIR: serve another build (e.g. a saved copy of the old dist/ for a before / after)
    const dist = opt('dist', '');
    if (!dist) build(flag('no-build'));
    const s = await startPreview(undefined, dist || 'dist');
    url = s.url;
    stop = s.stop;
  }
  const [w, h] = size.split('x').map(Number);
  const chrome = await launchChrome({ width: w, height: h });
  const load = systemLoad();
  try {
    const page = await chrome.ctx.newPage();
    const cdp = await chrome.ctx.newCDPSession(page);
    if (emu) {
      const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(emu)!;
      await applyEmulation(cdp, { width: +m[1], height: +m[2], dpr: +m[3], cpu: 1 });
    } else await applyDesktopViewport(cdp, w, h);
    await page.addInitScript('window.__name = (f) => f;');
    page.on('console', (m) => m.type() === 'error' && console.log('   [page]', m.text().slice(0, 240)));
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 240)));
    const q = new URLSearchParams(mode === 'ui' ? { menu: '1', noaudio: '1', seed, quality, tod: tods[0] } : { autostart: '1', noaudio: '1', seed, tempo: opt('tempo', 'standard'), quality, tod: tods[0] });
    for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
    const tag = emu ? emu.replace('@', '_') : size;
    if (mode === 'ui') {
      // loading screen, title, setup, settings, the game's HUD, the controls drawer and the pause menu (like scripts/ui-shots.py)
      await page.goto(`${url}?${q}`, { waitUntil: 'commit' });
      const shot = async (n: string) => {
        const d = ((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 })) as { data: string }).data;
        fs.writeFileSync(path.join(out, `${tag}-${n}.jpg`), Buffer.from(d, 'base64'));
        console.log('   ', `${tag}-${n}.jpg`);
      };
      await sleep(1500);
      await shot('0load');
      await page.waitForFunction(() => !!(window as unknown as { __boot?: { tti: number } }).__boot?.tti, null, { timeout: 240000 });
      await sleep(1500);
      await shot('1title');
      await page.getByText('Game Setup').click();
      await sleep(800);
      await shot('2setup');
      await page.keyboard.press('Escape');
      await sleep(600);
      await page.getByText('Settings', { exact: true }).click();
      await sleep(800);
      await shot('3settings');
      await page.keyboard.press('Escape');
      await sleep(600);
      await page.getByRole('button', { name: 'Start Game' }).first().click();
      for (let i = 0; i < 4; i++) {
        await sleep(7000);
        await shot(`4play${i}`);
      }
      if (emu) {
        const pt = { x: +emu.split('x')[0] / 2, y: 200 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      else {
        await page.mouse.move(w / 2, h / 3);
        await page.mouse.move(w / 2 + 5, h / 3 + 5);
      }
      await sleep(700);
      await shot('5controls');
      await page.keyboard.press('Escape');
      await sleep(900);
      await shot('6pause');
      await page.close();
      await chrome.close();
      stop();
      return;
    }
    await page.goto(`${url}?${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as unknown as { __boot?: { tti: number } }).__boot?.tti, null, { timeout: 240000 });
    const gpu = await page.evaluate(() => {
      const e = (window as any).engine;
      const gl = e.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    console.log(`[look] ${gpu} | gpu load: ${load.gpu} | loadavg ${load.loadavg.join(' ')}`);
    const shoot = async (file: string) => {
      const d = ((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 })) as { data: string }).data;
      fs.writeFileSync(path.join(out, file), Buffer.from(d, 'base64'));
      console.log('   ', file);
    };
    const frames = (n: number) => page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

    if (mode === 'static') {
      // deterministic: fixed step, no adaptive scale; run to the requested game time, then pause
      await page.evaluate((target) => new Promise<void>((res) => {
        const e = (window as any).engine;
        e.fixedDt = 1 / 60;
        e.sim.stepBudgetMs = 1e9;
        e.adaptive.enabled = false;
        e.adaptive.scale = 1;
        e.resize();
        e.director.replaysEnabled = false;
        e.director.brollEnabled = false;
        const f = () => (e.liveState.time >= target ? ((e.sim.paused = true), res()) : requestAnimationFrame(f));
        f();
      }), at);
      const ev = opt('eval', '');
      for (const tod of tods) {
        await page.evaluate((t) => (window as any).engine.setTimeOfDay(t), tod);
        // --eval: script run in the page before the shots (e.g. "engine.stadium.crowd.startWave()"), then --settle seconds of frames
        if (ev) {
          await page.evaluate(ev);
          await frames(Math.round(+opt('settle', '0') * 60));
        }
        await frames(20);
        for (const c of camSpecs()) {
          await page.evaluate((c) => {
            const e = (window as any).engine;
            const V = e.camera.position.constructor;
            const cam = { pos: new V(...c.p), tgt: new V(...c.t), fov: c.fov, aperture: c.aperture ?? 0 };
            const lm = c.crowd !== undefined ? e.director.landmarks.crowdShots?.[c.crowd] : c.dugout !== undefined ? e.director.dugoutShots?.[c.dugout] : null;
            if (lm) { cam.pos.copy(lm.pos); cam.tgt.copy(lm.target); cam.aperture = c.aperture ?? 0; }
            if (c.face) {
              const p = e.liveState.players.find((q: any) => q.role === c.face || q.id === c.face);
              const f = new V();
              if (p && e.players.faceOf(p.id, f)) {
                cam.tgt.copy(f);
                if (p.id === c.face) {
                  // in front of the face: the head bone's forward axis (+Z in the rig)
                  const pu = e.players.puppets.get(p.id);
                  const head = pu?.bones?.Head;
                  const fwd = new V(0, 0, 1);
                  if (head) fwd.transformDirection(head.matrixWorld);
                  if (pu?.mirrored) fwd.x *= 1;
                  fwd.y = 0.05;
                  cam.pos.copy(f).addScaledVector(fwd.normalize(), 3);
                } else cam.pos.copy(f).add(c.face === 'batter' ? new V(0.7, 0.15, 2.6) : new V(0.5, 0.15, -2.6));
                cam.aperture = 1.2;
              }
            }
            e.director.bench = cam;
          }, c);
          await frames(30); // autofocus / exposure / temporal effects settle
          await shoot(`${tod}-${quality}-${c.name}.jpg`);
        }
      }
    } else {
      await page.evaluate((s) => { const e = (window as any).engine; e.sim.speed = s; }, speed);
      let next = (await page.evaluate(() => (window as any).engine.liveState.time)) + every;
      for (let i = 0; i < count; i++) {
        const info = await page.evaluate((target) => new Promise<{ t: number; shot: string; broll: string }>((res) => {
          const e = (window as any).engine;
          const f = () => {
            if (e.liveState.time >= target) {
              e.sim.paused = true;
              const d = e.director as any;
              res({ t: e.liveState.time, shot: d.shot, broll: d.broll?.shot?.kind ?? '' });
            } else requestAnimationFrame(f);
          };
          f();
        }), next);
        await frames(3);
        await shoot(`${tods[0]}-${String(i).padStart(3, '0')}-t${info.t.toFixed(0)}-${info.shot}${info.broll ? '-' + info.broll : ''}.jpg`);
        await page.evaluate(() => { (window as any).engine.sim.paused = false; });
        next = info.t + every;
      }
    }
    await page.close();
  } finally {
    await chrome.close();
    stop();
  }
  if (flag('sheet')) {
    const files = fs.readdirSync(out).filter((f) => f.endsWith('.jpg') && !f.startsWith('_')).sort();
    execFileSync('montage', ['-label', '%t', '-pointsize', '18', '-geometry', '640x360+4+4', '-tile', '4x', '-background', '#222', '-fill', 'white', ...files.map((f) => path.join(out, f)), path.join(out, '_sheet.jpg')]);
    console.log('[look] sheet', path.join(out, '_sheet.jpg'));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
