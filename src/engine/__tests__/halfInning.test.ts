import { describe, expect, it } from 'vitest';
import { createGame } from '../../sim/game';
import { RealSimAdapter, type RealGame } from '../realSimAdapter';
import type { GameEvent } from '../types';

/** A whole short game through the engine adapter, recording what the HUD, director and booth are told. */
function play(seed: string) {
  const g = createGame({ seed, innings: 2, pace: 0 });
  const a = new RealSimAdapter(g as unknown as RealGame);
  const events: GameEvent[] = [];
  const ends: { final: boolean }[] = [];
  g.on('halfInningEnd', (e) => ends.push(e));
  a.on((e) => events.push(e));
  while (!g.over && g._world.tick < 240 * 3600) a.step(1 / 60);
  return { w: g._world, events, ends };
}

describe('half innings at the end of a game', () => {
  // seeds whose 2-inning game ends after the top of the 2nd (home ahead) and after the bottom of the 2nd
  const games = ['hi-1', 'hi-2', 'hi-3', 'hi-4', 'hi-5', 'hi-6'].map(play);

  it('no half inning is announced after the one that ends the game', () => {
    for (const { w, events } of games) {
      expect(w.gameOver).toBe(true);
      const end = events.findIndex((e) => e.type === 'game_end');
      expect(end).toBeGreaterThan(0);
      const halves = events.filter((e): e is Extract<GameEvent, { type: 'half_inning' }> => e.type === 'half_inning');
      const lastHalf = halves[halves.length - 1];
      // the last announced half is the one the game ended in, never the next one ("Top of inning 3 - Game over")
      expect({ inning: lastHalf.inning, half: lastHalf.half }).toEqual({ inning: w.inning, half: w.half });
      expect(lastHalf.inning).toBeLessThanOrEqual(2);
    }
  });

  it("the sim marks only the game's last halfInningEnd as final", () => {
    for (const { ends } of games) {
      expect(ends.map((e) => e.final)).toEqual([...ends.slice(1).map(() => false), true]);
    }
  });

  it('covers both endings: home ahead after the top of the last inning, and a decision in the bottom', () => {
    const halves = new Set(games.filter((x) => x.w.inning === 2).map((x) => x.w.half));
    expect([...halves].sort()).toEqual(['bottom', 'top']);
  });
});
