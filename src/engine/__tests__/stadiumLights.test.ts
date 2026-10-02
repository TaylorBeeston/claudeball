import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { aimPoint, CAST_SHARE, LIGHT_BUDGETS, shadowOrder, spotWeights, unitsToShadowLimit } from '../stadiumLights';

const towers = [[91, 49, 71], [-91, 49, 70], [104, 49, 0], [-105, 49, -1], [26, 49, 138], [-26, 49, 138]].map(([x, y, z]) => new Vector3(x, y, z));

describe('stadium lights', () => {
  it('keeps the total light constant whatever number of spots cast shadows', () => {
    for (const n of [3, 6, 8]) for (let c = 0; c <= n; c++) {
      const w = spotWeights(n, c);
      expect(w.cast * c + w.plain * (n - c)).toBeCloseTo(n, 6);
    }
    expect(spotWeights(6, 3).cast * 3).toBeCloseTo(CAST_SHARE * 6, 6);
  });
  it('aims every tower at the field, towers on either side across it', () => {
    towers.forEach((t, i) => {
      const a = aimPoint(t, i);
      expect(a.y).toBe(0);
      expect(a.z).toBeGreaterThan(20);
      expect(Math.sign(a.x) * Math.sign(t.x)).toBeLessThanOrEqual(0);
    });
  });
  it('ranks all towers for shadows, side towers first', () => {
    const o = shadowOrder(towers);
    expect([...o].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect([2, 3]).toContain(o[0]);
  });
  it('limits shadow spots on GPUs with few texture units', () => {
    expect(unitsToShadowLimit(32)).toBe(4);
    expect(unitsToShadowLimit(16)).toBe(2);
    expect(unitsToShadowLimit(8)).toBe(0);
  });
  it('budgets shrink with quality and never ask for more shadows than spots', () => {
    for (const b of Object.values(LIGHT_BUDGETS)) expect(b.shadows).toBeLessThanOrEqual(b.spots);
    expect(LIGHT_BUDGETS.low.shadows).toBe(0);
    expect(LIGHT_BUDGETS.ultra.shadows).toBeGreaterThan(LIGHT_BUDGETS.medium.shadows);
  });
});
