/**
 * The swing clip's own bat and body in world space (a right-handed batter in the box, as the engine stands him): knob, bat direction
 * (elevation above the ground, azimuth from +z toward +x), the hands and shoulders, per frame. For designing the sim's bat path.
 *   npx tsx tools/swing/clipbat.ts [--file assets/optimized/players/player_base.glb] [--step 0.0417]
 */
import path from 'node:path';
import { loadRig, sampleClip } from '../jank/glb';
import { ROOT } from '../jank/sweep';
import { B, fk } from '../../src/engine/pose/skeleton';
import { restInfo } from '../../src/engine/pose/limits';
import { qrot } from '../../src/engine/pose/qmath';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const sl = (a: ArrayLike<number>, i: number, n: number) => Array.from(a).slice(i * n, i * n + n);
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

async function main() {
  const rig = await loadRig(path.join(ROOT, opt('file', 'assets/optimized/players/player_base.glb')));
  const rw0 = fk(rig.rest);
  fk(rig.rest, rw0, rw0);
  const R = restInfo(rw0);
  const g = rig.attach.get('Bat_Grip')!;
  const axisR = qrot(g.q, 0, 1, 0, [0, 0, 0]) as number[];
  const s0 = -dot(g.t, axisR);
  const fistR = [g.t[0] + axisR[0] * s0, g.t[1] + axisR[1] * s0, g.t[2] + axisR[2] * s0];
  const clip = rig.clips.get(opt('clip', 'swing'))!;
  const yaw = -Math.PI / 2 + 0.2, root = [0.72, 0, 0.15];
  const W = (p: number[]) => [root[0] + p[0] * Math.cos(yaw) + p[2] * Math.sin(yaw), root[1] + p[1], root[2] - p[0] * Math.sin(yaw) + p[2] * Math.cos(yaw)];
  const Wd = (p: number[]) => [p[0] * Math.cos(yaw) + p[2] * Math.sin(yaw), p[1], -p[0] * Math.sin(yaw) + p[2] * Math.cos(yaw)];
  const f3 = (v: number[]) => v.map((c) => c.toFixed(3).padStart(6)).join(' ');
  const step = +opt('step', String(1 / 24));
  console.log(`grip: fist->knob ${s0.toFixed(3)} (rig units); clip ${clip.name} ${clip.duration.toFixed(3)} s`);
  console.log('   t  frm |  knob x y z          | el    az   | R hand               | L hand               | R shoulder           | L shoulder');
  const rows: unknown[] = [];
  for (let t = 0; t <= clip.duration + 1e-6; t += step) {
    const L = sampleClip(clip, t, rig.rest);
    const w = fk(L, undefined, R.rest);
    const qR = sl(w.wq, B.RightHand, 4);
    const fR = qrot(qR, fistR[0], fistR[1], fistR[2]) as number[];
    const HR = sl(w.wp, B.RightHand, 3);
    const ax = norm(qrot(qR, axisR[0], axisR[1], axisR[2]) as number[]);
    const knob = [HR[0] + fR[0] - ax[0] * s0, HR[1] + fR[1] - ax[1] * s0, HR[2] + fR[2] - ax[2] * s0];
    const k = W(knob), d = Wd(ax);
    const el = (Math.asin(d[1]) * 180) / Math.PI, az = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
    const hr = W(HR), hl = W(sl(w.wp, B.LeftHand, 3)), sr = W(sl(w.wp, B.RightArm, 3)), sL = W(sl(w.wp, B.LeftArm, 3));
    rows.push({ t, knob: k, dir: d, hr, hl, sr, sl: sL });
    console.log(`${t.toFixed(3)} ${(t * 24).toFixed(1).padStart(4)} | ${f3(k)} | ${el.toFixed(0).padStart(4)} ${az.toFixed(0).padStart(5)} | ${f3(hr)} | ${f3(hl)} | ${f3(sr)} | ${f3(sL)}`);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(rows));
}
main().catch((e) => { console.error(e); process.exit(1); });
