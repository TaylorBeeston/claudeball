import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { ARM_REACH, CONTACT_HOLD, TORSO_CLEAR, shoulderFor } from '../batting';

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
      // (a bunt presents the bat square to the pitch instead of swinging it, so the swing's reach limit does not apply)
      if (!s.bat.active || g._world.swingPlan?.bunt) {
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

  it('keeps the hands off the chest line except right at contact (where the planned geometry is left alone)', () => {
    const g = createGame({ seed: 'body-2', pace: 0 });
    const w = g._world;
    let swings = 0;
    let wasActive = false;
    let off = 0;
    let near = 0;
    let worstOff = Infinity;
    for (let i = 0; i < 60_000 && swings < 40; i++) {
      g.step(1 / 240);
      const sw = w.swing;
      if (!sw || !w.swingStarted || sw.plan.bunt || sw.done) {
        wasActive = false;
        continue;
      }
      if (!wasActive) swings++;
      wasActive = true;
      const sh = shoulderFor(w.batStance);
      const k = sw.pose().knob;
      const d = Math.hypot(k.x - sh.x, k.z - sh.z);
      if (Math.abs(sw.tau - sw.plan.tauC) > CONTACT_HOLD * 1.5) {
        off++;
        worstOff = Math.min(worstOff, d);
      } else near++;
    }
    expect(off).toBeGreaterThan(200);
    expect(near).toBeGreaterThan(20);
    // (a small allowance: the reach limit can win over the clearance where the two meet)
    expect(worstOff).toBeGreaterThan(TORSO_CLEAR * 0.6);
  });
});
