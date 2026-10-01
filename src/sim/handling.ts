/**
 * Ball handling and getting set between plays: the casual return of the ball after a dead ball or a pitch (glove-to-hand transfer,
 * a look at the situation, an easy toss — sometimes around the horn), fielders / replaced players leaving for the dugout, and the
 * check that everybody is in place before the next pitch (bounded, so the game never stalls).
 */
import { SHOULDER_X } from './batting';
import { emit } from './events';
import { CATCH_LEAD, catchClipOn } from './fielding';
import { MOUND_DIST, groundHeight } from './field';
import { clamp } from './math';
import { setGoal } from './movement';
import * as running from './running';
import { DUGOUT } from './setup';
import { giveBall, releaseBall, setAnim } from './util';
import type { Ratings } from './types';
import type { PlayerRT, World } from './world';
import { TICK, secToTicks } from './world';

/** Longest the pitch waits for stragglers (s of sim time at `pace: 1`, scaled by `pace`). */
export const READY_TIMEOUT = 25;

/** Glove-to-hand transfer after an out (s): slower for a force out (no rush), quicker with a good release and a sharp head. */
export function transferRoutine(r: Ratings, forceOut: boolean, jitter = 0): number {
  return clamp(0.62 + (forceOut ? 0.15 : 0) - 0.0055 * (r.release - 50) - 0.0035 * (r.iq - 50) + jitter, 0.4, 1.0);
}
/** A catcher's transfer of a caught pitch (s): quicker, his exchange. */
export const transferCatcher = (r: Ratings, jitter = 0) => clamp(0.34 - 0.003 * (r.pop - 50) + jitter, 0.2, 0.5);
/** Speed (m/s) of a casual return: 25–40 by distance. */
export const casualSpeed = (dist: number) => clamp(24 + 0.3 * dist, 25, 40);

const homeOf = (w: World, p: PlayerRT) => p.home ?? { x: p.x, z: p.z };

/**
 * The ball is dead (or a pitch was caught) and a fielder other than the pitcher has it: he transfers it, looks, and returns it. Headless
 * runs (`pace: 0`) skip the handling and put the ball straight back in the pitcher's hand.
 */
export function ensureBallReturn(w: World, afterPitch: boolean): void {
  if (w.gameOver) return;
  const P = w.pitcher;
  const h = w.ball.holder;
  if (w.cfg.pace === 0) {
    if (h !== P && !(w.ball.lob && w.ball.lob.to === P)) giveBall(w, P);
    w.hornKind = null;
    return;
  }
  if (w.ret) return;
  if (w.ball.lob) return;
  if (!h) {
    // a ball nobody has (over the fence, foul, dead in the dirt): a fresh one comes from the ball boy
    giveBall(w, P);
    w.hornKind = null;
    return;
  }
  if (h === P) {
    w.hornKind = null;
    return;
  }
  if (h.team !== w.fieldingTeam) return;
  const runnersOn = w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead);
  // after an out with nobody on the infield may toss it around before it gets back to the pitcher
  const chain: PlayerRT[] = [];
  const horn = !afterPitch && !runnersOn && w.outs < 3 && ((w.hornKind === 'k' && w.aiRng.next() < 0.5) || (w.hornKind === 'out' && w.aiRng.next() < 0.12));
  if (horn) {
    for (const pos of ['3B', 'SS', '2B', '1B'] as const) {
      const F = w.fieldingTeam.defense.get(pos);
      if (F && F.onField && F !== h) chain.push(F);
    }
    if (w.hornKind !== 'k') chain.splice(1);
  }
  w.hornKind = null;
  chain.push(P);
  const to = chain.shift()!;
  startLeg(w, h, to, chain, afterPitch, true);
}

function startLeg(w: World, from: PlayerRT, to: PlayerRT, chain: PlayerRT[], afterPitch: boolean, first: boolean): void {
  const jitter = w.aiRng.normal(0, 0.05);
  const r = from.info.ratings;
  let T: number;
  if (afterPitch && from === w.catcher) T = transferCatcher(r, jitter);
  else if (first) T = transferRoutine(r, w.play?.outsThisPlay.some((o) => o.force) ?? false, jitter);
  else T = clamp(0.4 - 0.003 * (r.release - 50) + jitter, 0.3, 0.6);
  const runnersOn = w.runners.some((q) => q.state === 'live' && q.base >= 1 && !q.dead);
  const look = afterPitch ? 0.15 : first ? 0.2 + (runnersOn ? 0.35 : 0) : 0.1;
  w.ret = { stage: 'transfer', from, to, until: w.tick + secToTicks(T), look, chain, afterPitch };
  from.goal = null;
  from.lookAt = null;
  setAnim(w, from, 'transfer', T);
}

/** Per-tick: run the transfer / look stages of a return (the flight itself is `tickLob`). */
export function tickBallReturn(w: World): void {
  const ret = w.ret;
  if (!ret) return;
  const ball = w.ball;
  if (ret.stage === 'flight') {
    if (ball.lob) tickLob(w);
    else w.ret = null;
    return;
  }
  if (ball.holder !== ret.from) {
    // somebody else took the ball (a new play): abandon the return
    w.ret = null;
    return;
  }
  readyReceiver(w, ret);
  const b = ball.body;
  const from = ret.from;
  const hx = from.x + Math.sin(from.facing) * 0.32;
  const hz = from.z + Math.cos(from.facing) * 0.32;
  b.x = hx;
  b.z = hz;
  b.y = groundHeight(from.x, from.z) + 1.15;
  b.vx = b.vy = b.vz = 0;
  if (w.tick < ret.until) return;
  if (ret.stage === 'transfer') {
    ret.stage = 'look';
    ret.until = w.tick + secToTicks(ret.look);
    from.lookAt = { x: ret.to.x, z: ret.to.z };
    return;
  }
  // release: an easy toss
  const to = ret.to;
  const D = Math.hypot(to.x - from.x, to.z - from.z);
  const v = casualSpeed(D) * (from === w.catcher ? 1.04 : 1);
  const dur = secToTicks(D / v + 0.06);
  from.facing = Math.atan2(to.x - from.x, to.z - from.z);
  releaseBall(w);
  ball.mode = 'thrown';
  ball.lob = { from, to, start: w.tick, dur, arc: clamp(0.06 * D, 0.5, 3) };
  ball.throwTo = null;
  ball.throwBase = null;
  ret.stage = 'flight';
  setAnim(w, from, D < 14 ? 'toss' : 'throw', 0.5);
  emit(w, { type: 'ballReturn', fromId: from.info.id, toId: to.info.id, mph: v / 0.44704, casual: true });
  // the passer goes back to his spot; the receiver comes to meet it
  sendHome(w, from, false);
  sendHome(w, to, false);
}

/** Where a casual toss ends: in the receiver's glove, a little toward the passer and to his glove side, at chest height. */
function lobGlove(from: PlayerRT, to: PlayerRT): { x: number; y: number; z: number } {
  const dx = from.x - to.x;
  const dz = from.z - to.z;
  const d = Math.hypot(dx, dz) || 1;
  const ux = dx / d;
  const uz = dz / d;
  // his glove hand is opposite his throwing hand: with the passer in front of him (direction u), his right is (uz, -ux)
  const gs = to.info.throws === 'R' ? -1 : 1;
  return { x: to.x + ux * 0.4 + uz * gs * 0.22, y: groundHeight(to.x, to.z) + 1.15, z: to.z + uz * 0.4 - ux * gs * 0.22 };
}

/** The receiver gets his glove out this long before the throw leaves (s). */
export const READY_LEAD = 0.35;

/**
 * Before a return throw leaves the thrower's hand the receiver (the pitcher, or the next man around the horn) turns to face him, holds his glove out at the
 * point where the ball will come to it (`catch_ready`, loops) and publishes it as `gloveTarget` with `catchIn` = seconds until the catch, counting through
 * the throw's flight; `tickLob` then switches to the catch clip at its lead.
 */
function readyReceiver(w: World, ret: NonNullable<World['ret']>): void {
  const from = ret.from;
  const to = ret.to;
  const preSec = Math.max(0, (ret.until - w.tick) * TICK) + (ret.stage === 'transfer' ? ret.look : 0);
  if (preSec > READY_LEAD) return;
  const D = Math.hypot(to.x - from.x, to.z - from.z);
  const flight = D / (casualSpeed(D) * (from === w.catcher ? 1.04 : 1)) + 0.06;
  const g = lobGlove(from, to);
  to.gloveTarget = g;
  to.gloveAt = w.tick + secToTicks(preSec + flight);
  to.lookAt = { x: from.x, z: from.z };
  if (to.anim !== 'catch_ready' || w.tick >= to.animUntil) setAnim(w, to, 'catch_ready', preSec + flight + 0.15);
}

/** Casual return of the ball: purely kinematic arc from his hand to the receiver's glove, at the chosen speed. The receiver's catch is shown like any other. */
export function tickLob(w: World): void {
  const l = w.ball.lob!;
  const t = (w.tick - l.start) / l.dur;
  const b = w.ball.body;
  const to = l.to;
  const g = lobGlove(l.from, to);
  const remaining = Math.max(0, (l.start + l.dur - w.tick) * TICK);
  // the glove target, and the catch clip started its catch-frame time before the arrival
  to.gloveTarget = g;
  to.gloveAt = l.start + l.dur;
  const hint = to === w.pitcher || to.fieldPos === 'P' ? 'pitcher_catch_toss' : 'catch_throw';
  if (!catchClipOn(w, to) && (remaining <= CATCH_LEAD[hint] || l.dur * TICK <= CATCH_LEAD[hint])) {
    to.catchArmed = true;
    setAnim(w, to, hint, CATCH_LEAD[hint] * 2);
  }
  if (t >= 1) {
    b.x = g.x;
    b.y = g.y;
    b.z = g.z;
    emit(w, { type: 'catch', fielderId: to.info.id, fly: false, pos: { x: g.x, y: g.y, z: g.z }, kind: 'throw', height: 'chest', side: 'glove', firm: true });
    to.gloveTarget = null;
    to.catchArmed = false;
    giveBall(w, to);
    to.gloveHold = { x: g.x, y: g.y, z: g.z, t0: w.tick };
    onBallArrived(w, to);
    return;
  }
  const ax = l.from.x, az = l.from.z;
  const y0 = groundHeight(ax, az) + 1.15;
  b.x = ax + (g.x - ax) * t;
  b.z = az + (g.z - az) * t;
  b.y = y0 + (g.y - y0) * t + (l.arc ?? 1.2) * Math.sin(Math.PI * t);
  b.vx = ((g.x - ax) / l.dur) * 240;
  b.vz = ((g.z - az) / l.dur) * 240;
  b.vy = 0;
}

function onBallArrived(w: World, to: PlayerRT): void {
  const ret = w.ret;
  if (!ret) return;
  if (ret.chain.length) {
    const next = ret.chain.shift()!;
    startLeg(w, to, next, ret.chain, false, false);
    return;
  }
  w.ret = null;
}

// ---------------------------------------------------------------------------------------------
// getting back to place
// ---------------------------------------------------------------------------------------------

/** Send a fielder to his spot: a walk when it is close, a jog further out, a run when he is far or the game is waiting on him. */
export function sendHome(w: World, p: PlayerRT, respectBall = true): void {
  const h = p.home;
  if (!h) return;
  if (respectBall && w.ret && w.ret.from === p && w.ret.stage !== 'flight') return;
  const d = Math.hypot(p.x - h.x, p.z - h.z);
  const late = w.phase === 'prePitch' && w.tick >= w.phaseUntil;
  const mul = late ? 1 : d < 3 ? 0.4 : d < 10 ? 0.55 : d < 25 ? 0.7 : 0.85;
  setGoal(p, h.x, h.z, true, mul);
}

/** Players who are done for now (a replaced pitcher, the fielders at the end of an inning) jog to their dugout. */
export function sendToDugout(w: World, p: PlayerRT): void {
  if (w.cfg.pace === 0 || w.tick === 0) {
    p.onField = false;
    return;
  }
  if (!w.leavers.some((l) => l.p === p)) w.leavers.push({ p, since: w.tick });
  p.goal = null;
}

export function tickLeavers(w: World): void {
  if (!w.leavers.length) return;
  w.leavers = w.leavers.filter((l) => {
    const p = l.p;
    const d = DUGOUT[p.team.side];
    setGoal(p, d.x, d.z, true, 0.75);
    p.gait = 'trot';
    if (Math.hypot(p.x - d.x, p.z - d.z) < 1.8 || w.tick - l.since > 15 * 240) {
      p.onField = false;
      p.gait = null;
      p.goal = null;
      return false;
    }
    return true;
  });
}

const TOL: Record<string, number> = { P: 0.6, C: 1.0 };

/** Is everybody where the next pitch needs them? (`why` names the first one who is not.) */
export function readyToPitch(w: World): { ready: boolean; why: string } {
  if (w.ret) return { ready: false, why: 'ball return' };
  if (w.ball.holder !== w.pitcher) return { ready: false, why: 'pitcher without the ball' };
  for (const F of w.fieldingTeam.defense.values()) {
    if (!F.onField || !F.home) continue;
    const d = Math.hypot(F.x - F.home.x, F.z - F.home.z);
    if (d > (TOL[F.fieldPos ?? ''] ?? 1.5) || Math.hypot(F.vx, F.vz) > 1.5) return { ready: false, why: `${F.fieldPos} out of place` };
  }
  const b = w.batter;
  if (b) {
    const side = w.batStance === 'R' ? 1 : -1;
    if (Math.hypot(b.x - side * SHOULDER_X, b.z - 0.15) > 0.6 || Math.hypot(b.vx, b.vz) > 0.4) return { ready: false, why: 'batter not in the box' };
  }
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead || r.base < 1) continue;
    const p = r.p;
    const atLead = Math.hypot(p.x - r.leadX, p.z - r.leadZ) < 0.9 && r.leadKey !== '';
    if (!(running.isOnBase(r) || atLead) || Math.hypot(p.vx, p.vz) > 1.2) return { ready: false, why: 'runner not set' };
  }
  return { ready: true, why: '' };
}

/** The game is waiting on somebody: those who are not in place hurry. */
export function hurryStragglers(w: World): void {
  for (const F of w.fieldingTeam.defense.values()) {
    if (F.onField && F.goal && F.home && Math.hypot(F.x - F.home.x, F.z - F.home.z) > 1.5) F.goal.mul = 1;
  }
  if (w.batter?.goal) w.batter.goal.mul = 1;
}

export { MOUND_DIST, TICK };
