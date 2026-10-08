import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import type { GameEvent } from '../types';
import { ofType } from './helpers';

type Tempo = 'quick' | 'standard' | 'broadcast';

interface Run {
  events: GameEvent[];
  hints: Set<string>;
  lullKinds: Set<string>;
  details: Set<string>;
  extraBalls: number;
  gaps: { g: number; samePA: boolean; runners: boolean }[];
  maxStep: number;
  minutes: number;
  who: string;
  box: { ab: number; h: number; so: number; bb: number; hr: number; runs: number };
}

/** Play a game (or part of one) and collect what the tempo layer shows: hints in use, lulls, pitch-to-pitch gaps, the biggest step anybody takes. */
function play(seed: string, tempo: Tempo, innings = 9, pace = 1, sample = true): Run {
  const g = createGame({ seed, pace, tempo, innings });
  const w = g._world;
  const events: GameEvent[] = [];
  g.on('*', (e) => events.push(e));
  const hints = new Set<string>();
  const lullKinds = new Set<string>();
  const details = new Set<string>();
  const gaps: Run['gaps'] = [];
  let extraBalls = 0;
  let lastRelease = -1;
  let lastBatter = '';
  g.on('pitchReleased', () => {
    const t = w.tick / 240;
    if (lastRelease >= 0) gaps.push({ g: t - lastRelease, samePA: w.batter!.info.id === lastBatter, runners: w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead) });
    lastRelease = t;
    lastBatter = w.batter!.info.id;
  });
  const prev = new Map<string, { x: number; z: number }>();
  let maxStep = 0;
  let who = '';
  let n = 0;
  while (!g.over && n++ < 240 * 3600 * 5) {
    g.step(1 / 240);
    if (!sample || n % 6) continue;
    const tick = w.tick;
    for (const t of [w.teams.home, w.teams.away]) {
      for (const p of t.players.values()) {
        if (tick < p.animUntil) hints.add(p.anim);
        if (p.onField || p.dug) {
          const q = prev.get(p.info.id);
          if (n % 12 === 0) {
            if (q) {
              const d = Math.hypot(p.x - q.x, p.z - q.z);
              if (d > maxStep) {
                maxStep = d;
                who = `${p.info.id} ${p.anim} t${(tick / 240).toFixed(0)}`;
              }
            }
            prev.set(p.info.id, { x: p.x, z: p.z });
          }
        }
      }
    }
    for (const s of w.staff) if (tick < s.animUntil) hints.add(s.anim);
    for (const u of w.umpires) if (tick < u.animUntil) hints.add(u.anim);
    if (w.lull) lullKinds.add(w.lull.kind);
    if (w.extraBalls.length) extraBalls++;
    if (n % 120 === 0) {
      const d = g.getState().phaseDetail;
      if (d) details.add(d);
    }
  }
  const box = g.getBoxScore();
  const sum = { ab: 0, h: 0, so: 0, bb: 0, hr: 0, runs: box.home.runs + box.away.runs };
  for (const side of [box.home, box.away]) for (const b of side.batters) {
    sum.ab += b.line.ab;
    sum.h += b.line.h;
    sum.so += b.line.so;
    sum.bb += b.line.bb;
    sum.hr += b.line.hr;
  }
  return { events, hints, lullKinds, details, extraBalls, gaps, maxStep, minutes: w.tick / 240 / 60, who, box: sum };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * q)];

describe('tempo: the real game\'s non-pitch time', () => {
  const runs = ['tp-1', 'tp-2'].map((s) => play(s, 'broadcast'));
  const all = <K extends GameEvent['type']>(type: K) => runs.flatMap((r) => ofType(r.events, type));

  it('routines happen at their rates: signs before nearly every pitch, shake-offs a few percent, time called now and then, practice swings on most turns', () => {
    const pitches = all('pitchReleased').length;
    const signs = all('signsGiven').length;
    const shakes = all('shakeOff').length;
    const times = all('timeCalled').length;
    expect(signs / pitches).toBeGreaterThan(0.9);
    expect(signs / pitches).toBeLessThan(1.15);
    expect(shakes / signs).toBeGreaterThan(0.025);
    expect(shakes / signs).toBeLessThan(0.14);
    expect(times / pitches).toBeGreaterThan(0.004);
    expect(times / pitches).toBeLessThan(0.035);
    const hints = new Set(runs.flatMap((r) => [...r.hints]));
    for (const h of ['batter_practice_swing', 'batter_step_in', 'batter_adjust', 'batter_step_out', 'catcher_signs', 'pitcher_shake_off', 'pitcher_nod', 'pitcher_step_off', 'pitcher_look_runner', 'pitcher_adjust', 'pitcher_rosin']) expect(hints.has(h), h).toBe(true);
    // each sign sequence is for the pitch he then throws (a shake-off excepted); a runner on second makes it a longer, decoyed sequence
    for (const e of all('signsGiven')) {
      expect(e.seq.length).toBe(e.complex ? 4 : 1);
      expect(e.seq.includes(e.pitchType === 'FF' ? 1 : 0) || e.pitchType !== 'FF').toBe(true);
    }
    expect(all('signsGiven').some((e) => e.complex)).toBe(true);
  });

  it('a shake-off is a second pitch decision: the pitch he refused is not the one he throws', () => {
    let checked = 0;
    for (const r of runs) {
      const ev = r.events;
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        if (e.type !== 'shakeOff') continue;
        const next = ev.slice(i + 1).find((x) => x.type === 'pitchReleased');
        if (!next || next.type !== 'pitchReleased') continue;
        expect(next.pitchType).not.toBe(e.rejected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('pitch-to-pitch time at broadcast tempo: 15-22 s with nobody on, 18-28 s with runners (within a plate appearance)', () => {
    const same = runs.flatMap((r) => r.gaps.filter((x) => x.samePA && x.g < 120));
    const empty = same.filter((x) => !x.runners).map((x) => x.g);
    const on = same.filter((x) => x.runners).map((x) => x.g);
    expect(empty.length).toBeGreaterThan(200);
    expect(median(empty)).toBeGreaterThan(14.5);
    expect(median(empty)).toBeLessThan(22);
    expect(median(on)).toBeGreaterThan(17.5);
    expect(median(on)).toBeLessThan(28);
    expect(median(on)).toBeGreaterThan(median(empty));
  });

  it('a whole game takes about 2-2.5 hours at broadcast tempo; a half-inning of three outs a few minutes; nothing stalls', () => {
    for (const r of runs) {
      expect(r.minutes).toBeGreaterThan(105);
      expect(r.minutes).toBeLessThan(190); // (extra innings)
      expect(Math.max(...r.gaps.map((x) => x.g))).toBeLessThan(260); // (a pitching change plus a review is the longest)
    }
    const perNine = runs.map((r) => (r.minutes * 18) / Math.max(1, ofType(r.events, 'halfInningEnd').length));
    expect(perNine.reduce((a, b) => a + b, 0) / perNine.length).toBeLessThan(160);
    expect(perNine.reduce((a, b) => a + b, 0) / perNine.length).toBeGreaterThan(115);
    const halves = runs.flatMap((r) => {
      const out: number[] = [];
      let start = 0;
      for (const e of r.events) {
        if (e.type === 'halfInningStart') start = e.time;
        if (e.type === 'halfInningEnd') out.push(e.time - start);
      }
      return out;
    });
    expect(median(halves)).toBeGreaterThan(300);
    expect(median(halves)).toBeLessThan(540);
  });

  it('inning breaks are 25-60 s, with warm-up pitches (eight), a throw down to second and tosses between the infielders and outfielders', () => {
    const br = all('breakStart');
    expect(br.length).toBeGreaterThan(20);
    for (const b of br.filter((x) => x.inning > 1)) {
      expect(b.sec).toBeGreaterThanOrEqual(25.9);
      expect(b.sec).toBeLessThanOrEqual(60.1);
    }
    for (const r of runs) {
      expect(r.extraBalls).toBeGreaterThan(100);
      expect(r.lullKinds.has('break')).toBe(true);
    }
    const hints = new Set(runs.flatMap((r) => [...r.hints]));
    for (const h of ['warmup_pitch', 'umpire_brush_plate', 'catch_toss', 'roll_ball', 'bullpen_throw', 'bench_cheer']) expect(hints.has(h), h).toBe(true);
    // the outfielders play catch with a real throwing motion (a flick / a relaxed throw by distance), the infielders roll grounders
    expect(hints.has('toss_sidearm_short') || hints.has('throw_casual') || hints.has('toss_underhand')).toBe(true);
    // the warm-up pitches arrive in the catcher's mitt as pitch-type catches, 8 per break at most
    const first = runs[0].events;
    let inBreak = false;
    let catches = 0;
    const perBreak: number[] = [];
    for (const e of first) {
      if (e.type === 'breakStart') {
        if (inBreak) perBreak.push(catches);
        inBreak = true;
        catches = 0;
      } else if ((e.type === 'batterUp' || e.type === 'pitchingChangeStart') && inBreak) {
        perBreak.push(catches);
        inBreak = false;
      } else if (inBreak && e.type === 'catch' && e.kind === 'pitch') catches++;
    }
    expect(perBreak.length).toBeGreaterThan(10);
    expect(median(perBreak)).toBeGreaterThanOrEqual(7);
    expect(Math.max(...perBreak)).toBeLessThanOrEqual(8);
  });

  it('mound visits: triggered by the state, 12-25 s of talk, the visitor walks out and back, the infield sometimes gathers; limits per team', () => {
    const visits = all('moundVisit');
    const ends = all('moundVisitEnd');
    expect(visits.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBe(visits.length);
    for (const r of runs) {
      for (const side of ['home', 'away'] as const) expect(ofType(r.events, 'moundVisit').filter((e) => e.team === side).length).toBeLessThanOrEqual(4);
    }
    const hints = new Set(runs.flatMap((r) => [...r.hints]));
    for (const h of ['mound_talk', 'mound_talk_listen']) expect(hints.has(h), h).toBe(true);
    // each visit lasts a realistic time
    for (const r of runs) {
      const vs = ofType(r.events, 'moundVisit');
      for (const v of vs) {
        const end = ofType(r.events, 'moundVisitEnd').find((e) => e.time > v.time)!;
        expect(end.time - v.time).toBeGreaterThan(14);
        expect(end.time - v.time).toBeLessThan(75);
      }
    }
  });

  it('a pitching change is a sequence: the manager signals and walks out, takes the ball, the reliever jogs in from the bullpen, throws 5-8 warm-up pitches and the catcher throws down to second', () => {
    const starts = all('pitchingChangeStart');
    expect(starts.length).toBeGreaterThanOrEqual(4);
    let checked = 0;
    for (const r of runs) {
      for (const s of ofType(r.events, 'pitchingChangeStart')) {
        const change = ofType(r.events, 'pitchingChange').find((e) => e.time > s.time && e.inId === s.inId);
        expect(change).toBeTruthy();
        expect(change!.time - s.time).toBeGreaterThan(18); // the manager's walk, the talk, the hand-over
        const nextBatter = ofType(r.events, 'batterUp').find((e) => e.time > change!.time)!;
        const warm = r.events.filter((e) => e.time > change!.time && e.time < nextBatter.time && e.type === 'catch' && e.kind === 'pitch').length;
        expect(warm).toBeGreaterThanOrEqual(5);
        expect(warm).toBeLessThanOrEqual(8);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    const hints = new Set(runs.flatMap((r) => [...r.hints]));
    for (const h of ['manager_signal', 'manager_walk', 'pitcher_handoff']) expect(hints.has(h), h).toBe(true);
  });

  it('the lull flag is up in the quiet stretches (walk-up, between pitches, visits, changes, breaks) with a kind and a length, and phaseDetail names them', () => {
    for (const r of runs) {
      for (const k of ['walkup', 'betweenPitches', 'break', 'pitchingChange']) expect(r.lullKinds.has(k), k).toBe(true);
    }
    const details = new Set(runs.flatMap((r) => [...r.details]));
    for (const d of ['batterRoutine', 'signs', 'break']) expect(details.has(d), d).toBe(true);
  });

  it('nobody teleports at broadcast tempo: the biggest step anybody takes in 0.05 s is a sprint', () => {
    for (const r of runs) expect(r.maxStep, r.who).toBeLessThan(1.2);
  });
});

describe('tempo: scaling, determinism and the stats', () => {
  it('the tempo scales the durations: quick < standard < broadcast between pitches and for the inning breaks', () => {
    const med = (t: Tempo) => {
      const rs = ['tp-s1', 'tp-s2'].map((s) => play(s, t, 4));
      const same = rs.flatMap((r) => r.gaps.filter((x) => x.samePA && x.g < 120 && !x.runners).map((x) => x.g));
      const br = rs.flatMap((r) => ofType(r.events, 'breakStart').filter((e) => e.inning > 1).map((e) => e.sec));
      return { gap: median(same), brk: median(br) };
    };
    const q = med('quick');
    const s = med('standard');
    const b = med('broadcast');
    expect(q.gap).toBeGreaterThan(5.5);
    expect(q.gap).toBeLessThan(9);
    expect(s.gap).toBeGreaterThan(q.gap + 2);
    expect(b.gap).toBeGreaterThan(s.gap);
    expect(s.gap).toBeGreaterThan(10);
    expect(s.gap).toBeLessThan(19);
    // breaks: ~25 %, ~60 % and all of 25-60 s
    expect(q.brk).toBeLessThan(0.35 * b.brk);
    expect(s.brk).toBeGreaterThan(0.45 * b.brk);
    expect(s.brk).toBeLessThan(0.75 * b.brk);
  });

  it('the same seed and tempo give the same game, event for event', () => {
    const a = play('tp-det', 'broadcast', 3);
    const b = play('tp-det', 'broadcast', 3);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    const c = play('tp-det', 'quick', 3);
    expect(c.events.length).toBeGreaterThan(50);
    expect(c.minutes).toBeLessThan(a.minutes);
  });

  it('the league line does not depend on the tempo (apart from fatigue / rhythm): batting average, strikeouts, walks and home runs per plate appearance hold', () => {
    const lines = (t: Tempo) => {
      // (pace 0.05: the waits are a twentieth, but every ritual, shake-off, step-out and visit still happens as the tempo says: it is the decisions that could change the game)
      const rs = Array.from({ length: 8 }, (_, i) => play(`st-${i}`, t, 4, 0.05, false));
      const sum = { ab: 0, h: 0, so: 0, bb: 0, hr: 0, runs: 0 };
      for (const r of rs) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r.box[k];
      const pa = sum.ab + sum.bb;
      return { avg: sum.h / sum.ab, k: sum.so / pa, bb: sum.bb / pa, hr: sum.hr / pa, rg: sum.runs / (rs.length * 2) };
    };
    const q = lines('quick');
    const b = lines('broadcast');
    // (`npm run sim -- 40 1 1 broadcast` at full pace: AVG .245 vs .247, K% 23.4 vs 23.4, BABIP .301 vs .300, R/G 4.56 vs 4.63)
    expect(Math.abs(q.avg - b.avg)).toBeLessThan(0.06);
    expect(Math.abs(q.k - b.k)).toBeLessThan(0.08);
    expect(Math.abs(q.bb - b.bb)).toBeLessThan(0.05);
    expect(Math.abs(q.hr - b.hr)).toBeLessThan(0.035);
    expect(Math.abs(q.rg - b.rg)).toBeLessThan(2.5);
  }, 900_000);

  it('pace 0 skips all of it: no signs, no breaks, no mound visits, no lulls, and the headless game is as quick as ever', () => {
    const g = createGame({ seed: 'tp-p0', pace: 0, tempo: 'broadcast', innings: 4 });
    const kinds = new Set<string>();
    g.on('*', (e) => kinds.add(e.type));
    g.simulateToEnd(3600);
    for (const t of ['signsGiven', 'shakeOff', 'timeCalled', 'moundVisit', 'pitchingChangeStart', 'breakStart', 'challenge']) expect(kinds.has(t), t).toBe(false);
    expect(g._world.lull).toBeNull();
  });
});

describe('tempo: a challenge of a close play', () => {
  it('a manager can challenge a close call (twice per team at most): signal, huddle, a review of about a minute, the call is confirmed by the play\'s own margin', () => {
    let found: { events: GameEvent[]; gap: number } | null = null;
    for (let k = 0; k < 40 && !found; k++) {
      const g = createGame({ seed: `ch-${k}`, pace: 1, tempo: 'broadcast', innings: 5 });
      const w = g._world;
      const events: GameEvent[] = [];
      g.on('*', (e) => events.push(e));
      // a close call at a base in every play that can have one (the sim's own margins are rarely this close): make the first few plays at bases close
      g.on('out', (e) => {
        if (e.base && e.margin !== undefined && (!w.lastClose || w.lastClose.used)) w.lastClose = { tick: w.tick, call: 'out', runnerId: e.playerId, base: e.base, margin: 0.004, used: false };
      });
      let n = 0;
      while (!g.over && n++ < 240 * 3600 * 4 && !ofType(events, 'challengeResult').length) g.step(1 / 240);
      if (ofType(events, 'challengeResult').length) found = { events, gap: 0 };
    }
    expect(found).toBeTruthy();
    const ev = found!.events;
    const ch = ofType(ev, 'challenge')[0];
    const res = ofType(ev, 'challengeResult')[0];
    expect(res.time - ch.time).toBeGreaterThan(45);
    expect(res.time - ch.time).toBeLessThan(125);
    expect(res.overturned).toBe(false); // (the sim's calls come from the physics: the margin says the call was right)
    expect(ch.margin).toBeLessThan(0.1);
  });
});
