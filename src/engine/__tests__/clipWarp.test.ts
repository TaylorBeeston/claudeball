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
  it('play the practice swings at the clip speed (never faster), then ease the last frames out to rest', () => {
    // on deck: 2.0 s hint, 1.833 s clip; in the box: 1.75-1.95 s hint, 1.667 s clip (the re-keyed clips of t-0038 bring the bat back in ~0.5 s)
    for (const [name, len] of [['ondeck_swing', 44 / 24], ['batter_practice_swing', 40 / 24]] as const) {
      const w = WARPS[name];
      for (let i = 1; i <= 100; i++) {
        const u0 = (i - 1) / 100, u1 = i / 100;
        const speed = ((warpProgress(w, u1) - warpProgress(w, u0)) * len) / ((u1 - u0) * w.sec);
        expect(speed, `${name} at ${u1}`).toBeLessThanOrEqual(1.001);
      }
      expect(warpProgress(w, (len / w.sec) * 0.5)).toBeCloseTo(0.5, 2);
      expect(warpProgress(w, 0.995)).toBeGreaterThan(0.999);
    }
  });
  it('sit-down is the stand-up clip backwards', () => {
    const w = WARPS.bench_sit_down;
    expect(w.clip).toBe('bench_stand_up');
    expect(warpProgress(w, 0)).toBe(1);
    expect(warpProgress(w, 1)).toBe(0);
    expect(warpProgress(w, 0.5)).toBeCloseTo(0.5, 6);
  });
});
