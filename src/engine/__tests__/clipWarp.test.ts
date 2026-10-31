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
  it('play the practice swings to their finish at the clip speed, then the way back slower (never faster than the clip)', () => {
    // on deck: 2.2 s hint, 1.833 s clip, finish at frame 24 of 44; in the box: 2.0-2.2 s hint, 1.667 s clip, finish at frame 20 of 40
    for (const [name, len, fin] of [['ondeck_swing', 44 / 24, 24 / 44], ['batter_practice_swing', 40 / 24, 20 / 40]] as const) {
      const w = WARPS[name];
      const speed = (u0: number, u1: number) => ((warpProgress(w, u1) - warpProgress(w, u0)) * len) / ((u1 - u0) * w.sec);
      for (let i = 1; i <= 100; i++) expect(speed((i - 1) / 100, i / 100), `${name} at ${i / 100}`).toBeLessThanOrEqual(1.001);
      const uFin = (fin * len) / w.sec;
      expect(warpProgress(w, uFin)).toBeCloseTo(fin, 3);
      expect(speed(0, uFin)).toBeCloseTo(1, 3);
      expect(speed(uFin, 1)).toBeLessThan(0.85);
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
