import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { generateTeam } from '../roster';
import type { GameEvent } from '../types';

function play(seed: string | number, chunk: number, cfg: Record<string, unknown> = {}) {
  const g = createGame({ seed, pace: 0.02, ...cfg });
  const events: GameEvent[] = [];
  g.on('*', (e) => events.push(e));
  let guard = 0;
  while (!g.over && guard++ < 4_000_000) g.step(chunk);
  return { g, events };
}

describe('full game', () => {
  it('plays a complete, consistent game', () => {
    const { g, events } = play('full-1', 0.5);
    const s = g.getState();
    expect(s.gameOver).toBe(true);
    expect(s.winner).not.toBeNull();
    expect(s.score.home).not.toBe(s.score.away);
    expect(s.inning).toBeGreaterThanOrEqual(9);
    const box = g.getBoxScore();
    // the linescore sums to the final score
    expect(box.home.linescore.reduce((a, b) => a + b, 0)).toBe(box.home.runs);
    expect(box.away.linescore.reduce((a, b) => a + b, 0)).toBe(box.away.runs);
    // batting stats agree with the scoreboard
    const sumR = (t: typeof box.home) => t.batters.reduce((a, b) => a + b.line.r, 0);
    expect(sumR(box.home)).toBe(box.home.runs);
    expect(sumR(box.away)).toBe(box.away.runs);
    const outsRecorded = (t: typeof box.home) => t.pitchers.reduce((a, p) => a + p.line.outs, 0);
    // fielding team records 27 outs per full 9 innings (home skips the bottom of the 9th when ahead)
    expect(outsRecorded(box.home)).toBeGreaterThanOrEqual(24);
    expect(outsRecorded(box.away)).toBeGreaterThanOrEqual(24);
    const types = new Set(events.map((e) => e.type));
    for (const t of ['gameStart', 'pitchReleased', 'swing', 'contact', 'call', 'out', 'runScored', 'halfInningStart', 'halfInningEnd', 'batterUp', 'gameEnd']) expect(types.has(t as never)).toBe(true);
  });

  it('is deterministic per seed and independent of how time is chunked', () => {
    const a = play('det-1', 1 / 60);
    const b = play('det-1', 1.0);
    const c = play('det-1', 0.37);
    const key = (r: ReturnType<typeof play>) => JSON.stringify({ s: r.g.getState().score, n: r.events.length, last: r.events.at(-1), lp: r.g.getState().lastPlay });
    expect(key(b)).toBe(key(a));
    expect(key(c)).toBe(key(a));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('different seeds produce genuinely different games', () => {
    const a = play('seed-A', 1);
    const b = play('seed-B', 1);
    expect(JSON.stringify(a.g.getState().score) + a.events.length).not.toBe(JSON.stringify(b.g.getState().score) + b.events.length);
  });

  it('getState is a pure read: calling it (and listeners) does not change the game', () => {
    const g1 = createGame({ seed: 'pure', pace: 0.02 });
    const g2 = createGame({ seed: 'pure', pace: 0.02 });
    for (let i = 0; i < 20000; i++) {
      g1.step(0.05);
      g1.getState();
      g2.step(0.05);
    }
    expect(JSON.stringify(g1.getState())).toBe(JSON.stringify(g2.getState()));
  });

  it('snapshot has the documented shape', () => {
    const g = createGame({ seed: 'shape', pace: 0.05 });
    for (let i = 0; i < 400; i++) g.step(0.05);
    const s = g.getState();
    expect(s.players.filter((p) => p.role !== 'umpire').length).toBeGreaterThanOrEqual(10);
    for (const p of s.players) {
      expect(Number.isFinite(p.pos.x + p.pos.z + p.facing)).toBe(true);
      expect(typeof p.anim).toBe('string');
      expect(p.anim === 'idle' || /^(windup|pitch|swing|run|field|throw|catch|slide|celebrate|trot|transfer|toss|tag_|dive_back|catcher_block|ump_)/.test(p.anim)).toBe(true);
    }
    expect(s.pitcher?.info.name).toBeTruthy();
    expect(s.batter?.info.name).toBeTruthy();
    expect(Number.isFinite(s.ball.pos.x + s.ball.vel.y + s.ball.spin.z)).toBe(true);
  });

  it('honors no-DH and extra-innings rules', () => {
    const away = generateTeam('nodh-a', { side: 'away' });
    const home = generateTeam('nodh-h', { side: 'home' });
    const g = createGame({ seed: 'nodh', pace: 0, dh: false, homeTeam: home, awayTeam: away });
    const w = g._world;
    const pitchers = w.teams.home.lineup.filter((s) => s.position === 'P');
    expect(pitchers.length).toBe(1);
    expect(w.teams.home.lineup.some((s) => s.position === 'DH')).toBe(false);
    // extra innings: a one-inning game that ends tied must continue with the runner on second
    let sawGhost = false;
    for (let s = 0; s < 40 && !sawGhost; s++) {
      const gg = createGame({ seed: 'ex' + s, pace: 0, innings: 1 });
      gg.on('halfInningStart', (e) => {
        if (e.inning === 2 && e.half === 'top') sawGhost = !!gg.getState().runners.second;
      });
      gg.simulateToEnd(5 * 3600);
    }
    expect(sawGhost).toBe(true);
  });
});
