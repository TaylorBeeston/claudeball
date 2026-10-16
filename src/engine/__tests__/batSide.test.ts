import { describe, expect, it } from 'vitest';
import { createGame } from '../../sim/game';
import { RealSimAdapter, type RealGame } from '../realSimAdapter';

describe('a batter who becomes a runner keeps his batting side', () => {
  it('never switches handedness (the left-hander mirror) between batting and running', () => {
    let switches = 0;
    for (const seed of ['bat-side-1', 'bat-side-2', 'bat-side-3']) {
      const g = createGame({ seed, innings: 2, pace: 1, tempo: 'quick' });
      const a = new RealSimAdapter(g as unknown as RealGame);
      const last = new Map<string, { role: string; hand?: string }>();
      while (!g.over && g._world.tick < 240 * 3600) {
        a.step(1 / 60);
        for (const p of a.getState().players) {
          const l = last.get(p.id);
          if (l && l.role === 'batter' && p.role === 'runner') {
            switches++;
            expect(p.hand).toBe(l.hand);
          }
          last.set(p.id, { role: p.role, hand: p.hand });
        }
      }
    }
    expect(switches).toBeGreaterThan(3);
  });
});
