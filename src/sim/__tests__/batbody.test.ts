import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { ARM_REACH, shoulderFor } from '../batting';

describe('bat vs batter body', () => {
  it('keeps the knob within arm reach of the batter\'s shoulders through every swing', () => {
    const g = createGame({ seed: 'body-1', pace: 0 });
    let swingsSeen = 0;
    let frames = 0;
    let worst = 0;
    let wasActive = false;
    for (let i = 0; i < 40_000 && swingsSeen < 40; i++) {
      g.step(1 / 120);
      const s = g.getState();
      if (!s.bat.active) {
        wasActive = false;
        continue;
      }
      if (!wasActive) swingsSeen++;
      wasActive = true;
      const sh = shoulderFor(g._world.batStance);
      const k = s.bat.knob;
      worst = Math.max(worst, Math.hypot(k.x - sh.x, k.y - sh.y, k.z - sh.z));
      frames++;
    }
    expect(swingsSeen).toBeGreaterThanOrEqual(20);
    expect(frames).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(ARM_REACH + 1e-6);
  });
});
