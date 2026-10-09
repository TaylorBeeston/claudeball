/**
 * Between innings: a proper break (25-60 s at `broadcast` tempo, 60 % at `standard`, 25 % at `quick`; none at `pace: 0`). The side that took the field
 * trots out (and the side that came off trots in: that is `startHalfInning` / `tickLeavers`), then the pitcher throws his warm-up pitches to the catcher (up
 * to eight, the last followed by the catcher's throw down to second), the infielders roll ground balls to each other, the outfielders play catch, and the
 * plate umpire brushes the plate (before the first pitch of the game the crew meets at the plate, then takes the field). The infield and outfield balls are only for show (`GameStateSnapshot.extraBalls`); the warm-up ball is the real one.
 */
import { emit } from './events';
import { showClock } from './clock';
import { BASE_POS } from './field';
import { clamp } from './math';
import { giveBall, setAnim } from './util';
import { DEFAULT_SPOTS } from './setup';
import { lticks, lullScale, setLull, clearLull } from './tempo';
import { warmTick, type WarmCtx } from './visits';
import type { PlayerRT, UmpireRT, World } from './world';
import { secToTicks } from './world';
import { sendHome } from './handling';
import { RELEASE_S, releaseHeight, throwMotion } from './throws';
import { BRUSH_FACE, BRUSH_SPOT, restSpot, scheduleCall } from './umpires';
import { CREW_MEETING, crewMeetingSpot } from './venue';
import { crewMeets } from './setup';

interface Pair {
  a: PlayerRT;
  b: PlayerRT;
  mode: 'air' | 'ground';
  period: number;
  t0: number;
  /** Which half of the cycle the last hint was set for (so the throw / catch hints are set once per toss). */
  half: number;
}

export interface BreakShow {
  stage: 'arrive' | 'warm' | 'tail' | 'done';
  start: number;
  planned: number;
  hardEnd: number;
  warm: WarmCtx;
  pairs: Pair[];
  /** The plate umpire has brushed the plate (the break's last chore). */
  brushed: boolean;
  /** The break's tail lasts at least until this tick (without a brush: the 2.2 s it took when he brushed in place, so the game's timeline stays). */
  tailUntil: number;
  /** Until this tick the crew stands at its pre-game plate meeting (0 = no meeting: every break but the first, or no time for one). */
  meeting: number;
  /** the pregame (before the first pitch): it ends with the plate umpire's "Play ball!" */
  pregame: boolean;
}

/** Start the show for the half-inning that begins now (called from `startHalfInning`); returns the length of the break in ticks. */
export function beginBreak(w: World): number {
  const first = w.inning === 1 && w.half === 'top' && w.tick <= 1; // (startGame runs on tick 1)
  // the pregame is longer (60-90 s at `broadcast`, ~36-54 s at `standard`, ~15-22 s at `quick`): the booth's opening segment fits into it
  const sec = first ? 60 + 30 * w.propRng.next() : 26 + 34 * w.propRng.next();
  const planned = lticks(w, sec);
  const P = w.pitcher;
  const warmTotal = Math.max(2, Math.round(8 * clamp(lullScale(w), 0, 1)));
  const show: BreakShow = {
    stage: 'arrive',
    start: w.tick,
    planned,
    hardEnd: w.tick + planned + secToTicks(25),
    warm: { np: P, cover: w.fieldingTeam.defense.get('SS') ?? null, warmTotal, warmDone: 0, wstep: 'start', wuntil: 0, deadline: w.tick + planned + secToTicks(120) },
    pairs: [],
    brushed: false,
    tailUntil: 0,
    // the crew meets at the plate for the first third of the pregame (they start there, see setup.ts), then takes the field
    meeting: first && crewMeets(w.cfg) ? w.tick + Math.round(planned * 0.3) : 0,
    pregame: first,
  };
  w.breakShow = show;
  w.extraBalls = [];
  setLull(w, 'break', 'break', planned / 240);
  if (!first) showClock(w, 'break', planned / 240 / Math.max(1, w.cfg.pace)); // (the break clock; the pregame has none)
  emit(w, { type: 'breakStart', inning: w.inning, half: w.half, sec: planned / 240, ...(first ? { pregame: true } : {}) });
  return planned;
}

const home = (p: PlayerRT) => p.home ?? { x: p.x, z: p.z };
const arrived = (p: PlayerRT) => Math.hypot(p.x - home(p).x, p.z - home(p).z) < 1.2 && Math.hypot(p.vx, p.vz) < 1.0;

function makePairs(w: World): Pair[] {
  const d = w.fieldingTeam.defense;
  const pairs: Pair[] = [];
  const add = (x: string, y: string, mode: Pair['mode'], period: number) => {
    const a = d.get(x as 'P');
    const b = d.get(y as 'P');
    if (a && b) pairs.push({ a, b, mode, period: secToTicks(period), t0: w.tick, half: -1 });
  };
  add('3B', 'SS', 'ground', 2.6 + 0.4 * w.propRng.next());
  add('2B', '1B', 'ground', 2.8 + 0.4 * w.propRng.next());
  add('LF', 'CF', 'air', 4.0 + 0.6 * w.propRng.next());
  return pairs;
}

/** Per tick while the break lasts: the warm-ups, the tosses, the umpires. */
export function tickBreak(w: World): void {
  const s = w.breakShow;
  if (!s) return;
  const P = w.pitcher;
  const C = w.catcher;
  const plate = w.umpires.find((u) => u.key === 'plate')!;
  const others = w.umpires.filter((u) => u.key !== 'plate');
  switch (s.stage) {
    case 'arrive': {
      const ok = arrived(P) && arrived(C);
      if (ok || w.tick > s.start + s.planned * 0.55) {
        s.stage = 'warm';
        s.warm.np = P;
      }
      break;
    }
    case 'warm': {
      // the pitcher stays on the rubber with the ball (he came out holding it)
      if (w.ball.holder === null && !w.ball.lob && !w.ret) giveBall(w, P);
      if (!s.pairs.length && w.tick > s.start + secToTicks(6 * (1 + lullScale(w)))) s.pairs = makePairs(w);
      if (warmTick(w, s.warm)) {
        s.stage = 'tail';
        // with time for it (a `standard` / `broadcast` break) the plate umpire walks round beside the plate and brushes it
        if (lullScale(w) >= 0.5) {
          plate.hold = BRUSH_SPOT;
          plate.face = BRUSH_FACE;
        } else {
          // (no brush, but the break keeps the length it had when he brushed in place, so every seed plays the same game)
          s.brushed = true;
          s.tailUntil = w.tick + secToTicks(2.2);
        }
      }
      break;
    }
    case 'tail':
      if (!s.pairs.length) s.pairs = makePairs(w);
      if (!s.brushed && Math.hypot(plate.x - BRUSH_SPOT.x, plate.z - BRUSH_SPOT.z) < 0.3) {
        s.brushed = true;
        plate.anim = 'umpire_brush_plate';
        plate.animStart = w.tick;
        plate.animUntil = w.tick + secToTicks(2.2);
      }
      if (s.brushed && w.tick >= plate.animUntil) {
        plate.hold = null;
        plate.face = null;
      }
      if (w.tick >= s.start + s.planned && s.brushed && w.tick >= plate.animUntil && w.tick >= s.tailUntil) s.stage = 'done';
      break;
  }
  tickCrew(w, s, others);
  if (w.tick > s.hardEnd) s.stage = 'done';
  tickPairs(w, s);
}

/**
 * The base umpires during a break. Before the first pitch of the game the crew stands together at its plate meeting (where the game set it up),
 * then takes the field; between innings they stay at their posts (relaxed, see `umpStance`).
 */
function tickCrew(w: World, s: BreakShow, others: UmpireRT[]): void {
  if (!s.meeting) return;
  const all = [...others, w.umpires.find((u) => u.key === 'plate')!];
  if (w.tick < s.meeting) {
    for (const u of all) {
      if (u.key === 'plate' && s.stage === 'tail') continue;
      u.hold = crewMeetingSpot(u.position);
      u.face = CREW_MEETING;
    }
    return;
  }
  for (const u of all) {
    if (u.key === 'plate' && s.stage === 'tail') continue;
    u.hold = null;
    u.face = null;
  }
  s.meeting = 0;
}

/** Are the umpires at their posts (the first pitch waits for the crew to take the field)? */
const crewInPlace = (w: World) => w.umpires.every((u) => u.hold || Math.hypot(u.x - restSpot(u).x, u.z - restSpot(u).z) < 1.5);

function tickPairs(w: World, s: BreakShow): void {
  w.extraBalls = [];
  if (s.stage === 'done') {
    for (const p of s.pairs) p.a.tossAt = p.b.tossAt = undefined;
    return;
  }
  for (const p of s.pairs) {
    if (!arrived(p.a) || !arrived(p.b)) continue;
    const u0 = ((w.tick - p.t0) % p.period) / p.period;
    const flip = Math.floor(((w.tick - p.t0) / p.period) * 2);
    const from = u0 < 0.5 ? p.a : p.b;
    const to = u0 < 0.5 ? p.b : p.a;
    const halfSec = p.period / 2 / 240;
    const tau = ((u0 % 0.5) / 0.5) * halfSec;
    // infielders roll grounders to each other; outfielders play catch (an underhand flip up close, a short-arm flick, a relaxed throw)
    const D = Math.hypot(to.x - from.x, to.z - from.z);
    const motion = p.mode === 'air' ? throwMotion(D, true) : 'roll_ball';
    const rel = Math.min(RELEASE_S[motion], halfSec * 0.45);
    if (flip !== p.half) {
      p.half = flip;
      setAnim(w, from, motion, rel + 0.5);
      from.tossAt = w.tick + secToTicks(rel - tau);
      to.tossAt = undefined;
      from.lookAt = { x: to.x, z: to.z };
      to.lookAt = { x: from.x, z: from.z };
    }
    // the ball is in his hand until the clip's release frame, then flies (or rolls) for the rest of the half cycle
    const f = Math.max(0, (tau - rel) / Math.max(0.05, halfSec - rel));
    // the receiver's catch clip starts its lead ahead of the arrival
    const lead = p.mode === 'air' ? 0.5 : 0.46;
    const remain = (1 - f) * (halfSec - rel);
    if (tau >= rel && remain < lead && remain > lead - 0.05 && to.anim !== (p.mode === 'air' ? 'catch_toss' : 'field_grounder')) setAnim(w, to, p.mode === 'air' ? 'catch_toss' : 'field_grounder', lead * 2);
    if (tau < rel) {
      // in the thrower's hand (low for a roll)
      const hy = motion === 'roll_ball' ? 0.25 + 0.75 * Math.max(0, 1 - tau / rel) : 1.1;
      w.extraBalls.push({ x: from.x + Math.sin(from.facing) * 0.3, y: hy, z: from.z + Math.cos(from.facing) * 0.3 });
      continue;
    }
    const x = from.x + (to.x - from.x) * f;
    const z = from.z + (to.z - from.z) * f;
    const arc = motion === 'toss_underhand' ? 0.7 : 3.6;
    const y0 = releaseHeight(motion);
    // a roll leaves the hand a hand's height up and runs along the grass; a toss arcs from the release height to the partner's chest
    const y = p.mode === 'air' ? y0 + (1.3 - y0) * f + arc * f * (1 - f) : 0.037 + Math.max(0, y0 - 0.037) * Math.max(0, 1 - f / 0.06);
    w.extraBalls.push({ x, y, z });
  }
}

/** The break is over (or there never was one): the first batter may walk in. */
export function breakFinished(w: World): boolean {
  const s = w.breakShow;
  if (!s) return true;
  if (s.stage !== 'done') return false;
  // finish: the ball is with the pitcher, everybody goes home, the umpires go to their places
  if (w.ret || w.ball.lob) return false;
  if (!crewInPlace(w) && w.tick < s.hardEnd) return false;
  if (w.ball.holder !== w.pitcher) giveBall(w, w.pitcher);
  for (const u of w.umpires) {
    u.hold = null;
    u.face = null;
  }
  for (const p of s.pairs) {
    sendHome(w, p.a, false);
    sendHome(w, p.b, false);
  }
  w.extraBalls = [];
  if (s.pregame) scheduleCall(w, 'plate', 'play_ball', 0.2);
  w.breakShow = null;
  clearLull(w);
  void DEFAULT_SPOTS;
  void BASE_POS;
  return true;
}
