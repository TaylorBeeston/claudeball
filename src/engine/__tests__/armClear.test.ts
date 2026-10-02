import { describe, expect, it } from 'vitest';
import { pushOutsideTorso, torsoClearance, torsoRadius, torsoVolume } from '../armClear';

describe('elbow clearance', () => {
  const v = torsoVolume(undefined);
  it('grows the trunk with stocky / muscular builds and shrinks it for lean ones', () => {
    const stocky = torsoVolume({ build_stocky: 1 });
    const lean = torsoVolume({ build_lean: 1 });
    expect(stocky.halfW).toBeGreaterThan(v.halfW);
    expect(stocky.halfD).toBeGreaterThan(v.halfD);
    expect(lean.halfW).toBeLessThan(v.halfW);
    expect(torsoVolume({ build_muscular: 1 }).halfW).toBeGreaterThan(v.halfW);
  });
  it('knows what is inside the trunk, only within its height band', () => {
    expect(torsoRadius(0.05, -0.2, 0.0, v)).toBeLessThan(1);
    expect(torsoRadius(0.3, -0.2, 0, v)).toBeGreaterThan(1);
    expect(torsoRadius(0.05, 0.6, 0, v)).toBe(Infinity);
    expect(torsoClearance(0.05, -0.2, 0, v)).toBeLessThan(0);
    expect(torsoClearance(0.3, -0.2, 0, v)).toBeGreaterThan(0);
  });
  it('pushes an elbow that is inside the torso out to the surface plus a margin, in the same direction', () => {
    const [x, z] = pushOutsideTorso(0.08, -0.2, 0.05, v, 1, 0.02);
    expect(torsoClearance(x, -0.2, z, v)).toBeGreaterThanOrEqual(0.0199);
    expect(x).toBeGreaterThan(0.08); // pushed away from the axis, not across it
    expect(z).toBeGreaterThan(0.05 - 1e-9);
  });
  it('leaves elbows that are clear alone, and handles a point on the spine axis', () => {
    const [x, z] = pushOutsideTorso(0.3, -0.2, 0.02, v, 1);
    expect(x).toBe(0.3);
    expect(z).toBe(0.02);
    const [ax] = pushOutsideTorso(0, -0.1, v.zOff, v, -1);
    expect(ax).toBeLessThan(0);
    expect(Math.abs(ax)).toBeGreaterThan(v.halfW);
  });
  it('never pushes an elbow that is outside the height band', () => {
    const [x, z] = pushOutsideTorso(0.0, 0.5, 0.0, v, 1);
    expect(x).toBe(0);
    expect(z).toBe(0);
  });
  it('the result of a push is stable (idempotent)', () => {
    const a = pushOutsideTorso(-0.06, -0.3, -0.03, v, -1, 0.02);
    const b = pushOutsideTorso(a[0], -0.3, a[1], v, -1, 0.02);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });
});

import { armHeadClearance, headClearance, headVolume, swivelElbow, type V3 } from '../armClear';

describe('head volume clearance', () => {
  const v = headVolume(undefined, true);
  const centre: V3 = [0, 1.7, 0];
  it('is negative inside the head sphere and positive outside', () => {
    expect(headClearance(centre, centre, v)).toBeCloseTo(-v.radius, 6);
    expect(headClearance([0, 1.7, v.radius + 0.1], centre, v)).toBeCloseTo(0.1, 6);
  });
  it('a helmet and wide-head morph make a bigger head, narrow a smaller one', () => {
    expect(headVolume(undefined, true).radius).toBeGreaterThan(headVolume(undefined, false).radius);
    expect(headVolume({ head_wide: 1 }).radius).toBeGreaterThan(headVolume({ head_narrow: 1 }).radius);
  });
  it('an elbow swung through the head is swivelled out round the shoulder-hand axis, the hand staying put', () => {
    const S: V3 = [0.2, 1.55, 0], H: V3 = [0.12, 1.85, 0.25];
    const E: V3 = [0.05, 1.72, 0.1]; // elbow inside the head sphere (a bent arm raised past the ear)
    const clearance = (p: V3) => armHeadClearance(S, p, H, centre, v);
    expect(clearance(E)).toBeLessThan(0);
    const r = swivelElbow(S, H, E, clearance, 0.015);
    expect(r.clear).toBeGreaterThanOrEqual(0.015 - 1e-9);
    // both bones keep their lengths
    const d = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(d(S, r.elbow)).toBeCloseTo(d(S, E), 6);
    expect(d(r.elbow, H)).toBeCloseTo(d(E, H), 6);
  });
});
