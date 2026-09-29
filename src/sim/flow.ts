import { flightStep, stepBall } from './ball';
import { BatSwing, batBallCollision, planSwing, stanceFor } from './batting';
import { emit } from './events';
import { BALL_RADIUS, MOUND_DIST, PLATE_DEPTH } from './field';
import { clamp, DEG } from './math';
import { setGoal } from './movement';
import { callPitch, fatigueOf } from './pitchai';
import { pitchTouchesZone, strikeZoneFor, throwPitch, zoneContains } from './pitching';
import { giveBall, placeBallInHand, releaseBall, setAnim } from './util';
import type { PlayerRT, World } from './world';
import { TICK, secToTicks } from './world';
import { DEFAULT_SPOTS, DUGOUT } from './setup';
import * as rules from './rules';
import * as inplay from './inplay';
import * as manager from './manager';
import * as running from './running';

export const BATTER_X = 0.72;
export const CATCH_Z = -0.8;
const WALKUP = 2.4;
const BETWEEN = 3.6;
const WINDUP_EMPTY = 1.12;
const WINDUP_RUNNERS = 0.84;

const paced = (w: World, s: number) => secToTicks(s * w.cfg.pace);

export function startGame(w: World): void {
  emit(w, { type: 'gameStart' });
  startHalfInning(w);
}

export function startHalfInning(w: World): void {
  const bottom = w.half === 'bottom';
  w.battingTeam = bottom ? w.teams.home : w.teams.away;
  w.fieldingTeam = bottom ? w.teams.away : w.teams.home;
  w.outs = 0;
  w.count = { balls: 0, strikes: 0 };
  w.runners = [];
  w.play = null;
  w.inningRuns = 0;
  w.halfStartTick = w.tick;
  const t = w.battingTeam;
  while (t.linescore.length < w.inning) t.linescore.push(0);
  w.teams.home.linescore.length = Math.max(w.teams.home.linescore.length, w.inning - (bottom ? 0 : 1));
  // fielders take the field
  const f = w.fieldingTeam;
  w.pitcher = f.pitcher;
  w.catcher = f.defense.get('C')!;
  const dug = DUGOUT[f.side];
  for (const [pos, p] of f.defense) {
    const spot = DEFAULT_SPOTS[pos as keyof typeof DEFAULT_SPOTS];
    p.onField = true;
    p.role = pos === 'P' ? 'pitcher' : pos === 'C' ? 'catcher' : 'fielder';
    p.hasBall = false;
    p.fieldPos = pos;
    p.vx = p.vz = 0;
    p.vmax = fielderSpeed(p);
    if (w.cfg.pace === 0 || w.tick === 0) {
      p.x = spot.x;
      p.z = spot.z;
      p.goal = null;
    } else {
      p.x = dug.x + (p.info.jersey % 5) - 2;
      p.z = dug.z + (p.info.jersey % 3);
      p.goal = { x: spot.x, z: spot.z, stop: true, mul: 0.7 };
    }
    p.facing = Math.atan2(-p.x, -p.z + 0.001);
    p.lookAt = { x: 0, z: 0 };
    p.anim = 'idle';
  }
  // batting team players off the field
  for (const p of w.battingTeam.players.values()) {
    p.onField = false;
    p.role = 'batter';
    p.vx = p.vz = 0;
    p.goal = null;
    p.hasBall = false;
  }
  giveBall(w, w.pitcher);
  // extra innings: automatic runner on second
  if (w.inning > w.cfg.innings && w.cfg.extraInningsRunner) {
    const slot = w.battingTeam.lineup[(w.battingTeam.batIdx + 8) % 9];
    running.placeGhostRunner(w, slot.player);
  }
  w.phase = 'halfBreak';
  w.phaseUntil = w.tick + paced(w, w.tick === 0 ? 3 : 7.5);
  w.play = null;
  emit(w, { type: 'halfInningStart', inning: w.inning, half: w.half });
}

export function fielderSpeed(p: PlayerRT): number {
  return (6.65 + 0.031 * p.info.ratings.speed) * 0.975;
}

/** Called when the halfBreak timer elapses. */
export function startPlateAppearance(w: World): void {
  if (w.gameOver) return;
  manager.beforePlateAppearance(w);
  const bt = w.battingTeam;
  const slot = bt.lineup[bt.batIdx % 9];
  const b = slot.player;
  w.batter = b;
  b.role = 'batter';
  b.onField = true;
  b.hasBall = false;
  w.batStance = stanceFor(b.info.bats, w.pitcher.info.throws);
  w.zone = strikeZoneFor(b.info.height, 0.97);
  w.count = { balls: 0, strikes: 0 };
  w.paPitches = 0;
  w.play = null;
  b.vx = b.vz = 0;
  const side = w.batStance === 'R' ? 1 : -1;
  if (w.cfg.pace === 0) {
    b.x = side * BATTER_X;
    b.z = 0.15;
    b.goal = null;
  } else {
    b.x = side * 3.2;
    b.z = -4.0;
    b.goal = { x: side * BATTER_X, z: 0.15, stop: true, mul: 0.5 };
  }
  b.lookAt = { x: 0, z: MOUND_DIST };
  b.facing = side === 1 ? -Math.PI / 2 : Math.PI / 2;
  b.vmax = (6.65 + 0.031 * b.info.ratings.speed);
  b.anim = 'idle';
  w.pitcher.pit.bf += 1;
  resetDefense(w);
  emit(w, { type: 'batterUp', batterId: b.info.id, pitcherId: w.pitcher.info.id });
  w.phase = 'prePitch';
  w.phaseUntil = w.tick + paced(w, WALKUP);
  w.seq = { lastType: null, lastMph: 0, count: 0 };
  w.pitch = null;
  w.swing = null;
  w.swingPlan = null;
  w.swingStarted = false;
  if (w.ball.holder !== w.pitcher) giveBall(w, w.pitcher);
}

export function tickPrePitch(w: World): void {
  running.updateLeads(w);
  if (w.tick < w.phaseUntil) return;
  // ball must be with the pitcher before he can begin
  if (w.ball.holder !== w.pitcher) {
    if (w.ball.holder === w.catcher && !w.ball.lob) beginReturn(w);
    if (w.ball.lob) return;
    if (w.ball.holder !== w.pitcher) return;
  }
  if (running.considerPickoff(w)) return;
  beginWindup(w);
}

function beginReturn(w: World): void {
  const c = w.catcher;
  const p = w.pitcher;
  const dur = 0.75;
  w.ball.lob = { from: c, to: p, start: w.tick, dur: secToTicks(dur) };
  setAnim(w, c, 'throw', 0.5);
}

/** Catcher -> pitcher lob, purely kinematic. */
export function tickLob(w: World): void {
  const l = w.ball.lob!;
  const t = (w.tick - l.start) / l.dur;
  const b = w.ball.body;
  if (t >= 1) {
    giveBall(w, l.to);
    return;
  }
  const ax = l.from.x, az = l.from.z, bx = l.to.x, bz = l.to.z;
  b.x = ax + (bx - ax) * t;
  b.z = az + (bz - az) * t;
  b.y = 1.2 + 1.2 * Math.sin(Math.PI * t);
  b.vx = ((bx - ax) / l.dur) * 240;
  b.vz = ((bz - az) / l.dur) * 240;
  b.vy = 0;
}

export function beginWindup(w: World): void {
  const call = callPitch(w);
  w.pitchAim = { x: call.x, y: call.y, intent: call.intent };
  (w as unknown as { _spec: unknown })._spec = call.spec;
  const runnersOn = w.runners.some((r) => r.state === 'live');
  const dur = (runnersOn ? WINDUP_RUNNERS : WINDUP_EMPTY) + w.rng.normal(0, 0.05);
  w.phase = 'windup';
  w.phaseUntil = w.tick + secToTicks(dur);
  running.decideSteals(w, dur);
  setAnim(w, w.pitcher, 'windup', dur);
  emit(w, { type: 'windup', pitcherId: w.pitcher.info.id });
}

export function tickWindup(w: World): void {
  running.updateLeads(w);
  if (w.tick >= w.phaseUntil) releasePitch(w);
}

export function releasePitch(w: World): void {
  const P = w.pitcher;
  const spec = (w as unknown as { _spec: import('./types').PitchSpec })._spec;
  const aim = w.pitchAim!;
  const slot = { x: P.info.traits.armSide, y: P.info.traits.armHeight, ext: P.info.traits.extension };
  const fat = fatigueOf(P);
  P.fatigue = fat;
  const pitch = throwPitch(P.info, slot, spec, aim.x, aim.y, { fatigue: fat, rng: w.rng, env: w.env, careful: aim.intent === 'middle' });
  pitch.inZone = pitchTouchesZone(pitch, w.zone);
  w.pitch = pitch;
  w.pitchTick = w.tick;
  w.pitchCrossed = false;
  w.pitchInZone = pitch.inZone;
  w.swingContact = false;
  w.swing = null;
  w.swingStarted = false;
  w.catcherHandled = false;
  P.pitchCount++;
  P.pit.pitches++;
  w.paPitches++;
  releaseBall(w);
  const b = w.ball.body;
  b.x = pitch.release.x;
  b.y = pitch.release.y;
  b.z = pitch.release.z;
  b.vx = pitch.vel.x;
  b.vy = pitch.vel.y;
  b.vz = pitch.vel.z;
  b.wx = pitch.spin.x;
  b.wy = pitch.spin.y;
  b.wz = pitch.spin.z;
  b.rolling = false;
  w.ball.mode = 'pitched';
  w.ball.touchedGround = false;
  w.ball.touchedWall = false;
  w.ball.path = [];
  // batter's plan (perception & decision happen inside the model at the decision moment)
  const ctx = {
    balls: w.count.balls,
    strikes: w.count.strikes,
    outs: w.outs,
    runnersOn: w.runners.some((r) => r.state === 'live'),
    scoringPosition: w.runners.some((r) => r.state === 'live' && r.base >= 2),
    inning: w.inning,
    scoreDiff: w.battingTeam.runs - w.fieldingTeam.runs,
  };
  const fbMph = P.info.arsenal.length ? Math.max(...P.info.arsenal.map((a) => a.mph)) : 90;
  w.swingPlan = planSwing(w.batter!.info, w.batStance, pitch, w.zone, ctx, fbMph, w.rng);
  if (w.swingPlan.swing) w.swing = new BatSwing(w.swingPlan);
  w.phase = 'pitch';
  setAnim(w, P, 'pitch', 0.5);
  w.seq.lastType = spec.type;
  w.seq.lastMph = pitch.mph;
  emit(w, { type: 'pitchReleased', pitcherId: P.info.id, pitchType: pitch.type, mph: pitch.mph, rpm: pitch.rpm, release: { ...pitch.release }, targetX: aim.x, targetY: aim.y });
  running.onPitchRelease(w);
}

const BODY_HALF_W = 0.12;

export function tickPitch(w: World): void {
  const pitch = w.pitch!;
  const ball = w.ball;
  const b = ball.body;
  const elapsed0 = (w.tick - 1 - w.pitchTick) * TICK;
  const plan = w.swingPlan!;
  let n = 1;
  if (w.swing && !w.swing.done && (w.swingStarted || elapsed0 + TICK >= plan.startTime)) n = 8;
  const dt = TICK / n;
  const bodyX = (w.batStance === 'R' ? 1 : -1) * BATTER_X;
  for (let i = 0; i < n; i++) {
    const tSub = elapsed0 + (i + 1) * dt;
    const pz = b.z;
    const px = b.x;
    const py = b.y;
    if (n === 1) stepBall(b, dt, w.env, w.rng, ball.flags, false);
    else {
      // fine steps while the bat is in the zone (ground contact unlikely there)
      flightStep(b, dt, w.env);
    }
    if (ball.flags.bounced && n === 1) ball.touchedGround = true;
    // swing start + bat advance
    if (w.swing && !w.swing.done) {
      if (!w.swingStarted && tSub >= plan.startTime) {
        w.swingStarted = true;
        setAnim(w, w.batter!, 'swing', plan.tauC * 2.1);
        emit(w, { type: 'swing', batterId: w.batter!.info.id });
      }
      if (w.swingStarted) {
        w.swing.advance(dt);
        if (!w.swingContact) {
          const res = batBallCollision(b, w.swing.pose());
          if (res) {
            w.swingContact = true;
            onContact(w, res);
            return;
          }
        }
      }
    }
    // plate crossing
    if (!w.pitchCrossed && pz > PLATE_DEPTH && b.z <= PLATE_DEPTH) {
      w.pitchCrossed = true;
      emit(w, { type: 'pitchCrossed', x: pitch.plateX, y: pitch.plateY, inZone: pitch.inZone, mph: Math.hypot(b.vx, b.vy, b.vz) / 0.44704 });
    }
    // hit by pitch
    if (!w.catcherHandled && b.z < 0.4 && b.z > -0.3 && Math.abs(b.x - bodyX) < BODY_HALF_W + BALL_RADIUS && b.y > 0.1 && b.y < 1.95) {
      const swungThrough = w.swingStarted;
      if (!swungThrough && !pitch.inZone) {
        hitBatter(w);
        return;
      }
    }
    // catcher's mitt plane
    if (!w.catcherHandled && pz > CATCH_Z && b.z <= CATCH_Z) {
      const f = (pz - CATCH_Z) / (pz - b.z);
      b.x = px + (b.x - px) * f;
      b.y = py + (b.y - py) * f;
      b.z = CATCH_Z;
      catcherReceive(w);
      return;
    }
  }
  if (b.rolling && Math.hypot(b.vx, b.vz) < 0.5) {
    // pitch died short of the catcher (dirt ball)
    w.catcherHandled = true;
    finishMissedPitch(w, 'blocked');
    return;
  }
  if ((w.tick - w.pitchTick) * TICK > 4) {
    giveBall(w, w.catcher);
    finishPitchResult(w, true);
  }
}

function hitBatter(w: World): void {
  w.catcherHandled = true;
  const b = w.ball.body;
  // ball drops near the plate
  b.vx *= 0.1;
  b.vy = 0;
  b.vz *= 0.1;
  w.ball.mode = 'loose';
  emit(w, { type: 'call', call: mkCall(w, 'hitByPitch') });
  rules.hitByPitch(w);
}

function mkCall(w: World, kind: import('./types').CallKind) {
  const c = {
    kind,
    time: w.tick * TICK,
    balls: w.count.balls,
    strikes: w.count.strikes,
    plateX: w.pitch?.plateX,
    plateY: w.pitch?.plateY,
    inZone: w.pitch?.inZone,
  };
  w.lastCall = c;
  return c;
}

function onContact(w: World, res: import('./batting').ContactResult): void {
  const b = w.ball.body;
  emit(w, {
    type: 'contact',
    batterId: w.batter!.info.id,
    exitMph: res.exitSpeed / 0.44704,
    launchDeg: res.launchDeg,
    sprayDeg: res.sprayDeg,
    spinRpm: res.spinRpm,
    pos: { x: b.x, y: b.y, z: b.z },
  });
  w.ball.mode = 'batted';
  inplay.beginBattedBall(w, res);
}

/** Catcher tries to receive the pitch (or block a ball in the dirt). */
function catcherReceive(w: World): void {
  w.catcherHandled = true;
  const C = w.catcher;
  const cr = C.info.ratings.catching;
  const pitch = w.pitch!;
  const b = w.ball.body;
  const aim = w.pitchAim!;
  const flight = (w.tick - w.pitchTick) * TICK;
  const lateBreak = pitch.type === 'CU' || pitch.type === 'SL' || pitch.type === 'SW' || pitch.type === 'FS' ? 1.35 : 1.0;
  const setY = clamp(aim.y, 0.3, 1.5);
  const timeAvail = Math.max(0.05, flight - 0.14);
  void timeAvail;
  const react = 0.19 + 0.12 * (1 - cr / 100);
  const avail = Math.max(0, pitch.tPlate + 0.05 - react);
  const hand = 5.2 + 0.035 * cr;
  const maxMove = hand * avail * 0.6 + 0.12;
  const perceive = 0.03 * (1.6 - cr / 100) * lateBreak;
  const errX = w.rng.normal(0, perceive);
  const errY = w.rng.normal(0, perceive);
  let dx = b.x - aim.x + errX;
  let dy = b.y - setY + errY;
  const dl = Math.hypot(dx, dy);
  if (dl > maxMove) {
    dx *= maxMove / dl;
    dy *= maxMove / dl;
  }
  const mx = aim.x + dx;
  const my = setY + dy;
  const miss = Math.hypot(b.x - mx, b.y - my);
  const inDirt = w.ball.touchedGround || b.y < 0.16;
  if (!inDirt && b.y < 2.2 && miss <= 0.12 + BALL_RADIUS) {
    // clean catch
    giveBall(w, C);
    setAnim(w, C, 'catch', 0.4);
    emit(w, { type: 'catch', fielderId: C.info.id, fly: false, pos: { x: b.x, y: b.y, z: b.z } });
    finishPitchResult(w, true);
    return;
  }
  // block attempt for balls in the dirt / off target
  const blockHalf = 0.3 + 0.0045 * cr;
  const shift = clamp((b.x - aim.x) * 0.75, -0.5, 0.5);
  const blocked = b.y < 0.85 && Math.abs(b.x - (aim.x + shift)) <= blockHalf;
  if (blocked) {
    finishMissedPitch(w, 'blocked');
    return;
  }
  finishMissedPitch(w, 'missed');
}

function finishMissedPitch(w: World, how: 'blocked' | 'missed'): void {
  const b = w.ball.body;
  const C = w.catcher;
  w.catcherHandled = true;
  const pitch = w.pitch!;
  if (how === 'blocked') {
    // ball smothers in front of the catcher and squirts away a bit
    const ang = w.rng.range(-0.9, 0.9);
    const sp = w.rng.range(0.8, 2.4);
    b.vx = Math.sin(ang) * sp + 0.3 * b.vx * 0.05;
    b.vz = Math.abs(Math.cos(ang)) * sp * -0.4;
    b.vy = 0.3;
    b.rolling = false;
    setAnim(w, C, 'field', 0.6);
  } else {
    // ball gets by; loses a little speed off the glove
    b.vx *= 0.75;
    b.vy *= 0.5;
    b.vz *= 0.75;
  }
  w.ball.mode = 'loose';
  w.ball.pathDirty = true;
  const nearMiss = Math.hypot(b.x - w.pitchAim!.x, b.y - w.pitchAim!.y) < 0.5;
  finishPitchResult(w, false, how, nearMiss, pitch.inZone);
}

/** The pitch has reached the catcher. Decide the umpire call / swing result and update the count. */
function finishPitchResult(w: World, caught: boolean, how: 'blocked' | 'missed' | 'caught' = 'caught', nearMiss = false, _inZone = false): void {
  void _inZone;
  const pitch = w.pitch!;
  const swung = w.swingStarted && !w.swingContact;
  const C = w.catcher;
  if (!caught) {
    if (how === 'missed') {
      if (nearMiss) {
        emit(w, { type: 'passedBall', catcherId: C.info.id });
        w.passedBallFlag = true;
      } else {
        emit(w, { type: 'wildPitch', pitcherId: w.pitcher.info.id });
        w.wildPitchFlag = true;
      }
    }
  }
  let ballOrStrike: 'ball' | 'strikeLooking' | 'strikeSwinging';
  if (swung) ballOrStrike = 'strikeSwinging';
  else ballOrStrike = umpireCall(w, pitch.plateX, pitch.plateY) ? 'strikeLooking' : 'ball';
  const keep = w.lastCall;
  void keep;
  emit(w, { type: 'call', call: mkCall(w, ballOrStrike) });
  // pitcher strike count
  if (ballOrStrike !== 'ball') w.pitcher.pit.strikes++;
  const ballLive = !caught;
  const droppedThird = !caught && w.count.strikes === 2 && ballOrStrike !== 'ball' && (w.runners.every((r) => r.state !== 'live' || r.base !== 1) || w.outs === 2);
  rules.applyPitchOutcome(w, ballOrStrike, { ballLive, droppedThird });
}

export function umpireCall(w: World, px: number, py: number): boolean {
  const z = w.zone;
  const bias = w.umpBias;
  const C = w.catcher;
  const frame = clamp((C.info.ratings.catching - 50) * 0.00022, -0.008, 0.012);
  let x = px + w.rng.normal(0, bias.noise);
  let y = py + w.rng.normal(0, bias.noise);
  // framing pulls borderline pitches toward the middle of the zone
  const cx = 0;
  const cy = (z.top + z.bottom) / 2;
  x -= Math.sign(x - cx) * Math.min(Math.abs(x - cx), frame);
  y -= Math.sign(y - cy) * Math.min(Math.abs(y - cy), frame);
  const zeff = { left: z.left - bias.width, right: z.right + bias.width, bottom: z.bottom + bias.low, top: z.top + bias.high };
  return zoneContains(zeff, x, y, 0.042);
}

/** Batter's pitch-by-pitch state reset helpers for the next pitch. */
/** Send every fielder back to his spot (shading with the situation). */
export function resetDefense(w: World): void {
  const t = w.fieldingTeam;
  const runnerThird = w.runners.some((r) => r.state === 'live' && r.base === 3);
  const runnerFirst = w.runners.some((r) => r.state === 'live' && r.base === 1);
  const infieldIn = runnerThird && w.outs < 2 && w.inning >= 7 && Math.abs(w.battingTeam.runs - t.runs) <= 1;
  const dpDepth = runnerFirst && w.outs < 2;
  const power = w.batter ? w.batter.info.ratings.power : 50;
  const ofDepth = power > 65 ? 5 : power < 40 ? -4 : 0;
  for (const [pos, F] of t.defense) {
    if (!F.onField) continue;
    const s = DEFAULT_SPOTS[pos as keyof typeof DEFAULT_SPOTS];
    let x = s.x;
    let z = s.z;
    if (pos === '1B' || pos === '2B' || pos === 'SS' || pos === '3B') {
      if (infieldIn) z -= 6.5;
      else if (dpDepth && (pos === '2B' || pos === 'SS')) {
        z -= 2.0;
        x *= 0.85;
      }
    }
    if (pos === 'LF' || pos === 'CF' || pos === 'RF') z += ofDepth;
    F.plan.kind = 'idle';
    F.plan.releaseAt = 0;
    F.lookAt = { x: 0, z: 0 };
    if (w.cfg.pace === 0) {
      F.x = x;
      F.z = z;
      F.vx = F.vz = 0;
      F.goal = null;
    } else {
      F.goal = { x, z, stop: true, mul: 0.75 };
    }
  }
}

export function readyNextPitch(w: World, seconds = BETWEEN): void {
  resetDefense(w);
  w.phase = 'prePitch';
  w.phaseUntil = w.tick + paced(w, seconds);
  w.swing = null;
  w.swingPlan = null;
  w.swingStarted = false;
  w.pitch = null;
  w.pitchAim = null;
  w.play = null;
  w.stealing.clear();
}

export function ballFollowsHolder(w: World): void {
  const h = w.ball.holder;
  if (h) placeBallInHand(w, h);
}

export { DEG };
export function pickoffPhase(w: World): void {
  void w;
}
export { setGoal };

export function resetBatterToBox(w: World): void {
  const b = w.batter!;
  const side = w.batStance === 'R' ? 1 : -1;
  b.role = 'batter';
  b.onField = true;
  b.vx = b.vz = 0;
  b.goal = null;
  b.x = side * BATTER_X;
  b.z = 0.15;
  b.lookAt = { x: 0, z: MOUND_DIST };
  b.facing = side === 1 ? -Math.PI / 2 : Math.PI / 2;
  b.anim = 'idle';
  b.animUntil = 0;
}
