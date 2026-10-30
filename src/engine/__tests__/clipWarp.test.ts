import { describe, expect, it } from 'vitest';
import { WARPS, warpProgress } from '../clipWarp';

describe('clip time warps', () => {
  it('start at the clip start, end at its end, and never run backwards before a jump', () => {
    for (const [name, w] of Object.entries(WARPS)) {
      if (name === 'bench_sit_down') continue;
      expect(warpProgress(w, 0)).toBe(0);
      expect(warpProgress(w, 1)).toBeCloseTo(1, 6);
      let last = -1;
      for (let i = 0; i <= 200; i++) {
        const v = warpProgress(w, i / 200);
        expect(v).toBeGreaterThanOrEqual(last - 1e-9);
        last = v;
      }
    }
  });
  it('play the practice swings to their finish at the clip speed, then hold it before the jump', () => {
    // on deck: the clip's finish (1.0 s of 1.333) is reached at 1.0 s of the 2.0 s hint (its own speed), held, then the jump to the carry key
    const od = WARPS.ondeck_swing;
    expect(warpProgress(od, 0.5) * 1.333).toBeCloseTo(1.0, 2);
    expect(warpProgress(od, od.jump!.at - 1e-6)).toBeLessThan(0.77);
    expect(warpProgress(od, od.jump!.at)).toBeCloseTo(28 / 32, 6);
  });
  it('sit-down is the stand-up clip backwards', () => {
    const w = WARPS.bench_sit_down;
    expect(w.clip).toBe('bench_stand_up');
    expect(warpProgress(w, 0)).toBe(1);
    expect(warpProgress(w, 1)).toBe(0);
    expect(warpProgress(w, 0.5)).toBeCloseTo(0.5, 6);
  });
});
