import { describe, expect, it } from 'vitest';
import { benchLook, loopPhase, loopRate } from '../benchLife';

const ids = Array.from({ length: 12 }, (_, i) => `REN-away-bn${i}`);

describe('bench life', () => {
  it('gives each player his own loop phase and rate, the same every time', () => {
    const ph = ids.map(loopPhase), rt = ids.map(loopRate);
    expect(new Set(ph.map((x) => x.toFixed(3))).size).toBe(ids.length);
    expect(Math.max(...ph) - Math.min(...ph)).toBeGreaterThan(0.5);
    for (const r of rt) expect(r).toBeGreaterThanOrEqual(0.86), expect(r).toBeLessThanOrEqual(1.14);
    expect(loopPhase(ids[3])).toBe(loopPhase(ids[3]));
  });
  it('looks at different things at the same moment, and changes over time', () => {
    for (const t of [5, 30, 61.5, 200]) {
      const at = new Set(ids.map((id) => benchLook(id, t, -1).at));
      expect(at.size).toBeGreaterThanOrEqual(3);
    }
    const seq = new Set(Array.from({ length: 300 }, (_, i) => benchLook(ids[0], i, -1).at));
    expect(seq.size).toBeGreaterThanOrEqual(3);
  });
  it('a ball in play draws most of them, each after his own reaction time', () => {
    const at0 = ids.filter((id) => benchLook(id, 50, 0.05).at === 'ball').length;
    const at1 = ids.filter((id) => benchLook(id, 50, 1.0).at === 'ball').length;
    expect(at0).toBe(0);
    expect(at1).toBeGreaterThanOrEqual(8);
    // they turn at different moments
    const first = ids.map((id) => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].find((l) => benchLook(id, 50, l).at === 'ball') ?? 9);
    expect(new Set(first).size).toBeGreaterThanOrEqual(3);
  });
});
