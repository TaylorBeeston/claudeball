import { describe, expect, it } from 'vitest';
import { WARPS, warpProgress } from '../clipWarp';

describe('clip time warps', () => {
  it('start at the clip start, end at its end, and never run backwards', () => {
    for (const [name, w] of Object.entries(WARPS)) {
      if (name === 'bench_sit_down' || name === 'bench_stand' || name === 'batter_tap_cleats') continue; // (a clip backwards, held, a part of one)
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
  it('play the practice swings to their finish at the clip speed, hold it, then take the rest of the hint for the way back', () => {
    // on deck: the clip's finish (1.0 s of 1.333) is reached at 1.0 s of the 2.0 s hint (its own speed), held 0.2 s, then 0.8 s for the 8 frames back
    const od = WARPS.ondeck_swing;
    expect(warpProgress(od, 0.5) * 1.333).toBeCloseTo(1.0, 2);
    expect(warpProgress(od, 0.6)).toBeLessThan(0.77);
    // the way back (finish -> ready, 8 frames = 0.33 s of clip) takes at least 0.8 s of the hint (laid linearly: 0.5 s)
    const fin = 24 / 32;
    const back = [...Array(201).keys()].map((i) => i / 200).filter((u) => warpProgress(od, u) > fin + 0.005);
    expect((1 - back[0]) * 2.0).toBeGreaterThan(0.8);
  });
  it('sit-down is the stand-up clip backwards', () => {
    const w = WARPS.bench_sit_down;
    expect(w.clip).toBe('bench_stand_up');
    expect(warpProgress(w, 0)).toBe(1);
    expect(warpProgress(w, 1)).toBe(0);
    expect(warpProgress(w, 0.5)).toBeCloseTo(0.5, 6);
  });
});
