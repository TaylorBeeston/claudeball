/**
 * Per-frame body sanity probe: runs the real game (production build, headed Chrome, fixed 1/60 s step) and after every engine tick measures the chosen
 * puppets' skeletons: bone lengths vs rest (stretched / squashed bones), the joint rotations relative to the rest pose (elbow, knee, wrist, neck + head vs
 * the upper spine) as axis-angle in the rest frame, hand reach vs arm length, hand-in-head, the elbow's clearance from the torso, the IK weight and the clip.
 *
 *   npx tsx tools/visual/bodyprobe.ts --out DIR [--seconds 600] [--roles batter] [--seed 15] [--every 1] [--no-build] [--extra "k=v"]
 *
 * Writes DIR/samples.jsonl (one line per sampled frame and puppet) and prints a summary; `bodyprobe-report.ts`-style analysis is done offline from the file.
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
const out = path.resolve(opt('out', path.join(ROOT, 'tools/visual/out/bodyprobe')));

/** runs in the page: install the probe on `engine.tick` */
function install([roles, every]: [string[], number]) {
  const e = (window as any).engine;
  const V = e.camera.position.constructor;
  const Q = e.camera.quaternion.constructor;
  const M = e.camera.matrixWorld.constructor;
  const w = window as any;
  w.__probe = { lines: [] as string[], frame: 0 };
  const rest = new WeakMap<object, Map<string, any>>();
  const JOINTS: [string, string][] = [
    ['LeftForeArm', 'LeftArm'], ['RightForeArm', 'RightArm'], ['LeftHand', 'LeftForeArm'], ['RightHand', 'RightForeArm'],
    ['LeftLeg', 'LeftUpLeg'], ['RightLeg', 'RightUpLeg'], ['LeftArm', 'LeftShoulder'], ['RightArm', 'RightShoulder'], ['Neck', 'Spine2'], ['Head', 'Neck'], ['Spine2', 'Spine1'],
  ];
  const restOf = (pu: any) => {
    let r = rest.get(pu);
    if (r) return r;
    r = new Map();
    // rest local quaternions from the skin's bind matrices (world bind = inverse(boneInverse))
    const sk = pu.meshes.find((m: any) => m.isSkinnedMesh)?.skeleton;
    if (!sk) return r;
    const world = new Map<string, any>();
    sk.bones.forEach((b: any, i: number) => world.set(b.name.replace('mixamorig', '').replace(':', ''), new M().copy(sk.boneInverses[i]).invert()));
    for (const [c, p] of JOINTS) {
      const cw = world.get(c), pw = world.get(p);
      if (!cw || !pw) continue;
      const loc = new M().copy(pw).invert().multiply(cw);
      const q = new Q(), s = new V(), t = new V();
      loc.decompose(t, q, s);
      r.set(c, { q, len: t.length() });
    }
    rest.set(pu, r);
    return r;
  };
  const orig = e.tick.bind(e);
  e.tick = (dt: number, render?: boolean) => {
    orig(dt, render);
    const f = w.__probe.frame++;
    if (f % every) return;
    const st = e.liveState;
    for (const p of st.players) {
      if (!roles.includes(p.role)) continue;
      const pu = e.players.puppets.get(p.id);
      if (!pu || !pu.bones?.Head) continue;
      const R = restOf(pu);
      const B = pu.bones;
      const wp = (n: string) => B[n].getWorldPosition(new V());
      const rec: any = { t: +st.time.toFixed(3), id: p.id, hand: p.hand, anim: p.anim, clip: pu.currentName, ikW: +(pu.ikW ?? 0).toFixed(2), clear: Number.isFinite(pu.elbowClear) ? +pu.elbowClear.toFixed(3) : null, scale: +pu.bodyScale.toFixed(3) };
      // bone length ratios (child joint distance from its parent joint, world, over rest length x body scale)
      const len: Record<string, number> = {};
      for (const [c, par] of JOINTS) {
        const r = R.get(c);
        if (!r || !B[c] || !B[par] || r.len < 1e-4) continue;
        len[c] = +(wp(c).distanceTo(wp(par)) / (r.len * pu.bodyScale)).toFixed(3);
      }
      rec.len = len;
      // joint rotation vs rest, axis-angle in the parent's rest frame of the joint
      const rot: Record<string, number[]> = {};
      for (const [c] of JOINTS) {
        const r = R.get(c);
        if (!r || !B[c]) continue;
        const d = r.q.clone().invert().multiply(B[c].quaternion);
        if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
        const ang = 2 * Math.acos(Math.min(1, d.w));
        const sn = Math.sqrt(Math.max(1e-12, 1 - d.w * d.w));
        rot[c] = [+((ang * 180) / Math.PI).toFixed(1), +(d.x / sn).toFixed(2), +(d.y / sn).toFixed(2), +(d.z / sn).toFixed(2)];
      }
      rec.rot = rot;
      // reach: hand from shoulder joint vs upper + fore arm length; hand inside the head
      const head = wp('Head').add(new V(0, 0.09 * pu.bodyScale, 0));
      for (const s of ['Left', 'Right']) {
        const sh = wp(`${s}Arm`), el = wp(`${s}ForeArm`), ha = wp(`${s}Hand`);
        const arm = sh.distanceTo(el) + el.distanceTo(ha);
        rec[`reach${s[0]}`] = +(sh.distanceTo(ha) / arm).toFixed(3);
        rec[`head${s[0]}`] = +ha.distanceTo(head).toFixed(3);
      }
      // how far the look-at / IK / elbow fixes moved the arm bones away from the clip's own pose this frame (deg), and the weights that drive them
      const dev: Record<string, number> = {};
      for (const b of ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'Spine2', 'Neck', 'Head']) {
        const q0 = pu.clipPose?.get(B[b]);
        if (!q0 || !B[b]) continue;
        const d = Math.abs(q0.dot(B[b].quaternion));
        const a = (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
        if (a > 0.5) dev[b] = +a.toFixed(1);
      }
      rec.dev = dev;
      rec.gloveW = +(pu.gloveW ?? 0).toFixed(2);
      rec.readyW = +(pu.readyW ?? 0).toFixed(2);
      rec.sp = +Math.hypot(p.vel.x, p.vel.z).toFixed(2);
      w.__probe.lines.push(JSON.stringify(rec));
    }
  };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  build(flag('no-build'));
  const s = await startPreview();
  const chrome = await launchChrome({ width: 960, height: 540 });
  const file = path.join(out, 'samples.jsonl');
  fs.writeFileSync(file, '');
  try {
    const page = await chrome.ctx.newPage();
    const cdp = await chrome.ctx.newCDPSession(page);
    await applyDesktopViewport(cdp, 960, 540);
    await page.addInitScript('window.__name = (f) => f;');
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 300)));
    const q = new URLSearchParams({ autostart: '1', noaudio: '1', seed: opt('seed', '15'), tempo: opt('tempo', 'standard'), quality: opt('quality', 'low'), tod: 'day' });
    for (const [k, v] of new URLSearchParams(opt('extra', ''))) q.set(k, v);
    await page.goto(`${s.url}?${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__boot?.tti, null, { timeout: 240000 });
    await page.evaluate(() => {
      const e = (window as any).engine;
      e.fixedDt = 1 / 60;
      e.sim.stepBudgetMs = 1e9;
      e.director.replaysEnabled = false;
    });
    await page.evaluate(install, [opt('roles', 'batter').split(','), +opt('every', '1')] as [string[], number]);
    const end = +opt('seconds', '600');
    let t = 0;
    while (t < end) {
      await new Promise((r) => setTimeout(r, 4000));
      const r = await page.evaluate(() => {
        const w = window as any;
        const lines = w.__probe.lines;
        w.__probe.lines = [];
        return { lines, t: w.engine.liveState.time as number, over: !!w.engine.liveState.gameOver };
      });
      fs.appendFileSync(file, r.lines.map((l: string) => l + '\n').join(''));
      t = r.t;
      process.stdout.write(`\r[bodyprobe] game t ${t.toFixed(0)} s`);
      if (r.over) break;
    }
    console.log(`\n[bodyprobe] wrote ${file}`);
  } finally {
    await chrome.close();
    s.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
