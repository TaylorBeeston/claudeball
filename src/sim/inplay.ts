import { stepBall } from './ball';
import type { ContactResult } from './batting';
import { emit } from './events';
import { BASE_POS, BASE_XZ, MOUND_DIST, fenceAt, isFairXZ } from './field';
import { setGoal } from './movement';
import { giveBall, releaseBall, setAnim } from './util';
import type { BipInfo, PlayKind, PlayState, PlayerRT, RunnerRT, World } from './world';
import { TICK, secToTicks } from './world';
import * as fielding from './fielding';
import * as flow from './flow';
import * as rules from './rules';
import * as running from './running';
import { DUGOUT } from './setup';
import { CallInfo } from './types';

const bpos = (b: number) => BASE_POS[b % 4];

export function newPlay(w: World, kind: PlayKind): PlayState {
  return {
    kind,
    startTick: w.tick,
    bip: null,
    runsThisPlay: [],
    outsThisPlay: [],
    dead: false,
    batterOut: false,
    hadError: false,
    fieldersChoice: false,
    errors: [],
    settleTicks: 0,
    primary: null,
    catchMargin: null,
    est: [],
    estTick: -1,
    aiNext: 0,
    runnerAiNext: 0,
    throws: 0,
    touches: [],
    covers: { 1: null, 2: null, 3: null, 4: null },
    cutoff: null,
    deadReason: '',
    deadTick: 0,
    throwChecked: false,
    lastThrowTick: -999,
    lastThrower: null,
    rbiEligible: true,
    dropped3Swinging: false,
  };
}

function beginLive(w: World, kind: PlayKind): PlayState {
  const play = newPlay(w, kind);
  w.play = play;
  w.phase = 'inPlay';
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    r.origin = r.base;
    r.bias = w.rng.normal(0, 0.28);
  }
  fielding.initFielderPlans(w, kind === 'battedBall' ? 0 : 0.05);
  w.ball.pathDirty = true;
  w.ball.path = [];
  return play;
}

export function beginBattedBall(w: World, res: ContactResult): void {
  const b = w.ball.body;
  const bip: BipInfo = {
    startTick: w.tick,
    exitMph: res.exitSpeed / 0.44704,
    launchDeg: res.launchDeg,
    sprayDeg: res.sprayDeg,
    contact: { x: b.x, y: b.y, z: b.z },
    status: 'undecided',
    firstTouch: null,
    peakY: b.y,
    landed: false,
    caught: false,
    infieldFly: false,
    infieldFlyChecked: false,
    homeRun: false,
    groundRuleDouble: false,
    bunt: false,
    fielders: [],
    fieldersTouched: [],
    errorBy: null,
    firstFielder: null,
    bounced: false,
    line: res.launchDeg > 8 && res.launchDeg < 26 && res.exitSpeed / 0.44704 > 80,
  };
  const batter = w.batter!;
  const br = running.makeRunner(w, batter, true);
  br.responsible = w.pitcher;
  const play = beginLive(w, 'battedBall');
  play.bip = bip;
  w.ball.mode = 'batted';
  w.ball.touchedGround = false;
  w.ball.touchedWall = false;
  w.ballInPlayEver = true;
  batter.vx = batter.vz = 0;
  batter.reactUntil = w.tick;
  batter.lookAt = null;
  br.reaction = w.tick + secToTicks(0.16);
  batter.anim = 'swing';
  w.stealing.clear();
  for (const r of w.runners) r.stealing = false;
}

/** Live ball after a wild pitch / passed ball / blocked pitch. */
export function beginLooseBall(w: World): void {
  w.batterKeepsPA = true;
  beginLive(w, 'looseBall');
  w.ball.mode = 'loose';
  w.ball.pathDirty = true;
  for (const r of w.runners) if (r.state === 'live' && r.stealing) r.stealing = true;
}

/** After a caught pitch with a runner going: the catcher throws down. */
export function beginStealPlay(w: World): void {
  beginLive(w, 'steal');
  // ball is already in the catcher's glove
  const C = w.catcher;
  giveBall(w, C);
  C.plan.holdUntil = w.tick + fielding.transferTicks(C, 0) - secToTicks(0.1);
}

export function beginPickoff(w: World, r: RunnerRT): void {
  const P = w.pitcher;
  const play = beginLive(w, 'pickoff');
  void play;
  const cover = w.fieldingTeam.defense.get(r.base === 1 ? '1B' : w.batStance === 'R' ? 'SS' : '2B')!;
  w.phase = 'inPlay';
  emit(w, { type: 'pickoffAttempt', pitcherId: P.info.id, base: r.base });
  // the runner dives back; the fielder covers and the pitcher throws
  r.want = r.base;
  r.target = r.base;
  r.reaction = w.tick + secToTicks(0.22 - 0.0008 * (r.p.info.ratings.baserunning - 50));
  const bp = bpos(r.base);
  setGoal(r.p, bp.x, bp.z, true, 1);
  P.plan.holdUntil = w.tick;
  P.plan.releaseAt = w.tick + secToTicks(0.35);
  P.plan.throwBase = r.base;
  P.plan.throwTo = cover;
  P.goal = null;
  const dx = bp.x - P.x;
  const dz = bp.z - P.z;
  P.facing = Math.atan2(dx, dz);
  setAnim(w, P, 'throw', 0.5);
  setGoal(cover, bp.x + (P.x - bp.x) * 0.03, bp.z + (P.z - bp.z) * 0.03, true, 1);
  cover.plan.kind = 'cover';
  cover.plan.base = r.base;
  cover.plan.reactTick = w.tick;
  w.ball.mode = 'held';
  w.play!.covers[r.base] = cover;
}

export function beginDroppedThirdStrike(w: World, swinging: boolean): void {
  const b = w.batter!;
  b.bat.so += 0; // decided at the end of the play
  const br = running.makeRunner(w, b, true);
  br.responsible = w.pitcher;
  const play = beginLive(w, 'droppedThird');
  play.dropped3Swinging = swinging;
  w.ball.mode = 'loose';
  b.reactUntil = w.tick;
  br.reaction = w.tick + secToTicks(0.2);
  b.lookAt = null;
  setAnim(w, b, 'run', 1);
}

// ---------------------------------------------------------------------------------------------

export function startDeadBallMovement(w: World): void {
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    r.p.role = 'runner';
    r.p.onField = true;
    r.reaction = w.tick + secToTicks(0.5);
    if (w.cfg.pace === 0) {
      // snap immediately to the awarded bases
      r.base = r.target;
      const bp = bpos(r.target);
      r.p.x = bp.x;
      r.p.z = bp.z;
      r.p.vx = r.p.vz = 0;
    }
  }
  for (const F of fielding.fielders(w)) {
    F.goal = null;
  }
}

/** A home run: everyone trots around the bases. */
function homeRun(w: World, bip: BipInfo): void {
  const play = w.play!;
  bip.homeRun = true;
  bip.status = 'fair';
  play.dead = true;
  w.ball.mode = 'dead';
  const b = w.ball.body;
  const dist = Math.hypot(b.x, b.z);
  emit(w, { type: 'homeRun', batterId: w.batter!.info.id, distance: dist });
  emit(w, { type: 'call', call: mkCall(w, 'homeRun') });
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    r.dead = true;
    r.awarded = true;
    r.want = 4;
    r.reaction = w.tick + secToTicks(0.6);
    r.stealing = false;
    r.tagWait = false;
    r.retouch = 0;
    r.p.vmax = Math.min(r.p.vmax, 6.5);
  }
  for (const F of fielding.fielders(w)) {
    F.goal = null;
    F.lookAt = { x: b.x, z: b.z };
  }
  w.phase = 'inPlay';
}

function groundRuleDouble(w: World, bip: BipInfo): void {
  const play = w.play!;
  bip.groundRuleDouble = true;
  bip.status = 'fair';
  play.dead = true;
  w.ball.mode = 'dead';
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    r.dead = true;
    r.awarded = true;
    r.want = Math.min(4, r.base + 2);
    if (r.isBatter) r.want = 2;
    r.reaction = w.tick + secToTicks(0.3);
    r.stealing = false;
    r.tagWait = false;
  }
}

function mkCall(w: World, kind: CallInfo['kind']): CallInfo {
  const c: CallInfo = { kind, time: w.tick * TICK, balls: w.count.balls, strikes: w.count.strikes };
  w.lastCall = c;
  return c;
}

// ---------------------------------------------------------------------------------------------
// per-tick
// ---------------------------------------------------------------------------------------------

export function tickInPlay(w: World): void {
  const play = w.play!;
  const ball = w.ball;
  const bip = play.bip;

  // batter's follow-through
  if (w.swing && !w.swing.done && w.swingStarted) w.swing.advance(TICK);

  // ball
  if (ball.lob) flow.tickLob(w);
  else if (ball.holder) flow.ballFollowsHolder(w);
  else if (ball.mode === 'batted' || ball.mode === 'loose' || ball.mode === 'thrown') stepLiveBall(w);

  if (!play.dead) {
    // throws leave the hand when the wind-up ends
    for (const F of fielding.fielders(w)) {
      if (F.plan.releaseAt > 0 && w.tick >= F.plan.releaseAt) fielding.doThrow(w, F);
    }
    fielding.fieldingAttempts(w);
    if (ball.mode === 'thrown') fielding.checkWildThrow(w);
    checkPlays(w);
    if (bip && !bip.infieldFlyChecked) checkInfieldFly(w, bip);
    if (bip) determineFairFoul(w, bip);
  }

  running.tickRunners(w);

  if (!play.dead && w.tick >= play.aiNext) {
    play.aiNext = w.tick + 12;
    fielding.defenseAI(w);
  }
  if (!play.dead && w.tick >= play.runnerAiNext) {
    play.runnerAiNext = w.tick + 12;
    running.runnerAI(w);
  }

  if (bip && bip.status === 'foul' && !play.dead && !ball.holder) foulBallDead(w);
  else if (bip && bip.status === 'foul' && !play.dead && ball.holder) foulBallDead(w);

  // dead-ball movement (walks, HR, ground-rule double, foul resets)
  if (play.dead) {
    if (deadBallDone(w)) finishPlay(w);
    return;
  }
  checkSettled(w);
  if ((w.tick - play.startTick) * TICK > 45) {
    play.dead = true;
    finishPlay(w);
  }
}

function stepLiveBall(w: World): void {
  const ball = w.ball;
  const b = ball.body;
  const play = w.play!;
  const bip = play.bip;
  stepBall(b, TICK, w.env, w.rng, ball.flags, true);
  const f = ball.flags;
  if (bip && b.y > bip.peakY) bip.peakY = b.y;
  if (f.bounced) {
    if (!ball.touchedGround && bip && bip.status === 'undecided') bip.landed = true;
    ball.touchedGround = true;
    ball.pathDirty = true;
    ball.lastBounceTick = w.tick;
    if (bip) bip.bounced = true;
  }
  if (f.wallHit) {
    ball.touchedWall = true;
    ball.pathDirty = true;
    if (bip && bip.status === 'undecided') bip.status = isFairXZ(b.x, b.z) ? 'fair' : 'foul';
  }
  if (f.overFence) {
    if (bip && bip.status !== 'foul' && isFairXZ(b.x, b.z)) {
      if (ball.touchedGround) groundRuleDouble(w, bip);
      else homeRun(w, bip);
    } else if (bip) {
      bip.status = 'foul';
    } else {
      // thrown/loose ball out of play: award bases
      play.dead = true;
      ball.mode = 'dead';
      for (const r of w.runners) {
        if (r.state !== 'live') continue;
        r.dead = true;
        r.awarded = true;
        r.want = Math.min(4, Math.max(r.want, r.target) + (r.target > r.base ? 0 : 1));
      }
    }
  }
  if (b.rolling && Math.hypot(b.vx, b.vz) < 0.05) {
    if (bip && bip.status === 'undecided') bip.status = isFairXZ(b.x, b.z) ? 'fair' : 'foul';
    if (ball.mode === 'batted') ball.mode = 'loose';
  }
  // stop the sim for balls that get far outside
  if (Math.hypot(b.x, b.z) > 160) {
    ball.mode = 'dead';
    play.dead = true;
  }
}

function determineFairFoul(w: World, bip: BipInfo): void {
  if (bip.status !== 'undecided') return;
  const b = w.ball.body;
  const onGround = w.ball.body.rolling || (w.ball.flags.bounced && w.tick === w.ball.lastBounceTick);
  if (!onGround && !w.ball.touchedGround) return;
  if (w.ball.holder) return;
  const first = w.ball.touchedGround;
  if (b.z >= BASE_XZ && (b.y < 0.2 || w.ball.body.rolling)) {
    bip.status = isFairXZ(b.x, b.z) ? 'fair' : 'foul';
    return;
  }
  if (first && !isFairXZ(b.x, b.z) && (b.z < 0 || Math.abs(b.x) > b.z + 4) && w.tick - w.ball.lastBounceTick < 3 + 1e6) {
    if (b.z < 0 || Math.abs(b.x) > b.z + 4) bip.status = 'foul';
  }
}

/** Umpire declares the infield fly (fair fly ball an infielder can catch, runners on 1st & 2nd or loaded, <2 outs). */
function checkInfieldFly(w: World, bip: BipInfo): void {
  if ((w.tick - bip.startTick) * TICK < 0.45) return;
  bip.infieldFlyChecked = true;
  if (w.outs >= 2 || bip.line || bip.launchDeg < 25) return;
  const r1 = w.runners.some((r) => r.state === 'live' && r.base === 1 && !r.isBatter);
  const r2 = w.runners.some((r) => r.state === 'live' && r.base === 2 && !r.isBatter);
  const r3 = w.runners.some((r) => r.state === 'live' && r.base === 3 && !r.isBatter);
  if (!(r1 && r2)) return;
  void r3;
  fielding.ensurePath(w);
  const path = w.ball.path;
  const land = path.find((s) => s.y < 0.3 && s.t > 0.2);
  if (!land) return;
  if (!isFairXZ(land.x, land.z)) return;
  if (Math.hypot(land.x, land.z - 20) > 38 || Math.hypot(land.x, land.z) > 52) return;
  bip.infieldFly = true;
  const br = w.runners.find((r) => r.isBatter && r.state === 'live');
  emit(w, { type: 'call', call: mkCall(w, 'infieldFly') });
  if (br) {
    // batter is out on the declaration; runners may advance at their own risk
    rules.recordOut(w, br, 'infieldFly', [], null, false);
  }
}

function foulBallDead(w: World): void {
  const play = w.play!;
  const bip = play.bip!;
  if (play.dead) return;
  if (bip.caught) return;
  play.dead = true;
  play.deadReason = 'foul';
  w.ball.mode = w.ball.holder ? 'held' : 'dead';
  emit(w, { type: 'call', call: mkCall(w, 'foul') });
  if (w.count.strikes < 2) w.count.strikes++;
  w.pitcher.pit.strikes++;
  // runners go back to their original bases; batter-runner is removed
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    if (r.isBatter) {
      r.state = 'out';
      r.dead = true;
      r.p.onField = true;
      continue;
    }
    r.want = r.origin;
    r.base = r.origin;
    r.target = r.origin;
    r.dead = true;
    r.stealing = false;
    r.tagWait = false;
    r.retouch = 0;
    r.touched = [false, false, false, false, false];
    const bp = bpos(r.origin);
    r.p.goal = null;
    if (w.cfg.pace === 0) {
      r.p.x = bp.x;
      r.p.z = bp.z;
    } else setGoal(r.p, bp.x, bp.z, true, 0.6);
  }
  // batter walks back to the box
  const b = w.batter!;
  b.role = 'batter';
  w.runners = w.runners.filter((r) => !(r.isBatter && r.state === 'out' && r.p === b));
  w.foulReset = true;
}

// ---------------------------------------------------------------------------------------------
// tags, forces, appeals
// ---------------------------------------------------------------------------------------------

function checkPlays(w: World): void {
  const ball = w.ball;
  const F = ball.holder;
  if (!F || F.team !== w.fieldingTeam) return;
  if (w.play!.dead) return;
  const catchOut = w.play!.bip?.caught;
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead) continue;
    // force out / appeal at the base the fielder is standing on
    const advancingTarget = r.target > r.base ? r.target : 0;
    if (advancingTarget && running.forced(w, r)) {
      const bp = bpos(advancingTarget);
      if (Math.hypot(F.x - bp.x, F.z - bp.z) <= 0.95 && !r.touched[advancingTarget]) {
        rules.recordOut(w, r, 'force', [...w.play!.touches.slice(-2), F].filter((x, i, a) => a.indexOf(x) === i), advancingTarget, true);
        continue;
      }
    }
    // doubled off: failed to retouch after a catch
    if (r.retouch && !r.retouchDone) {
      const bp = bpos(r.retouch);
      if (Math.hypot(F.x - bp.x, F.z - bp.z) <= 0.95) {
        rules.recordOut(w, r, 'tagUp', [F], r.retouch, true);
        continue;
      }
    }
    // tag
    if (running.vulnerable(r) && Math.hypot(F.x - r.p.x, F.z - r.p.z) <= 0.95) {
      if (w.play!.kind === 'steal') {
        // caught stealing
      }
      const type = w.play!.kind === 'steal' && r.stealing ? 'caughtStealing' : w.play!.kind === 'pickoff' ? 'pickoff' : 'tag';
      if (type === 'caughtStealing') r.p.bat.cs++;
      rules.recordOut(w, r, type, [F], null, false);
    }
  }
  void catchOut;
}

function checkSettled(w: World): void {
  const play = w.play!;
  const ball = w.ball;
  const F = ball.holder;
  let settled = false;
  if (F && F.team === w.fieldingTeam && !ball.lob && F.plan.releaseAt === 0 && w.tick >= F.plan.holdUntil) {
    settled = true;
    for (const r of w.runners) {
      if (r.state !== 'live' || r.dead) continue;
      const sp = Math.hypot(r.p.vx, r.p.vz);
      if (r.target > r.base || r.want > r.base) {
        settled = false;
        break;
      }
      if (r.isBatter && r.base === 0) {
        settled = false;
        break;
      }
      if (!(running.isOnBase(r) || (r.overrun && sp < 1.2) || r.retouch)) {
        settled = false;
        break;
      }
      if (r.retouch && !r.retouchDone) {
        settled = false;
        break;
      }
    }
    // a runner in a rundown keeps the play alive; a fielder chasing a runner too
    if (F.plan.kind === 'tag') settled = false;
  }
  if (settled) play.settleTicks++;
  else play.settleTicks = 0;
  if (play.settleTicks > 50) play.dead = true;
  if (play.dead && w.outs < 3) finishPlay(w);
  else if (w.outs >= 3) {
    play.dead = true;
    finishPlay(w);
  }
}

function deadBallDone(w: World): boolean {
  const play = w.play!;
  if (w.gameOver) return false;
  if (w.outs >= 3) return true;
  // wait for dead-ball movement to complete
  let allDone = true;
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    if (!r.dead) continue;
    if (r.want > r.base || (r.dead && r.target > r.base)) allDone = false;
    if (r.state === 'live' && r.base === r.target && r.dead && !running.isOnBase(r) && r.base >= 1) allDone = false;
  }
  if (play.kind !== 'deadBall' && play.deadReason === 'foul') {
    // give runners a moment to walk back
    allDone = (w.tick - play.deadTick) * TICK > 0.6 || w.cfg.pace === 0;
  }
  if (play.deadTick === 0) play.deadTick = w.tick;
  if ((w.tick - play.startTick) * TICK > 30) allDone = true;
  return allDone;
}

/** Everything has settled or the ball is dead: score the play and move on. */
export function finishPlay(w: World): void {
  const play = w.play;
  if (!play || play.finished) return;
  play.finished = true;
  const bip = play.bip;
  if (w.walkOffPending && w.half === 'bottom' && w.teams.home.runs > w.teams.away.runs && w.outs < 3) {
    // (recorded outs may have nullified the run earlier)
  }
  if (play.deadReason === 'foul') {
    w.foulReset = false;
    fixupRunners(w);
    // return to position
    for (const F of fielding.fielders(w)) F.goal = null;
    resetFielders(w);
    w.batterKeepsPA = false;
    flow.resetBatterToBox(w);
    flow.readyNextPitch(w, 2.4);
    w.ball.mode = 'dead';
    returnBallToPitcher(w);
    return;
  }
  if (play.kind === 'battedBall') rules.resolveBattedBall(w);
  else if (play.kind === 'droppedThird') rules.resolveDroppedThird(w);
  else if (play.kind === 'steal' || play.kind === 'pickoff' || play.kind === 'looseBall') rules.resolveOtherPlay(w);
  else if (play.kind === 'deadBall') {
    /* walk / HBP already recorded */
  }
  void bip;
  if (w.gameOver) return;
  // walk-off with two outs waits until now
  if (w.walkOffPending && w.half === 'bottom' && w.inning >= w.cfg.innings && w.teams.home.runs > w.teams.away.runs && w.outs < 3) {
    rules.endGame(w, 'home');
    return;
  }
  w.walkOffPending = false;
  fixupRunners(w);
  resetFielders(w);
  returnBallToPitcher(w);
  rules.toPlayOver(w);
}

function fixupRunners(w: World): void {
  running.snapRunnersToBases(w);
  for (const r of w.runners) {
    if (r.state === 'live') {
      r.p.role = 'runner';
    }
  }
  w.runners = w.runners.filter((r) => {
    if (r.state === 'live') return true;
    r.p.goal = null;
    // scored/out runners leave the field after a short walk
    r.p.onField = false;
    return false;
  });
}

function resetFielders(w: World): void {
  for (const F of fielding.fielders(w)) {
    F.plan.kind = 'idle';
    F.plan.releaseAt = 0;
    F.hasBall = F === w.ball.holder;
  }
}

/** The fielder holding the ball tosses it back to the pitcher. */
function returnBallToPitcher(w: World): void {
  const ball = w.ball;
  const P = w.pitcher;
  if (ball.holder === P) return;
  if (ball.holder) {
    const from = ball.holder;
    ball.lob = { from, to: P, start: w.tick, dur: secToTicks(Math.max(0.5, Math.hypot(from.x - P.x, from.z - P.z) / 28)) };
    return;
  }
  giveBall(w, P);
}

export { DUGOUT, MOUND_DIST, fenceAt, releaseBall };
