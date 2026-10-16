import { describe, expect, it } from 'vitest';
import { Inertia } from './inertia';
import { NB, newLocals } from './skeleton';
import { qaxisAngle, qdist } from './qmath';

const pose = (ang: number) => {
  const L = newLocals();
  for (let i = 0; i < NB; i++) L.lq.set(qaxisAngle(0, 1, 0, ang), i * 4);
  return L;
};

describe('inertialization', () => {
  it('starts exactly at the old pose, ends exactly at the new clip, and moves monotonically', () => {
    const src = pose(1.2), inert = new Inertia();
    inert.start(src.lq, src.lp, 0.3);
    let prev = Infinity;
    for (let f = 0; f <= 30; f++) {
      const L = pose(0.2);
      inert.apply(L, 1 / 60);
      const d = qdist(L.lq, pose(0.2).lq);
      if (f === 0) expect(qdist(L.lq, src.lq)).toBeLessThan(1e-6);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
    expect(prev).toBeLessThan(1e-4);
    expect(inert.active).toBe(false);
  });
  it('keeps to one path between poses nearly half a turn apart (a crossfade between two live clips can switch sides mid-way)', () => {
    const src = pose(0), inert = new Inertia();
    inert.start(src.lq, src.lp, 0.3);
    let last = newLocals().lq;
    for (let f = 0; f <= 20; f++) {
      // the new clip itself moves across the half-turn while the offset decays
      const L = pose(Math.PI * (0.95 + 0.002 * f));
      inert.apply(L, 1 / 60);
      if (f > 0) expect(qdist(L.lq, last)).toBeLessThan(0.35);
      last = L.lq.slice();
    }
  });
});
