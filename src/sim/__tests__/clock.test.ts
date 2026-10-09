import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { PENDING, type DecisionProvider } from '../decisions';
import { CLOCK_RULES, remaining } from '../clock';
import { pitcherTarget } from '../tempo';
import type { GameConfig, GameEvent } from '../types';
import type { World } from '../world';

type Ev<K extends GameEvent['type']> = Extract<GameEvent, { type: K }>;

/** Play (part of) a game tick by tick, recording every event and, at each one, a little of the state it happened in. */
function play(cfg: Partial<GameConfig> & { seed: string }, opts: { until?: (w: World) => boolean; each?: (w: World) => void; maxSec?: number } = {}) {
  const g = createGame({ pace: 1, tempo: 'broadcast', innings: 2, ...cfg });
  const w = g._world;
  const events: GameEvent[] = [];
  const at: { runners: number; remaining: number; state: string; balls: number; strikes: number }[] = [];
  g.on('*', (e) => {
    events.push(e);
    at.push({ runners: w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead).length, remaining: remaining(w), state: w.clock.state, balls: w.count.balls, strikes: w.count.strikes });
  });
  const maxTicks = 240 * (opts.maxSec ?? 4 * 3600);
  while (!g.over && w.tick < maxTicks && !(opts.until?.(w) ?? false)) {
    g.step(1 / 240);
    opts.each?.(w);
  }
  const of = <K extends GameEvent['type']>(t: K) => events.map((e, i) => ({ e, s: at[i] })).filter((x) => x.e.type === t) as { e: Ev<K>; s: (typeof at)[number] }[];
  return { g, w, events, of };
}

describe('the pitch clock (MLB 2023-2025 rules)', () => {
  const runs = ['pc-1', 'pc-2', 'pc-3'].map((seed) => play({ seed, innings: 3 }));

  it('the timer is 15 s with the bases empty, 18 s with a runner on, 30 s between batters', () => {
    let n = 0;
    for (const r of runs) {
      for (const { e, s } of r.of('pitchClockStart')) {
        if (e.kind === 'betweenBatters') expect(e.limitSec).toBe(30);
        else if (e.kind === 'pitch') expect(e.limitSec).toBe(s.runners ? 18 : 15);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('a delivery never starts after the clock ran out: every windup has time left (or a violation came first)', () => {
    let windups = 0;
    for (const r of runs) {
      for (const { s } of r.of('windup')) {
        windups++;
        expect(s.state).toBe('stopped');
        expect(s.remaining).toBeGreaterThan(0);
      }
      // every pitcher violation happened at zero, every batter violation at the 8-second mark
      for (const { e } of r.of('pitchClockViolation')) {
        if (e.on === 'pitcher') expect(e.clockSec).toBeLessThanOrEqual(0.01);
        else expect(e.clockSec).toBeLessThanOrEqual(CLOCK_RULES.batterAlert + 0.01);
      }
    }
    expect(windups).toBeGreaterThan(200);
  });

  it('the snapshot shows the clock (and the decision requests carry it); no clock headless', () => {
    const r = play({ seed: 'pc-snap' }, { until: (w) => w.clock.state === 'running' && remaining(w) < 10 });
    const pc = r.g.getState().pitchClock!;
    expect(pc.running).toBe(true);
    expect(pc.remainingSec).toBeLessThan(10);
    expect([15, 18, 30]).toContain(pc.limitSec);
    expect(pc.batterAlertBy).toBe(8);
    expect(pc.disengagementsLeft).toBe(2);
    expect(pc.visitsLeft.home).toBe(5);
    const headless = createGame({ seed: 'pc-snap', pace: 0 });
    headless.step(30);
    expect(headless.getState().pitchClock).toBeNull();
    // a provider sees the clock in its requests
    const seen: number[] = [];
    const spy: DecisionProvider = { pitch: (req) => (req.situation.clockSec != null && seen.push(req.situation.clockSec), undefined) };
    play({ seed: 'pc-req', providers: { home: spy, away: spy } }, { maxSec: 300 });
    expect(seen.length).toBeGreaterThan(5);
    for (const s of seen) expect(s).toBeGreaterThan(0);
  });

  it('a pitcher who does not start in time is charged an automatic ball (a clocked human provider who never answers): four of them walk the batter', () => {
    const slow: DecisionProvider = { clocked: true, pitch: () => PENDING };
    const r = play({ seed: 'pc-slow', tempo: 'quick', providers: { home: slow } }, { maxSec: 400 });
    const v = r.of('pitchClockViolation');
    expect(v.length).toBeGreaterThanOrEqual(4);
    for (const { e } of v) {
      expect(e.on).toBe('pitcher');
      expect(e.result).toBe('ball');
    }
    // the first batter (the away side bats first; the home pitcher never gets a pitch off): ball one, two, three, four (the count before each call)
    expect(v.slice(0, 4).map((x) => x.s.balls)).toEqual([0, 1, 2, 3]);
    const firstWalk = r.events.find((e) => e.type === 'walk');
    expect(firstWalk).toBeTruthy();
    expect(r.events.filter((e) => e.type === 'pitchReleased' && e.time < firstWalk!.time).length).toBe(0);
    // the umpire signals it: time, then the ball
    expect(r.of('umpireCall').some(({ e }) => e.kind === 'clock_violation_ball')).toBe(true);
    // the withdrawn question no longer holds the game: it went on (no deferred answer is pending)
    expect(r.g.pendingDecisions.every((d) => d.kind === 'pitch')).toBe(true);
  });

  it('a batter not in the box and alert by the 8-second mark is charged an automatic strike', () => {
    let held = false;
    const r = play(
      { seed: 'pc-alert' },
      {
        each: (w) => {
          // once the clock runs on a pitch, keep the batter wandering outside the box
          if (!held && w.clock.state === 'running' && w.clock.kind === 'pitch' && remaining(w) > 9) held = true;
          if (held && w.batter && w.phase === 'prePitch') {
            w.batter.goal = null;
            w.batter.x = (w.batStance === 'R' ? 1 : -1) * 2.4;
            w.batter.vx = w.batter.vz = 0;
          }
        },
        until: (w) => w.events.some((e) => e.type === 'pitchClockViolation'),
        maxSec: 600,
      },
    );
    const v = r.of('pitchClockViolation')[0];
    expect(v).toBeTruthy();
    expect(v.e.on).toBe('batter');
    expect(v.e.result).toBe('strike');
    expect(v.e.clockSec).toBeGreaterThan(7.5);
    // (the count before the call: one more strike now, or strike three)
    expect(r.w.count.strikes === v.s.strikes + 1 || v.s.strikes === 2).toBe(true);
  });

  it('two disengagements per plate appearance: a third pickoff that gets nobody is a balk', () => {
    const throwOver: DecisionProvider = { pickoff: () => ({ throw: true }) };
    const r = play({ seed: 'pc-pick', innings: 4, providers: { home: throwOver, away: throwOver } });
    const d = r.of('disengagement');
    expect(d.length).toBeGreaterThan(6);
    for (const { e } of d) expect(e.count).toBeLessThanOrEqual(3);
    const thirds = d.filter(({ e }) => e.count === 3);
    expect(thirds.length).toBeGreaterThan(0);
    const balks = r.events.filter((e) => e.type === 'playEnd' && /third disengagement/.test(e.description));
    expect(balks.length).toBeGreaterThan(0);
    expect(balks.length).toBeLessThanOrEqual(thirds.length);
    // each disengagement but the pickoffs resets the timer at once; a pickoff's play stops it
    expect(r.of('pitchClockReset').every(({ e }) => e.limitSec === 15 || e.limitSec === 18 || e.limitSec === 30)).toBe(true);
  });

  it('one time-out per batter per plate appearance; the defense\'s time-outs are disengagements; a second request is denied', () => {
    let checked = 0;
    for (const r of runs) {
      let batterTimes = 0;
      for (const e of r.events) {
        if (e.type === 'batterUp') batterTimes = 0;
        if (e.type === 'timeCalled' && e.by === 'batter') {
          batterTimes++;
          checked++;
          expect(batterTimes).toBeLessThanOrEqual(CLOCK_RULES.batterTimeouts);
        }
        if (e.type === 'timeDenied') expect(['timeoutUsed', 'tooLate', 'noMoundVisits']).toContain(e.reason);
      }
      // the clock resets after each granted time-out
      const outs = r.of('timeCalled').filter(({ e }) => e.by === 'batter').length;
      expect(r.of('pitchClockReset').filter(({ e }) => e.reason === 'timeout').length).toBeLessThanOrEqual(outs);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('five mound visits a game: a team in trouble that has used them is denied the next one', () => {
    // a pitcher who stays rattled draws visit after visit
    // (each team has used four already)
    const r = play(
      { seed: 'pc-visits', innings: 6 },
      {
        each: (w) => {
          if (w.tick === 1) w.visits.home = w.visits.away = 4;
          if (w.tick % 240 === 0) w.pitcher.rattle = 1;
        },
      },
    );
    for (const side of ['home', 'away'] as const) expect(r.of('moundVisit').filter(({ e }) => e.team === side).length).toBeLessThanOrEqual(CLOCK_RULES.moundVisits - 4);
    expect(r.of('moundVisit').length).toBeGreaterThanOrEqual(1);
    expect(r.of('timeDenied').some(({ e }) => e.reason === 'noMoundVisits')).toBe(true);
    // a visit pauses the clock and resets it afterwards
    expect(r.of('pitchClockReset').some(({ e }) => e.reason === 'moundVisit')).toBe(true);
  });

  it('quick workers use less of the clock than slow ones; nobody plans to go past his margin', () => {
    const r = play({ seed: 'pc-tgt' }, { until: (w) => w.clock.state === 'running' && w.clock.kind === 'pitch' });
    const w = r.w;
    const P = w.pitcher;
    const d = P.info.delivery!;
    const keep = d.tempo;
    const at = (t: number) => {
      d.tempo = t;
      return Array.from({ length: 200 }, () => pitcherTarget(w)).reduce((a, b) => a + b, 0) / 200;
    };
    const quick = at(1.25);
    const slow = at(0.75);
    d.tempo = keep;
    expect(quick).toBeLessThan(slow - 3);
    expect(quick).toBeGreaterThan(5);
    expect(slow).toBeLessThan(w.clock.limit);
  });

  it('violations are rare: a few tenths a game, not every inning', () => {
    let v = 0;
    let halves = 0;
    for (const r of runs) {
      v += r.of('pitchClockViolation').length;
      halves += r.of('halfInningEnd').length;
    }
    expect(v / (halves / 18)).toBeLessThan(1.5);
  });

  it('the same seed gives the same game, clock and all', () => {
    const a = play({ seed: 'pc-det', innings: 1 });
    const b = play({ seed: 'pc-det', innings: 1 });
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(a.of('pitchClockStart').length).toBeGreaterThan(10);
  });

  it('breaks and pitching changes show their clocks; nothing stalls', () => {
    const r = play({ seed: 'pc-brk', innings: 2 }, { until: (w) => w.phase === 'halfBreak' && w.inning === 1 && w.half === 'bottom' && w.tick % 240 === 0 && w.clock.kind === 'break' });
    const pc = r.g.getState().pitchClock!;
    expect(pc.kind).toBe('break');
    expect(pc.limitSec).toBeGreaterThanOrEqual(25);
    expect(pc.limitSec).toBeLessThanOrEqual(61);
    for (const run of runs) expect(run.g.over).toBe(true);
  });
});
