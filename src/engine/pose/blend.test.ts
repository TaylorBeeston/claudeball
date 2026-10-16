import { describe, expect, it } from 'vitest';
import { ContinuousBlend } from './blend';
import { slerpRaw } from '../../../tools/jank/glb';

const axisAngle = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
const angleBetween = (a: ArrayLike<number>, b: ArrayLike<number>) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;

describe('ContinuousBlend', () => {
  // the outgoing clip holds a bone still, the incoming one turns it from 150 to 220 deg about Y while the weight goes 0 -> 1: the two cross half a
  // turn apart mid-fade
  const frames = 30;
  const run = (blend: (a: number[], b: number[], w: number, i: number, out: number[]) => void) => {
    let prev: number[] | null = null, worst = 0;
    for (let i = 0; i <= frames; i++) {
      const a = axisAngle(0), b = axisAngle(150 + (70 * i) / frames), out = [0, 0, 0, 1];
      blend(a, b, i / frames, i, out);
      if (prev) worst = Math.max(worst, angleBetween(prev, out));
      prev = out;
    }
    return worst;
  };
  it('three-style shortest-arc slerp turns the bone the other way round in one frame', () => {
    const worst = run((a, b, w, _i, out) => slerpRaw(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], w, out, 0));
    expect(worst).toBeGreaterThan(60);
  });
  it('keeps the arc it started on: every step small', () => {
    const cb = new ContinuousBlend();
    const worst = run((a, b, w, i, out) => cb.blend(a, 0, b, 0, w, 0, out, 0, i === 0));
    expect(worst).toBeLessThan(15);
  });
  it('is the plain slerp when the two rotations stay close', () => {
    const cb = new ContinuousBlend();
    const out = [0, 0, 0, 1], ref = [0, 0, 0, 1];
    const a = axisAngle(10), b = axisAngle(70);
    cb.blend(a, 0, b, 0, 0.5, 0, out, 0, true);
    slerpRaw(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], 0.5, ref, 0);
    expect(angleBetween(out, ref)).toBeLessThan(1e-6);
  });
});
