/**
 * The bat directions two hands can hold: for a sim thread that drives the bat (src/sim batting), the envelope it must stay inside so the
 * batter's arms can follow it within human joint ranges. Offline, on the shipped rig (player_base.glb) and the `swing` clip's body:
 *
 *   npx tsx tools/jank/envelope.ts [--out tools/jank/out/envelope.md] [--step 10]
 *
 * For each key phase of the swing the body is the clip's; the knob is where the clip's top fist holds it; the bat is turned to every direction
 * (azimuth / elevation in the SHOULDER frame: +x the batter's model-left shoulder line R -> L, +y up the spine, +z forward = toward the plate's
 * far side for a right-handed batter) and both arms are solved with the game's solver (pose/armIK.ts, every swivel and fist roll tried). A
 * direction is holdable when both hands are on the handle (miss < 2 cm) and neither needs more than 5 deg past the pronation / supination
 * (88 / 88 deg) or wrist (72 deg) range ('+': within 35 deg, which the authored swing itself needs). Writes a table per phase and
 * envelope.json (every sample).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRig, sampleClip } from './glb';
import { ROOT } from './sweep';
import { B, fk } from '../../src/engine/pose/skeleton';
import { restInfo } from '../../src/engine/pose/limits';
import { qrot } from '../../src/engine/pose/qmath';
import { armRest, solveArm } from '../../src/engine/pose/armIK';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const STEP = +opt('step', '10');
const OUT = opt('out', path.join(ROOT, 'tools/jank/out/envelope.md'));

const sl = (a: ArrayLike<number>, i: number, n: number) => Array.from(a).slice(i * n, i * n + n);
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

async function main() {
  const rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  const rw0 = fk(rig.rest);
  fk(rig.rest, rw0, rw0);
  const R = restInfo(rw0);
  const g = rig.attach.get('Bat_Grip')!;
  const axisR = qrot(g.q, 0, 1, 0, [0, 0, 0]) as number[];
  const s0 = -dot(g.t, axisR);
  const fistR = [g.t[0] + axisR[0] * s0, g.t[1] + axisR[1] * s0, g.t[2] + axisR[2] * s0];
  const gripTop = s0, gripBottom = Math.max(0.02, s0 - 0.085);
  const restOf = (side: 'Left' | 'Right') =>
    armRest(sl(R.dir, B[`${side}Arm`], 3), sl(R.dir, B[`${side}ForeArm`], 3), sl(R.rest.wq, B[`${side}Arm`], 4), sl(R.rest.wq, B[`${side}ForeArm`], 4), sl(R.rest.wq, B[`${side}Hand`], 4), side === 'Left' ? 1 : -1);
  const rests = { Left: restOf('Left'), Right: restOf('Right') };
  const clip = rig.clips.get('swing')!;
  // the key frames of player_clips.py's swing (24 fps): load, stride, launch, pre-contact, contact (21), extension, finish
  const PHASES: [string, number][] = [['stance (0)', 0], ['load (8)', 8], ['stride (13)', 13], ['launch (17)', 17], ['pre-contact (20)', 20], ['contact (21)', 21], ['extension (22)', 22], ['finish (27)', 27]];
  const lines = ['# Bat directions two hands can hold (tools/jank/envelope.ts)', '', `Rig: player_base.glb, body: the \`swing\` clip at each phase. Knob where the clip's top fist holds it. Directions in the shoulder frame: azimuth from +z (forward) toward +x (the model's left shoulder), elevation above the shoulder plane. # = holdable (both fists on the handle, <= 5 deg past the pronation / wrist range), + = within 35 deg of it (the authored swing's own grips need ~30 deg past the top hand's range), . = neither; @ = the clip's own bat. Step ${STEP} deg.`, ''];
  const samples: unknown[] = [];
  for (const [label, frame] of PHASES) {
    const L = sampleClip(clip, Math.min(clip.duration - 1e-3, frame / 24), rig.rest);
    const w = fk(L, undefined, R.rest);
    const SL = sl(w.wp, B.LeftArm, 3), SR = sl(w.wp, B.RightArm, 3);
    const x = norm(sub(SL, SR));
    const up0 = norm(sub(sl(w.wp, B.Spine2, 3), sl(w.wp, B.Hips, 3)));
    const y = norm(sub(up0, x.map((v) => v * dot(up0, x))));
    const z = cross(x, y);
    // the clip's knob and bat direction (from the right fist's grip)
    const qR = sl(w.wq, B.RightHand, 4);
    const fR = qrot(qR, fistR[0], fistR[1], fistR[2]) as number[];
    const HR = sl(w.wp, B.RightHand, 3);
    const clipAxis = norm(qrot(qR, axisR[0], axisR[1], axisR[2]) as number[]);
    const knob = [HR[0] + fR[0] - clipAxis[0] * gripTop, HR[1] + fR[1] - clipAxis[1] * gripTop, HR[2] + fR[2] - clipAxis[2] * gripTop];
    const toFrame = (d: number[]) => ({ az: (Math.atan2(dot(d, x), dot(d, z)) * 180) / Math.PI, el: (Math.asin(Math.max(-1, Math.min(1, dot(d, y)))) * 180) / Math.PI });
    const own = toFrame(clipAxis);
    const solve = (side: 'Left' | 'Right', d: number[]) => {
      const mx = side === 'Right' ? 1 : -1;
      const fist = [mx * fistR[0], fistR[1], fistR[2]], gl = [mx * axisR[0], axisR[1], axisR[2]];
      const sAlong = side === 'Right' ? gripTop : gripBottom;
      const target = [knob[0] + d[0] * sAlong, knob[1] + d[1] * sAlong, knob[2] + d[2] * sAlong];
      const [a, f, h] = [B[`${side}Arm`], B[`${side}ForeArm`], B[`${side}Hand`]];
      return solveArm(rests[side], { S: sl(w.wp, a, 3), E: sl(w.wp, f, 3), H: sl(w.wp, h, 3), qUpper: sl(w.wq, a, 4), qFore: sl(w.wq, f, 4), qHand: sl(w.wq, h, 4) }, { target, fist, gripLocal: gl, gripDir: d });
    };
    lines.push(`## ${label}: the clip's bat az ${own.az.toFixed(0)}, el ${own.el.toFixed(0)}`, '', '```', `el\\az ${Array.from({ length: Math.round(360 / STEP) }, (_, i) => -180 + i * STEP).map((a) => (a % 90 === 0 ? String(a).padEnd(STEP === 10 ? 1 : 2) : ' ')).join('')}`);
    let ok = 0, n = 0;
    for (let el = 80; el >= -80; el -= STEP) {
      let row = '';
      for (let az = -180; az < 180; az += STEP) {
        const ce = Math.cos((el * Math.PI) / 180);
        const dl = [ce * Math.sin((az * Math.PI) / 180), Math.sin((el * Math.PI) / 180), ce * Math.cos((az * Math.PI) / 180)];
        const d = [x[0] * dl[0] + y[0] * dl[1] + z[0] * dl[2], x[1] * dl[0] + y[1] * dl[1] + z[1] * dl[2], x[2] * dl[0] + y[2] * dl[1] + z[2] * dl[2]];
        const l = solve('Left', d), r = solve('Right', d);
        const hold = Math.max(l.over, r.over) <= 5 && Math.max(l.miss, r.miss) < 0.02;
        n++;
        if (hold) ok++;
        samples.push({ phase: label, az, el, overL: +l.over.toFixed(1), overR: +r.over.toFixed(1), missL: +l.miss.toFixed(3), missR: +r.miss.toFixed(3), hold });
        const isOwn = Math.abs(((az - own.az + 540) % 360) - 180) < STEP / 2 && Math.abs(el - own.el) < STEP / 2;
        const near = Math.max(l.over, r.over) <= 35 && Math.max(l.miss, r.miss) < 0.02;
        row += isOwn ? '@' : hold ? '#' : near ? '+' : '.';
      }
      lines.push(`${String(el).padStart(4)}  ${row}`);
    }
    lines.push('```', '', `${ok} of ${n} directions holdable (${((ok / n) * 100).toFixed(0)} %).`, '');
    console.log(`[envelope] ${label}: ${ok}/${n} holdable; clip's bat az ${own.az.toFixed(0)} el ${own.el.toFixed(0)}`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  fs.writeFileSync(OUT.replace(/\.md$/, '.json'), JSON.stringify(samples));
  console.log(`[envelope] wrote ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
