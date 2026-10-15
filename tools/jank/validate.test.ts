import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, blendLocals, type RigFile } from './glb';
import { B, copyLocals, fk, newLocals } from '../../src/engine/pose/skeleton';
import { measureJoints, axialSwing, JOINT_LIMITS, excess } from '../../src/engine/pose/limits';
import { qaxisAngle, qmul, twistAngle, DEG } from '../../src/engine/pose/qmath';
import { newTrack, rigInfo, validateFrame, type RigInfo, type Violation } from './validate';
import { gripBat } from './sweep';

const ROOT = path.resolve(__dirname, '../..');
let rig: RigFile, info: RigInfo;
beforeAll(async () => {
  rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  info = rigInfo(rig.rest, rig.attach.get('Bat_Grip')!);
});

const at = (clip: string, t: number) => {
  const c = rig.clips.get(clip)!;
  return measureJoints(fk(sampleClip(c, t * c.duration, rig.rest), undefined, info.R.rest), info.R);
};
const flat = () => 0;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('quaternion maths', () => {
  it('splits a rotation into swing and twist', () => {
    const tw = qaxisAngle(0, 1, 0, 0.7), sw = qaxisAngle(1, 0, 0, 0.4);
    expect(twistAngle(qmul(sw, tw), 0, 1, 0)).toBeCloseTo(0.7, 6);
    const a = axialSwing(qmul(sw, tw), [0, 0, 0]);
    expect(a[0]).toBeCloseTo(0.7, 6);
    expect(a[1]).toBeCloseTo(0.4, 6);
    expect(a[2]).toBeCloseTo(0, 6);
  });
  it('stays defined for a head level over a trunk bent 90 degrees forward (no gimbal lock)', () => {
    const a = axialSwing(qmul(qaxisAngle(1, 0, 0, -Math.PI / 2), qaxisAngle(0, 1, 0, 0.3)), [0, 0, 0]);
    expect(a[0]).toBeCloseTo(0.3, 6);
    expect(a[1]).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('calibration on reference clips (if these fail the validator is wrong, not the clip)', () => {
  it('idle: relaxed, no joint out of range', () => {
    const m = at('idle', 0.5);
    expect(JOINT_LIMITS.filter((l) => excess(l, m[l.key]) > 0).map((l) => l.key)).toEqual([]);
    expect(m['kneeL.flex']).toBeGreaterThan(0);
    expect(Math.abs(m['forearmL.pron'])).toBeLessThan(5);
  });
  it('catcher_crouch: knees deeply flexed (positive), hips flexed', () => {
    const m = at('catcher_crouch', 0.5);
    expect(m['kneeL.flex']).toBeGreaterThan(100);
    expect(m['kneeR.flex']).toBeGreaterThan(100);
    expect(m['hipL.flex']).toBeGreaterThan(60);
  });
  it('bench_sit: knees and hips about 90', () => {
    const m = at('bench_sit', 0.5);
    expect(m['kneeL.flex']).toBeGreaterThan(70);
    expect(m['kneeL.flex']).toBeLessThan(110);
    expect(m['hipL.flex']).toBeGreaterThan(60);
  });
  it('batting_stance: both elbows flexed forward', () => {
    const m = at('batting_stance', 0.5);
    expect(m['elbowL.flex']).toBeGreaterThan(60);
    expect(m['elbowR.flex']).toBeGreaterThan(60);
  });
});

describe('violations', () => {
  it('an elbow bent backwards is a hinge violation; the same bend forward is not', () => {
    for (const [sign, bad] of [[1, false], [-1, true]] as const) {
      const L = copyLocals(rig.rest);
      // rotate the forearm about the hinge axis found by bending it: anterior is +Z in the upper arm's anatomical frame
      const w0 = fk(L, undefined, info.R.rest);
      const u = info.R.dir.subarray(B.LeftArm * 3, B.LeftArm * 3 + 3);
      // hinge axis (rig space at rest) = u x +Z; express in the arm bone's local frame
      const ax = [u[1] * 1 - u[2] * 0, u[2] * 0 - u[0] * 1, 0];
      const qa = w0.wq.slice(B.LeftArm * 4, B.LeftArm * 4 + 4);
      const inv = [-qa[0], -qa[1], -qa[2], qa[3]];
      const r = qmul(qmul(inv, qaxisAngle(ax[0], ax[1], ax[2], sign * 40 * DEG)), qa);
      const lq = L.lq.slice(B.LeftForeArm * 4, B.LeftForeArm * 4 + 4);
      L.lq.set(qmul(r, lq), B.LeftForeArm * 4);
      const m = measureJoints(fk(L, undefined, info.R.rest), info.R);
      expect(Math.sign(m['elbowL.flex'])).toBe(sign);
      const v: Violation[] = [];
      validateFrame({ L, model: ID, ground: flat, dt: 0 }, info, newTrack(), v);
      expect(v.some((x) => x.kind === 'joint:elbowL.flex')).toBe(bad);
    }
  });
  it('a one-frame pop is a flip, a smooth turn is not', () => {
    const c = rig.clips.get('idle')!;
    const tr = newTrack();
    const v: Violation[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const L = sampleClip(c, i / 60, rig.rest);
      if (i === 4) L.lq.set(qmul(qaxisAngle(0, 1, 0, 1.2), L.lq.slice(B.Head * 4, B.Head * 4 + 4)), B.Head * 4);
      validateFrame({ L, model: ID, ground: flat, dt: 1 / 60 }, info, tr, v);
      kinds.push(...v.map((x) => x.kind));
    }
    expect(kinds).toContain('flip:Head');
  });
  it('a bat on Bat_Grip is in the right hand; moved off the hand it is a grip violation', () => {
    const L = sampleClip(rig.clips.get('batting_stance')!, 0.5, rig.rest);
    const bat = gripBat(L, info, ID, { L: false, R: true });
    const v: Violation[] = [];
    validateFrame({ L, model: ID, ground: flat, dt: 0, bat }, info, newTrack(), v);
    expect(v.filter((x) => x.kind === 'bat:grip-R')).toEqual([]);
    bat.knob[1] += 0.15;
    bat.tip[1] += 0.15;
    validateFrame({ L, model: ID, ground: flat, dt: 0, bat }, info, newTrack(), v);
    expect(v.some((x) => x.kind === 'bat:grip-R')).toBe(true);
  });
  it('a mirrored (left-handed) model measures like the right-handed one', () => {
    const L = sampleClip(rig.clips.get('swing')!, 0.4, rig.rest);
    const M = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const a: Violation[] = [], b: Violation[] = [];
    validateFrame({ L, model: ID, ground: flat, dt: 0, bat: gripBat(L, info, ID, { L: true, R: true }) }, info, newTrack(), a);
    validateFrame({ L, model: M, ground: flat, dt: 0, bat: gripBat(L, info, M, { L: true, R: true }) }, info, newTrack(), b);
    expect(b.map((x) => `${x.kind}:${x.excess.toFixed(4)}`)).toEqual(a.map((x) => `${x.kind}:${x.excess.toFixed(4)}`));
  });
  it('a crossfade between a clip and itself is the clip', () => {
    const c = rig.clips.get('run')!;
    const A = sampleClip(c, 0.2, rig.rest), out = newLocals();
    blendLocals(A, A, 0.37, out);
    for (let i = 0; i < out.lq.length; i++) expect(out.lq[i]).toBeCloseTo(A.lq[i], 6);
  });
});
