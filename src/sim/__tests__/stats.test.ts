import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { simulateSeason } from '../season';
import { batterStats, inningsString, pitcherStats } from '../stats';
import type { GameEvent } from '../types';

describe('live box-score stats', () => {
  it('the snapshot carries every player\'s game and season lines, consistent with the scoreboard', () => {
    const g = createGame({ seed: 'stats-1', pace: 0.02 });
    const events: GameEvent[] = [];
    g.on('*', (e) => events.push(e));
    let mid = null as ReturnType<typeof g.getState> | null;
    let i = 0;
    while (!g.over && i++ < 4_000_000) {
      g.step(0.5);
      if (!mid && g.getState().inning === 5) mid = g.getState();
    }
    const s = g.getState();
    for (const side of ['home', 'away'] as const) {
      const t = s.stats![side];
      expect(t.batters.length).toBeGreaterThanOrEqual(9);
      expect(t.pitchers.length).toBeGreaterThanOrEqual(1);
      expect(t.batters.reduce((a, b) => a + b.game.batting.r, 0)).toBe(s.score[side]);
      expect(t.batters.reduce((a, b) => a + b.game.batting.h, 0)).toBe(t.totals.hits);
      expect(t.totals.runs).toBe(s.score[side]);
      // the other side's pitchers gave up exactly those runs
      const other = side === 'home' ? 'away' : 'home';
      expect(s.stats![other].pitchers.reduce((a, p) => a + p.game.pitching!.r, 0)).toBe(s.score[side]);
      for (const b of t.batters) {
        const l = b.game.batting;
        expect(l.h).toBeLessThanOrEqual(l.ab);
        expect(l.doubles + l.triples + l.hr).toBeLessThanOrEqual(l.h);
        if (l.ab) expect(l.avg).toBeCloseTo(l.h / l.ab, 6);
        // with no prior stats the season line is this game
        expect(b.season.batting.ab).toBe(l.ab);
      }
      for (const p of t.pitchers) {
        expect(p.game.pitching!.ip).toBe(inningsString(p.game.pitching!.outs));
        if (p.game.pitching!.outs) expect(p.game.pitching!.era).toBeCloseTo((27 * p.game.pitching!.er) / p.game.pitching!.outs, 6);
      }
      // home runs and strikeouts agree with the events
      const mine = (e: GameEvent) => 'batterId' in e && (e as { batterId: string }).batterId.includes(`-${side}-`);
      expect(t.batters.reduce((a, b) => a + b.game.batting.hr, 0)).toBe(events.filter((e) => e.type === 'plateAppearanceEnd' && e.result === 'home run' && mine(e)).length);
      expect(t.batters.reduce((a, b) => a + b.game.batting.so, 0)).toBe(events.filter((e) => e.type === 'plateAppearanceEnd' && e.result.startsWith('strikeout') && mine(e)).length);
    }
    // it is live: stats only ever grow
    expect(mid).not.toBeNull();
    const totalAb = (st: NonNullable<typeof mid>) => st.stats!.home.batters.concat(st.stats!.away.batters).reduce((a, b) => a + b.game.batting.ab, 0);
    expect(totalAb(s)).toBeGreaterThan(totalAb(mid!));
  });

  it('rate stats and innings are worked out like a box score', () => {
    const l = { pa: 5, ab: 4, h: 2, doubles: 1, triples: 0, hr: 1, bb: 1, so: 1, hbp: 0, rbi: 2, r: 1, sb: 0, cs: 0, sf: 0, sh: 0 };
    const b = batterStats(l, 1);
    expect(b.avg).toBeCloseTo(0.5);
    expect(b.tb).toBe(6);
    expect(b.obp).toBeCloseTo(3 / 5);
    expect(b.slg).toBeCloseTo(1.5);
    const p = pitcherStats({ outs: 19, bf: 27, h: 5, r: 3, er: 2, bb: 2, so: 7, hr: 1, hbp: 0, pitches: 98, strikes: 62, wp: 0 }, 1);
    expect(p.ip).toBe('6.1');
    expect(p.era).toBeCloseTo((27 * 2) / 19);
    expect(p.whip).toBeCloseTo((7 * 3) / 19);
  });

  it('prior stats are carried: the season line is prior + this game', () => {
    const a = createGame({ seed: 'stats-2', pace: 0.02, innings: 3 });
    a.simulateToEnd(6 * 3600);
    const first = a.getState().stats!.home.batters[0];
    const prior = { [first.playerId]: { g: 10, bat: { ...first.game.batting, pa: 40, ab: 35, h: 10, doubles: 2, triples: 0, hr: 1, bb: 4, so: 8, hbp: 0, rbi: 5, r: 6, sb: 0, cs: 0, sf: 1, sh: 0 }, pit: { outs: 0, bf: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, hbp: 0, pitches: 0, strikes: 0, wp: 0 }, pg: 0 } };
    const b = createGame({ seed: 'stats-2', pace: 0.02, innings: 3, priorStats: prior });
    b.simulateToEnd(6 * 3600);
    const again = b.getState().stats!.home.batters.find((x) => x.playerId === first.playerId)!;
    expect(again.season.batting.ab).toBe(35 + again.game.batting.ab);
    expect(again.season.batting.g).toBe(11);
  });
});

describe('a simulated season', () => {
  it('plays a round robin, rotates the starters, and accumulates every player\'s stats', () => {
    const s = simulateSeason({ seed: 'ss1', teams: 3, rounds: 1, innings: 5 });
    expect(s.games).toBe(6);
    expect(s.standings.reduce((a, t) => a + t.w, 0)).toBe(6);
    expect(s.standings.reduce((a, t) => a + t.l, 0)).toBe(6);
    expect(s.standings.reduce((a, t) => a + t.rs, 0)).toBe(s.standings.reduce((a, t) => a + t.ra, 0));
    const starters = new Set<string>();
    for (const p of s.players) if (p.pitching && p.pitching.pitches > 20 && p.pitching.g >= 1 && p.playerId.includes('-sp')) starters.add(p.playerId);
    expect(starters.size).toBeGreaterThanOrEqual(4); // different starters on different days
    const batters = s.players.filter((p) => p.batting.ab > 0);
    expect(batters.length).toBeGreaterThan(20);
    const games = batters.map((p) => p.batting.g);
    expect(Math.max(...games)).toBeLessThanOrEqual(4);
    // runs scored by the players equal the runs on the scoreboards
    expect(s.players.reduce((a, p) => a + p.batting.r, 0)).toBe(s.standings.reduce((a, t) => a + t.rs, 0));
  });
});
