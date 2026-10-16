import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, type RigFile } from '../../../tools/jank/glb';
import { B, copyLocals, fk } from './skeleton';
import { restInfo, type RestInfo } from './limits';
import { FOOT_LOCK, footLock, newFootLock } from './footLock';

let rig: RigFile, R: RestInfo;
const ROOT = path.resolve(__dirname, '../../..');
beforeAll(async () => {
  rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  R = restInfo(rw);
});
const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const ankleX = (L: ReturnType<typeof sampleClip>, x: number, side: 'Left' | 'Right') => fk(L, undefined, R.rest).wp[B[`${side}Foot`] * 3] + x;

describe('foot locking', () => {
  it('keeps a planted foot on its spot while the root carries the body, then steps it back under the body (no slide, no jump)', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const st = newFootLock();
    const dt = 1 / 60, v = 0.6;
    let lastX = 0, maxStep = 0, unlockedAt = -1, liftMax = 0;
    for (let i = 0; i < 60; i++) {
      const x = v * i * dt;
      const L = copyLocals(L0);
      footLock(L, R, at(x), st, dt);
      const ax = ankleX(L, x, 'Left');
      if (i > 0) maxStep = Math.max(maxStep, Math.abs(ax - lastX));
      // locked: the ankle stays put in the world (within the soft reach of a near-straight standing leg) while the root moves under it
      if (st.feet.Left.locked) expect(Math.abs(ax - st.feet.Left.lw[0])).toBeLessThan(FOOT_LOCK.maxMiss + 0.001);
      else if (unlockedAt < 0) unlockedAt = i;
      lastX = ax;
      if (!st.feet.Left.locked) liftMax = Math.max(liftMax, fk(L, undefined, R.rest).wp[B.LeftFoot * 3 + 1] - R.rest.wp[B.LeftFoot * 3 + 1]);
    }
    // let go once the leg could not reach the spot (or it drifted too far), then eased back: never a step bigger than a few centimetres
    expect(unlockedAt).toBeGreaterThan(3);
    expect(maxStep).toBeLessThan(0.05);
    // the way back is a step: the foot is off the ground for it
    expect(liftMax).toBeGreaterThan(0.03);
  });
  it('leaves a foot the animation lifts, and an airborne clip, alone', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const st = newFootLock();
    const L = copyLocals(L0);
    expect(footLock(L, R, at(0), st, 1 / 60, true)).toBe(0);
    expect(st.feet.Left.locked).toBe(false);
  });
});
