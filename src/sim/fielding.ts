import { flightStep, newFlags, predictPath, PathSample, BallBody } from './ball';
import { emit } from './events';
import { BALL_RADIUS, BASE_POS, fenceAt, isFairXZ } from './field';
import { clamp, MPH, RPM } from './math';
import { setGoal, travelTime } from './movement';
import { giveBall, releaseBall, setAnim } from './util';
import type { PlayerRT, RunnerRT, World } from './world';
import { TICK, secToTicks } from './world';
import { DEFAULT_SPOTS } from './setup';
import * as running from './running';
import * as rules from './rules';

/** Tunables (glove noise and throw noise scales). */
export const TUNE = { fieldSigma: 0.03, throwSigma: 0.0165, pocket: 0.135 };

export const fielders = (w: World): PlayerRT[] => [...w.fieldingTeam.defense.values()].filter((p) => p.onField);
export const armSpeed = (p: PlayerRT) => 27 + 0.21 * p.info.ratings.arm;
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

export interface Intercept {
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
  const start = Math.max(0, Math.floor(tNow * 60));
  for (let i = start + 1; i < path.length; i += 2) {
    const s = path[i];
    const tRel = s.t - tNow;
    if (tRel < 0.01) continue;
    if (s.y > 2.55) continue;
    const tx = s.x + bx;
    const tz = s.z + bz;
    const fd = fenceAt(w.env.fence, tx, tz).distance;
    if (Math.hypot(tx, tz) > fd - 0.4) continue;
    const T = react + travelTime(F, tx, tz);
    const margin = tRel - T;
    const air = s.y > 0.5 && !s.rolling;
    if (margin >= 0) return { found: true, x: tx, z: tz, y: s.y, t: tRel, tF: T, margin, air };
    if (!best || -margin < -best.margin) best = { found: false, x: tx, z: tz, y: s.y, t: tRel, tF: T, margin, air };
  }
  if (best) return best;
  const last = path[path.length - 1] ?? { x: ball.body.x, z: ball.body.z, y: 0, t: 0 };
  return { found: false, x: last.x, z: last.z, y: last.y, t: 5, tF: 5 + travelTime(F, last.x, last.z), margin: -5, air: false };
}

// ---------------------------------------------------------------------------------------------
// play start: reactions and judgement bias
// ---------------------------------------------------------------------------------------------

export function initFielderPlans(w: World, reactSecBase: number): void {
  for (const F of fielders(w)) {
    const rg = F.info.ratings.range;
    const react = reactSecBase + 0.19 + 0.2 * (1 - rg / 100) + Math.abs(w.rng.normal(0, 0.04));
    const kJ = clamp(0.5 - 0.004 * (rg - 50), 0.2, 0.85);
    F.plan = {
      kind: 'idle',
      base: 0,
      tx: F.x,
      tz: F.z,
      reactTick: w.tick + secToTicks(react),
      biasX: w.rng.normal(0, kJ),
      biasZ: w.rng.normal(0, kJ),
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
    if (bestF && bestIc) {
      const F = bestF;
      F.plan.kind = 'chase';
      F.plan.tx = bestIc.x;
      F.plan.tz = bestIc.z;
      setGoal(F, bestIc.x, bestIc.z, !bestIc.found || bestIc.margin > 0.25, 1);
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
      F.plan.tx = px + (px / dl) * 10;
      F.plan.tz = pz + (pz / dl) * 10;
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
  const g = F.info.ratings.glove;
  if (F.fieldPos === 'C') return secToTicks(clamp(0.74 - 0.0045 * (F.info.ratings.catching - 50), 0.5, 1.0));
  return secToTicks(clamp(0.5 - 0.004 * (g - 50) + 0.03 * onRun, 0.3, 0.85));
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
    const reachH = (low ? 0.92 : 1.15) + (sp > 5 ? 0.22 : 0);
    const reachV = 2.45 + (sp > 3 ? 0.3 : 0.05);
    if (dh > reachH || b.y > reachV) continue;
    if (F.plan.kind === 'idle' && ball.mode === 'batted' && ball.touchedGround === false && b.y > 2.6) continue;
    attempt(w, F, dh / reachH);
    if (ball.holder) return;
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
  const e = gauss2(w, sigma * (ball.mode === 'thrown' ? 0.6 : 1));
  const pocket = TUNE.pocket;
  const fromThrow = ball.mode === 'thrown';
  const routine = stretch < 0.6 && sp < 40;
  if (e <= pocket) {
    secure(w, F, air, fromThrow, fs);
    return;
  }
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

/** A fielder controls the ball. */
export function secure(w: World, F: PlayerRT, air: boolean, fromThrow: boolean, fs: number): void {
  const play = w.play!;
  const ball = w.ball;
  const b = ball.body;
  const bip = play.bip;
  const fairHere = isFairXZ(b.x, b.z);
  giveBall(w, F);
  F.plan.kind = 'hold';
  F.plan.holdUntil = w.tick + transferTicks(F, fs > 4 ? 1 : 0);
  F.plan.releaseAt = 0;
  F.goal = null;
  play.touches.push(F);
  setAnim(w, F, air ? 'catch' : 'field', 0.45);
  if (!fromThrow && bip && !bip.firstFielder) {
    bip.firstFielder = F;
    bip.fielders.push(F);
    if (bip.status === 'undecided') {
      bip.status = fairHere ? 'fair' : 'foul';
      bip.firstTouch = { x: b.x, z: b.z };
    }
    emit(w, { type: air && !ball.touchedGround ? 'catch' : 'fielded', fielderId: F.info.id, ...(air && !ball.touchedGround ? { fly: true, pos: { x: b.x, y: b.y, z: b.z } } : { clean: true, pos: { x: b.x, y: b.y, z: b.z } }) } as never);
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
    }
  } else if (fromThrow) {
    if (!bip?.fielders.includes(F)) bip?.fielders.push(F);
    emit(w, { type: 'catch', fielderId: F.info.id, fly: false, pos: { x: b.x, y: b.y, z: b.z } });
  } else if (!bip) {
    emit(w, { type: 'fielded', fielderId: F.info.id, clean: true, pos: { x: b.x, y: b.y, z: b.z } });
  }
  void fairHere;
}

// ---------------------------------------------------------------------------------------------
// the man with the ball
// ---------------------------------------------------------------------------------------------

interface ThrowOption {
  kind: 'throw' | 'self' | 'tag';
  base: number;
  runner: RunnerRT;
  margin: number;
  receiver: PlayerRT | null;
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
  const opt = decideThrow(w, F);
  if (!opt) {
    // nothing to do: hold the ball and drift toward the infield
    if (!F.goal) F.plan.kind = 'hold';
    return;
  }
  if (opt.kind === 'tag') {
    setGoal(F, opt.runner.p.x, opt.runner.p.z, false, 1);
    F.plan.kind = 'tag';
    F.lookAt = null;
    return;
  }
  if (opt.kind === 'self') {
    const bp = bpos(opt.base);
    setGoal(F, bp.x, bp.z, true, 1);
    F.plan.kind = 'cover';
    F.plan.base = opt.base;
    return;
  }
  // throw
  F.goal = null;
  const wind = 0.07 + 0.06 * Math.min(1, Math.hypot(F.vx, F.vz) / 6);
  F.plan.releaseAt = w.tick + secToTicks(wind);
  F.plan.throwBase = opt.base;
  F.plan.throwTo = opt.receiver;
  const tx = opt.receiver ? opt.receiver.x : bpos(opt.base).x;
  const tz = opt.receiver ? opt.receiver.z : bpos(opt.base).z;
  F.lookAt = { x: tx, z: tz };
  F.facing = Math.atan2(tx - F.x, tz - F.z);
  setAnim(w, F, 'throw', 0.5);
  void play;
}

function decideThrow(w: World, F: PlayerRT): ThrowOption | null {
  const play = w.play!;
  const arm = armSpeed(F);
  const options: ThrowOption[] = [];
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
    let receiver: PlayerRT | null = cover && cover !== F ? cover : null;
    let tB: number;
    if (cover === F || (!receiver && selfT < 1.5)) {
      // fielder plays the base himself
      if (frc && selfT < tR - 0.05) {
        options.push({ kind: 'self', base: b, runner: r, margin: tR - selfT, receiver: null });
        continue;
      }
      if (!receiver) continue;
    }
    if (!receiver) continue;
    const D = Math.hypot(receiver.x - F.x, receiver.z - F.z);
    tB = throwTimeEstimate(D, arm) + 0.1 + (frc ? 0 : 0.16) + 0.07 + 0.06;
    const margin = tR - tB;
    options.push({ kind: 'throw', base: b, runner: r, margin, receiver });
    // rundown: runner is close to the fielder and between bases
    const dr = Math.hypot(r.p.x - F.x, r.p.z - F.z);
    if (!frc && !running.isOnBase(r) && dr < 6 && dr < D * 0.6 && r.target > r.base && r.base >= 1) {
      options.push({ kind: 'tag', base: b, runner: r, margin: 0.2, receiver: null });
    }
  }
  if (!options.length) return null;
  // long throws use the cut-off man when the runner's target is beyond a direct throw
  const viable = options.filter((o) => o.margin > 0.03);
  if (!viable.length) return null;
  viable.sort((a, c) => (c.kind === 'tag' ? 1 : 0) - (a.kind === 'tag' ? 1 : 0) || c.base - a.base || c.margin - a.margin);
  const pick = viable[0];
  if (pick.kind === 'throw' && pick.receiver) {
    const D = Math.hypot(pick.receiver.x - F.x, pick.receiver.z - F.z);
    if (D > 68 && play.cutoff && play.cutoff !== F) {
      return { ...pick, receiver: play.cutoff };
    }
  }
  return pick;
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
  const atBase = R && base > 0 && (R.plan.kind === 'cover' || R.plan.kind === 'cutoff');
  const tx = atBase ? R!.plan.tx : R ? R.x : bp!.x;
  const tz = atBase ? R!.plan.tz : R ? R.z : bp!.z;
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
    if (process.env.DBG_THROW) console.log('wild throw', { tgt: ball.throwTarget && [ball.throwTarget.x.toFixed(1), ball.throwTarget.z.toFixed(1)], from: F.fieldPos, to: R.fieldPos, d: d.toFixed(1), rpos: [R.x.toFixed(1), R.z.toFixed(1)], ball: [b.x.toFixed(1), b.y.toFixed(1), b.z.toFixed(1)], base: ball.throwBase, kind: R.plan.kind });
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
