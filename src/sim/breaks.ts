/**
 * Between innings: a proper break (25-60 s at `broadcast` tempo, 60 % at `standard`, 25 % at `quick`; none at `pace: 0`). The side that took the field
 * trots out (and the side that came off trots in: that is `startHalfInning` / `tickLeavers`), then the pitcher throws his warm-up pitches to the catcher (up
 * to eight, the last followed by the catcher's throw down to second), the infielders roll ground balls to each other, the outfielders play catch, and the
 * umpires gather at the plate. The infield and outfield balls are only for show (`GameStateSnapshot.extraBalls`); the warm-up ball is the real one.
 */
import { emit } from './events';
import { BASE_POS } from './field';
import { clamp } from './math';
import { giveBall, setAnim } from './util';
import { DEFAULT_SPOTS } from './setup';
import { lticks, lullScale, setLull, clearLull } from './tempo';
import { warmTick, type WarmCtx } from './visits';
import type { PlayerRT, World } from './world';
import { secToTicks } from './world';
import { sendHome } from './handling';
import { scheduleCall } from './umpires';

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
    pregame: first,
  };
  w.breakShow = show;
  w.extraBalls = [];
  setLull(w, 'break', 'break', planned / 240);
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
        // the field umpires walk in toward the plate
        others.forEach((u, k) => {
          u.hold = { x: (k - 1) * 3.2, z: 5.5 + (k === 1 ? 1.2 : 0) };
        });
        plate.hold = { x: -0.3, z: -2.4 };
      }
      break;
    }
    case 'warm': {
      // the pitcher stays on the rubber with the ball (he came out holding it)
      if (w.ball.holder === null && !w.ball.lob && !w.ret) giveBall(w, P);
      if (!s.pairs.length && w.tick > s.start + secToTicks(6 * (1 + lullScale(w)))) s.pairs = makePairs(w);
      if (warmTick(w, s.warm)) {
        s.stage = 'tail';
        plate.anim = 'umpire_brush_plate';
        plate.animStart = w.tick;
        plate.animUntil = w.tick + secToTicks(2.2);
      }
      break;
    }
    case 'tail':
      if (!s.pairs.length) s.pairs = makePairs(w);
      if (w.tick >= s.start + s.planned && w.tick >= plate.animUntil) s.stage = 'done';
      break;
  }
  if (w.tick > s.hardEnd) s.stage = 'done';
  tickPairs(w, s);
}

function tickPairs(w: World, s: BreakShow): void {
  w.extraBalls = [];
  if (s.stage === 'done') return;
  for (const p of s.pairs) {
    if (!arrived(p.a) || !arrived(p.b)) continue;
    const u0 = ((w.tick - p.t0) % p.period) / p.period;
    const half = Math.floor((((w.tick - p.t0) / p.period) * 2) % 2);
    const flip = Math.floor(((w.tick - p.t0) / p.period) * 2);
    const from = u0 < 0.5 ? p.a : p.b;
    const to = u0 < 0.5 ? p.b : p.a;
    const f = (u0 % 0.5) / 0.5;
    if (flip !== p.half) {
      p.half = flip;
      void half;
      setAnim(w, from, p.mode === 'air' ? 'toss' : 'throw', 0.6);
      from.lookAt = { x: to.x, z: to.z };
      to.lookAt = { x: from.x, z: from.z };
    }
    // the receiver's catch clip starts its lead ahead of the arrival
    const lead = p.mode === 'air' ? 0.5 : 0.46;
    const remain = (1 - f) * (p.period / 2 / 240);
    if (remain < lead && remain > lead - 0.05 && to.anim !== (p.mode === 'air' ? 'catch_toss' : 'field_grounder')) setAnim(w, to, p.mode === 'air' ? 'catch_toss' : 'field_grounder', lead * 2);
    const x = from.x + (to.x - from.x) * f;
    const z = from.z + (to.z - from.z) * f;
    const y = p.mode === 'air' ? 1.3 + 3.6 * f * (1 - f) : 0.04 + Math.abs(Math.sin(f * 9)) * 0.08 * (1 - f);
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
  if (w.ball.holder !== w.pitcher) giveBall(w, w.pitcher);
  for (const u of w.umpires) u.hold = null;
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
