import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, type RigFile } from '../../../tools/jank/glb';
import { B, copyLocals, fk } from './skeleton';
import { measureJoints, restInfo, type RestInfo } from './limits';
import { DEG, qaxisAngle, qmul } from './qmath';
import { constrainPose, softClamp } from './constrain';

let rig: RigFile, R: RestInfo;
const ROOT = path.resolve(__dirname, '../../..');
beforeAll(async () => {
  rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  R = restInfo(rw);
});
const at = (clip: string, f: number) => {
  const c = rig.clips.get(clip)!;
  return sampleClip(c, f * c.duration, rig.rest);
};
const measure = (L: ReturnType<typeof at>) => measureJoints(fk(L, undefined, R.rest), R);

describe('soft clamp', () => {
  it('is the identity inside, approaches the limit outside, continuous at the margin', () => {
    expect(softClamp(50, 0, 150, 12)).toBe(50);
    expect(softClamp(150, 0, 150, 12)).toBe(150);
    expect(softClamp(400, 0, 150, 12)).toBeLessThanOrEqual(162);
    expect(softClamp(400, 0, 150, 12)).toBeGreaterThan(161.9);
    expect(softClamp(-40, 0, 150, 12)).toBeGreaterThanOrEqual(-12);
    expect(Math.abs(softClamp(150.001, 0, 150, 12) - 150.001)).toBeLessThan(1e-6);
  });
});

describe('constraint layer', () => {
  it('leaves a clean pose (idle) untouched', () => {
    const L = at('idle', 0.5);
    const before = L.lq.slice();
    expect(constrainPose(L, R)).toBe(0);
    expect(Array.from(L.lq)).toEqual(Array.from(before));
  });
  it('unbends an elbow bent backwards, keeping it in the hinge plane', () => {
    const L = at('idle', 0.5);
    const w = fk(L, undefined, R.rest);
    const u = R.dir.subarray(B.LeftArm * 3, B.LeftArm * 3 + 3);
    const ax = [u[1], -u[0], 0];
    const qa = Array.from(w.wq.subarray(B.LeftArm * 4, B.LeftArm * 4 + 4));
    const inv = [-qa[0], -qa[1], -qa[2], qa[3]];
    const r = qmul(qmul(inv, qaxisAngle(ax[0], ax[1], ax[2], -(48 + 40) * DEG)), qa);
    L.lq.set(qmul(r, L.lq.slice(B.LeftForeArm * 4, B.LeftForeArm * 4 + 4)), B.LeftForeArm * 4);
    expect(measure(L)['elbowL.flex']).toBeLessThan(-20);
    constrainPose(L, R);
    const m = measure(L);
    expect(m['elbowL.flex']).toBeGreaterThanOrEqual(-6.5); // the soft band (6) plus the measure's own rounding
    expect(Math.abs(m['elbowL.off'])).toBeLessThanOrEqual(20);
  });
  it('brings an over-twisted forearm (catcher signs, ~160 deg) into range and shares the twist', () => {
    const L = at('catcher_signs', 0.5);
    expect(Math.abs(measure(L)['forearmL.pron'])).toBeGreaterThan(120);
    constrainPose(L, R);
    const m = measure(L);
    expect(Math.abs(m['forearmL.pron'])).toBeLessThanOrEqual(94.01);
    expect(m['wristL.split']).toBeLessThan(1);
  });
  it('puts sideways / twisted knees back in their hinge plane without moving the ankle (slides, catcher block)', () => {
    for (const clip of ['slide_feet', 'catcher_block', 'pop_up']) {
      for (const f of [0.3, 0.5, 0.7]) {
        const S = at(clip, f);
        const w0 = fk(S, undefined, R.rest);
        const ank = [B.LeftFoot, B.RightFoot].map((i) => Array.from(w0.wp.subarray(i * 3, i * 3 + 3)));
        constrainPose(S, R);
        const w1 = fk(S, undefined, R.rest);
        const m = measureJoints(w1, R);
        for (const s of ['L', 'R']) {
          expect(Math.abs(m[`knee${s}.off`])).toBeLessThan(10.5);
          expect(Math.abs(m[`knee${s}.twist`])).toBeLessThan(30.5);
        }
        [B.LeftFoot, B.RightFoot].forEach((i, k) => {
          const p = Array.from(w1.wp.subarray(i * 3, i * 3 + 3));
          expect(Math.hypot(p[0] - ank[k][0], p[1] - ank[k][1], p[2] - ank[k][2])).toBeLessThan(0.01);
        });
      }
    }
  });
  it('limits twisted ankles only when asked (pitcher set)', () => {
    const P = at('pitcher_set', 0.5);
    constrainPose(P, R, { ankles: true });
    expect(Math.abs(measure(P)['ankleR.twist'])).toBeLessThanOrEqual(30.01);
    const P2 = at('pitcher_set', 0.5);
    constrainPose(P2, R);
    expect(measure(P2)['ankleR.twist']).toBeCloseTo(measure(at('pitcher_set', 0.5))['ankleR.twist'], 3);
  });
  it('touches only the bones it reports', () => {
    const L = at('catcher_signs', 0.5);
    const before = copyLocals(L);
    const mask = constrainPose(L, R);
    for (let i = 0; i < 22; i++) {
      const changed = [0, 1, 2, 3].some((k) => Math.abs(L.lq[i * 4 + k] - before.lq[i * 4 + k]) > 1e-9);
      if (changed) expect(mask & (1 << i)).not.toBe(0);
    }
  });
});
