/**
 * The people who are not in the play: seated on the bench, walking to and from it, the next hitter warming up on deck, relievers in the bullpen.
 * Nobody appears from nowhere: a player walks from his seat (up the steps, through the door onto the field) to wherever he is needed, and a player who
 * is done walks back and sits down. Headless runs (`pace: 0`) skip the walking and place people directly.
 */
import { emit } from './events';
import { clamp } from './math';
import { setGoal, stepPlayer } from './movement';
import { setAnim } from './util';
import { behindPlate, benchAisle, benchFacing, benchSeat, bullpenSpot, dugDoor, dugStep, onDeckSpot } from './venue';
import { pitchLimit } from './attributes';
import type { AnimHint, GameEvent } from './types';
import type { PlayerRT, TeamRT, World } from './world';
import { secToTicks } from './world';

/** How fast he walks (m/s): a brisk walk to the plate or the circle. */
export const WALK_SPEED = 2.1;
const sgn = (side: 'home' | 'away') => (side === 'home' ? 1 : -1);

const walkMul = (p: PlayerRT, speed = WALK_SPEED) => clamp(speed / Math.max(1, p.vmax), 0.08, 1);

/** Players who sit on the bench: everybody but the pitchers who are not in the game. */
const sitsOnBench = (p: PlayerRT) => !p.info.isPitcher || p.inGame;

/** Place a player on his bench seat (no walking). */
export function placeOnBench(p: PlayerRT): void {
  const side = p.team.side;
  const s = benchSeat(side, p.seat);
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
  p.anim = 'bench_sit';
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
    for (const p of t.players.values()) {
      if (sitsOnBench(p)) {
        p.seat = k++;
        placeOnBench(p);
      }
    }
    t.bullpen.slice(0, 3).forEach((p, i) => placeInBullpen(p, i));
  }
}

const inDugout = (p: PlayerRT) => p.dug === 'bench' || p.dug === 'toBench' || p.dug === 'toDeck';

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
  // door -> steps -> aisle -> seat (from wherever he is on the field)
  p.route = [dugDoor(side), dugStep(side), benchAisle(side, p.seat), benchSeat(side, p.seat)];
  p.routeMul = walkMul(p, 2.6);
  p.after = null;
}

/** The next hitter gets up, walks out of the dugout to the on-deck circle and starts warming up. */
export function sendToDeck(w: World, p: PlayerRT): void {
  if (w.cfg.pace === 0 || p.onField || p.dug !== 'bench') return;
  const side = p.team.side;
  p.dug = 'toDeck';
  p.route = [benchAisle(side, p.seat), dugStep(side), dugDoor(side), onDeckSpot(side)];
  p.routeMul = walkMul(p);
  p.after = null;
  emit(w, { type: 'onDeck', playerId: p.info.id, team: side });
}

/** The way from where a hitter is to the batter's box: out of the dugout if he is in it, around behind the plate if the box is on the other side. */
export function routeToBox(b: PlayerRT, boxSide: 1 | -1): { x: number; z: number }[] {
  const side = b.team.side;
  const dsg = sgn(side);
  const route: { x: number; z: number }[] = [];
  if (inDugout(b)) route.push(benchAisle(side, b.seat), dugStep(side), dugDoor(side));
  if (boxSide !== dsg) route.push(behindPlate(dsg * 5.2), behindPlate(boxSide * 3.4));
  return route;
}

/**
 * Per tick: everyone who is walking a route (to the bench, to the circle, out of the dugout), the on-deck hitter's warm-up swings, and the people in the
 * bullpen. Players who are on the field are stepped by the main loop; the others are stepped here.
 */
export function tickDugout(w: World): void {
  if (w.cfg.pace === 0) return;
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
    if (p.dug !== 'bench' || p.route.length || w.propRng.next() > share) continue;
    setAnim(w, p, hint, hint === 'bench_stand_up' ? 3.0 : 2.2);
  }
}

function tickOne(w: World, p: PlayerRT): void {
  if (p.route.length) {
    const next = p.route[0];
    const last = p.route.length === 1;
    setGoal(p, next.x, next.z, last, p.routeMul);
    if (p.gait !== 'trot') p.gait = 'walk';
    if (!p.onField) stepPlayer(p, w);
    const d = Math.hypot(p.x - next.x, p.z - next.z);
    if (d < (last ? 0.12 : 0.5)) {
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
        setAnim(w, p, 'ondeck_swing', 2.0);
        p.nextSwing = w.tick + secToTicks(6 + 4 * w.propRng.next());
      } else setAnim(w, p, 'ondeck_ready', clamp((p.nextSwing - w.tick) / 240, 0.2, 1.5));
    }
  } else if (p.dug === 'bench' || p.dug === 'bullpen') {
    p.vx = p.vz = 0;
  }
}

function arrive(w: World, p: PlayerRT): void {
  p.gait = null;
  const side = p.team.side;
  if (p.dug === 'toBench') {
    p.dug = 'bench';
    p.goal = null;
    p.vx = p.vz = 0;
    p.facing = benchFacing(side);
    p.anim = 'bench_sit';
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
  p.route = [...out, ...then];
  p.dug = null;
  p.after = after;
  p.routeMul = walkMul(p, speed);
  if (!p.route.length && after) setGoal(p, after.x, after.z, after.stop, after.mul);
}
