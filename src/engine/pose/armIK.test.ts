import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, type RigFile } from '../../../tools/jank/glb';
import { B, PARENT, fk, type PoseLocals } from './skeleton';
import { measureJoints, restInfo, type RestInfo } from './limits';
import { qaxisAngle, qinv, qmul, qrot } from './qmath';
import { ARM_LIMITS, armRest, solveArm, softReach, type ArmRest, type GripTrack } from './armIK';

let rig: RigFile, R: RestInfo;
const ROOT = path.resolve(__dirname, '../../..');
beforeAll(async () => {
  rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  R = restInfo(rw);
});
const dot3 = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));
const restOf = (side: 'Left' | 'Right'): ArmRest => {
  const rw = R.rest;
  return armRest(sl(R.dir, B[`${side}Arm`], 3), sl(R.dir, B[`${side}ForeArm`], 3), sl(rw.wq, B[`${side}Arm`], 4), sl(rw.wq, B[`${side}ForeArm`], 4), sl(rw.wq, B[`${side}Hand`], 4), side === 'Left' ? 1 : -1);
};
/** solve one arm of a clip pose and write the result back as locals */
function solveInto(L: PoseLocals, side: 'Left' | 'Right', target: number[], fist: number[], grip?: { local: number[]; dir: number[] }) {
  const w = fk(L, undefined, R.rest);
  const [a, f, h] = [B[`${side}Arm`], B[`${side}ForeArm`], B[`${side}Hand`]];
  const out = solveArm(restOf(side), { S: sl(w.wp, a, 3), E: sl(w.wp, f, 3), H: sl(w.wp, h, 3), qUpper: sl(w.wq, a, 4), qFore: sl(w.wq, f, 4), qHand: sl(w.wq, h, 4) }, { target, fist, gripLocal: grip?.local, gripDir: grip?.dir });
  // locals: parent^-1 * rig, chain order
  const parentQ = sl(w.wq, PARENT[a], 4);
  L.lq.set(qmul(qinv(parentQ), out.qUpper), a * 4);
  L.lq.set(qmul(qinv(out.qUpper), out.qFore), f * 4);
  L.lq.set(qmul(qinv(out.qFore), out.qHand), h * 4);
  return out;
}

describe('analytic arm IK', () => {
  it('soft reach approaches full extension smoothly and never passes it', () => {
    expect(softReach(0.5, 1)).toBe(0.5);
    expect(softReach(1.2, 1)).toBeLessThan(1);
    expect(softReach(0.99, 1)).toBeGreaterThan(softReach(0.97, 1));
  });
  for (const side of ['Left', 'Right'] as const) {
    it(`${side}: puts the fist on a reachable target, bends only in the hinge plane, keeps the elbow in range`, () => {
      const L = sampleClip(rig.clips.get('batting_stance')!, 0.5, rig.rest);
      const w = fk(L, undefined, R.rest);
      const fist = [side === 'Right' ? 0.024 : -0.024, 0.074, -0.028];
      // targets around the current hand: in front, up, across the body
      for (const off of [[0.1, 0.05, 0.15], [-0.15, 0.2, 0.05], [0, -0.25, 0.2], [0.2, 0.1, -0.1]]) {
        const L2 = { lq: L.lq.slice(), lp: L.lp.slice(), base: L.base.slice() };
        const hp = sl(w.wp, B[`${side}Hand`], 3);
        const target = [hp[0] + off[0], hp[1] + off[1], hp[2] + off[2]];
        const out = solveInto(L2, side, target, fist);
        expect(out.miss).toBeLessThan(0.005); // the soft clamp near full extension may leave a few mm
        const w2 = fk(L2, undefined, R.rest);
        const m = measureJoints(w2, R);
        const s = side[0];
        expect(Math.abs(m[`elbow${s}.off`])).toBeLessThan(0.5);
        expect(m[`elbow${s}.flex`]).toBeGreaterThan(-1);
        expect(m[`elbow${s}.flex`]).toBeLessThan(156);
        // the fist really is there (forward kinematics of the written locals)
        const qh = sl(w2.wq, B[`${side}Hand`], 4), hw = sl(w2.wp, B[`${side}Hand`], 3);
        const fo = qrot(qh, fist[0], fist[1], fist[2]) as number[];
        expect(Math.hypot(hw[0] + fo[0] - target[0], hw[1] + fo[1] - target[1], hw[2] + fo[2] - target[2])).toBeLessThan(0.005);
      }
    });
    it(`${side}: turns the fist's grip line onto a bat axis, sharing the twist between forearm and hand`, () => {
      const L = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
      const w = fk(L, undefined, R.rest);
      const g = rig.attach.get('Bat_Grip')!;
      const a = qrot(g.q, 0, 1, 0, [0, 0, 0]) as number[];
      const local = side === 'Right' ? a : [-a[0], a[1], a[2]];
      const fist = [side === 'Right' ? 0.024 : -0.024, 0.074, -0.028];
      const hp = sl(w.wp, B[`${side}Hand`], 3);
      // the clip's own grip line turned 35 deg about a sideways axis: a bat held at a different angle in the same stance
      const g0 = qrot(sl(w.wq, B[`${side}Hand`], 4), local[0], local[1], local[2]) as number[];
      const c = Math.cos(0.61), sn = Math.sin(0.61);
      const dir = [g0[0], g0[1] * c - g0[2] * sn, g0[1] * sn + g0[2] * c];
      const n = Math.hypot(...dir);
      const out = solveInto(L, side, [hp[0] + 0.05, hp[1] + 0.03, hp[2]], fist, { local, dir: dir.map((x) => x / n) });
      const g2 = qrot(out.qHand, local[0], local[1], local[2]) as number[];
      const ang = (Math.acos(Math.min(1, (g2[0] * dir[0] + g2[1] * dir[1] + g2[2] * dir[2]) / n)) * 180) / Math.PI;
      expect(ang).toBeLessThan(5);
      const m = measureJoints(fk(L, undefined, R.rest), R);
      expect(m[`wrist${side[0]}.split`]).toBeLessThan(5);
      expect(Math.abs(m[`forearm${side[0]}.pron`])).toBeLessThanOrEqual(95.5);
    });
  }
  it('reaches a bat at an angle the forearm alone cannot by moving the elbow, and keeps that choice from frame to frame', () => {
    const L0 = sampleClip(rig.clips.get('batting_stance')!, 0.5, rig.rest);
    const w = fk(L0, undefined, R.rest);
    const g = rig.attach.get('Bat_Grip')!;
    const a = qrot(g.q, 0, 1, 0, [0, 0, 0]) as number[];
    const hp = sl(w.wp, B.RightHand, 3);
    // the bat flat, pointing back and across: far from the clip's grip line
    const dir = [0.6, 0.1, -0.79];
    const n = Math.hypot(...dir);
    const rest = restOf('Right');
    const pose = { S: sl(w.wp, B.RightArm, 3), E: sl(w.wp, B.RightForeArm, 3), H: hp, qUpper: sl(w.wq, B.RightArm, 4), qFore: sl(w.wq, B.RightForeArm, 4), qHand: sl(w.wq, B.RightHand, 4) };
    const goal = { target: [hp[0] + 0.05, hp[1], hp[2]], fist: [0.024, 0.074, -0.028], gripLocal: a, gripDir: dir.map((x) => x / n) };
    const fixed = solveArm(rest, pose, goal);
    const g1 = qrot(fixed.qHand, a[0], a[1], a[2]) as number[];
    const err = (Math.acos(Math.min(1, (g1[0] * dir[0] + g1[1] * dir[1] + g1[2] * dir[2]) / n)) * 180) / Math.PI;
    expect(err).toBeLessThan(25);
    // the next frame, the same goal, the grip held: at most a step from that swivel
    const again = solveArm(rest, pose, { ...goal, track: { pole: fixed.pole, roll: fixed.roll, pron: fixed.pron } });
    expect(Math.abs(again.pole - fixed.pole)).toBeLessThanOrEqual(ARM_LIMITS.poleStep + 1e-9);
  });
  it('a held grip follows a turning bat continuously: the fist rolls on the round handle, the elbow and the hand never hop', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const w = fk(L0, undefined, R.rest);
    const g = rig.attach.get('Bat_Grip')!;
    const a = qrot(g.q, 0, 1, 0, [0, 0, 0]) as number[];
    const hp = sl(w.wp, B.RightHand, 3);
    const rest = restOf('Right');
    const pose = { S: sl(w.wp, B.RightArm, 3), E: sl(w.wp, B.RightForeArm, 3), H: hp, qUpper: sl(w.wq, B.RightArm, 4), qFore: sl(w.wq, B.RightForeArm, 4), qHand: sl(w.wq, B.RightHand, 4) };
    const g0 = qrot(pose.qHand, a[0], a[1], a[2]) as number[];
    const errOf = (q: number[], d: number[]) => (Math.acos(Math.min(1, dot3(qrot(q, a[0], a[1], a[2]) as number[], d))) * 180) / Math.PI;
    const sweep = (roll: number) => {
      const lim = (globalThis as { __armLimits?: typeof ARM_LIMITS });
      lim.__armLimits = { ...ARM_LIMITS, roll };
      let track: GripTrack | undefined, sum = 0, maxPole = 0, maxRoll = 0, maxPron = 0;
      // the bat turned a half turn about the vertical in 4.5 deg steps (a swing at 60 fps turns it about that fast)
      for (let i = 0; i <= 40; i++) {
        const d = qrot(qaxisAngle(0, 1, 0, (i * 4.5 * Math.PI) / 180), g0[0], g0[1], g0[2]) as number[];
        const out = solveArm(rest, pose, { target: [hp[0] + 0.05, hp[1], hp[2]], fist: [0.024, 0.074, -0.028], gripLocal: a, gripDir: d, track });
        sum += errOf(out.qHand, d);
        if (track) {
          maxPole = Math.max(maxPole, Math.abs(out.pole - track.pole));
          maxRoll = Math.max(maxRoll, Math.abs(out.roll - track.roll));
          maxPron = Math.max(maxPron, Math.abs(out.pron - (track.pron ?? out.pron)));
        }
        track = { pole: out.pole, roll: out.roll, pron: out.pron, vPole: out.vPole, vRoll: out.vRoll };
      }
      delete lim.__armLimits;
      return { mean: sum / 41, maxPole, maxRoll, maxPron };
    };
    // the fist kept on the clip's roll leaves the grip line ~11 deg off the bat on average; rolling it on the handle, ~1 deg
    const fixed = sweep(0), rolled = sweep(90);
    expect(rolled.mean).toBeLessThan(fixed.mean / 4);
    expect(rolled.mean).toBeLessThan(3);
    for (const r of [fixed, rolled]) {
      expect(r.maxPole).toBeLessThanOrEqual(ARM_LIMITS.poleStep + 1e-6);
      expect(r.maxRoll).toBeLessThanOrEqual(ARM_LIMITS.rollStep + 1e-6);
      // no flip to the other end of the twist range
      expect(r.maxPron).toBeLessThan(40);
    }
  });
  it('an unreachable target: no NaN, no hyperextension, the fist as close as the soft reach allows', () => {
    const L = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const w = fk(L, undefined, R.rest);
    const S = sl(w.wp, B.LeftArm, 3);
    const out = solveInto(L, 'Left', [S[0] + 2, S[1], S[2] + 0.5], [-0.024, 0.074, -0.028]);
    expect(Number.isFinite(out.miss)).toBe(true);
    expect(out.miss).toBeGreaterThan(1);
    const m = measureJoints(fk(L, undefined, R.rest), R);
    expect(m['elbowL.flex']).toBeGreaterThan(-0.5);
    expect(Math.abs(m['elbowL.off'])).toBeLessThan(0.5);
  });
  it('moves continuously: a target sweeping past the body never flips the elbow', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const w = fk(L0, undefined, R.rest);
    const hp = sl(w.wp, B.RightHand, 3);
    let prev: number[] | null = null;
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const L = { lq: L0.lq.slice(), lp: L0.lp.slice(), base: L0.base.slice() };
      const out = solveInto(L, 'Right', [hp[0] + 0.5 * t, hp[1] + 0.4 * t, hp[2] + 0.3 * Math.sin(t * 3)], [0.024, 0.074, -0.028]);
      if (prev) {
        const d = Math.hypot(out.elbow[0] - prev[0], out.elbow[1] - prev[1], out.elbow[2] - prev[2]);
        expect(d).toBeLessThan(0.05);
      }
      prev = out.elbow;
    }
  });
});
