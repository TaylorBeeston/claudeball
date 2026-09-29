import { flightStep, newFlags, predictPath, PathSample, BallBody } from './ball';
import { emit } from './events';
import { BALL_RADIUS, BASE_POS, fenceAt, isFairXZ } from './field';
import { clamp, MPH, RPM } from './math';
import { armMps, catcherTransfer, firstStepSeconds, judgementSigma, throwWindup, transferSeconds } from './attributes';
import { WALL_STAND, insideFence, setGoal, travelTime } from './movement';
import { giveBall, releaseBall, setAnim } from './util';
import type { AnimHint } from './types';
import { PENDING } from './decisions';
import type { ThrowDecision, WallPlayDecision, WallPlayRequest } from './decisions';
import { ask, situationOf } from './dispatch';
import type { PlayerRT, RunnerRT, WallPlan, World } from './world';
import { TICK, TICKS_PER_SEC as TICKS, secToTicks } from './world';
import { DEFAULT_SPOTS } from './setup';
import * as running from './running';
import * as rules from './rules';

/** Tunables (glove noise and throw noise scales). */
export const TUNE = { fieldSigma: 0.032, throwSigma: 0.0150, pocket: 0.135 };

export const fielders = (w: World): PlayerRT[] => [...w.fieldingTeam.defense.values()].filter((p) => p.onField);
export const armSpeed = (p: PlayerRT) => armMps(p.info.ratings);
export const throwTimeEstimate = (D: number, v: number) => D / (0.9 * v) + 0.05;
const bpos = (b: number) => BASE_POS[b % 4];

// ---------------------------------------------------------------------------------------------
// ball path prediction shared by the defense
// ---------------------------------------------------------------------------------------------

export function ensurePath(w: World): void {
  const ball = w.ball;
  if (!ball.pathDirty && ball.path.length && w.tick - ball.pathStart < 120) return;
  ball.path = predictPath(ball.body, w.env, 7, 1 / 60);
  ball.pathStart = w.tick;
  ball.pathDirty = false;
}

// ---------------------------------------------------------------------------------------------
// reach and jump (wall play)
// ---------------------------------------------------------------------------------------------

/** Glove height standing flat-footed, arm overhead (m). */
export const standReach = (F: PlayerRT) => F.info.height * 1.32 + 0.12;
/** Peak height of a running jump at the wall (m): athleticism and instincts. */
export const jumpHeight = (F: PlayerRT) => clamp(0.58 + 0.005 * (F.info.ratings.speed - 50) + 0.003 * (F.info.ratings.range - 50), 0.35, 0.85);
/** Glove height at `tick` for a fielder who may be in mid-leap. */
export function gloveY(F: PlayerRT, tick: number): number {
  const L = F.leap;
  if (!L) return standReach(F);
  const u = (tick - L.t0) / L.dur;
  if (u <= 0 || u >= 1) return standReach(F);
  return standReach(F) + 4 * L.h * u * (1 - u);
}
/** Horizontal reach of a glove extended over the wall while leaping (m). */
export const WALL_REACH_H = 1.25;
const LEAP_DUR = (h: number) => 2 * Math.sqrt((2 * h) / 9.80665);

export interface Intercept {
  wall?: WallPlan;
  found: boolean;
  x: number;
  z: number;
  y: number;
  t: number; // ball time from now
  tF: number; // fielder time
  margin: number;
  air: boolean;
}

export function computeIntercept(w: World, F: PlayerRT): Intercept {
  const ball = w.ball;
  const path = ball.path;
  const tNow = (w.tick - ball.pathStart) * TICK;
  const react = Math.max(0, (F.plan.reactTick - w.tick) * TICK);
  // first ground contact time (for judgement-noise scaling)
  let tGround = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i].y <= BALL_RADIUS * 1.5 && path[i].t > tNow) {
      tGround = path[i].t;
      break;
    }
  }
  const tLeft = Math.max(0, tGround - tNow);
  const off = Math.min(tLeft, 5);
  const bx = F.plan.biasX * off;
  const bz = F.plan.biasZ * off;
  let best: Intercept | null = null;
  // a ball that will meet the wall above the height a fielder can reach standing: this is a wall play
  const wallS = path.find((q) => q.wall && q.t > tNow);
  if (wallS) {
    const standing = standReach(F);
    const fd = fenceAt(w.env.fence, wallS.x, wallS.z);
    if (wallS.wall === 'over' || wallS.y > standing - 0.25) {
      const tRel = wallS.t - tNow;
      const off = Math.min(tRel, 5);
      const wp = insideFence(w, wallS.x + F.plan.biasX * off, wallS.z + F.plan.biasZ * off);
      const T = react + travelTime(F, wp.x, wp.z);
      const margin = tRel - 0.3 - T;
      const reach = standing + jumpHeight(F);
      const plan: WallPlan = {
        crossTick: w.tick + Math.round(tRel / TICK),
        x: wp.x,
        z: wp.z,
        crossY: wallS.y,
        dy: wallS.y - fd.height,
        over: wallS.wall === 'over',
        leap: null,
        timing: 0,
      };
      // reachable with a leap if the ball is within the glove's reach when it passes the wall
      const canReach = wallS.y <= reach + 0.1;
      if (margin >= 0) return { found: true, x: wp.x, z: wp.z, y: wallS.y, t: tRel, tF: T, margin, air: canReach, wall: plan };
      best = { found: false, x: wp.x, z: wp.z, y: wallS.y, t: tRel, tF: T, margin, air: false, wall: plan };
    }
  }
  const start = Math.max(0, Math.floor(tNow * 60));
  for (let i = start + 1; i < path.length; i += 2) {
    const s = path[i];
    const tRel = s.t - tNow;
    if (tRel < 0.01) continue;
    if (s.y > 2.55) continue;
    const tx = s.x + bx;
    const tz = s.z + bz;
    const fd = fenceAt(w.env.fence, tx, tz).distance;
    if (Math.hypot(tx, tz) > fd - WALL_STAND) continue;
    const T = react + travelTime(F, tx, tz);
    const margin = tRel - T;
    const air = s.y > 0.5 && !s.rolling;
    if (margin >= 0) return { found: true, x: tx, z: tz, y: s.y, t: tRel, tF: T, margin, air };
    if (!best || -margin < -best.margin) best = { found: false, x: tx, z: tz, y: s.y, t: tRel, tF: T, margin, air };
  }
  if (best) return best;
  const last = path[path.length - 1] ?? { x: ball.body.x, z: ball.body.z, y: 0, t: 0 };
  const lp = insideFence(w, last.x, last.z);
  return { found: false, x: lp.x, z: lp.z, y: last.y, t: 5, tF: 5 + travelTime(F, lp.x, lp.z), margin: -5, air: false };
}

// ---------------------------------------------------------------------------------------------
// play start: reactions and judgement bias
// ---------------------------------------------------------------------------------------------

export function initFielderPlans(w: World, reactSecBase: number): void {
  for (const F of fielders(w)) {
    const rg = F.info.ratings.range;
    // first step (range, reads) and how well he judges the ball's flight (range, fielding IQ)
    const react = reactSecBase + firstStepSeconds(F.info.ratings, Math.abs(w.rng.normal(0, 0.04)));
    const kJ = judgementSigma(F.info.ratings);
    F.plan = {
      kind: 'idle',
      base: 0,
      tx: F.x,
      tz: F.z,
      reactTick: w.tick + secToTicks(react),
      biasX: w.rng.normal(0, kJ),
      biasZ: w.rng.normal(0, kJ),
      biasY: w.rng.normal(0, 0.16 + 0.0025 * (100 - rg) / 2),
      biasT: w.rng.normal(0, 0.05 + 0.0006 * (100 - rg)),
      wall: null,
      askSeq: 0,
      lastSig: '',
      recheckTick: 0,
      asking: false,
      tagTarget: null,
      catchZ: null,
      holdUntil: 0,
      releaseAt: 0,
      throwBase: 0,
      throwTo: null,
      lastAttempt: -999,
      wasPrimary: false,
      delays: 0,
    };
    F.lookAt = null;
  }
}

// ---------------------------------------------------------------------------------------------
// defense AI (runs every ~50 ms while the ball is live)
// ---------------------------------------------------------------------------------------------

const COVER_ORDER: Record<number, string[]> = {
  1: ['1B', 'P', '2B'],
  2: ['SS', '2B', '3B'],
  3: ['3B', 'SS', 'P'],
  4: ['C', 'P', '1B'],
};

export function defenseAI(w: World): void {
  const play = w.play!;
  const ball = w.ball;
  const team = w.fieldingTeam;
  const all = fielders(w);
  ensurePath(w);
  const holder = ball.holder && ball.holder.team === team ? ball.holder : null;

  // coverage needs
  const needs = new Set<number>();
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead) continue;
    if (r.isBatter && r.base === 0) needs.add(1);
    else if (r.target > r.base) needs.add(r.target);
    else if (r.base >= 1 && !running.isOnBase(r)) needs.add(r.base);
    if (r.base >= 2 && r.target === r.base && (r.want > r.base || w.ball.mode !== 'held')) needs.add(r.base + 1);
    if (r.retouch) needs.add(r.retouch);
  }

  // chase logic
  let primary: PlayerRT | null = null;
  const chasing = !holder && (ball.mode === 'batted' || ball.mode === 'loose');
  if (chasing) {
    let bestScore = Infinity;
    let bestF: PlayerRT | null = null;
    let bestIc: Intercept | null = null;
    let catchMargin = -Infinity;
    for (const F of all) {
      if (F.plan.releaseAt > 0 && w.tick < F.plan.releaseAt + 20) continue;
      const ic = computeIntercept(w, F);
      if (ic.found && ic.air) catchMargin = Math.max(catchMargin, ic.margin);
      const deepBonus = ic.air && Math.hypot(ic.x, ic.z) > 45 && !isOutfielder(F) ? 0.35 : 0;
      const isDeepFly = ic.air && Math.hypot(ic.x, ic.z) > 40;
      const ofBonus = isDeepFly && isOutfielder(F) ? -0.25 : 0;
      const score = ic.found ? ic.t - 0.7 * ic.margin + deepBonus + ofBonus + (F.plan.wasPrimary ? -0.12 : 0) : 100 + (-ic.margin) + (F.plan.wasPrimary ? -0.2 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestF = F;
        bestIc = ic;
      }
    }
    primary = bestF;
    play.primary = primary;
    for (const F of all) F.plan.wasPrimary = F === primary;
    const bip = play.bip;
    play.catchMargin = bip && bip.status !== 'foul' && !bip.landed && !ball.touchedGround && catchMargin > -Infinity ? catchMargin : null;
    for (const F of all) if (F !== primary && !F.leap) F.plan.wall = null;
    if (bestF && bestIc) {
      const F = bestF;
      const tgt = insideFence(w, bestIc.x, bestIc.z);
      if (bestIc.wall) {
        // wall play: run to the fence under the ball, plant, and (maybe) leave the ground
        const prev = F.plan.wall;
        F.plan.wall = prev ? { ...bestIc.wall, leap: prev.leap, timing: prev.timing } : bestIc.wall;
        F.plan.kind = 'wall';
        setGoal(F, tgt.x, tgt.z, true, 1);
      } else {
        if (!F.leap) F.plan.wall = null;
        F.plan.kind = 'chase';
        setGoal(F, tgt.x, tgt.z, !bestIc.found || bestIc.margin > 0.12, 1); // he plans his braking unless the ball only just gets there
      }
      F.plan.tx = tgt.x;
      F.plan.tz = tgt.z;
      F.lookAt = { x: ball.body.x, z: ball.body.z };
    }
  } else {
    play.primary = holder;
    play.catchMargin = null;
    for (const F of all) F.plan.wasPrimary = F === holder;
  }

  // coverage assignments
  const covers: Record<number, PlayerRT | null> = { 1: null, 2: null, 3: null, 4: null };
  if (play.kind === 'pickoff') for (const b of [1, 2, 3, 4]) covers[b] = play.covers[b] ?? null;
  const taken = new Set<PlayerRT>();
  if (primary) taken.add(primary);
  if (holder) taken.add(holder);
  const sideLeft = ball.body.x >= 0; // ball toward third-base side
  for (const b of [...needs].filter((x) => x >= 1 && x <= 4).sort((a, c) => a - c)) {
    let order = COVER_ORDER[b];
    if (b === 2) order = sideLeft ? ['2B', 'SS', '3B'] : ['SS', '2B', '1B'];
    let chosen: PlayerRT | null = covers[b];
    // holder standing at the base covers it himself
    if (!chosen && holder && Math.hypot(holder.x - bpos(b).x, holder.z - bpos(b).z) < 4) chosen = holder;
    for (const pos of order) {
      if (chosen) break;
      const F = team.defense.get(pos as never);
      if (!F || !F.onField || taken.has(F)) continue;
      chosen = F;
    }
    covers[b] = chosen;
    if (chosen) taken.add(chosen);
  }
  play.covers = covers;
  for (const b of [1, 2, 3, 4]) {
    const F = covers[b];
    if (!F || F === holder || F === primary) continue;
    const bp = bpos(b);
    // stand a little inside the bag toward the ball
    const dx = ball.body.x - bp.x;
    const dz = ball.body.z - bp.z;
    const dl = Math.hypot(dx, dz) || 1;
    F.plan.kind = 'cover';
    F.plan.base = b;
    F.plan.tx = bp.x + (dx / dl) * 0.5;
    F.plan.tz = bp.z + (dz / dl) * 0.5;
    setGoal(F, F.plan.tx, F.plan.tz, true, 1);
    F.lookAt = { x: ball.body.x, z: ball.body.z };
  }

  // cut-off man for deep balls to the outfield
  play.cutoff = null;
  if (primary && isOutfielder(primary) && (chasing || (holder && isOutfielder(holder)))) {
    const src = holder ?? primary;
    const cand = team.defense.get(src.x >= 0 ? 'SS' : '2B');
    if (cand && !taken.has(cand) && needs.size > 0) {
      const targetBase = Math.max(...needs);
      const bp = bpos(targetBase);
      const sx = holder ? holder.x : play.primary ? play.primary!.plan.tx : src.x;
      const sz = holder ? holder.z : play.primary ? play.primary!.plan.tz : src.z;
      const dx = bp.x - sx;
      const dz = bp.z - sz;
      const dl = Math.hypot(dx, dz) || 1;
      const dcut = Math.min(dl * 0.55, dl - 12);
      cand.plan.kind = 'cutoff';
      cand.plan.tx = sx + (dx / dl) * dcut;
      cand.plan.tz = sz + (dz / dl) * dcut;
      setGoal(cand, cand.plan.tx, cand.plan.tz, true, 1);
      cand.lookAt = { x: sx, z: sz };
      play.cutoff = cand;
      taken.add(cand);
    }
  }

  // remaining fielders: outfield backups / back to position
  for (const F of all) {
    if (taken.has(F)) continue;
    if (F === primary || F === holder) continue;
    const pos = F.fieldPos as keyof typeof DEFAULT_SPOTS;
    if (isOutfielder(F) && primary && ball.mode !== 'thrown') {
      const px = play.primary!.plan.tx;
      const pz = play.primary!.plan.tz;
      const dl = Math.hypot(px, pz) || 1;
      F.plan.kind = 'backup';
      const bk = insideFence(w, px + (px / dl) * 10, pz + (pz / dl) * 10);
      F.plan.tx = bk.x;
      F.plan.tz = bk.z;
      setGoal(F, F.plan.tx, F.plan.tz, true, 1);
    } else {
      const spot = DEFAULT_SPOTS[pos] ?? { x: 0, z: 30 };
      F.plan.kind = 'idle';
      setGoal(F, spot.x, spot.z, true, 0.9);
    }
    F.lookAt = { x: ball.body.x, z: ball.body.z };
  }

  // the holder decides what to do with the ball
  if (holder) holderLogic(w, holder);
  // receivers of a thrown ball
  if (ball.mode === 'thrown') receiverLogic(w);
}

export const isOutfielder = (p: PlayerRT) => p.fieldPos === 'LF' || p.fieldPos === 'CF' || p.fieldPos === 'RF';

function receiverLogic(w: World): void {
  const ball = w.ball;
  const R = ball.throwTo;
  if (!R || !ball.throwTarget) return;
  R.plan.kind = 'receive';
  // go to (and stay at) the spot the throw is aimed at; small adjustments for a throw that is going astray
  let gx = ball.throwTarget.x;
  let gz = ball.throwTarget.z;
  const b = ball.body;
  const path = ball.path;
  if (path.length) {
    // where does the throw actually pass nearest the aiming point (with the glove at chest height)?
    let bestD = 1e9;
    let bx = gx;
    let bz = gz;
    for (let i = 1; i < path.length; i++) {
      const s = path[i];
      if (s.y > 2.6) continue;
      const d = Math.hypot(s.x - gx, s.z - gz);
      if (d < bestD) {
        bestD = d;
        bx = s.x;
        bz = s.z;
      }
      if (s.t > 4) break;
    }
    if (bestD > 0.9 && bestD < 4) {
      const move = Math.min(bestD, 2.2);
      gx += ((bx - gx) / bestD) * move;
      gz += ((bz - gz) / bestD) * move;
    }
  }
  setGoal(R, gx, gz, true, 1);
  R.lookAt = { x: b.x, z: b.z };
}

// ---------------------------------------------------------------------------------------------
// ball times for baserunner decisions
// ---------------------------------------------------------------------------------------------

export function estimateBallTimes(w: World): number[] {
  const play = w.play!;
  if (play.estTick === w.tick && play.est.length) return play.est;
  const ball = w.ball;
  const team = w.fieldingTeam;
  let Tc = 0;
  let Lx = ball.body.x;
  let Lz = ball.body.z;
  let arm = 36;
  if (ball.holder && ball.holder.team === team) {
    const F = ball.holder;
    Tc = Math.max(0, (Math.max(F.plan.holdUntil, F.plan.releaseAt) - w.tick) * TICK);
    Lx = F.x;
    Lz = F.z;
    arm = armSpeed(F);
  } else if (ball.mode === 'thrown' && ball.throwTo) {
    const R = ball.throwTo;
    const bp = ball.body;
    Tc = throwTimeEstimate(Math.hypot(R.x - bp.x, R.z - bp.z), Math.hypot(bp.vx, bp.vz) + 1) + 0.3;
    Lx = R.x;
    Lz = R.z;
    arm = armSpeed(R);
  } else if (play.primary) {
    const F = play.primary;
    const ic = computeIntercept(w, F);
    Tc = Math.max(ic.found ? ic.t : ic.tF, 0) + 0.45;
    Lx = ic.x;
    Lz = ic.z;
    arm = armSpeed(F);
  }
  const est = [0, 0, 0, 0, 0];
  for (let b = 1; b <= 4; b++) {
    const bp = bpos(b);
    const D = Math.hypot(bp.x - Lx, bp.z - Lz);
    let t = Tc + throwTimeEstimate(D, arm) + 0.2;
    if (D > 66) t += 0.5;
    est[b] = t;
  }
  play.est = est;
  play.estTick = w.tick;
  return est;
}

export function playNearBase(w: World, b: number): boolean {
  const ball = w.ball;
  const bp = bpos(b);
  if (ball.mode === 'thrown' && ball.throwBase === b) return true;
  if (ball.holder && ball.holder.team === w.fieldingTeam && Math.hypot(ball.holder.x - bp.x, ball.holder.z - bp.z) < 9) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// fielding a ball: catches, bobbles, misses
// ---------------------------------------------------------------------------------------------

function gauss2(w: World, sigma: number): number {
  return Math.hypot(w.rng.normal(0, sigma), w.rng.normal(0, sigma));
}

export function transferTicks(F: PlayerRT, onRun: number): number {
  if (F.fieldPos === 'C') return secToTicks(catcherTransfer(F.info.ratings));
  return secToTicks(transferSeconds(F.info.ratings, onRun));
}

/** Per-tick check whether any fielder gets a glove on the ball. */
export function fieldingAttempts(w: World): void {
  const ball = w.ball;
  if (ball.holder) return;
  if (ball.mode !== 'batted' && ball.mode !== 'loose' && ball.mode !== 'thrown') return;
  const b = ball.body;
  for (const F of fielders(w)) {
    if (w.tick < F.plan.reactTick && ball.mode !== 'thrown') continue;
    if (w.tick - F.plan.lastAttempt < 48) continue;
    if (F.plan.releaseAt > 0) continue;
    if (ball.mode === 'thrown' && ball.thrower === F && w.tick - (w.play?.lastThrowTick ?? 0) < 60) continue;
    const dh = Math.hypot(b.x - F.x, b.z - F.z);
    const sp = Math.hypot(F.vx, F.vz);
    const low = b.y < 0.5;
    if (F.leap) {
      // leaping at the wall: the glove reaches over the fence, as high as the jump takes it
      if (leapAttempt(w, F)) return;
      continue;
    }
    const reachH = (low ? 0.92 : 1.15) + (sp > 5 ? 0.22 : 0);
    const reachV = 2.45 + (sp > 3 ? 0.3 : 0.05);
    if (dh > reachH || b.y > reachV) continue;
    if (F.plan.kind === 'idle' && ball.mode === 'batted' && ball.touchedGround === false && b.y > 2.6) continue;
    attempt(w, F, dh / reachH);
    if (ball.holder) return;
  }
}

/** A leaping fielder's glove against the ball; returns true if the ball is now held. */
function leapAttempt(w: World, F: PlayerRT): boolean {
  const ball = w.ball;
  const b = ball.body;
  if (ball.holder || w.tick - F.plan.lastAttempt < 48) return false;
  const glove = gloveY(F, w.tick);
  const dh = Math.hypot(b.x - F.x, b.z - F.z);
  if (dh > WALL_REACH_H || b.y > glove + 0.18 || b.y < glove - 1.3) return false;
  const vs = clamp((b.y - (glove - 0.45)) / 0.65, 0, 1);
  attempt(w, F, Math.max(dh / WALL_REACH_H, vs));
  return !!ball.holder;
}

/** One last try at the tick a fair ball clears the fence: anyone in mid-leap gets a glove out. */
export function wallLastChance(w: World): boolean {
  for (const F of fielders(w)) {
    if (F.leap && leapAttempt(w, F)) return true;
  }
  return false;
}

/** Wall play state machine: decide (once) whether to leap, and leave the ground so the glove peaks as the ball arrives. */
export function tickWallPlay(w: World): void {
  const play = w.play;
  for (const F of fielders(w)) {
    if (F.leap && w.tick >= F.leap.t0 + F.leap.dur) F.leap = null;
    const wp = F.plan.wall;
    if (!wp || F.leap || !play || play.dead) continue;
    if (w.tick > wp.crossTick + 24) continue;
    const d = Math.hypot(F.x - wp.x, F.z - wp.z);
    if (wp.leap === null && d < 12) {
      // he watches the ball and decides whether it is worth going up for (he misjudges its height by biasY)
      const reach = standReach(F) + jumpHeight(F);
      const dec = ask(
        w,
        `wall:${F.info.id}`,
        'wallPlay',
        w.fieldingTeam.side,
        () => ({
          fielder: F.info,
          ballHeightAtWall: wp.crossY + F.plan.biasY,
          aboveWall: wp.dy + F.plan.biasY,
          wallHeight: wp.crossY - wp.dy,
          standingReach: standReach(F),
          jumpReach: reach,
          timeToWall: Math.max(0, (wp.crossTick - w.tick) * TICK),
          overFence: wp.over,
        }),
        { F },
      );
      if (dec === PENDING) continue;
      wp.leap = dec.leap;
      wp.timing = dec.timing ?? 0;
    }
    if (!wp.leap) continue;
    const h = jumpHeight(F);
    const dur = LEAP_DUR(h);
    const apexTicks = Math.round((dur / 2) * TICKS);
    const startTick = wp.crossTick - apexTicks + Math.round((F.plan.biasT + wp.timing) * TICKS);
    if (d < 2.4 && w.tick >= startTick && w.tick <= wp.crossTick) {
      F.leap = { t0: w.tick, dur: Math.round(dur * TICKS), h };
      setAnim(w, F, 'catch_jump', dur + 0.25);
      F.plan.lastAttempt = Math.min(F.plan.lastAttempt, w.tick - 60);
      emit(w, { type: 'wallLeap', fielderId: F.info.id, pos: { x: F.x, y: 0, z: F.z }, ballHeightAboveWall: wp.dy });
    }
  }
}

function attempt(w: World, F: PlayerRT, stretch: number): void {
  const ball = w.ball;
  const b = ball.body;
  const play = w.play!;
  F.plan.lastAttempt = w.tick;
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  const rel = Math.hypot(b.vx - F.vx, b.vy, b.vz - F.vz);
  const fs = Math.hypot(F.vx, F.vz);
  const air = b.y > 0.4 && !b.rolling;
  const g = F.info.ratings.glove;
  const isCatcher = F.fieldPos === 'C';
  const skill = isCatcher ? (g + F.info.ratings.catching) / 2 : g;
  const sigma = TUNE.fieldSigma * (air ? 1 : 1.12) * (0.55 + rel / 38) * (1 + 1.1 * stretch * stretch) * (1 + 0.1 * (fs / 8)) * (1.75 - 0.015 * skill);
  // his glove's miss was drawn when he first committed to the catch (so the renderer can show it coming); its size is set by the difficulty now
  const zz = F.plan.catchZ;
  F.plan.catchZ = null;
  const sg = sigma * (ball.mode === 'thrown' ? 0.6 : 1);
  const e = zz ? sg * Math.hypot(zz[0], zz[1]) : gauss2(w, sg);
  const pocket = TUNE.pocket;
  const fromThrow = ball.mode === 'thrown';
  const routine = stretch < 0.6 && sp < 40;
  if (e <= pocket) {
    secure(w, F, air, fromThrow, fs, { firm: e <= pocket * 0.7, stretch });
    return;
  }
  F.catchArmed = false;
  F.gloveTarget = null;
  if (e <= pocket * 1.7 && sp < 32) {
    // bobble: ball spills a short distance in front of the fielder
    const ang = w.rng.range(0, Math.PI * 2);
    b.x += Math.sin(ang) * 0.4;
    b.z += Math.cos(ang) * 0.4;
    b.vx = Math.sin(ang) * 1.4 + F.vx * 0.3;
    b.vz = Math.cos(ang) * 1.4 + F.vz * 0.3;
    b.vy = air ? -0.5 : 0.8;
    b.y = Math.max(b.y, BALL_RADIUS);
    b.rolling = false;
    ball.mode = 'loose';
    ball.pathDirty = true;
    ball.touchedGround = true;
    ball.lastTouch = F;
    if (routine) chargeError(w, F, 'bobble');
    return;
  }
  // clean miss: ball ricochets off the glove/body
  const mult = 0.35;
  b.vx = b.vx * mult + w.rng.normal(0, 2.5);
  b.vz = b.vz * mult + w.rng.normal(0, 2.5);
  b.vy = Math.abs(b.vy) * 0.3 + 1.2;
  ball.mode = 'loose';
  ball.pathDirty = true;
  ball.lastTouch = F;
  if (air) ball.touchedGround = ball.touchedGround; // a dropped fly is not a catch
  if (routine) chargeError(w, F, fromThrow ? 'throw' : 'drop');
}

/** The ball pops out of the glove / hand on contact with the runner: loose at the spot, an error on the fielder. */
export function dropBall(w: World, F: PlayerRT, at: { x: number; z: number }): void {
  const b = w.ball.body;
  releaseBall(w);
  F.hasBall = false;
  b.x = at.x;
  b.z = at.z;
  b.y = 0.6;
  b.vx = w.rng.normal(0, 1.2) + F.vx * 0.3;
  b.vz = w.rng.normal(0, 1.2) + F.vz * 0.3;
  b.vy = 0.5;
  b.rolling = false;
  w.ball.mode = 'loose';
  w.ball.pathDirty = true;
  w.ball.touchedGround = true;
  w.ball.lastTouch = F;
  F.plan.kind = 'idle';
  F.plan.lastAttempt = w.tick;
  chargeError(w, F, 'drop');
}

function chargeError(w: World, F: PlayerRT, kind: 'drop' | 'bobble' | 'throw'): void {
  const play = w.play!;
  play.hadError = true;
  if (!play.errors.includes(F)) {
    play.errors.push(F);
    F.team.errors++;
    emit(w, { type: 'error', fielderId: F.info.id, kind });
  }
  if (play.bip) play.bip.errorBy = F;
  for (const r of w.runners) if (r.state === 'live' && r.isBatter && r.base === 0) r.reachedOnError = true;
}

/** Which side of his body a catch is on: `lateral` > 0 is toward his throwing-arm side (the glove is on the other hand). */
function lateralOf(F: PlayerRT, x: number, z: number): number {
  const rx = -Math.cos(F.facing);
  const rz = Math.sin(F.facing);
  const l = (x - F.x) * rx + (z - F.z) * rz; // + = his right
  return F.info.throws === 'R' ? l : -l; // for a right-hander the throwing arm is the right one
}

/** How a catch is made, from where the ball meets the glove: height, side, kind and the animation hint that shows it. */
function catchDetail(w: World, F: PlayerRT, air: boolean, fromThrow: boolean, how: { firm: boolean; stretch: number }) {
  const b = w.ball.body;
  const lat = lateralOf(F, b.x, b.z);
  const height: 'low' | 'chest' | 'high' = b.y < 0.6 ? 'low' : b.y < 1.5 ? 'chest' : 'high';
  const bip = w.play?.bip;
  const kind: 'throw' | 'pickoff' | 'fly' | 'line' | 'ground' = fromThrow ? (w.play?.kind === 'pickoff' ? 'pickoff' : 'throw') : air && !w.ball.touchedGround ? (bip?.line ? 'line' : 'fly') : 'ground';
  let side: 'glove' | 'arm' | 'backhand' | 'forehand';
  if (kind === 'ground') side = lat > 0.35 ? 'backhand' : 'forehand';
  else side = lat > 0.6 ? 'backhand' : lat > 0.3 ? 'arm' : 'glove';
  const reachOut = Math.hypot(b.x - F.x, b.z - F.z);
  let hint: AnimHint;
  if (kind === 'ground') hint = 'field_grounder';
  else if (kind === 'throw' || kind === 'pickoff') hint = F.fieldPos === '1B' || reachOut > 1.0 || how.stretch > 0.6 ? 'catch_stretch' : 'catch_throw';
  else hint = side === 'backhand' ? 'catch_backhand' : 'catch_fly';
  return { hint, fields: { kind, height, side, firm: how.firm } as const };
}

/** A fielder controls the ball. */
export function secure(w: World, F: PlayerRT, air: boolean, fromThrow: boolean, fs: number, how: { firm: boolean; stretch: number } = { firm: true, stretch: 0 }): void {
  const play = w.play!;
  const ball = w.ball;
  const b = ball.body;
  const bip = play.bip;
  const fairHere = isFairXZ(b.x, b.z);
  // a fair fly ball that was going over the fence and is caught by a leaping fielder is a robbed home run
  let robbedDy: number | null = null;
  if (F.leap && bip && air && !fromThrow && !ball.touchedGround && fairHere) {
    const wallS = predictPath(b, w.env, 3, 1 / 60).find((q) => q.wall);
    if (wallS && wallS.wall === 'over') robbedDy = wallS.y - fenceAt(w.env.fence, wallS.x, wallS.z).height;
  }
  const bx0 = b.x;
  const by0 = b.y;
  const bz0 = b.z;
  const detail = catchDetail(w, F, air, fromThrow, how);
  giveBall(w, F);
  F.gloveHold = { x: bx0, y: by0, z: bz0, t0: w.tick };
  F.gloveTarget = null;
  F.plan.kind = 'hold';
  F.plan.holdUntil = w.tick + transferTicks(F, fs > 4 ? 1 : 0);
  F.plan.releaseAt = 0;
  F.goal = null;
  play.touches.push(F);
  // the catch animation was started ~0.3 s ahead so that the catch is at about its half-way point; if it was not, start it now
  if (!F.catchArmed && !F.leap) setAnim(w, F, detail.hint, 0.6);
  F.catchArmed = false;
  if (!fromThrow && bip && !bip.firstFielder) {
    bip.firstFielder = F;
    bip.fielders.push(F);
    if (bip.status === 'undecided') {
      bip.status = fairHere ? 'fair' : 'foul';
      bip.firstTouch = { x: b.x, z: b.z };
    }
    emit(w, { type: air && !ball.touchedGround ? 'catch' : 'fielded', fielderId: F.info.id, ...(air && !ball.touchedGround ? { fly: true, pos: { x: bx0, y: by0, z: bz0 } } : { clean: true, pos: { x: bx0, y: by0, z: bz0 } }), ...detail.fields } as never);
    if (air && !ball.touchedGround && !bip.caught) {
      bip.caught = true;
      bip.landed = false;
      const br = w.runners.find((r) => r.isBatter && r.state === 'live');
      if (br) {
        const kind = bip.status === 'foul' ? 'foulFly' : bip.infieldFly ? 'infieldFly' : bip.launchDeg > 45 ? 'pop' : bip.line ? 'line' : 'fly';
        rules.recordOut(w, br, kind, [F], null, false);
      }
      // runners must retouch their bases
      for (const r of w.runners) {
        if (r.state !== 'live' || r.isBatter) continue;
        r.tagWait = false;
        r.retouch = r.base;
        r.retouchDone = running.isOnBase(r);
        r.want = r.base;
      }
      if (robbedDy !== null) {
        bip.robbed = true;
        emit(w, { type: 'robbedHomeRun', fielderId: F.info.id, batterId: w.batter!.info.id, distance: Math.hypot(bx0, bz0), heightAboveWall: robbedDy, pos: { x: bx0, y: by0, z: bz0 } });
      }
    }
  } else if (fromThrow) {
    if (!bip?.fielders.includes(F)) bip?.fielders.push(F);
    emit(w, { type: 'catch', fielderId: F.info.id, fly: false, pos: { x: bx0, y: by0, z: bz0 }, ...detail.fields });
  } else if (!bip) {
    emit(w, { type: 'fielded', fielderId: F.info.id, clean: true, pos: { x: bx0, y: by0, z: bz0 }, ...detail.fields });
  }
  void fairHere;
}

// ---------------------------------------------------------------------------------------------
// the man with the ball
// ---------------------------------------------------------------------------------------------

interface ThrowOptionRT {
  kind: 'throw' | 'self' | 'tag';
  base: number;
  runner: RunnerRT;
  margin: number;
  receiver: PlayerRT | null;
  fielderTime: number;
  runnerTime: number;
  force: boolean;
}

function throwSig(w: World, F: PlayerRT): string {
  const play = w.play!;
  return [w.ball.mode, play.throws, F.plan.holdUntil <= w.tick ? 1 : 0, play.errors.length, ...w.runners.filter((r) => r.state === 'live' && !r.dead).map((r) => `${r.p.info.id}:${r.base}:${r.target}:${r.overrun ? 1 : 0}`)].join('|');
}

function holderLogic(w: World, F: PlayerRT): void {
  const play = w.play!;
  if (F.plan.releaseAt > 0) {
    // winding up: stand and face the target
    F.goal = null;
    return;
  }
  if (w.tick < F.plan.holdUntil) {
    // the man covering a base with a runner coming keeps moving to the bag while he secures the ball
    const cb = [1, 2, 3, 4].find((b) => play.covers[b] === F && w.runners.some((r) => r.state === 'live' && !r.dead && r.target === b && r.target > r.base));
    if (cb) setGoal(F, bpos(cb).x, bpos(cb).z, true, 1);
    else F.goal = null;
    return;
  }
  // chasing a runner down: keep closing on him
  if (F.plan.kind === 'tag' && F.plan.tagTarget && F.plan.tagTarget.state === 'live' && !F.plan.tagTarget.dead) {
    setGoal(F, F.plan.tagTarget.p.x, F.plan.tagTarget.p.z, false, 1);
  }
  const options = throwOptions(w, F);
  if (!options.length) {
    // nothing to do: hold the ball and drift toward the infield
    if (!F.goal) F.plan.kind = 'hold';
    return;
  }
  const sig = throwSig(w, F);
  if (!F.plan.asking && sig === F.plan.lastSig && w.tick < F.plan.recheckTick) return;
  F.plan.asking = true;
  const d = ask(
    w,
    `throw:${F.info.id}`,
    'throw',
    w.fieldingTeam.side,
    () => ({
      situation: situationOf(w),
      fielder: F.info,
      pos: { x: F.x, y: 0, z: F.z },
      armMps: armSpeed(F),
      options: options.map((o) => ({
        action: o.kind === 'self' ? ('run' as const) : o.kind,
        base: o.base,
        runnerId: o.runner.p.info.id,
        receiverId: o.receiver ? o.receiver.info.id : null,
        viaCutoff: o.kind === 'throw' && !!o.receiver && willRelay(w, F, o.receiver),
        fielderTime: o.fielderTime,
        runnerTime: o.runnerTime,
        margin: o.margin,
        force: o.force,
      })),
      cutoffId: play.cutoff ? play.cutoff.info.id : null,
    }),
    { F, options },
  );
  if (d === PENDING) {
    play.aiNext = w.tick + 1; // come back next tick for the answer
    return;
  }
  F.plan.asking = false;
  F.plan.lastSig = throwSig(w, F);
  F.plan.recheckTick = d.recheckSec !== undefined ? w.tick + secToTicks(d.recheckSec) : Infinity;
  if (d.action === 'hold') {
    if (!F.goal) F.plan.kind = 'hold';
    return;
  }
  if (d.action === 'tag') {
    const r = w.runners.find((q) => q.state === 'live' && !q.dead && q.p.info.id === d.runnerId);
    if (!r) return;
    F.plan.tagTarget = r;
    setGoal(F, r.p.x, r.p.z, false, 1);
    F.plan.kind = 'tag';
    F.lookAt = null;
    return;
  }
  if (d.action === 'run') {
    const bp = bpos(clamp(Math.round(d.base), 1, 4));
    setGoal(F, bp.x, bp.z, true, 1);
    F.plan.kind = 'cover';
    F.plan.base = clamp(Math.round(d.base), 1, 4);
    return;
  }
  // throw
  const base = clamp(Math.round(d.base), 1, 4);
  let receiver: PlayerRT | null = options.find((o) => o.kind === 'throw' && o.base === base)?.receiver ?? play.covers[base] ?? null;
  if (!receiver || receiver === F) {
    const pos = base === 1 ? '1B' : base === 2 ? '2B' : base === 3 ? '3B' : 'C';
    receiver = w.fieldingTeam.defense.get(pos as never) ?? null;
  }
  if (!receiver || receiver === F) return;
  if (d.viaCutoff && play.cutoff && play.cutoff !== F) receiver = play.cutoff;
  F.goal = null;
  const wind = throwWindup(F.info.ratings, Math.min(1, Math.hypot(F.vx, F.vz) / 6));
  F.plan.releaseAt = w.tick + secToTicks(wind);
  F.plan.throwBase = base;
  F.plan.throwTo = receiver;
  F.plan.tagTarget = null;
  const tx = receiver.x;
  const tz = receiver.z;
  F.lookAt = { x: tx, z: tz };
  F.facing = Math.atan2(tx - F.x, tz - F.z);
  setAnim(w, F, 'throw', 0.5);
}

const willRelay = (w: World, F: PlayerRT, receiver: PlayerRT) => {
  const play = w.play!;
  return !!play.cutoff && play.cutoff !== F && Math.hypot(receiver.x - F.x, receiver.z - F.z) > 68;
};

/** Every play the man with the ball could make (throw to a base, run it in himself, chase a runner down). */
export function throwOptions(w: World, F: PlayerRT): ThrowOptionRT[] {
  const play = w.play!;
  const arm = armSpeed(F);
  const options: ThrowOptionRT[] = [];
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead) continue;
    if (running.isOnBase(r) && r.target === r.base && !r.isBatter) continue;
    if (r.isBatter && r.base === 1 && running.isOnBase(r)) continue;
    const advancing = r.target > r.base;
    const b = advancing ? r.target : r.base;
    if (b < 1) continue;
    if (r.overrun) continue;
    const bp = bpos(b);
    const tR = running.runnerETA(r, b);
    const frc = running.forced(w, r) && advancing;
    const cover = play.covers[b] ?? null;
    const selfT = travelTime(F, bp.x, bp.z);
    const receiver: PlayerRT | null = cover && cover !== F ? cover : null;
    if (cover === F || (!receiver && selfT < 1.5)) {
      // fielder plays the base himself
      if (frc && selfT < tR - 0.05) {
        options.push({ kind: 'self', base: b, runner: r, margin: tR - selfT, receiver: null, fielderTime: selfT, runnerTime: tR, force: true });
        continue;
      }
      if (!receiver) continue;
    }
    if (!receiver) continue;
    const D = Math.hypot(receiver.x - F.x, receiver.z - F.z);
    const tB = throwTimeEstimate(D, arm) + 0.1 + (frc ? 0 : 0.16) + 0.07 + 0.06;
    options.push({ kind: 'throw', base: b, runner: r, margin: tR - tB, receiver, fielderTime: tB, runnerTime: tR, force: frc });
    // rundown: runner is close to the fielder and between bases
    const dr = Math.hypot(r.p.x - F.x, r.p.z - F.z);
    if (!frc && !running.isOnBase(r) && dr < 6 && dr < D * 0.6 && r.target > r.base && r.base >= 1) {
      options.push({ kind: 'tag', base: b, runner: r, margin: 0.2, receiver: null, fielderTime: dr / Math.max(F.vmax, 1), runnerTime: tR, force: false });
    }
  }
  return options;
}

/** The built-in fielder's choice: the most advanced runner he can still get (a runner to tag first), long throws through the cut-off man. */
export function aiThrow(w: World, F: PlayerRT, options: ThrowOptionRT[]): ThrowDecision {
  const play = w.play!;
  const rec = 0.05;
  const viable = options.filter((o) => o.margin > 0.03 || (play.kind === 'steal' && F.fieldPos === 'C' && o.runner.stealing && o.margin > -0.6));
  if (!viable.length) {
    // nobody can be stopped, but an outfielder still gets the ball back in (through the cut-off man) to hold the trailing runners
    const cand = options.filter((o) => o.kind === 'throw').sort((a, c) => c.margin - a.margin)[0];
    if (cand && isOutfielder(F)) return { action: 'throw', base: cand.base, viaCutoff: !!play.cutoff && play.cutoff !== F && Math.hypot(play.cutoff.x - F.x, play.cutoff.z - F.z) > 25, recheckSec: rec };
    return { action: 'hold', recheckSec: rec };
  }
  viable.sort((a, c) => (c.kind === 'tag' ? 1 : 0) - (a.kind === 'tag' ? 1 : 0) || c.base - a.base || c.margin - a.margin);
  const pick = viable[0];
  if (pick.kind === 'tag') return { action: 'tag', runnerId: pick.runner.p.info.id, recheckSec: rec };
  if (pick.kind === 'self') return { action: 'run', base: pick.base, recheckSec: rec };
  return { action: 'throw', base: pick.base, viaCutoff: willRelay(w, F, pick.receiver!), recheckSec: rec };
}

// ---------------------------------------------------------------------------------------------
// throwing
// ---------------------------------------------------------------------------------------------

export function solveThrow(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, speed: number, env: World['env']): { dx: number; dy: number; dz: number; time: number } {
  const hx = to.x - from.x;
  const hz = to.z - from.z;
  const Dh = Math.hypot(hx, hz);
  const ux = hx / Math.max(Dh, 1e-6);
  const uz = hz / Math.max(Dh, 1e-6);
  let ay = to.y + 0.5 * 9.8 * (Dh / speed) ** 2 * 0.9;
  let out = { dx: ux, dy: 0, dz: uz, time: Dh / speed };
  for (let it = 0; it < 9; it++) {
    const dl = Math.hypot(Dh, ay - from.y);
    const dir = { x: (ux * Dh) / dl, y: (ay - from.y) / dl, z: (uz * Dh) / dl };
    const rpm = 1500 * RPM;
    // backspin: omega = vhat x up
    const wv = { x: dir.y * 0 - dir.z * 1, y: 0, z: dir.x * 1 - 0 };
    void wv;
    const body: BallBody = {
      x: from.x, y: from.y, z: from.z,
      vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
      wx: -dir.z * rpm, wy: 0, wz: dir.x * rpm, rolling: false,
    };
    // omega = vhat x yhat = (vy*0 - vz*1, vz*0 - vx*0, vx*1 - vy*0) = (-vz, 0, vx)
    let t = 0;
    let yAt = -9;
    for (let i = 0; i < 400; i++) {
      const px = body.x, pz = body.z, py = body.y;
      flightStep(body, 1 / 120, env);
      t += 1 / 120;
      const dd = (body.x - from.x) * ux + (body.z - from.z) * uz;
      if (dd >= Dh) {
        const pd = (px - from.x) * ux + (pz - from.z) * uz;
        const f = (Dh - pd) / Math.max(dd - pd, 1e-9);
        yAt = py + (body.y - py) * f;
        t -= (1 / 120) * (1 - f);
        break;
      }
      if (body.y < 0.03) {
        yAt = body.y - 3; // fell short
        break;
      }
    }
    out = { dx: dir.x, dy: dir.y, dz: dir.z, time: t };
    const err = to.y - yAt;
    if (Math.abs(err) < 0.04) break;
    ay += clamp(err, -4, 8);
    if (ay - from.y > Dh * 1.2) break;
  }
  return out;
}

/** Release a throw (called when the wind-up ends). */
export function doThrow(w: World, F: PlayerRT): void {
  const ball = w.ball;
  const play = w.play!;
  const R = F.plan.throwTo;
  const base = F.plan.throwBase;
  F.plan.releaseAt = 0;
  if (ball.holder !== F) return;
  const bp = base > 0 && !R ? bpos(base) : null;
  const isCutoff = !!R && R === play.cutoff;
  const atBase = !!R && base > 0 && !isCutoff;
  let tx: number;
  let tz: number;
  if (atBase) {
    // aim at the bag, a little toward the thrower, where the receiver will be standing
    const bp2 = bpos(base);
    const ddx = F.x - bp2.x;
    const ddz = F.z - bp2.z;
    const dl2 = Math.hypot(ddx, ddz) || 1;
    tx = bp2.x + (ddx / dl2) * 0.5;
    tz = bp2.z + (ddz / dl2) * 0.5;
    R!.plan.tx = tx;
    R!.plan.tz = tz;
    R!.plan.kind = 'receive';
    setGoal(R!, tx, tz, true, 1);
  } else if (isCutoff) {
    tx = R!.plan.tx;
    tz = R!.plan.tz;
  } else {
    tx = R ? R.x : bp!.x;
    tz = R ? R.z : bp!.z;
  }
  const from = { x: F.x + Math.sin(F.facing) * 0.45, y: 1.75, z: F.z + Math.cos(F.facing) * 0.45 };
  const D = Math.hypot(tx - from.x, tz - from.z);
  const effort = D > 14 ? 1 : 0.82 + 0.18 * (D / 14);
  const fs = Math.hypot(F.vx, F.vz);
  const speed = armSpeed(F) * effort * (1 - 0.05 * Math.min(1, fs / 6));
  const to = { x: tx, y: 1.25, z: tz };
  const sol = solveThrow(from, to, speed, w.env);
  if (R && atBase && F.plan.delays < 14) {
    // hold the throw until the man covering the base can be there when it arrives
    const tR = travelTime(R, tx, tz);
    if (tR > sol.time + 0.1) {
      F.plan.delays++;
      F.plan.releaseAt = w.tick + 24;
      return;
    }
  }
  F.plan.delays = 0;
  const acc = F.info.ratings.accuracy;
  const sigma = (TUNE.throwSigma - 0.00011 * acc) * (1 + 0.5 * Math.min(1, fs / 6)) * (0.8 + 0.5 * Math.min(1, D / 50));
  // angular noise: horizontal (about vertical axis) and vertical
  const az = w.rng.normal(0, sigma);
  const el = w.rng.normal(0, sigma * 1.15);
  let dx = sol.dx, dy = sol.dy, dz = sol.dz;
  const c = Math.cos(az), s = Math.sin(az);
  const rx = dx * c + dz * s;
  const rz = -dx * s + dz * c;
  dx = rx; dz = rz;
  const hl = Math.hypot(dx, dz);
  const elev = Math.atan2(dy, hl) + el;
  const ch = Math.cos(elev);
  const nx = (dx / hl) * ch, nz = (dz / hl) * ch, ny = Math.sin(elev);
  const b = ball.body;
  b.x = from.x; b.y = from.y; b.z = from.z;
  b.vx = nx * speed; b.vy = ny * speed; b.vz = nz * speed;
  const rpm = 1500 * RPM;
  b.wx = -nz * rpm; b.wy = 0; b.wz = nx * rpm;
  b.rolling = false;
  releaseBall(w);
  ball.mode = 'thrown';
  ball.thrower = F;
  ball.throwTo = R;
  ball.throwBase = base > 0 ? base : null;
  ball.throwTarget = { x: tx, z: tz };
  ball.pathDirty = true;
  ball.touchedGround = false;
  ball.lastTouch = F;
  play.throws++;
  play.lastThrowTick = w.tick;
  play.lastThrower = F;
  F.plan.kind = 'idle';
  F.plan.lastAttempt = w.tick;
  emit(w, { type: 'throw', fromId: F.info.id, toId: R ? R.info.id : null, toBase: base > 0 ? base : null, mph: speed / MPH });
}

/** Evaluate a throw that has flown past its receiver without being caught. */
export function checkWildThrow(w: World): void {
  const ball = w.ball;
  const play = w.play!;
  if (ball.mode !== 'thrown' || play.throwChecked) return;
  const R = ball.throwTo;
  const F = ball.thrower;
  if (!R || !F) return;
  const b = ball.body;
  const d = Math.hypot(b.x - R.x, b.z - R.z);
  const closing = (b.x - R.x) * b.vx + (b.z - R.z) * b.vz < 0;
  if (!closing && d > 3.2 && w.tick - play.lastThrowTick > 12) {
    play.throwChecked = true;
    // charge the thrower: the throw was beyond the receiver's reach
    play.hadError = true;
    if (!play.errors.includes(F)) {
      play.errors.push(F);
      F.team.errors++;
      emit(w, { type: 'error', fielderId: F.info.id, kind: 'throw' });
    }
    ball.mode = 'loose';
    ball.pathDirty = true;
    for (const r of w.runners) if (r.state === 'live' && r.isBatter && r.base === 0) r.reachedOnError = true;
  }
}

export { newFlags };
export type { PathSample };

/** The built-in outfielder's call at the wall: go up if the ball looks reachable (a near miss is worth a try). */
export function aiWallPlay(F: PlayerRT, req: WallPlayRequest): WallPlayDecision {
  return { leap: req.ballHeightAtWall > req.standingReach - 0.15 && req.ballHeightAtWall <= req.jumpReach + 0.2 };
}

// ---------------------------------------------------------------------------------------------
// the glove: where the ball will meet it, and the catch animation ahead of it
// ---------------------------------------------------------------------------------------------

/** First point of the ball's predicted flight that a fielder heading for his plan spot can reach (position, height, seconds from now). */
function meetPoint(w: World, F: PlayerRT): { x: number; y: number; z: number; t: number } | null {
  const path = w.ball.path;
  if (!path.length) return null;
  const tNow = (w.tick - w.ball.pathStart) * TICK;
  const T = Math.max(0.05, travelTime(F, F.plan.tx, F.plan.tz));
  let prev: { x: number; y: number; z: number; t: number; d: number } | null = null;
  for (let i = Math.max(1, Math.floor(tNow * 60)); i < path.length; i++) {
    const s = path[i];
    const t = s.t - tNow;
    if (t < 0.02) continue;
    const k = Math.min(1, t / T);
    const px = F.x + (F.plan.tx - F.x) * k;
    const pz = F.z + (F.plan.tz - F.z) * k;
    // the same reach test the attempt uses (a low ball is within 0.92 m, a higher one 1.15 m, more at a run)
    const reach = (s.y < 0.5 ? 0.92 : 1.15) + (Math.hypot(F.vx, F.vz) > 5 ? 0.22 : 0);
    const d = Math.hypot(s.x - px, s.z - pz);
    if (d <= reach && s.y <= 2.7) {
      // interpolate to the instant the ball crosses into reach (the prediction samples are 1/60 s apart)
      if (prev && prev.d > reach && prev.y <= 2.7) {
        const f = (prev.d - reach) / Math.max(1e-6, prev.d - d);
        return { x: prev.x + (s.x - prev.x) * f, y: Math.max(0.12, prev.y + (s.y - prev.y) * f), z: prev.z + (s.z - prev.z) * f, t: prev.t + (t - prev.t) * f };
      }
      return { x: s.x, y: Math.max(0.12, s.y), z: s.z, t };
    }
    prev = { x: s.x, y: s.y, z: s.z, t, d };
  }
  return null;
}

/** Each tick a ball is in flight: publish the glove target of the fielder about to catch it, and start his catch animation ~0.3 s ahead. */
export function updateGloveTargets(w: World): void {
  const ball = w.ball;
  for (const F of fielders(w)) {
    if (F.gloveTarget && F !== w.catcher && (ball.holder || w.tick > F.gloveAt + 30)) {
      F.gloveTarget = null;
      F.catchArmed = false;
    }
  }
  if (ball.holder || !(ball.mode === 'batted' || ball.mode === 'loose' || ball.mode === 'thrown')) return;
  ensurePath(w);
  const cand: PlayerRT[] = [];
  if (ball.mode === 'thrown' && ball.throwTo) cand.push(ball.throwTo);
  else if (w.play?.primary) cand.push(w.play.primary);
  // anyone the ball is about to reach (a leaper, or a fielder who is not the one the play was built around)
  for (const F of fielders(w)) if (!cand.includes(F) && (F.leap || Math.hypot(ball.body.x - F.x, ball.body.z - F.z) < 2.5)) cand.push(F);
  for (const F of cand) {
    const m = meetPoint(w, F);
    if (!m) {
      // no meeting point ahead: if the ball is already at him (or he is leaping for it) the glove is simply on the ball
      const bb = ball.body;
      const near = Math.hypot(bb.x - F.x, bb.z - F.z) < (F.leap ? 3.2 : 2.2);
      F.gloveTarget = near ? { x: bb.x, y: Math.max(0.12, bb.y), z: bb.z } : null;
      F.gloveAt = w.tick;
      continue;
    }
    if (!F.plan.catchZ) F.plan.catchZ = [w.rng.normal(0, 1), w.rng.normal(0, 1)];
    const z = F.plan.catchZ;
    // the glove is a little off the ball's line by the miss he is going to make (small: it is scaled up at the instant by the difficulty)
    // in the last few hundredths of a second the glove simply tracks the ball itself
    const bb = ball.body;
    const last = m.t <= 0.07;
    F.gloveTarget = last ? { x: bb.x + z[0] * 0.02, y: Math.max(0.12, bb.y) + z[1] * 0.02, z: bb.z } : { x: m.x + z[0] * 0.03, y: m.y + z[1] * 0.03, z: m.z };
    F.gloveAt = w.tick + Math.round(m.t / TICK);
    if (!F.catchArmed && m.t <= 0.32 && !F.leap) {
      F.catchArmed = true;
      const air = m.y > 0.4 && !ball.touchedGround;
      const fromThrow = ball.mode === 'thrown';
      const d = catchDetail(w, F, air, fromThrow, { firm: true, stretch: 0 });
      // (side is computed from where the glove will be)
      const lat = lateralOf(F, m.x, m.z);
      const hint: AnimHint = air && !fromThrow && lat > 0.6 ? 'catch_backhand' : !air && !fromThrow ? 'field_grounder' : fromThrow ? (F.fieldPos === '1B' || Math.hypot(m.x - F.x, m.z - F.z) > 1.0 ? 'catch_stretch' : 'catch_throw') : 'catch_fly';
      void d;
      setAnim(w, F, hint, 0.6);
    }
  }
}
