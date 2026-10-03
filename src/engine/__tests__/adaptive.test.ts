import { describe, expect, it } from 'vitest';
import { AdaptiveScale, LOAD_LEVELS, loadEffects } from '../quality';

const run = (a: AdaptiveScale, seconds: number, jsMs: number, frameMs: number) => {
  let changes = 0;
  for (let t = 0; t < seconds; t += 1 / 60) if (a.update(jsMs, frameMs, 1 / 60)) changes++;
  return changes;
};

describe('AdaptiveScale', () => {
  it('lowers the CPU load level first when the main thread is the bottleneck', () => {
    const a = new AdaptiveScale();
    run(a, 3, 20, 33);
    expect(a.level).toBeGreaterThan(0);
    expect(a.scale).toBe(1);
  });
  it('lowers the render scale first when the main thread is idle (GPU-bound)', () => {
    const a = new AdaptiveScale();
    run(a, 3, 4, 33);
    expect(a.scale).toBeLessThan(1);
    expect(a.level).toBe(0);
  });
  it('restores at 60 Hz vsync once the JS time shows headroom (the old controller never did)', () => {
    const a = new AdaptiveScale();
    run(a, 3, 4, 33);
    expect(a.scale).toBeLessThan(1);
    run(a, 120, 4, 16.7);
    expect(a.scale).toBe(1);
  });
  it('does not oscillate: a restore that is followed by a degrade makes the next restore wait longer', () => {
    const a = new AdaptiveScale();
    let changes = 0;
    // alternate: 20 s of calm, 3 s of slow, repeat (a scene that is just over the limit at full quality)
    for (let i = 0; i < 6; i++) {
      changes += run(a, 20, 4, 16.7);
      changes += run(a, 3, 4, 33);
    }
    expect(changes).toBeLessThan(40);
  });
  it('never exceeds its limits and is inert when disabled', () => {
    const a = new AdaptiveScale();
    run(a, 60, 30, 60);
    expect(a.level).toBe(LOAD_LEVELS);
    expect(a.scale).toBeCloseTo(a.min, 5);
    const b = new AdaptiveScale();
    b.enabled = false;
    expect(run(b, 10, 30, 60)).toBe(0);
  });
  it('load effects are cumulative', () => {
    expect(loadEffects(0)).toMatchObject({ lodScale: 1, noAo: false, farShadowEvery: 1 });
    expect(loadEffects(4)).toMatchObject({ lodScale: 1.5, noAo: true, farShadowEvery: 2, crowdAnimate: false, crowdSectors: 4 });
  });
});
