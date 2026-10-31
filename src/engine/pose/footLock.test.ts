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
/** the model matrix of a body turned to heading `y` (rad, about +Y: three's convention; heading atan2(m8, m10)) at the origin */
const turned = (y: number) => [Math.cos(y), 0, -Math.sin(y), 0, 0, 1, 0, 0, Math.sin(y), 0, Math.cos(y), 0, 0, 0, 0, 1];
const world = (L: ReturnType<typeof sampleClip>, m: number[], i: number) => {
  const p = fk(L, undefined, R.rest).wp;
  const [x, y, z] = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
};
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
    // let go once the leg could not reach the spot (or it drifted too far), then a step: never more than a swinging foot's ~3.5 m/s a frame
    expect(unlockedAt).toBeGreaterThan(3);
    expect(maxStep).toBeLessThan(0.06);
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
  it('a quick turn on the spot: a planted foot keeps its heading (its ball does not sweep round the ankle) until the body has turned past maxTurn', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const st = newFootLock();
    const dt = 1 / 60;
    let toe0: number[] | null = null, sweep = 0;
    // 12 deg in 0.1 s (2 rad/s, well over FOOT_LOCK.relax), below FOOT_LOCK.maxTurn
    for (let i = 0; i < 7; i++) {
      const m = turned((i * 2 * Math.PI) / 180);
      const L = copyLocals(L0);
      footLock(L, R, m, st, dt);
      const t = world(L, m, B.LeftToeBase);
      if (st.feet.Left.locked) {
        toe0 ??= t;
        sweep = Math.max(sweep, Math.hypot(t[0] - toe0[0], t[2] - toe0[2]));
      }
    }
    expect(st.feet.Left.locked && st.feet.Right.locked).toBe(true);
    // (it gives way at FOOT_LOCK.relax: ~1 rad/s x 0.1 s on a ~0.2 m foot, a couple of centimetres; the body turned 12 deg, ~4 cm at the ball)
    expect(sweep).toBeLessThan(0.025);
  });
  it('a turn on the spot at 5 rad/s: one foot steps while the other pivots on its ball (heel up, ball kept), never both dragged round', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const st = newFootLock();
    const dt = 1 / 60;
    for (let i = 0; i < 10; i++) footLock(copyLocals(L0), R, turned(0), st, dt);
    let pivots = 0, ballSlip = 0, bothOff = 0;
    let ball: number[] | null = null;
    for (let i = 0; i < 36; i++) {
      const m = turned(5 * dt * (i + 1));
      const L = copyLocals(L0);
      footLock(L, R, m, st, dt);
      const fs = [st.feet.Left, st.feet.Right];
      if (!fs[0].locked && !fs[1].locked) bothOff++;
      const pv = (['Left', 'Right'] as const).find((s) => st.feet[s].pivot);
      if (pv) {
        pivots++;
        const t = world(L, m, B[`${pv}ToeBase`]);
        ball ??= t;
        ballSlip = Math.max(ballSlip, Math.hypot(t[0] - ball[0], t[2] - ball[2]));
      } else ball = null;
    }
    expect(pivots).toBeGreaterThan(5);
    expect(ballSlip).toBeLessThan(0.02);
    expect(bothOff).toBe(0);
  });
  it('a slow turn (under FOOT_LOCK.relax) turns the planted foot with the body: no ankle wound up in a crouch', () => {
    const L0 = sampleClip(rig.clips.get('idle')!, 0.5, rig.rest);
    const st = newFootLock();
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) footLock(copyLocals(L0), R, turned(0.5 * dt * i), st, dt);
    expect(Math.abs(st.feet.Left.th)).toBeLessThan(0.01);
  });
});
