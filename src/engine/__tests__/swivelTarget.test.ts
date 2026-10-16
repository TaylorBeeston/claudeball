import { describe, expect, it } from 'vitest';
import { swivelTarget, type V3 } from '../armClear';

describe('elbow swivel target', () => {
  // shoulder at the origin, hand 0.5 m down +X, elbow 0.15 m toward +Y: the "trunk" makes angles within 35 deg of the start blocked
  const S: V3 = [0, 0, 0], H: V3 = [0.5, 0, 0], E: V3 = [0.25, 0.15, 0];
  const blocked = (lo: number, hi: number) => (p: V3) => {
    const a = Math.atan2(p[2], p[1]);
    return a > lo && a < hi ? -0.05 : 0.05;
  };
  it('is 0 when the elbow is already clear', () => {
    expect(swivelTarget(S, H, E, () => 0.05, 0)).toBe(0);
  });
  it('takes the nearer side with no preference', () => {
    const t = swivelTarget(S, H, E, blocked(-0.5, 0.7), 0);
    expect(t).toBeLessThan(0);
  });
  it("keeps last frame's side unless the other is much shorter (no hop across the body)", () => {
    const t = swivelTarget(S, H, E, blocked(-0.5, 0.7), 1);
    expect(t).toBeGreaterThan(0);
    // far on the preferred side, near on the other: switch
    const t2 = swivelTarget(S, H, E, blocked(-0.3, 2.0), 1);
    expect(t2).toBeLessThan(0);
  });
});
