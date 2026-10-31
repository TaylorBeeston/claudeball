import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { CALL_FOR } from '../fielding';
import type { GameEvent } from '../types';

type Call = Extract<GameEvent, { type: 'callForBall' }>;

/** The first innings of a seeded game: every call for a fly ball, whether that ball was a line drive, and the next air catch after it. */
function calls(seed: number, innings = 5) {
  const g = createGame({ seed, pace: 1 } as never);
  const w = g._world;
  const out: { c: Call; line: boolean; calling: number | undefined; catch: Extract<GameEvent, { type: 'catch' }> | null }[] = [];
  g.on('*', (e: GameEvent) => {
    if (e.type === 'callForBall') out.push({ c: e, line: !!w.play?.bip?.line, calling: undefined, catch: null });
    if (e.type === 'catch' && e.fly) for (const o of out) o.catch ??= e;
  });
  let n = 0;
  while (!g.over && w.inning <= innings && n++ < 240 * 3600) {
    g.step(1 / 240);
    const o = out[out.length - 1];
    if (o && o.calling === undefined) o.calling = g.getState().players.find((p) => p.id === o.c.fielderId)?.calling;
  }
  return out;
}

describe('calling for a fly ball', () => {
  const all = [...calls(1), ...calls(2)];

  it('the fielder who calls for it makes the catch, 1 to 2.5 s later', () => {
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const { c, catch: k } of all) {
      expect(k).not.toBeNull();
      expect(k!.fielderId).toBe(c.fielderId);
      const dt = k!.time - c.time;
      expect(dt).toBeGreaterThanOrEqual(CALL_FOR.tMin - 0.1);
      expect(dt).toBeLessThanOrEqual(CALL_FOR.tMax + 0.1);
      expect(c.eta).toBeGreaterThanOrEqual(CALL_FOR.tMin);
      expect(c.eta).toBeLessThanOrEqual(CALL_FOR.tMax);
    }
  });

  it('never on a line drive', () => {
    for (const o of all) expect(o.line).toBe(false);
  });

  it('the snapshot reports how long ago he called', () => {
    for (const o of all) {
      expect(o.calling).toBeGreaterThanOrEqual(0);
      expect(o.calling).toBeLessThan(0.1);
    }
  });
});
