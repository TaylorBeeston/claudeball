import { describe, expect, it } from 'vitest';
import { createGame } from '../../sim/game';
import { RealSimAdapter, type RealGame } from '../realSimAdapter';

describe('the count after a plate appearance ends', () => {
  it('is flagged as finished (paOver) from the end of the PA until the next batter steps in with 0-0', () => {
    const g = createGame({ seed: 'pa-over', innings: 1, pace: 1, tempo: 'broadcast' });
    const a = new RealSimAdapter(g as unknown as RealGame);
    let ended = 0, fullCounts = 0, stepIns = 0;
    let phase = 'live' as 'live' | 'over' | 'break';
    g.on('plateAppearanceEnd', () => (phase = 'over'));
    g.on('batterUp', () => (phase = 'live'));
    g.on('halfInningEnd', () => (phase = 'break')); // the next half starts from a fresh 0-0
    while (!g.over && g._world.tick < 240 * 3600) {
      a.step(1 / 60);
      const s = a.getState();
      if (phase === 'over') {
        ended++;
        // the scorebug and the park board read this flag and show 0-0 instead of the finished count
        expect(s.paOver).toBe(true);
        if (s.count.balls >= 3 || s.count.strikes >= 2) fullCounts++;
      } else if (!g.over && g._world.batter && s.paOver === false) {
        stepIns++;
      }
    }
    expect(ended).toBeGreaterThan(0);
    expect(fullCounts).toBeGreaterThan(0); // the sim does hold the finished count meanwhile: what made the dots look stale
    expect(stepIns).toBeGreaterThan(0);
  });
});
