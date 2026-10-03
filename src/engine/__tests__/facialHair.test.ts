import { describe, expect, it } from 'vitest';
import { boundaryDistance } from '../facialHair';

/** an n x n grid of unit-spaced vertices in the xy plane, two triangles per cell; `seam` duplicates the middle column (a uv seam) */
function grid(n: number, seam = false) {
  const pos: number[] = [];
  const id: number[][] = [];
  for (let y = 0; y < n; y++) {
    id.push([]);
    for (let x = 0; x < n; x++) {
      id[y].push(pos.length / 3);
      pos.push(x, y, 0);
    }
  }
  const mid = Math.floor(n / 2);
  const dup: number[] = [];
  if (seam) for (let y = 0; y < n; y++) { dup.push(pos.length / 3); pos.push(mid, y, 0); }
  const idx: number[] = [];
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const v = (yy: number, xx: number) => (seam && xx === mid && x === mid ? dup[yy] : id[yy][xx]);
      idx.push(v(y, x), v(y, x + 1), v(y + 1, x), v(y, x + 1), v(y + 1, x + 1), v(y + 1, x));
    }
  return { pos, idx };
}

describe('boundaryDistance', () => {
  it('is 0 on the rim and grows inward', () => {
    const { pos, idx } = grid(7);
    const d = boundaryDistance(pos, idx);
    expect(d[0]).toBe(0);
    expect(d[3 * 7 + 3]).toBeCloseTo(3, 5); // the centre is 3 edges from every side
    expect(d[1 * 7 + 1]).toBeCloseTo(1, 5);
  });
  it('does not treat a uv seam (duplicated vertices) as an edge', () => {
    const { pos, idx } = grid(7, true);
    const d = boundaryDistance(pos, idx);
    expect(d[3 * 7 + 3]).toBeCloseTo(3, 5);
    expect(d[49 + 3]).toBeCloseTo(3, 5); // the duplicate of the centre
  });
});
