import { describe, expect, it } from 'vitest';
import { swivelElbow, torsoClearance, torsoVolume, type V3 } from '../armClear';

describe('swivelElbow', () => {
  const v = torsoVolume(undefined);
  // arm chain in the spine frame: shoulder at (0.2, 0, 0), hand held in front of the chest
  const S: V3 = [0.2, 0.0, 0.0], H: V3 = [0.02, -0.25, 0.22];
  const L1 = 0.28, L2 = 0.27;
  const elbowFor = (angle: number): V3 => {
    const sh = [H[0] - S[0], H[1] - S[1], H[2] - S[2]];
    const d = Math.hypot(sh[0], sh[1], sh[2]);
    const n = sh.map((x) => x / d);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(L1 * L1 - a * a);
    let u = [0, 1, 0];
    const k = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
    u = u.map((x, i) => x - k * n[i]);
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = u.map((x) => x / ul);
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    return [0, 1, 2].map((i) => S[i] + n[i] * a + h * (Math.cos(angle) * u[i] + Math.sin(angle) * w[i])) as V3;
  };
  const clearance = (p: V3) => torsoClearance(p[0], p[1], p[2], v);

  it('moves an elbow out of the torso, keeping both bone lengths (the hand does not move)', () => {
    let bad = elbowFor(0), worst = clearance(bad);
    for (let t = -Math.PI; t <= Math.PI; t += 0.1) {
      const e = elbowFor(t);
      if (clearance(e) < worst) {
        worst = clearance(e);
        bad = e;
      }
    }
    expect(worst).toBeLessThan(0);
    const r = swivelElbow(S, H, bad, clearance, 0.015);
    expect(r.clear).toBeGreaterThanOrEqual(0.015);
    const d1 = Math.hypot(r.elbow[0] - S[0], r.elbow[1] - S[1], r.elbow[2] - S[2]);
    const d2 = Math.hypot(r.elbow[0] - H[0], r.elbow[1] - H[1], r.elbow[2] - H[2]);
    expect(d1).toBeCloseTo(L1, 6);
    expect(d2).toBeCloseTo(L2, 6);
  });

  it('does nothing for an elbow that is already clear', () => {
    let good = elbowFor(0);
    for (let t = -Math.PI; t <= Math.PI; t += 0.1) if (clearance(elbowFor(t)) > clearance(good)) good = elbowFor(t);
    const r = swivelElbow(S, H, good, clearance, 0.015);
    expect(r.angle).toBe(0);
    expect(r.elbow).toEqual(good);
  });

  it('returns a finite best-effort swivel when the hand is buried in the torso', () => {
    const buried: V3 = [0.0, -0.2, 0.0];
    const r = swivelElbow(S, buried, [0.1, -0.1, 0.05], clearance, 0.015);
    expect(Number.isFinite(r.clear)).toBe(true);
  });
});
