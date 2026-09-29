import { emit } from './events';
import { PENDING } from './decisions';
import type { LeadDecision, PickoffDecision, RunnerDecision, RunnerRequest, StealDecision, StealRequest } from './decisions';
import { ask, situationOf } from './dispatch';
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
    askSeq: 0,
    lastSig: '',
    recheckTick: 0,
    leadDist: 3,
    leadKey: '',
    asking: false,
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
    // how far off the bag for this pitch: the runner's own decision, asked once per pitch
    const key = `${r.p.info.id}:${r.base}:${w.batter?.info.id ?? ''}:${w.paPitches}`;
    if (r.leadKey !== key) {
      const ans = ask(w, `lead:${r.p.info.id}`, 'lead', w.battingTeam.side, () => ({ situation: situationOf(w), runner: r.p.info, base: r.base, pitcher: w.pitcher.info, min: 0, max: MAX_LEAD }), { r });
      if (ans === PENDING) continue;
      r.leadDist = clamp(ans.lead, 0, MAX_LEAD);
      r.leadKey = key;
    }
    const lead = r.leadDist;
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

/** Longest lead a runner may take (m): beyond this he is not standing near a base any more. */
export const MAX_LEAD = 6;

/** The built-in runner's lead: from his speed and baserunning instincts. */
export function aiLead(req: { runner: { ratings: { speed: number; baserunning: number } }; base: number }): LeadDecision {
  const R = req.runner.ratings;
  return { lead: clamp(3.0 + 0.035 * (R.speed - 50) + 0.015 * (R.baserunning - 50), 1.8, 4.6) * (req.base === 3 ? 0.8 : 1) };
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

/** Is there a runner the pitcher could hold with a throw over? */
function pickoffCandidate(w: World): RunnerRT | null {
  const r = w.runners.find((q) => q.state === 'live' && q.base >= 1 && q.base <= 2 && q.target === q.base && !q.dead);
  if (!r) return null;
  const nextOpen = !w.runners.some((q) => q.state === 'live' && q.base === r.base + 1);
  return nextOpen ? r : null;
}

/** Ask the pitcher whether to throw over; 'thrown' if he did (the pickoff play starts). */
export function stagePickoff(w: World): 'none' | 'wait' | 'thrown' {
  const r = pickoffCandidate(w);
  if (!r) return 'none';
  const d = ask(w, 'pickoff', 'pickoff', w.fieldingTeam.side, () => ({ situation: situationOf(w), pitcher: w.pitcher.info, runner: r.p.info, base: r.base, lead: Math.hypot(r.p.x - bpos(r.base).x, r.p.z - bpos(r.base).z) }), { r });
  if (d === PENDING) return 'wait';
  if (d.throw && r.state === 'live') {
    inplay.beginPickoff(w, r);
    return 'thrown';
  }
  return 'none';
}

/** The built-in pitcher's pickoff rule: the more of a running threat, the more often he throws over (a mixed strategy). */
export function aiPickoff(w: World, r: RunnerRT): PickoffDecision {
  const threat = clamp((r.p.info.ratings.speed - 45) / 40, 0, 1) * (r.base === 1 ? 1 : 0.2);
  const p = (r.base === 1 ? 0.012 : 0.002) + (r.base === 1 ? 0.06 : 0.01) * threat;
  return { throw: w.aiRng.next() < p };
}

/** The runner who could break for the next base on this pitch, if the base is open. */
function stealCandidate(w: World): RunnerRT | null {
  const r = w.runners.find((q) => q.state === 'live' && q.base >= 1 && q.base <= 2 && q.target === q.base && !q.dead);
  if (!r) return null;
  const nb = r.base + 1;
  if (w.runners.some((q) => q.state === 'live' && q.base === nb && q !== r)) return null;
  return r;
}

/** Nominal times for a steal from the runner's current position (the numbers a runner / coach reads off the situation). */
export function stealTimes(w: World, r: RunnerRT, windupSecs: number): { ballTime: number; runnerTime: number } {
  const P = r.p;
  const catcher = w.catcher;
  const nb = r.base + 1;
  const jump = 0.32 - 0.002 * (P.info.ratings.baserunning - 50);
  const bp = bpos(nb);
  const dist = Math.hypot(bp.x - P.x, bp.z - P.z);
  const runnerTime = jump + travelTime({ x: 0, z: 0, vx: 0.4, vz: 0, vmax: P.vmax, accel: P.accel }, dist, 0) - 0.08;
  const armV = 27 + 0.21 * catcher.info.ratings.arm;
  const D = Math.hypot(bp.x - catcher.x, bp.z - catcher.z);
  const exch = 0.72 - 0.0035 * (catcher.info.ratings.catching - 50);
  const ballTime = windupSecs + 0.44 + exch + D / (armV * 0.9) + 0.2;
  return { ballTime, runnerTime };
}

/** Ask the runner (at the start of the windup) whether he goes. */
export function stageSteals(w: World): boolean {
  const r = stealCandidate(w);
  if (!r) {
    w.prep.steal = null;
    return true;
  }
  const runnersOn = true;
  const nominalWindup = runnersOn ? 0.84 : 1.12;
  const d = ask(
    w,
    'steal',
    'steal',
    w.battingTeam.side,
    () => {
      const t = stealTimes(w, r, nominalWindup);
      return { situation: situationOf(w), runner: r.p.info, fromBase: r.base, toBase: r.base + 1, pitcher: w.pitcher.info, catcher: w.catcher.info, ballTime: t.ballTime, runnerTime: t.runnerTime };
    },
    { r },
  );
  if (d === PENDING) return false;
  w.prep.steal = { r, go: d.go };
  return true;
}

/** The built-in runner's steal rule: his own time against the battery's, with the situation deciding how much margin he wants. */
export function aiSteal(w: World, r: RunnerRT, req: StealRequest): StealDecision {
  const P = r.p;
  if (w.outs >= 2 && r.base === 2) return { go: false };
  const margin = req.ballTime - req.runnerTime + w.aiRng.normal(0, 0.25);
  const aggr = (P.info.ratings.baserunning - 50) / 100 + (w.outs === 2 ? 0.05 : 0) + (r.base === 2 ? 0.1 : 0);
  const situational = w.count.balls === 3 && w.count.strikes < 2 ? -0.1 : 0;
  const thr = 0.3 - 0.3 * aggr + situational + (w.inning >= 8 && Math.abs(w.battingTeam.runs - w.fieldingTeam.runs) > 2 ? 0.2 : 0);
  return { go: margin > thr };
}

/** The windup begins: a runner who was told to go breaks with the pitcher's motion. */
export function commitSteals(w: World): void {
  w.stealing.clear();
  const s = w.prep.steal;
  w.prep.steal = null;
  if (!s || !s.go) return;
  const r = s.r;
  const nb = r.base + 1;
  if (r.state !== 'live' || r.dead || r.target !== r.base) return;
  if (w.runners.some((q) => q.state === 'live' && q.base === nb && q !== r)) return;
  const P = r.p;
  r.stealing = true;
  r.stealDelay = 0;
  w.stealing.add(r);
  // the runner breaks as the pitcher commits to the plate
  r.want = r.base + 1;
  r.target = r.base + 1;
  r.origin = r.base;
  r.reaction = w.tick + secToTicks(Math.max(0.05, 0.1 + 0.28 * (1 - P.info.ratings.baserunning / 100) + w.rng.normal(0, 0.13)));
  w.pitcher.lookAt = null;
}

export function onPitchRelease(w: World): void {
  for (const r of w.stealing) {
    // the middle infielder covering the base breaks toward the bag with the runner
    const nb = r.base + 1;
    const pos = nb === 2 ? (w.batStance === 'R' ? 'SS' : '2B') : nb === 3 ? '3B' : 'C';
    const cover = w.fieldingTeam.defense.get(pos as never);
    if (cover && cover.onField) {
      const bp = bpos(nb);
      setGoal(cover, bp.x + (nb === 2 ? 0 : 0), bp.z - 0.6, true, 1);
    }
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
// runner decisions while the ball is in play
// ---------------------------------------------------------------------------------------------

/** Everything that should make a runner (or his coach) think again: the ball changing hands, a catch, a throw, a bag reached... */
function runnerSig(w: World, r: RunnerRT): string {
  const play = w.play!;
  const bip = play.bip;
  const ball = w.ball;
  return [ball.mode, ball.holder?.info.id ?? '-', play.throws, bip?.caught ? 1 : 0, bip?.landed || ball.touchedGround ? 1 : 0, ball.touchedWall ? 1 : 0, play.errors.length, r.base, r.target, r.retouch, r.retouchDone ? 1 : 0, r.overrun ? 1 : 0, w.outs].join('|');
}

function buildRunnerRequest(w: World, r: RunnerRT): Omit<RunnerRequest, 'id' | 'kind' | 'side' | 'time' | 'state'> {
  const play = w.play!;
  const bip = play.bip;
  const ball = w.ball;
  const est = fielding.estimateBallTimes(w);
  const F = ball.holder && ball.holder.team === w.fieldingTeam ? ball.holder : play.primary;
  const eta = [0, 0, 0, 0, 0];
  for (let b = 1; b <= 4; b++) eta[b] = runnerETA(r, b);
  const b = ball.body;
  const airFly = !!bip && bip.status !== 'foul' && !bip.landed && !bip.caught && ball.mode === 'batted' && !ball.touchedGround;
  return {
    situation: situationOf(w),
    runner: r.p.info,
    isBatterRunner: r.isBatter,
    base: r.base,
    heading: r.target,
    want: r.want,
    pos: { x: r.p.x, y: 0, z: r.p.z },
    speed: Math.hypot(r.p.vx, r.p.vz),
    overrun: r.overrun,
    forced: forced(w, r),
    mustRetouch: r.retouch && !r.retouchDone ? r.retouch : 0,
    ball: {
      mode: ball.mode,
      pos: { x: b.x, y: b.y, z: b.z },
      vel: { x: b.vx, y: b.vy, z: b.vz },
      holderId: ball.holder?.info.id ?? null,
      inAir: b.y > 0.3 && !b.rolling,
      caught: !!bip?.caught,
      landed: !!bip && (bip.landed || ball.touchedGround),
      hitWall: ball.touchedWall,
      catchMargin: airFly ? play.catchMargin : null,
    },
    fielder: F ? { id: F.info.id, pos: { x: F.x, y: 0, z: F.z }, armMps: fielding.armSpeed(F), hasBall: F === ball.holder } : null,
    ballToBase: [...est],
    runnerToBase: eta,
    others: w.runners.filter((q) => q !== r && q.state === 'live').map((q) => ({ playerId: q.p.info.id, base: q.base, heading: q.target, want: q.want })),
  };
}

/** Ask each live runner what he wants to do, whenever the play changes (and after the interval an answer asks for). */
export function runnerAI(w: World): void {
  const play = w.play;
  if (!play) return;
  let pending = false;
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead) continue;
    if (r.stealing && !r.isBatter && r.base === r.origin) {
      // a runner who has broken for the next base is committed
      r.want = Math.max(r.want, r.origin + 1);
      continue;
    }
    if (r.tagWait) {
      // waiting on the bag for the catch (the catch clears this in fielding.secure); a ball that lands frees him to run
      const bip = play.bip;
      if (bip && (bip.landed || w.ball.touchedGround) && !bip.caught) r.tagWait = false;
      else continue;
    }
    const sig = runnerSig(w, r);
    if (!r.asking && sig === r.lastSig && w.tick < r.recheckTick) continue;
    r.asking = true;
    const d = ask(w, `run:${r.p.info.id}`, 'runner', w.battingTeam.side, () => buildRunnerRequest(w, r), { r });
    if (d === PENDING) {
      pending = true;
      continue;
    }
    r.asking = false;
    applyRunnerDecision(w, r, d);
    r.lastSig = runnerSig(w, r);
    r.recheckTick = d.recheckSec !== undefined ? w.tick + secToTicks(d.recheckSec) : Infinity;
  }
  if (pending) play.runnerAiNext = w.tick + 1;
}

/** The rules around a runner's decision: forces, tag-up obligations and the point of no return are the sim's, not the provider's. */
function applyRunnerDecision(w: World, r: RunnerRT, d: RunnerDecision): void {
  const play = w.play!;
  const bip = play.bip;
  const p = r.p;
  const airFly = !!bip && bip.status !== 'foul' && !bip.landed && !bip.caught && w.ball.mode === 'batted' && !w.ball.touchedGround;
  if (d.tagUp && airFly && r.base >= 1 && !r.isBatter && r.target === r.base) {
    r.tagWait = true;
    r.want = r.base;
    return;
  }
  let want = clamp(Math.round(Number.isFinite(d.want) ? d.want : r.base), r.base, 4);
  const frc = forced(w, r);
  if (frc) want = Math.max(want, r.base + 1);
  if (r.isBatter && r.base === 0) want = Math.max(want, 1);
  if (r.retouch && !r.retouchDone) want = r.base;
  // point of no return: close to the bag he is running to, he cannot turn around
  if (want < r.want && r.target > r.base && Math.hypot(p.x - bpos(r.target).x, p.z - bpos(r.target).z) < 3) want = r.want;
  if (frc) want = Math.max(want, r.base + 1);
  r.want = Math.max(want, r.base);
  if (r.retouch && r.retouchDone) r.retouch = 0;
  if (r.retouch && r.want > r.base) r.want = r.base;
}

/** The built-in baserunner (and third-base coach): weighs his time to each bag against the defense's time to have the ball there. */
export function aiRunner(w: World, r: RunnerRT, req: RunnerRequest): RunnerDecision {
  const play = w.play!;
  const bip = play.bip;
  const p = r.p;
  const est = req.ballToBase;
  const airFly = !!bip && bip.status !== 'foul' && !bip.landed && !bip.caught && w.ball.mode === 'batted' && !w.ball.touchedGround;
  const rec = 0.05;
  // tag up on a fly ball that is likely to be caught
  if (airFly && r.base >= 1 && !r.isBatter && r.target === r.base) {
    const cm = play.catchMargin;
    if (w.outs < 2 && cm !== null && cm + r.bias * 0.5 > -0.1) return { want: r.base, tagUp: true, recheckSec: rec };
  }
  let want = r.base;
  const frc = req.forced;
  if (frc) want = Math.max(want, r.base + 1);
  if (r.isBatter && r.base === 0) want = Math.max(want, 1);
  const safety = 0.16 + 0.3 * (1 - clamp((p.info.ratings.baserunning + 30) / 100, 0, 1)) + (w.outs === 2 ? -0.1 : 0);
  const coachExtra = r.base === 2 ? 0.05 : 0; // third-base coach is conservative at the plate
  for (let b = Math.max(r.base + 1, 1); b <= 4; b++) {
    if (b > r.base + 1 && b > want + 0) {
      // extra-base attempt needs the previous base to be attainable
      if (want < b - 1) break;
    }
    const tR = req.runnerToBase[b];
    const m = est[b] - tR - r.bias - safety - (b === 4 ? coachExtra : 0);
    if (m > 0) want = Math.max(want, b);
    else break;
  }
  // if between bases and the current target is a bad bet, consider returning
  if (r.target > r.base && want < r.target && !frc) {
    const mAdv = est[r.target] - req.runnerToBase[r.target] - r.bias;
    if (mAdv >= -0.05) want = r.target;
    else want = r.base;
  }
  return { want, recheckSec: rec };
}

export { rules };
