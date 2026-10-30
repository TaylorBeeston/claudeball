/**
 * Running arms, measured: per gait clip, over a stride, where the elbows and hands are relative to the trunk (in the chest's anatomical frame:
 * +X the model's left, +Y up, +Z forward), after the runtime constraint layer as the game applies it.
 *   npx tsx tools/jank/arms.ts [player.glb] [--clips run,run_sprint] [--step 0.0167] [--json out.json]
 * Per arm (both mirrored to one side: "out" is away from the midline):
 * - elbow: flexion (deg), out = the elbow's distance outside the ribcage ellipse (armClear.ts torso, cm), lat = its distance from the midline
 *   minus the shoulder joint's (cm, > 0 = carried wider than the shoulder);
 * - shoulder abduction (the upper arm's sideways angle from hanging, deg; > 0 = out from the side), fore-aft swing (deg, > 0 = forward);
 * - hand: lat = distance from the midline (cm; < 0 = across it), fwd / back extremes (cm from the chest), top (cm below the chin), and the
 *   hand's reach from the hip joint on the back swing (cm behind the hip).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRig, sampleClip } from './glb';
import { B, fk } from '../../src/engine/pose/skeleton';
import { restInfo, measureJoints } from '../../src/engine/pose/limits';
import { constrainPose, constrainOptsFor, newConstrainState } from '../../src/engine/pose/constrain';
import { torsoClearance, torsoVolume } from '../../src/engine/armClear';
import { qinv, qrot, qmul } from '../../src/engine/pose/qmath';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? path.join(ROOT, 'assets/optimized/players/player_base.glb');
const CLIPS = opt('clips', 'walk,trot,jog,run,run_sprint,run_turn,run_turn_sprint').split(',');
const STEP = +opt('step', String(1 / 60));

export interface ArmFrame {
  t: number;
  flex: number;
  clear: number;
  elbowLat: number;
  abd: number;
  swing: number;
  handLat: number;
  handFwd: number;
  handBelowChin: number;
  handBehindHip: number;
  pron: number;
  wristSwing: number;
  /** shoulder joint's and elbow's distance from the midline (cm) */
  shLat: number;
  elLat: number;
  /** the forearm's inward angle seen from above / in front (deg; > 0 = the hand nearer the midline than the elbow) */
  foreIn: number;
}

const torso = torsoVolume(undefined);

/** one arm's numbers in a posed world (rig space) */
export function armFrame(w: ReturnType<typeof fk>, R: ReturnType<typeof restInfo>, side: 'Left' | 'Right', j: Record<string, number>, t: number): ArmFrame {
  const s = side === 'Left' ? 1 : -1, k = side === 'Left' ? 'L' : 'R';
  const p = (i: number) => [w.wp[i * 3], w.wp[i * 3 + 1], w.wp[i * 3 + 2]];
  const chest = B.Spine2;
  const C = p(chest);
  // body-relative coordinates: the chest's anatomical frame (body axes at rest)
  const ai = qinv(Array.from(w.aq.subarray(chest * 4, chest * 4 + 4)));
  const loc = (v: number[]) => qrot(ai, v[0] - C[0], v[1] - C[1], v[2] - C[2]) as number[];
  // the runtime's ellipse lives in the chest bone's own rig frame
  const ri = qinv(Array.from(w.wq.subarray(chest * 4, chest * 4 + 4)));
  const rloc = (v: number[]) => qrot(ri, v[0] - C[0], v[1] - C[1], v[2] - C[2]) as number[];
  const Sh = loc(p(B[`${side}Arm`])), E = loc(p(B[`${side}ForeArm`])), H = loc(p(B[`${side}Hand`]));
  const er = rloc(p(B[`${side}ForeArm`]));
  const ua = [E[0] - Sh[0], E[1] - Sh[1], E[2] - Sh[2]];
  const ul = Math.hypot(ua[0], ua[1], ua[2]);
  const chin = loc(p(B.Head))[1] - 0.02;
  // hip joint on this side, in the chest frame
  const hip = loc(p(B[`${side}UpLeg`]));
  void qmul;
  return {
    t,
    flex: j[`elbow${k}.flex`],
    clear: torsoClearance(er[0], er[1], er[2], torso) * 100,
    elbowLat: (s * E[0] - s * Sh[0]) * 100,
    abd: (Math.atan2(s * ua[0], -ua[1]) * 180) / Math.PI,
    swing: (Math.atan2(ua[2], -ua[1]) * 180) / Math.PI,
    handLat: s * H[0] * 100,
    handFwd: H[2] * 100,
    handBelowChin: (chin - H[1]) * 100,
    handBehindHip: (hip[2] - H[2]) * 100,
    pron: j[`forearm${k}.pron`],
    wristSwing: j[`wrist${k}.swing`],
    shLat: s * Sh[0] * 100,
    elLat: s * E[0] * 100,
    foreIn: (Math.atan2(s * (E[0] - H[0]), Math.hypot(H[1] - E[1], H[2] - E[2])) * 180) / Math.PI,
    // (ul kept for sanity: upper arm length)
    ...(ul < 0.05 ? { bad: 1 } : {}),
  };
}

export interface ClipArms {
  clip: string;
  frames: number;
  arms: Record<'Left' | 'Right', ArmFrame[]>;
}

export async function measureArms(glb = file, clips = CLIPS, step = STEP, constrained = true): Promise<ClipArms[]> {
  const rig = await loadRig(glb);
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  const R = restInfo(rw);
  const out: ClipArms[] = [];
  for (const name of clips) {
    const clip = rig.clips.get(name);
    if (!clip) continue;
    const st = newConstrainState();
    const rows: ClipArms = { clip: name, frames: 0, arms: { Left: [], Right: [] } };
    // two loops: the first warms the constraint's time-continuous state
    for (let pass = 0; pass < 2; pass++)
      for (let t = 0; t < clip.duration - 1e-6; t += step) {
        const L = sampleClip(clip, t, rig.rest);
        if (constrained) constrainPose(L, R, { ...constrainOptsFor(name, false), state: st, dt: step });
        if (pass === 0) continue;
        const w = fk(L, undefined, R.rest);
        const j = measureJoints(w, R);
        for (const side of ['Left', 'Right'] as const) rows.arms[side].push(armFrame(w, R, side, j, t));
        rows.frames++;
      }
    out.push(rows);
  }
  return out;
}

const f1 = (v: number) => v.toFixed(1).padStart(6);
export function summary(c: ClipArms): string {
  const lines: string[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const a = c.arms[side];
    const col = (k: keyof ArmFrame) => a.map((f) => f[k] as number);
    const mn = (k: keyof ArmFrame) => Math.min(...col(k)), mx = (k: keyof ArmFrame) => Math.max(...col(k));
    const mean = (k: keyof ArmFrame) => col(k).reduce((x, y) => x + y, 0) / a.length;
    lines.push(
      `${c.clip.padEnd(16)} ${side[0]}  flex ${f1(mn('flex'))}..${f1(mx('flex'))} (mean ${f1(mean('flex'))})  elbow clear ${f1(mn('clear'))}..${f1(mx('clear'))}cm lat ${f1(mn('elbowLat'))}..${f1(mx('elbowLat'))}  abd ${f1(mn('abd'))}..${f1(mx('abd'))}  swing ${f1(mn('swing'))}..${f1(mx('swing'))}` +
        `  | hand lat ${f1(mn('handLat'))}..${f1(mx('handLat'))} fwd ${f1(mn('handFwd'))}..${f1(mx('handFwd'))} belowChin(min) ${f1(mn('handBelowChin'))} behindHip(max) ${f1(mx('handBehindHip'))}  pron ${f1(mn('pron'))}..${f1(mx('pron'))} wrist ${f1(mx('wristSwing'))}` +
        `\n${''.padEnd(19)}shoulder lat ${f1(mean('shLat'))}  elbow lat ${f1(mn('elLat'))}..${f1(mx('elLat'))} (mean ${f1(mean('elLat'))})  hand lat mean ${f1(mean('handLat'))}  forearm inward ${f1(mn('foreIn'))}..${f1(mx('foreIn'))} (mean ${f1(mean('foreIn'))})`,
    );
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const res = await measureArms(file, CLIPS, STEP, !argv.includes('--raw'));
  for (const c of res) console.log(summary(c));
  const js = opt('json', '');
  if (js) fs.writeFileSync(js, JSON.stringify(res));
}
