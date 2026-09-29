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
