import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, type RigFile } from '../../../tools/jank/glb';
import { armFrame } from '../../../tools/jank/arms';
import { fk, type PoseLocals } from './skeleton';
import { measureJoints, restInfo, type RestInfo } from './limits';
import { gaitArms, gaitWeightStep, type GaitArmsState } from './gaitArms';
import { torsoVolume } from '../armClear';
import { qdist } from './qmath';

let rig: RigFile, R: RestInfo;
const ROOT = path.resolve(__dirname, '../../..');
const T = torsoVolume(undefined);
beforeAll(async () => {
  rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  R = restInfo(rw);
});
const at = (clip: string, t: number) => sampleClip(rig.clips.get(clip)!, t, rig.rest);
const arms = (L: PoseLocals, t = 0) => {
  const w = fk(L, undefined, R.rest);
  const j = measureJoints(w, R);
  return { Left: armFrame(w, R, 'Left', j, t), Right: armFrame(w, R, 'Right', j, t) };
};

describe('running arms', () => {
  it('over a run stride: forearms angle in, hands nearer the midline, elbows less folded and clear of the trunk, fists out of it', () => {
    const c = rig.clips.get('run')!;
    let inBefore = 0, inAfter = 0, latBefore = 0, latAfter = 0, flexBefore = 0, flexAfter = 0, n = 0;
    for (let t = 0; t < c.duration; t += 1 / 60) {
      const L = at('run', t);
      const a = arms(L, t);
      gaitArms(L, R, { w: 1, torso: T });
      const b = arms(L, t);
      for (const s of ['Left', 'Right'] as const) {
        inBefore += a[s].foreIn;
        inAfter += b[s].foreIn;
        latBefore += a[s].handLat;
        latAfter += b[s].handLat;
        flexBefore += a[s].flex;
        flexAfter += b[s].flex;
        n++;
        expect(b[s].clear).toBeGreaterThan(5);
        // the fist (8.5 cm along the hand) at least 2 cm outside the trunk, as the jank validator wants it
        expect(b[s].handLat).toBeGreaterThan(10);
        expect(b[s].flex).toBeLessThan(118);
      }
    }
    expect(inBefore / n).toBeLessThan(-5);
    expect(inAfter / n).toBeGreaterThan(5);
    expect(latAfter / n).toBeLessThan(latBefore / n - 6);
    expect(flexAfter / n).toBeLessThan(flexBefore / n - 8);
  });

  it('does nothing at weight 0, and nothing to an arm held by an IK', () => {
    const L = at('run', 0.2), before = L.lq.slice();
    expect(gaitArms(L, R, { w: 0, torso: T })).toBe(0);
    expect(Array.from(L.lq)).toEqual(Array.from(before));
    gaitArms(L, R, { w: 1, torso: T, free: { Left: 0, Right: 1 } });
    // the left arm's bones untouched
    for (const i of [7, 8, 9]) expect(Array.from(L.lq.subarray(i * 4, i * 4 + 4))).toEqual(Array.from(before.subarray(i * 4, i * 4 + 4)));
  });

  it('leaves a raised arm (a throw) to its clip', () => {
    const c = rig.clips.get('throw')!;
    let worst = 0;
    for (let t = 0; t < c.duration; t += 1 / 30) {
      const L = at('throw', t);
      const w0 = fk(L, undefined, R.rest);
      const up = w0.wp[8 * 3 + 1] > w0.wp[7 * 3 + 1] - 0.05; // the left elbow about level with its shoulder or above
      const before = L.lq.slice();
      gaitArms(L, R, { w: 1, torso: T });
      if (up) worst = Math.max(worst, qdist(L.lq, before, 7 * 4, 7 * 4));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('a heavier build carries the elbows wider', () => {
    const heavy = torsoVolume({ build_heavy: 1 });
    let a = 0, b = 0;
    for (let t = 0; t < 0.67; t += 1 / 30) {
      const L1 = at('run', t), L2 = at('run', t);
      gaitArms(L1, R, { w: 1, torso: T });
      gaitArms(L2, R, { w: 1, torso: heavy });
      a += arms(L1).Left.elLat;
      b += arms(L2).Left.elLat;
    }
    expect(b).toBeGreaterThan(a);
  });

  it('fading out: the correction decays smoothly with the weight (no step from one frame to the next)', () => {
    const st: GaitArmsState = {};
    const g = { w: 1, v: 0 };
    let prev: Float64Array | null = null, worst = 0;
    for (let k = 0; k < 40; k++) {
      // the run for 10 frames, then the idle pose with the weight easing to 0
      const L = k < 10 ? at('run', k / 60) : at('idle', 0.5);
      if (k >= 10) gaitWeightStep(g, 0, 1 / 60);
      gaitArms(L, R, { w: g.w, torso: T, state: st, dt: 1 / 60 });
      if (prev && k > 10) worst = Math.max(worst, qdist(L.lq, prev, 7 * 4, 7 * 4));
      prev = L.lq.slice();
    }
    expect(g.w).toBeLessThan(0.05);
    // per frame, the upper arm moves less than 6 deg while the correction fades
    expect(worst).toBeLessThan((6 * Math.PI) / 180);
  });
});
