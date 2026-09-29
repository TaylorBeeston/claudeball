import { flightStep, stepBall } from './ball';
import { blockHalfWidth, consistencyScale, framingPull, nextForm, pressureOf, deliverySeconds, fielderTopSpeed, routeEfficiency, sprintOf } from './attributes';
import { BatSwing, batBallCollision, buildSwing, decisionTime, perceivePitch, stanceFor } from './batting';
import { ask, situationOf } from './dispatch';
import { PENDING } from './decisions';
import type { AlignmentDecision } from './decisions';
import { emit } from './events';
import { BALL_RADIUS, MOUND_DIST, PLATE_DEPTH } from './field';
import { clamp, DEG } from './math';
import { setGoal } from './movement';
import { fatigueOf } from './pitchai';
import { pathAt, pitchTouchesZone, strikeZoneFor, throwPitch, timeAtZ, zoneContains } from './pitching';
import { giveBall, placeBallInHand, releaseBall, setAnim } from './util';
import type { PlayerRT, World } from './world';
import { TICK, secToTicks } from './world';
import { DEFAULT_SPOTS, DUGOUT } from './setup';
import * as rules from './rules';
import * as inplay from './inplay';
import * as manager from './manager';
import * as running from './running';
import { scheduleCall } from './umpires';
import { ensureBallReturn, hurryStragglers, readyToPitch, READY_TIMEOUT, sendHome, sendToDugout } from './handling';
export { tickLob } from './handling';

export const BATTER_X = 0.72;
export const CATCH_Z = -0.8;
const WALKUP = 2.4;
const BETWEEN = 3.6;
const DEFAULT_DELIVERY = { style: 'three_quarter' as const, armSlotDeg: 45, tempo: 1 };

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
  w.fieldingTeam.pitcher.rattle *= 0.4; // a new half-inning: he shakes off trouble
  for (const r of w.exiting) r.p.onField = false;
  w.exiting = [];
  for (const l of w.leavers) l.p.onField = false;
  w.leavers = [];
  w.ret = null;
  w.hornKind = null;
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
      p.goal = { x: spot.x, z: spot.z, stop: true, mul: 0.85 }; // they run out to their positions
    }
    p.home = { x: spot.x, z: spot.z };
    p.facing = Math.atan2(-p.x, -p.z + 0.001);
    p.lookAt = { x: 0, z: 0 };
    p.anim = 'idle';
  }
  // batting team players off the field
  for (const p of w.battingTeam.players.values()) {
    const wasFielding = p.onField && w.cfg.pace !== 0 && w.tick > 0;
    p.role = wasFielding && (p.role === 'pitcher' || p.role === 'catcher') ? p.role : 'batter';
    p.hasBall = false;
    p.home = null;
    if (wasFielding) {
      // the side that just took the field jogs in to its dugout
      p.goal = null;
      w.leavers.push({ p, since: w.tick });
    } else {
      p.onField = false;
      p.vx = p.vz = 0;
      p.goal = null;
    }
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
  return fielderTopSpeed(p.info.ratings) * (routeEfficiency(p.info.ratings) / 0.955) * 0.975;
}

/**
 * Called when the halfBreak / playOver timer elapses (and every tick after, until it completes): the manager's decisions
 * (pitching change, pinch runner, pinch hitter), the batter stepping in, then the intentional-walk and bunt decisions.
 * Each stage asks its decision once and is applied on a later tick, so a deferred (human) answer just pauses the sim here.
 */
export function startPlateAppearance(w: World): void {
  if (w.gameOver) return;
  if (w.paStage === 0) {
    if (!manager.stagePitchingChange(w)) return;
    w.paStage = 1;
  }
  if (w.paStage === 1) {
    if (!manager.stagePinchRun(w)) return;
    w.paStage = 2;
  }
  if (w.paStage === 2) {
    if (!manager.stagePinchHit(w)) return;
    w.paStage = 3;
  }
  if (w.paStage === 3) {
    stepInBatter(w);
    w.paStage = 4;
  }
  if (w.paStage === 4) {
    const walk = manager.stageIntentionalWalk(w);
    if (walk === 'wait') return;
    if (walk === 'walk') {
      w.count = { balls: 4, strikes: 0 };
      w.paStage = 0;
      w.paDone = false;
      rules.intentionalWalk(w);
      return;
    }
    w.paStage = 5;
  }
  if (w.paStage === 5) {
    if (!manager.stageBunt(w)) return;
  }
  w.paStage = 0;
  w.paDone = false;
  w.phase = 'prePitch';
  w.phaseUntil = w.tick + paced(w, WALKUP);
  w.seq = { lastType: null, lastMph: 0, count: 0 };
  w.pitch = null;
  w.swing = null;
  w.swingPlan = null;
  w.swingStarted = false;
  w.prep = freshPrep();
  if (w.ball.holder !== w.pitcher) giveBall(w, w.pitcher);
}

function stepInBatter(w: World): void {
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
  w.swing = null;
  w.swingPlan = null;
  w.swingStarted = false;
  const side = w.batStance === 'R' ? 1 : -1;
  const walkingIn = w.leavers.some((l) => l.p === b); // he was still jogging in from the field: he goes on to the box from there
  w.leavers = w.leavers.filter((l) => l.p !== b);
  if (w.cfg.pace === 0) {
    b.vx = b.vz = 0;
    b.x = side * BATTER_X;
    b.z = 0.15;
    b.goal = null;
  } else if (walkingIn) {
    b.goal = { x: side * BATTER_X, z: 0.15, stop: true, mul: 0.7 };
  } else {
    b.vx = b.vz = 0;
    b.x = side * 3.2;
    b.z = -4.0;
    b.goal = { x: side * BATTER_X, z: 0.15, stop: true, mul: 0.5 };
  }
  b.lookAt = { x: 0, z: MOUND_DIST };
  b.facing = side === 1 ? -Math.PI / 2 : Math.PI / 2;
  b.vmax = sprintOf(b.info.ratings.speed);
  b.anim = 'idle';
  w.pitcher.pit.bf += 1;
  w.pitcher.rattle *= 0.93; // he settles a little between batters
  b.form = nextForm(b.form, b.info.ratings.consistency, w.rng.normal(0, 1));
  w.align = {};
  resetDefense(w);
  emit(w, { type: 'batterUp', batterId: b.info.id, pitcherId: w.pitcher.info.id });
}

export function tickPrePitch(w: World): void {
  running.updateLeads(w);
  // defensive alignment for this pitch (asked as soon as the pitch is set up, so the fielders move during the walk-up)
  if (!w.prep.alignmentDone) {
    if (!stageAlignment(w)) return;
    w.prep.alignmentDone = true;
  }
  if (w.tick < w.phaseUntil) return;
  // ball must be with the pitcher before he can begin (the catcher's / fielder's return is under way)
  if (w.ball.holder !== w.pitcher || w.ret) {
    if (!w.ret && !w.ball.lob) ensureBallReturn(w, true);
    if (w.ret || w.ball.lob || w.ball.holder !== w.pitcher) return;
  }
  // everybody set: fielders at their spots, the pitcher on the rubber with the ball, the catcher behind the plate, the batter in the box,
  // runners on their bases or at their leads; a slow case (a long trot in from the wall, a reliever from the bullpen) is waited for, up to a limit
  if (w.cfg.pace > 0) {
    if (w.prep.readyBy === 0) w.prep.readyBy = w.tick + secToTicks(READY_TIMEOUT * Math.min(1, w.cfg.pace));
    if (!readyToPitch(w).ready && w.tick < w.prep.readyBy) {
      hurryStragglers(w);
      return;
    }
  }
  if (!w.prep.pickoffDone) {
    const r = running.stagePickoff(w);
    if (r === 'wait' || r === 'thrown') return;
    w.prep.pickoffDone = true;
  }
  if (!w.prep.pitch) {
    if (!stagePitch(w)) return;
  }
  if (!w.prep.stealsDone) {
    if (!running.stageSteals(w)) return;
    w.prep.stealsDone = true;
  }
  beginWindup(w);
}

function stageAlignment(w: World): boolean {
  const b = w.batter;
  if (!b) return true;
  const d = ask(
    w,
    'align',
    'alignment',
    w.fieldingTeam.side,
    () => ({
      situation: situationOf(w),
      batter: b.info,
      stance: w.batStance,
      defense: [...w.fieldingTeam.defense].map(([position, p]) => ({ position, playerId: p.info.id })),
    }),
  );
  if (d === PENDING) return false;
  w.align = d;
  resetDefense(w);
  return true;
}

function stagePitch(w: World): boolean {
  const P = w.pitcher;
  const B = w.batter!;
  const z = w.zone;
  const d = ask(w, 'pitch', 'pitch', w.fieldingTeam.side, () => ({
    situation: situationOf(w),
    pitcher: P.info,
    batter: B.info,
    batterStance: w.batStance,
    arsenal: P.info.arsenal,
    lastPitchType: w.seq.lastType as never,
    pitchCount: P.pitchCount,
    fatigue: fatigueOf(P),
    zone: { left: z.left, right: z.right, bottom: z.bottom, top: z.top },
  }));
  if (d === PENDING) return false;
  w.prep.pitch = d;
  return true;
}

export function beginWindup(w: World): void {
  const P = w.pitcher;
  // the pitcher's timing from the set position varies from pitch to pitch (wilder pitchers vary more): this one draw is both the
  // length of his windup (it moves runners' jumps and the batter's timing) and, if he hesitates or rushes far enough, an illegal
  // motion that the umpire calls
  const hitch = w.rng.normal(0, 0.05 * (1 + (50 - P.info.ratings.control) / 250) * consistencyScale(P.info.ratings.consistency));
  if (Math.abs(hitch) > HITCH_BALK && w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead)) {
    rules.balk(w);
    return;
  }
  const d = w.prep.pitch!;
  const spec = P.info.arsenal.find((a) => a.type === d.pitchType) ?? P.info.arsenal[0];
  const zn = w.zone;
  const inner = { x: (zn.right - zn.left) * 0.3, y: (zn.top - zn.bottom) * 0.3 };
  const cy = (zn.top + zn.bottom) / 2;
  const careful = d.careful ?? (Math.abs(d.targetX) < inner.x && Math.abs(d.targetY - cy) < inner.y);
  w.pitchAim = { x: d.targetX, y: d.targetY, intent: careful ? 'middle' : 'edge' };
  (w as unknown as { _spec: unknown })._spec = spec;
  const runnersOn = w.runners.some((r) => r.state === 'live');
  // the delivery: windup with the bases empty, the shorter stretch with anyone on; tempo and the pitcher's holding decide how quick
  const dur = deliverySeconds(P.info.delivery ?? DEFAULT_DELIVERY, P.info.ratings, runnersOn) + hitch;
  w.phase = 'windup';
  w.phaseUntil = w.tick + secToTicks(dur);
  running.commitSteals(w);
  setAnim(w, w.pitcher, 'windup', dur);
  emit(w, { type: 'windup', pitcherId: w.pitcher.info.id });
}

/** A hitch in the set position longer than this (s) is an illegal motion. */
const HITCH_BALK = 0.19;

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
  const pitch = throwPitch(P.info, slot, spec, aim.x, aim.y, {
    fatigue: fat,
    rng: w.rng,
    env: w.env,
    careful: aim.intent === 'middle',
    stretch: w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead),
    pressure: leverage(w),
    rattled: P.rattle,
  });
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
  // the batter's decision (swing / take) is asked while the pitch is in flight, once he has seen enough of it
  w.swingPlan = null;
  w.swing = null;
  w.swingObs = null;
  w.swingDecided = false;
  w.buntNow = w.buntPlan && w.count.strikes < 2 ? w.buntPlan : null;
  w.phase = 'pitch';
  setAnim(w, P, 'pitch', 0.5);
  w.seq.lastType = spec.type;
  w.seq.lastMph = pitch.mph;
  emit(w, { type: 'pitchReleased', pitcherId: P.info.id, pitchType: pitch.type, mph: pitch.mph, rpm: pitch.rpm, release: { ...pitch.release }, targetX: aim.x, targetY: aim.y });
  running.onPitchRelease(w);
  planMitt(w);
}

const BODY_HALF_W = 0.10;

/** Perceive the pitch (perception noise first), ask the batter's decision, then plan the physical swing (execution noise after). */
function stageSwing(w: World): void {
  const pitch = w.pitch!;
  const elapsed = (w.tick - w.pitchTick) * TICK;
  const bunt = w.buntNow;
  if (!bunt && elapsed < decisionTime(pitch)) return;
  const B = w.batter!;
  const P = w.pitcher;
  const fbMph = P.info.arsenal.length ? Math.max(...P.info.arsenal.map((a) => a.mph)) : 90;
  if (!w.swingObs) w.swingObs = perceivePitch(B.info, w.batStance, pitch, w.zone, fbMph, w.rng);
  const obs = w.swingObs;
  const z = w.zone;
  const d = ask(
    w,
    'swing',
    'swing',
    w.battingTeam.side,
    () => ({
      situation: situationOf(w),
      batter: B.info,
      stance: w.batStance,
      elapsed,
      observed: { plateX: obs.front.x, plateY: obs.front.y, distanceFromZone: obs.dPerceived, timeToPlate: Math.max(0, pitch.tPlate - elapsed), speedMph: obs.speedMph, pitchType: obs.recognised ? pitch.type : null },
      zone: { left: z.left, right: z.right, bottom: z.bottom, top: z.top },
      bunt: bunt ? { kind: bunt.kind, psi: bunt.psi } : null,
    }),
    { obs },
  );
  if (d === PENDING) return;
  const ctx = {
    balls: w.count.balls,
    strikes: w.count.strikes,
    outs: w.outs,
    runnersOn: w.runners.some((r) => r.state === 'live'),
    scoringPosition: w.runners.some((r) => r.state === 'live' && r.base >= 2),
    inning: w.inning,
    scoreDiff: w.battingTeam.runs - w.fieldingTeam.runs,
  };
  w.swingPlan = buildSwing(B.info, w.batStance, pitch, obs, d, ctx, w.rng, bunt ? bunt.psi : null, elapsed, { form: B.form, pressure: leverage(w) });
  if (w.swingPlan.swing) w.swing = new BatSwing(w.swingPlan);
  w.swingObs = null;
  w.swingDecided = true;
}

export function tickPitch(w: World): void {
  const pitch = w.pitch!;
  const ball = w.ball;
  const b = ball.body;
  if (!w.swingDecided) stageSwing(w);
  moveMitt(w, (w.tick - w.pitchTick) * TICK);
  const elapsed0 = (w.tick - 1 - w.pitchTick) * TICK;
  const plan = w.swingPlan!;
  let n = 1;
  if (w.swing && !w.swing.done && (w.swingStarted || elapsed0 + TICK >= plan!.startTime)) n = 8;
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
      if (!w.swingStarted && tSub >= plan!.startTime) {
        w.swingStarted = true;
        setAnim(w, w.batter!, 'swing', plan!.tauC * 2.1);
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
  w.catcher.gloveTarget = null; // he will not be catching this one
  w.catcher.catchArmed = false;
  inplay.beginBattedBall(w, res);
}

/** The catcher's plan for this pitch: where his mitt will be at the catch plane (his read of the pitch, limited by how fast his hand can get there). */
function planMitt(w: World): void {
  const C = w.catcher;
  const cr = C.info.ratings.catching;
  const pitch = w.pitch!;
  const aim = w.pitchAim!;
  const tC = timeAtZ(pitch.path, CATCH_Z);
  const at = pathAt(pitch.path, tC);
  const lateBreak = pitch.type === 'CU' || pitch.type === 'SL' || pitch.type === 'SW' || pitch.type === 'FS' ? 1.35 : 1.0;
  const setY = clamp(aim.y, 0.3, 1.5);
  const react = 0.19 + 0.12 * (1 - cr / 100);
  const avail = Math.max(0, pitch.tPlate + 0.05 - react);
  const hand = 5.2 + 0.035 * cr;
  const maxMove = hand * avail * 0.6 + 0.12;
  const perceive = 0.03 * (1.6 - cr / 100) * lateBreak;
  const errX = w.rng.normal(0, perceive);
  const errY = w.rng.normal(0, perceive);
  let dx = at.x - aim.x + errX;
  let dy = at.y - setY + errY;
  const dl = Math.hypot(dx, dy);
  if (dl > maxMove) {
    dx *= maxMove / dl;
    dy *= maxMove / dl;
  }
  w.mitt = { x0: aim.x, y0: setY, x: aim.x + dx, y: setY + dy, tC, react, armed: false };
  C.gloveTarget = { x: aim.x, y: setY, z: CATCH_Z };
  C.gloveAt = w.pitchTick + secToTicks(tC);
  C.catchArmed = false;
}

/** While the pitch is in flight the mitt moves from where he set it to where he will take it, and the catch animation starts ~0.35 s before the ball arrives. */
function moveMitt(w: World, elapsed: number): void {
  const m = w.mitt;
  const C = w.catcher;
  if (!m || w.catcherHandled) return;
  const span = Math.max(0.05, m.tC - 0.03 - m.react);
  const u = clamp((elapsed - m.react) / span, 0, 1);
  const s = u * u * (3 - 2 * u);
  C.gloveTarget = { x: m.x0 + (m.x - m.x0) * s, y: m.y0 + (m.y - m.y0) * s, z: CATCH_Z };
  C.gloveAt = w.pitchTick + secToTicks(m.tC);
  if (!m.armed && elapsed >= m.tC - 0.35) {
    m.armed = true;
    C.catchArmed = true;
    setAnim(w, C, 'catch_pitch', 0.7);
  }
}

/** Catcher receives the pitch (or blocks a ball in the dirt). */
function catcherReceive(w: World): void {
  w.catcherHandled = true;
  const C = w.catcher;
  const b = w.ball.body;
  const aim = w.pitchAim!;
  const m = w.mitt!;
  const mx = m.x;
  const my = m.y;
  const miss = Math.hypot(b.x - mx, b.y - my);
  const inDirt = w.ball.touchedGround || b.y < 0.16;
  if (!inDirt && b.y < 2.2 && miss <= 0.12 + BALL_RADIUS) {
    // clean catch (the ball is where the mitt met it; it then settles into his hand)
    const cx = b.x;
    const cy = b.y;
    const cz = b.z;
    giveBall(w, C);
    if (!C.catchArmed) setAnim(w, C, 'catch_pitch', 0.7);
    C.catchArmed = false;
    C.gloveTarget = null;
    C.gloveHold = { x: cx, y: cy, z: cz, t0: w.tick };
    emit(w, { type: 'catch', fielderId: C.info.id, fly: false, pos: { x: cx, y: cy, z: cz }, kind: 'pitch', height: cy < 0.6 ? 'low' : cy < 1.5 ? 'chest' : 'high', side: cx < -0.25 ? 'backhand' : 'glove', firm: miss <= 0.07 });
    finishPitchResult(w, true);
    return;
  }
  // he could not glove it: the mitt is done for this pitch
  C.catchArmed = false;
  C.gloveTarget = null;
  // block attempt for balls in the dirt / off target
  const blockHalf = blockHalfWidth(C.info.ratings);
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
  // the plate umpire makes his call a moment after the catch
  if (ballOrStrike === 'ball') scheduleCall(w, 'plate', w.count.balls + 1 >= 4 ? 'ball_four' : 'ball', 0.2);
  else if (w.count.strikes + 1 >= 3) scheduleCall(w, 'plate', 'strikeout', 0.25, { swinging: ballOrStrike === 'strikeSwinging' });
  else scheduleCall(w, 'plate', ballOrStrike === 'strikeSwinging' ? 'strike_swinging' : 'strike_called', 0.25);
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
  const frame = framingPull(C.info.ratings);
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
/** Send every fielder back to his spot, shaded by the current alignment decision (`w.align`). */
export function resetDefense(w: World): void {
  const t = w.fieldingTeam;
  const a: AlignmentDecision = w.align ?? {};
  const pullSide = w.batStance === 'R' ? 1 : -1; // a right-handed batter pulls toward third base (+x)
  for (const [pos, F] of t.defense) {
    if (!F.onField) continue;
    const s = DEFAULT_SPOTS[pos as keyof typeof DEFAULT_SPOTS];
    let x = s.x;
    let z = s.z;
    if (pos === '1B' || pos === '2B' || pos === 'SS' || pos === '3B') {
      if (a.infieldIn) z -= 6.5;
      else if (a.doublePlayDepth && (pos === '2B' || pos === 'SS')) {
        z -= 2.0;
        x *= 0.85;
      }
      if (a.shift) x += pullSide * clamp(a.shift, 0, 1) * (pos === '1B' ? 2.5 : 7);
      if (a.guardLines && (pos === '1B' || pos === '3B')) x = Math.sign(x) * Math.min(Math.abs(x) + 3, z * 0.93);
    }
    if (pos === 'LF' || pos === 'CF' || pos === 'RF') z += a.outfieldDepth ?? 0;
    F.plan.kind = 'idle';
    F.plan.releaseAt = 0;
    F.home = { x, z };
    if (w.cfg.pace === 0) {
      F.lookAt = { x: 0, z: 0 };
      F.x = x;
      F.z = z;
      F.vx = F.vz = 0;
      F.goal = null;
    } else if (w.ret && w.ret.from === F && w.ret.stage !== 'flight') {
      // still holding the ball he is returning: he goes back to his spot once it has left his hand
      F.goal = null;
    } else {
      F.lookAt = { x: 0, z: 0 };
      sendHome(w, F);
    }
  }
}

export function readyNextPitch(w: World, seconds = BETWEEN): void {
  resetDefense(w);
  w.prep = freshPrep();
  w.phase = 'prePitch';
  w.phaseUntil = w.tick + paced(w, seconds);
  w.swing = null;
  w.swingPlan = null;
  w.swingStarted = false;
  w.pitch = null;
  w.pitchAim = null;
  w.play = null;
  w.stealing.clear();
  ensureBallReturn(w, true);
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

/** How much the moment matters (0..1): late, close, runners in scoring position. */
export function leverage(w: World): number {
  const bases = w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead).map((r) => r.base);
  return pressureOf(w.inning, w.cfg.innings, w.outs, w.battingTeam.runs - w.fieldingTeam.runs, bases);
}

export const freshPrep = (): World['prep'] => ({ alignmentDone: false, pickoffDone: false, pitch: null, stealsDone: false, readyBy: 0, steal: null });
