import { emit } from './events';
import { BASE_POS } from './field';
import { clamp } from './math';
import { setGoal, sprintSpeedOf, travelTime } from './movement';
import { setAnim } from './util';
import type { PlayerRT, RunnerRT, World } from './world';
import { TICK, secToTicks } from './world';
import * as fielding from './fielding';
import * as inplay from './inplay';
import * as rules from './rules';
import { DUGOUT } from './setup';

export const bpos = (b: number) => BASE_POS[b % 4];

export function makeRunner(w: World, p: PlayerRT, isBatter: boolean): RunnerRT {
  const r: RunnerRT = {
    p,
    base: 0,
    target: isBatter ? 1 : 0,
    state: 'live',
    origin: 0,
    isBatter,
    retouch: 0,
    stealing: false,
    reachedOnError: false,
    responsible: w.pitcher,
    committedUntil: 0,
    slide: false,
    dead: false,
    awarded: false,
    scoredTick: 0,
    touched: [false, false, false, false, false],
    want: isBatter ? 1 : 0,
    ghost: false,
    earned: false,
    overrun: false,
    bias: 0,
    tagWait: false,
    retouchDone: false,
    reaction: w.tick + secToTicks(0.12),
    stealDelay: 0,
    leadX: 0,
    leadZ: 0,
  };
  p.role = 'runner';
  p.onField = true;
  p.vmax = sprintSpeedOf(p);
  p.lookAt = null;
  if (isBatter) {
    p.goal = null;
  }
  w.runners.push(r);
  return r;
}

export function placeGhostRunner(w: World, p: PlayerRT): void {
  const r = makeRunner(w, p, false);
  r.base = 2;
  r.target = 2;
  r.want = 2;
  r.ghost = true;
  r.origin = 2;
  r.touched[2] = true;
  p.x = bpos(2).x;
  p.z = bpos(2).z;
  p.vx = p.vz = 0;
  p.goal = null;
  r.reaction = 0;
}

export const liveRunners = (w: World) => w.runners.filter((r) => r.state === 'live');
export const runnerAt = (w: World, base: number) => w.runners.find((r) => r.state === 'live' && r.base === base && r.target === r.base && !r.isBatter) ?? w.runners.find((r) => r.state === 'live' && r.base === base);

export function isOnBase(r: RunnerRT): boolean {
  if (r.base < 1) return false;
  const b = bpos(r.base);
  return Math.hypot(r.p.x - b.x, r.p.z - b.z) <= 0.9;
}

export function vulnerable(r: RunnerRT): boolean {
  if (r.state !== 'live' || r.dead) return false;
  if (isOnBase(r)) return false;
  if (r.overrun) return false;
  return true;
}

/** Is the runner forced to advance (a runner behind him needs his base)? */
export function forced(w: World, r: RunnerRT, depth = 0): boolean {
  if (r.state !== 'live' || depth > 4) return false;
  if (r.isBatter && r.base === 0) return true;
  for (const q of w.runners) {
    if (q === r || q.state !== 'live') continue;
    if (q.target === r.base && q.target > q.base && forced(w, q, depth + 1)) return true;
  }
  return false;
}

export function runnerETA(r: RunnerRT, b: number): number {
  // time to touch base b, from current position, along straight segments through intermediate bases
  const p = r.p;
  let cur = r.base;
  let t = 0;
  let first = true;
  let x = p.x;
  let z = p.z;
  const vmax = p.vmax;
  for (let k = Math.max(r.base + 1, 1); k <= b; k++) {
    const bp = bpos(k);
    if (first) {
      t += travelTime({ x, z, vx: p.vx, vz: p.vz, vmax, accel: p.accel }, bp.x, bp.z) - 0.05;
      first = false;
    } else {
      t += Math.hypot(bp.x - x, bp.z - z) / (vmax * 0.96) + 0.06;
    }
    x = bp.x;
    z = bp.z;
    cur = k;
  }
  void cur;
  if (b <= r.base) {
    const bp = bpos(b);
    t = travelTime(p, bp.x, bp.z);
  }
  return Math.max(0, t - 0.1); // reach of the foot / slide
}

// ---------------------------------------------------------------------------------------------
// leads, pickoffs, steals
// ---------------------------------------------------------------------------------------------

export function updateLeads(w: World): void {
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead || r.base < 1 || r.target !== r.base) continue;
    if (r.stealing || w.tick < r.reaction) continue;
    const nb = r.base === 3 ? 4 : r.base + 1;
    const a = bpos(r.base);
    const b = bpos(nb);
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const spd = r.p.info.ratings.speed;
    const lead = clamp(3.0 + 0.035 * (spd - 50) + 0.015 * (r.p.info.ratings.baserunning - 50), 1.8, 4.6) * (r.base === 3 ? 0.8 : 1);
    r.leadX = a.x + ((b.x - a.x) / d) * lead;
    r.leadZ = a.z + ((b.z - a.z) / d) * lead;
    const p = r.p;
    if (w.cfg.pace === 0 && Math.hypot(p.x - r.leadX, p.z - r.leadZ) > 0.1) {
      p.x = r.leadX;
      p.z = r.leadZ;
      p.vx = p.vz = 0;
    } else if (Math.hypot(p.x - r.leadX, p.z - r.leadZ) > 0.1) setGoal(p, r.leadX, r.leadZ, true, 0.5);
    p.lookAt = { x: w.pitcher.x, z: w.pitcher.z };
  }
}

/** Runners standing off a base should be able to run through their lead point quickly; snap to base when a play ends. */
export function snapRunnersToBases(w: World): void {
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    if (r.base >= 1) {
      const b = bpos(r.base);
      r.p.x = b.x;
      r.p.z = b.z;
      r.p.vx = r.p.vz = 0;
      r.p.goal = null;
      r.target = r.base;
      r.want = r.base;
      r.overrun = false;
      r.tagWait = false;
      r.retouch = 0;
      r.stealing = false;
      r.dead = false;
      r.awarded = false;
      r.origin = r.base;
      r.isBatter = false;
      r.touched = [false, false, false, false, false];
    }
  }
}

export function considerPickoff(w: World): boolean {
  const r = w.runners.find((q) => q.state === 'live' && q.base >= 1 && q.base <= 2 && q.target === q.base && !q.dead);
  if (!r) return false;
  const nextOpen = !w.runners.some((q) => q.state === 'live' && q.base === r.base + 1);
  if (!nextOpen) return false;
  const threat = clamp((r.p.info.ratings.speed - 45) / 40, 0, 1) * (r.base === 1 ? 1 : 0.6);
  const p = 0.02 + 0.1 * threat;
  if (w.rng.next() >= p) return false;
  inplay.beginPickoff(w, r);
  return true;
}

export function decideSteals(w: World, windupSecs: number): void {
  w.stealing.clear();
  const r = w.runners.find((q) => q.state === 'live' && q.base >= 1 && q.base <= 2 && q.target === q.base && !q.dead);
  if (!r) return;
  const nb = r.base + 1;
  if (w.runners.some((q) => q.state === 'live' && q.base === nb && q !== r)) return;
  if (w.outs >= 2 && r.base === 2) return;
  if (w.count.strikes === 2 && w.count.balls < 3 && w.outs < 2) {
    // less willing to run on a two-strike count with the batter possibly K'd (still allowed)
  }
  const P = r.p;
  const catcher = w.catcher;
  const jump = 0.32 - 0.002 * (P.info.ratings.baserunning - 50);
  const bp = bpos(nb);
  const dist = Math.hypot(bp.x - P.x, bp.z - P.z);
  const tRun = jump + travelTime({ x: 0, z: 0, vx: 0.4, vz: 0, vmax: P.vmax, accel: P.accel }, dist, 0) - 0.08;
  const armV = 27 + 0.21 * catcher.info.ratings.arm;
  const tx = bp.x - catcher.x;
  const tz = bp.z - catcher.z;
  const D = Math.hypot(tx, tz);
  const cr = catcher.info.ratings.catching;
  const exch = 0.72 - 0.0035 * (cr - 50);
  const tBall = windupSecs + (w.pitcher.info.arsenal.length ? 0.44 : 0.44) + exch + D / (armV * 0.9) + 0.2;
  const margin = tBall - tRun + w.rng.normal(0, 0.22);
  if (process.env.DBG_STEAL) console.log('steal eval', { tRun: tRun.toFixed(2), tBall: tBall.toFixed(2), margin: margin.toFixed(2), dist: dist.toFixed(1) });
  const aggr = (P.info.ratings.baserunning - 50) / 100 + (w.outs === 2 ? 0.05 : 0) + (r.base === 2 ? 0.1 : 0);
  const situational = w.count.balls === 3 && w.count.strikes < 2 ? -0.1 : 0;
  const thr = 0.3 - 0.3 * aggr + situational + (w.inning >= 8 && Math.abs(w.battingTeam.runs - w.fieldingTeam.runs) > 2 ? 0.2 : 0);
  if (margin > thr) {
    r.stealing = true;
    r.stealDelay = 0;
    w.stealing.add(r);
  }
}

export function onPitchRelease(w: World): void {
  for (const r of w.stealing) {
    r.want = r.base + 1;
    r.target = r.base + 1;
    r.reaction = w.tick + secToTicks(0.02 + 0.2 * (1 - r.p.info.ratings.baserunning / 100));
    r.p.vx = 0;
    r.p.lookAt = null;
    r.origin = r.base;
  }
}

// ---------------------------------------------------------------------------------------------
// per-tick runner movement and base touching
// ---------------------------------------------------------------------------------------------

export function tickRunners(w: World): void {
  for (const r of w.runners) {
    const p = r.p;
    if (r.state === 'out') {
      if (!p.goal || p.goal.mul !== 0.45) {
        const d = DUGOUT[p.team.side];
        setGoal(p, d.x, d.z, true, 0.45);
      }
      continue;
    }
    if (r.state === 'scored') {
      const d = DUGOUT[p.team.side];
      setGoal(p, d.x, d.z, true, 0.45);
      continue;
    }
    if (r.tagWait && !r.stealing) {
      // stay on the bag until the catch
      if (r.base >= 1) {
        const b = bpos(r.base);
        if (Math.hypot(p.x - b.x, p.z - b.z) > 0.3) setGoal(p, b.x, b.z, true, 0.9);
      }
      continue;
    }
    if (w.tick < r.reaction) continue;
    const nextTarget = r.want > r.base ? r.base + 1 : r.base;
    r.target = nextTarget;
    const jog = r.dead ? 0.55 : 1;
    if (r.target > r.base) {
      const tp = bpos(r.target);
      let gx = tp.x;
      let gz = tp.z;
      let stop = !(r.want > r.target) && r.target !== 1;
      if (r.target === 1 && r.want === 1 && !r.dead) {
        // run through first base
        const a = bpos(0);
        const dx = tp.x - a.x;
        const dz = tp.z - a.z;
        const dl = Math.hypot(dx, dz);
        gx = tp.x + (dx / dl) * 9;
        gz = tp.z + (dz / dl) * 9;
        stop = true;
      } else if (r.target === 1 && r.want > 1) stop = false;
      if (r.dead) stop = true;
      setGoal(p, gx, gz, stop, jog);
      p.lookAt = null;
      // touch?
      const dd = Math.hypot(p.x - tp.x, p.z - tp.z);
      if (dd < 0.9) touchBase(w, r, r.target);
    } else if (r.base >= 1 && !(r.want === r.base && !r.dead && !r.overrun && !r.retouch && !r.isBatter && w.phase !== 'inPlay')) {
      // returning to / staying at the base
      const b = bpos(r.base);
      const dd = Math.hypot(p.x - b.x, p.z - b.z);
      if (r.overrun) {
        // run-through: let momentum carry, then walk back
        if (Math.hypot(p.vx, p.vz) < 1.2) setGoal(p, b.x, b.z, true, 0.45);
        if (dd < 0.6 && Math.hypot(p.vx, p.vz) < 1.5) r.overrun = false;
      } else if (dd > 0.25 && !r.dead) setGoal(p, b.x, b.z, true, 1);
      else if (dd > 0.25) setGoal(p, b.x, b.z, true, jog);
      if (r.retouch && dd <= 0.9) r.retouchDone = true;
    }
    // slide animation: close to the target base with the ball around
    if (r.target > r.base && r.target >= 2 && !r.dead) {
      const tp = bpos(r.target);
      const dd = Math.hypot(p.x - tp.x, p.z - tp.z);
      if (dd < 3.4 && Math.hypot(p.vx, p.vz) > 3 && fielding.playNearBase(w, r.target)) {
        if (p.anim !== 'slide') setAnim(w, p, 'slide', 0.7);
      }
    }
  }
}

function touchBase(w: World, r: RunnerRT, b: number): void {
  if (r.touched[b] && r.base >= b) return;
  const from = r.base;
  r.base = b;
  r.touched[b] = true;
  emit(w, { type: 'runnerAdvance', playerId: r.p.info.id, fromBase: from, toBase: b });
  if (fielding.playNearBase(w, b)) emit(w, { type: 'safe', playerId: r.p.info.id, base: b });
  if (b === 1 && r.isBatter && r.want === 1) r.overrun = true;
  if (b === 4) {
    if (r.p.info.id) rules.scoreRun(w, r);
    return;
  }
  if (r.stealing && b === r.origin + 1) {
    r.p.bat.sb++;
    emit(w, { type: 'steal', runnerId: r.p.info.id, toBase: b });
  }
}

// ---------------------------------------------------------------------------------------------
// runner AI (decisions while the ball is in play)
// ---------------------------------------------------------------------------------------------

export function runnerAI(w: World): void {
  const play = w.play;
  if (!play) return;
  const est = fielding.estimateBallTimes(w);
  const bip = play.bip;
  const airFly = !!bip && bip.status !== 'foul' && !bip.landed && !bip.caught && w.ball.mode === 'batted' && !w.ball.touchedGround;
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead) continue;
    const p = r.p;
    if (r.stealing && !r.isBatter && r.base === r.origin) {
      // a runner who has broken for the next base is committed
      r.want = Math.max(r.want, r.origin + 1);
      continue;
    }
    // tag-up on a fly ball that is likely to be caught
    if (airFly && r.base >= 1 && !r.isBatter && r.target === r.base) {
      const cm = play.catchMargin;
      if (w.outs < 2 && cm !== null && cm + r.bias * 0.5 > -0.1) {
        r.tagWait = true;
        r.want = r.base;
        continue;
      }
    }
    if (r.tagWait) {
      if (bip && bip.caught) {
        r.tagWait = false;
        r.retouch = r.base;
      } else if (bip && (bip.landed || w.ball.touchedGround)) r.tagWait = false;
      else continue;
    }
    // desired final base
    let want = r.base;
    const frc = forced(w, r);
    if (frc) want = Math.max(want, r.base + 1);
    if (r.isBatter && r.base === 0) want = Math.max(want, 1);
    const safety = 0.16 + 0.3 * (1 - clamp((p.info.ratings.baserunning + 30) / 100, 0, 1)) + (w.outs === 2 ? -0.1 : 0);
    const coachExtra = r.base === 2 ? 0.05 : 0; // third-base coach is conservative at the plate
    for (let b = Math.max(r.base + 1, 1); b <= 4; b++) {
      if (b > r.base + 1 && b > want + 0) {
        // extra-base attempt needs the previous base to be attainable
        if (want < b - 1) break;
      }
      const tR = runnerETA(r, b);
      const m = est[b] - tR - r.bias - safety - (b === 4 ? coachExtra : 0);
      if (m > 0) want = Math.max(want, b);
      else break;
    }
    // if between bases and the current target is a bad bet, consider returning
    if (r.target > r.base && want < r.target && !frc) {
      const bp = bpos(r.base);
      const tBack = travelTime(p, bp.x, bp.z);
      const mAdv = est[r.target] - runnerETA(r, r.target) - r.bias;
      const mRet = est[r.base] - tBack;
      if (mAdv >= -0.05) want = r.target;
      else if (mRet > mAdv + 0.1 || true) want = r.base;
    }
    if (r.retouch && !r.retouchDone) want = r.base;
    if (want < r.want && r.target > r.base && Math.hypot(p.x - bpos(r.target).x, p.z - bpos(r.target).z) < 3) want = r.want; // committed near the bag
    if (frc) want = Math.max(want, r.base + 1);
    r.want = Math.max(want, r.base);
    if (r.retouch && r.retouchDone) r.retouch = 0;
    if (r.retouch && r.want > r.base) r.want = r.base;
  }
}

export { rules };
