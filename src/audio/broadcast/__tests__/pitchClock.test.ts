import { describe, expect, it } from 'vitest';
import { callsFor, type Env } from '../lexicon';
import { collectStories } from '../stories';
import { GameLog } from '../gamelog';
import { mulberry32 } from '../../dsp';
import { umpireCallText } from '../../cues';
import type { BoothCtx } from '../ctx';

const ctx = (over: Partial<BoothCtx> = {}): BoothCtx => ({
  inning: 5, half: 'bottom', outs: 0, balls: 1, strikes: 1, score: { home: 3, away: 2 }, runners: [false, false, false], teams: { home: 'Comets', away: 'Stars' },
  batter: { id: 'b1', name: 'Tyler Vance', hand: 'R' }, pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L', pit: { outs: 12, so: 5, bb: 1, h: 3, er: 1, pitches: 70, hr: 0 } },
  ...over,
});
const env = (s = 1): Env => ({ rng: mulberry32(s), live: () => ({ balls: 1, strikes: 1, outs: 0 }), epoch: () => 1 });

describe('the booth and the pitch clock', () => {
  it('a violation is a MUST call naming the man penalised, with the analyst reacting', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 30; s++) {
      const p = callsFor({ type: 'pitchClockViolation', on: 'pitcher', result: 'ball', clockSec: 0 }, ctx(), new GameLog(), env(s));
      expect(p).toHaveLength(1);
      expect(p[0].importance).toBe('must');
      expect(p[0].react).toBeTruthy();
      expect(p[0].text).toMatch(/ball/i);
      seen.add(p[0].text);
      const b = callsFor({ type: 'pitchClockViolation', on: 'batter', result: 'strike', clockSec: 8 }, ctx(), new GameLog(), env(s));
      expect(b[0].importance).toBe('must');
      expect(b[0].text).toMatch(/strike/i);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('a denied time-out and a team out of mound visits are said when the booth is free', () => {
    const t = callsFor({ type: 'timeDenied', by: 'batter', reason: 'timeoutUsed' }, ctx(), new GameLog(), env());
    expect(t[0].importance).toBe('should');
    const v = callsFor({ type: 'timeDenied', by: 'catcher', reason: 'noMoundVisits' }, ctx(), new GameLog(), env(3));
    expect(v[0].text).toMatch(/visit/i);
  });

  it('the umpire shouts the violation', () => {
    expect(umpireCallText('clock_violation_ball')).toMatch(/ball/i);
    expect(umpireCallText('clock_violation_strike')).toMatch(/strike/i);
  });

  it('colour about the clock: the clock running down, the disengagements used up, a quick or a slow worker', () => {
    const ids = (c: BoothCtx) => collectStories(new GameLog(), c).map((s) => s.id);
    expect(ids(ctx({ clock: { running: true, remaining: 2.5, limit: 15, kind: 'pitch', disengagementsLeft: 2 } }))).toContain('clockLow');
    expect(ids(ctx({ clock: { running: true, remaining: 9, limit: 15, kind: 'pitch', disengagementsLeft: 2 } }))).not.toContain('clockLow');
    expect(ids(ctx({ runners: [true, false, false], clock: { running: true, remaining: 12, limit: 18, kind: 'pitch', disengagementsLeft: 0 } }))).toContain('clockDiseng');
    expect(ids(ctx({ pitcherTempo: 1.2, clock: { running: false, remaining: 15, limit: 15, kind: 'pitch', disengagementsLeft: 2 } }))).toContain('quickWorker');
    expect(ids(ctx({ pitcherTempo: 0.8, clock: { running: false, remaining: 15, limit: 15, kind: 'pitch', disengagementsLeft: 2 } }))).toContain('slowWorker');
    // no clock (headless / an older sim): none of it
    expect(ids(ctx({ pitcherTempo: 1.2 })).some((x) => /clock|Worker/.test(x))).toBe(false);
  });
});
