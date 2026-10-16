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
  // 2-inning games that end after the top of the 2nd (home ahead) and after the bottom of the 2nd (three outs: not a walk-off), picked
  // from a pool of seeds so the test does not hang on one seed's timeline
  const games = Array.from({ length: 16 }, (_, i) => play(`hi-${i + 1}`)).filter((g) => g.w.inning === 2 && g.w.outs === 3).slice(0, 6);
  it('the pool has games ending after the top and after the bottom of the 2nd', () => {
    expect(games.length).toBeGreaterThanOrEqual(4);
    expect(games.some((g) => g.w.half === 'top')).toBe(true);
    expect(games.some((g) => g.w.half === 'bottom')).toBe(true);
  });

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
