/**
 * The people who are not in the play: seated on the bench, walking to and from it, the next hitter warming up on deck, relievers in the bullpen.
 * Nobody appears from nowhere: a player walks from his seat (up the steps, through the door onto the field) to wherever he is needed, and a player who
 * is done walks back and sits down. Headless runs (`pace: 0`) skip the walking and place people directly.
 */
import { emit } from './events';
import { clamp } from './math';
import { setGoal, stepPlayer } from './movement';
import { setAnim } from './util';
import { behindPlate, benchAisle, benchFacing, bullpenSpot, dugoutFloorY, dugDoor, dugStep, onDeckSpot, seatSpot, seatStands } from './venue';
import { pitchLimit } from './attributes';
import type { AnimHint, GameEvent } from './types';
import type { PlayerRT, TeamRT, World } from './world';
import { TICK, secToTicks } from './world';

/** How fast he walks (m/s): a brisk walk to the plate or the circle. */
export const WALK_SPEED = 2.1;
/**
 * The walk up to the plate (m/s): a hitter walks, he does not hurry (the walk clip's own foot speed is 1.42 m/s; at 2.4 m/s it was a trot). A
 * quicker game walks a little faster; a batter the game is waiting on goes no faster than `WALK_SPEED` (handling.ts hurryStragglers).
 */
export const WALKUP_SPEED = { broadcast: 1.45, standard: 1.7, quick: 2.3 } as const;
export const walkupMul = (w: World, p: PlayerRT) => walkMul(p, WALKUP_SPEED[w.cfg.tempo]);
const sgn = (side: 'home' | 'away') => (side === 'home' ? 1 : -1);

const walkMul = (p: PlayerRT, speed = WALK_SPEED) => clamp(speed / Math.max(1, p.vmax), 0.08, 1);

/** Players who sit on the bench: everybody but the pitchers who are not in the game. */
const sitsOnBench = (p: PlayerRT) => !p.info.isPitcher || p.inGame;

/**
 * His seat, given out the first time he needs one: the players seated at the start have theirs; a reliever who comes in and is
 * later taken out (or anyone else without one) gets the first seat nobody on his team has (he used to take seat 0, on top of
 * whoever sat there).
 */
function ensureSeat(p: PlayerRT): number {
  if (p.seat >= 0) return p.seat;
  const used = new Set<number>();
  // (a seat is taken by whoever owns it and is still around: on the bench, on deck, out on the field or walking anywhere in between)
  for (const q of [...p.team.players.values(), ...p.team.bullpen]) if (q !== p && q.seat >= 0 && (q.inGame || q.dug || q.onField)) used.add(q.seat);
  let k = 0;
  while (used.has(k)) k++;
  p.seat = k;
  return k;
}

/** Place a player on his bench seat (no walking). */
export function placeOnBench(p: PlayerRT): void {
  ensureSeat(p);
  const side = p.team.side;
  const s = seatSpot(side, p.seat);
  p.x = s.x;
  p.z = s.z;
  p.vx = p.vz = 0;
  p.facing = benchFacing(side);
  p.lookAt = null;
  p.goal = null;
  p.route = [];
  p.after = null;
  p.dug = 'bench';
  p.onField = false;
  p.gait = null;
  p.anim = seatStands(p.seat) ? 'idle' : 'bench_sit';
  p.animUntil = 0;
}

function placeInBullpen(p: PlayerRT, k: number): void {
  const s = bullpenSpot(p.team.side, k);
  p.x = s.x;
  p.z = s.z;
  p.vx = p.vz = 0;
  p.facing = Math.atan2(-s.x, -s.z);
  p.goal = null;
  p.route = [];
  p.dug = 'bullpen';
  p.onField = false;
}

/** Seat everyone: position players and the pitchers in the game on the bench, the first few relievers in the bullpen, the rest are not on screen. */
export function initDugouts(w: World): void {
  for (const t of [w.teams.home, w.teams.away]) {
    let k = 0;
    for (const p of t.bullpen) p.seat = -1;
    for (const p of t.players.values()) p.seat = sitsOnBench(p) ? k++ : -1;
    for (const p of t.players.values()) if (sitsOnBench(p)) placeOnBench(p);
    t.bullpen.slice(0, 3).forEach((p, i) => placeInBullpen(p, i));
  }
}

/** Someone who is done (out, scored, replaced, the inning is over): he walks back to the dugout and sits down. */
export function toBench(w: World, p: PlayerRT): void {
  p.onField = false;
  p.goal = null;
  if (w.cfg.pace === 0 || w.tick === 0) {
    if (p.info.isPitcher && !p.inGame && !sitsOnBench(p)) {
      p.dug = null;
      return;
    }
    placeOnBench(p);
    return;
  }
  if (p.dug === 'bench') return;
  const side = p.team.side;
  p.dug = 'toBench';
  ensureSeat(p);
  // door -> steps -> aisle -> seat (from wherever he is on the field)
  p.route = [dugDoor(side), dugStep(side), benchAisle(side, p.seat), seatSpot(side, p.seat)];
  p.routeMul = walkMul(p, 2.6);
  p.after = null;
}

/** The next hitter gets up, walks out of the dugout to the on-deck circle and starts warming up. */
export function sendToDeck(w: World, p: PlayerRT): void {
  if (w.cfg.pace === 0 || p.onField) return;
  // still walking in from the field (a crowd at the dugout door): he goes once he is back on the bench for his bat
  if (p.dug === 'toBench') {
    w.deckNext = p;
    return;
  }
  if (p.dug !== 'bench') return;
  if (w.deckNext === p) w.deckNext = null;
  const side = p.team.side;
  p.benchSeq = [];
  p.dug = 'toDeck';
  p.route = [benchAisle(side, p.seat), dugStep(side), dugDoor(side), onDeckSpot(side)];
  p.routeMul = walkMul(p);
  p.after = null;
  emit(w, { type: 'onDeck', playerId: p.info.id, team: side });
}

/**
 * The way from where a hitter is to the edge of his box (`boxEdge`, where he stops): behind the umpire and the
 * catcher if the box is on the other side. The far side's way point is no further out than the box edge itself: at 3.4 m he walked 1.6 m past
 * the box and came back into it in a curve.
 */
export function routeToBox(b: PlayerRT, boxSide: 1 | -1): { x: number; z: number }[] {
  const side = b.team.side;
  const dsg = sgn(side);
  const route: { x: number; z: number }[] = [];
  // (the way out from his seat is leaveDugout's, or already on his route to the circle: here it doubled, and he walked out to the door, back
  // to his seat and out again; a man on his way back in who is already down in the dugout turns round at the steps)
  if (b.dug === 'toBench' && dugoutFloorY(b.x, b.z) < 0) route.push(dugStep(side), dugDoor(side));
  if (boxSide !== dsg) route.push(behindPlate(dsg * 3.0), behindPlate(boxSide * 1.8));
  return route;
}

/**
 * Per tick: everyone who is walking a route (to the bench, to the circle, out of the dugout), the on-deck hitter's warm-up swings, and the people in the
 * bullpen. Players who are on the field are stepped by the main loop; the others are stepped here.
 */
export function tickDugout(w: World): void {
  if (w.cfg.pace === 0) return;
  const nx = w.deckNext;
  if (nx && nx.dug === 'bench' && !nx.route.length) sendToDeck(w, nx);
  else if (nx && nx.dug !== 'toBench' && nx.dug !== 'bench') w.deckNext = null;
  for (const t of [w.teams.home, w.teams.away]) {
    for (const p of t.players.values()) tickOne(w, p);
    tickBullpen(w, t);
  }
}

/** A reliever loosens up in the bullpen when the pitcher in the game is tiring or in trouble (`bullpen_throw`, looping). */
function tickBullpen(w: World, t: TeamRT): void {
  if (t !== w.fieldingTeam || w.phase === 'halfBreak') return;
  const P = t.pitcher;
  const likely = P.pitchCount >= 0.72 * pitchLimit(P.info.ratings) || P.rattle > 0.55 || P.pit.r >= 3;
  if (!likely) return;
  const cand = t.bullpen.find((b) => !b.used && b.dug === 'bullpen');
  if (!cand || w.tick < cand.animUntil) return;
  setAnim(w, cand, 'bullpen_throw', 2.6);
  cand.lookAt = { x: cand.x - 1.5, z: cand.z + 6 };
}

/** A [0, 1) for a man on the bench from the game seed, his id and a counter (show only: no rng stream is drawn from, so nothing else shifts). */
function benchHash(w: World, p: PlayerRT, k: number): number {
  let h = 2166136261 ^ k;
  const str = `${w.cfg.seed}:${p.info.id}`;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Seconds of the bench clips: getting up and sitting back down (`bench_stand_up` both ways), a round of clapping. */
const RISE = 1.167, CLAP = 1.5;

/**
 * A man on the bench gets up, does `hold` (a round of clapping, or just standing at the rail looking out) and sits back down, starting `delay` s
 * from now: nobody jumps from seated to standing in one frame any more, and two men are never on the same frame.
 */
function standUp(w: World, p: PlayerRT, delay: number, hold: { hint: AnimHint; sec: number }[]): void {
  let at = w.tick + secToTicks(delay);
  // (each man's delay is his own hash: two of them could still land on one tick, a 1-in-180 chance per pair, so a taken tick moves on by one)
  const taken = (t: number) => [w.teams.home, w.teams.away].some((tm) => [...tm.players.values()].some((q) => q !== p && q.benchSeq.some((x) => x.hint === 'bench_stand_up' && x.at === t)));
  while (taken(at)) at++;
  const seq: PlayerRT['benchSeq'] = [];
  for (const h of [{ hint: 'bench_stand_up' as AnimHint, sec: RISE }, ...hold, { hint: 'bench_sit_down' as AnimHint, sec: RISE }]) {
    seq.push({ hint: h.hint, at, sec: h.sec });
    at += secToTicks(h.sec);
  }
  p.benchSeq = seq;
}

/** The dugout reacts: the batting side's bench cheers (or stands) for a hit, a run, a homer; the fielding side's for a strikeout. */
export function benchReact(w: World, e: GameEvent): void {
  if (w.cfg.pace === 0) return;
  let team: TeamRT | null = null;
  let hint: AnimHint = 'bench_cheer';
  let share = 0.5;
  if (e.type === 'plateAppearanceEnd') {
    if (e.result === 'home run') {
      team = w.battingTeam;
      hint = 'bench_stand_up';
      share = 0.9;
    } else if (/^(single|double|triple)/.test(e.result)) {
      team = w.battingTeam;
      share = e.result.startsWith('single') ? 0.35 : 0.6;
    } else if (/strikeout/.test(e.result)) {
      team = w.fieldingTeam;
      share = 0.3;
    }
  } else if (e.type === 'runScored') {
    team = w.battingTeam;
    hint = 'bench_stand_up';
    share = 0.6;
  }
  if (!team) return;
  for (const p of team.players.values()) {
    // (the draw comes before the standing check: the prop stream stays the same however full the bench is)
    if (p.dug !== 'bench' || p.route.length || w.propRng.next() > share || seatStands(p.seat)) continue;
    if (p.benchSeq.length || w.tick < p.animUntil) continue; // already up (or about to be): he is not sent up again from his feet
    // each in his own time (0.15-0.9 s: some react to the crack of the bat, some to the ball landing); a big moment, longer on their feet
    const k = w.tick % 9973;
    const delay = 0.15 + 0.75 * benchHash(w, p, k);
    const claps = hint === 'bench_stand_up' ? 2 : 1;
    const stay = hint === 'bench_stand_up' ? 0.8 + 2.4 * benchHash(w, p, k + 1) : 0.4 * benchHash(w, p, k + 1);
    standUp(w, p, delay, [...Array.from({ length: claps }, () => ({ hint: 'bench_cheer' as AnimHint, sec: CLAP })), { hint: 'bench_stand', sec: stay }]);
  }
}

function tickOne(w: World, p: PlayerRT): void {
  // called up in the middle of a warm-up swing: he finishes it, then walks (he used to set off with the swing still playing)
  if (p.route.length && p.anim === 'ondeck_swing' && w.tick < p.animUntil) {
    p.goal = null;
    return;
  }
  if (p.route.length) {
    const next = p.route[0];
    const last = p.route.length === 1;
    // (the door on his way out is a way point too: his goal on the field comes after it)
    const final = last && !p.after;
    setGoal(p, next.x, next.z, final, p.routeMul);
    if (p.gait !== 'trot') p.gait = 'walk';
    if (!p.onField) stepPlayer(p, w);
    const d = Math.hypot(p.x - next.x, p.z - next.z);
    // (a way point with people on it: close and held up counts as there)
    if (d < (final ? 0.12 : 1.0) || (!final && d < 2 && Math.hypot(p.vx, p.vz) < 0.8)) {
      p.route.shift();
      if (!p.route.length) arrive(w, p);
    }
    return;
  }
  if (p.dug === 'deck') {
    // warm-up: a loose stance, and a swing with the donut every 6-10 s
    p.goal = null;
    stepPlayer(p, w);
    if (w.tick >= p.animUntil) {
      if (w.tick >= p.nextSwing) {
        setAnim(w, p, 'ondeck_swing', 2.2);
        p.nextSwing = w.tick + secToTicks(6 + 4 * w.propRng.next());
      } else setAnim(w, p, 'ondeck_ready', clamp((p.nextSwing - w.tick) / 240, 0.2, 1.5));
    }
  } else if (p.dug === 'bench') {
    p.vx = p.vz = 0;
    if (seatStands(p.seat)) return;
    const q = p.benchSeq[0];
    if (q && w.tick >= q.at) {
      p.benchSeq.shift();
      // (two ticks over: the next one starts as this one ends, no frame of the seated default between them)
      if (q.sec > 0) setAnim(w, p, q.hint, q.sec + 2 * TICK);
    } else if (!q && w.tick >= p.fidgetAt && w.tick >= p.animUntil) {
      // now and then a man gets up by himself and stands at the rail for a while (every 1.5-4 minutes each, at his own times)
      if (p.fidgetAt > 0) standUp(w, p, 0, [{ hint: 'bench_stand', sec: 4 + 10 * benchHash(w, p, w.tick % 9973) }]);
      p.fidgetAt = w.tick + secToTicks(90 + 150 * benchHash(w, p, (w.tick + 7) % 9973));
    }
  } else if (p.dug === 'bullpen') {
    p.vx = p.vz = 0;
  }
}

function arrive(w: World, p: PlayerRT): void {
  p.gait = null;
  const side = p.team.side;
  if (p.dug === 'toBench') {
    p.dug = 'bench';
    // (he has just sat down: no getting up again by himself for a while)
    p.fidgetAt = w.tick + secToTicks(45 + 60 * benchHash(w, p, w.tick % 9973));
    p.goal = null;
    p.vx = p.vz = 0;
    p.facing = benchFacing(side);
    p.anim = seatStands(p.seat) ? 'idle' : 'bench_sit';
    p.animUntil = 0;
  } else if (p.dug === 'toDeck') {
    p.dug = 'deck';
    p.goal = null;
    p.lookAt = { x: 0, z: 18 };
    p.nextSwing = w.tick + secToTicks(1.5 + 3 * w.propRng.next());
    p.animUntil = 0;
  } else if (p.after) {
    // he came out of the dugout for the field: he goes on to where he is needed
    setGoal(p, p.after.x, p.after.z, p.after.stop, p.after.mul);
    p.after = null;
  } else {
    p.goal = null;
  }
}

/** A player leaves the dugout (a fielder taking the field, a pinch runner, a batter): he walks out through the door and on along `then`, ending at `after`. */
export function leaveDugout(p: PlayerRT, then: { x: number; z: number }[], after: { x: number; z: number; stop: boolean; mul: number } | null, speed = 3.2): void {
  const side = p.team.side;
  const out = p.dug === 'bench' ? [benchAisle(side, p.seat), dugStep(side), dugDoor(side)] : [];
  p.benchSeq = [];
  p.route = [...out, ...then];
  p.dug = null;
  p.after = after;
  p.routeMul = walkMul(p, speed);
  if (!p.route.length && after) setGoal(p, after.x, after.z, after.stop, after.mul);
}
