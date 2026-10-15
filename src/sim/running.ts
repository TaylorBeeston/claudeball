import { emit } from './events';
import { PENDING } from './decisions';
import type { LeadDecision, PickoffDecision, RunnerDecision, RunnerRequest, StealDecision, StealRequest } from './decisions';
import { ask, situationOf } from './dispatch';
import { BASE_POS } from './field';
import { clamp } from './math';
import * as tagging from './tagging';
import { baseCallDelay, scheduleCall } from './umpires';
import { catcherExchange, deliverySeconds, holdingLeadAdjust, sprintOf } from './attributes';
import { setGoal, travelTime } from './movement';
import { setAnim } from './util';
import { aimStep, distToBase, shoeOn, standsOn, touchPoint } from './stride';
import type { PlayerRT, RunnerRT, World } from './world';
import { TICK, secToTicks } from './world';
import * as fielding from './fielding';
import * as staff from './staff';
import { noteClose } from './visits';
const visitsNoteClose = (w: World, id: string, b: number, margin: number, close: boolean) => {
  if (close) noteClose(w, 'safe', id, b, margin);
};
import type { CoachDecision } from './decisions';
import * as inplay from './inplay';
import * as rules from './rules';
import * as contact from './contact';
import * as clock from './clock';
import { DUGOUT } from './setup';
import { leaveDugout, toBench } from './dugout';

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
    slideKind: null,
    slideAt: 0,
    contactBase: 0,
    dodged: false,
    dead: false,
    awarded: false,
    scoredTick: 0,
    touched: [false, false, false, false, false],
    want: isBatter ? 1 : 0,
    ghost: false,
    earned: false,
    overrun: false,
    bias: 0,
    coachBias: 0,
    coachObey: null,
    coachCall: null,
    coachFresh: null,
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
    trot: 0,
    exitVia: 0,
    exitDone: false,
    outTick: 0,
    celebrateUntil: 0,
    nearMiss: 9,
    goBack: 0,
    strikeSeen: p.stride.last?.tick ?? 0,
    protectTo: 0,
    tagLine: null,
    apBase: 0,
    apMin: 9,
  };
  p.role = 'runner';
  p.onField = true;
  p.dug = null; // (a hitter who was warming up on deck, a pinch runner from the bench: he is in the play now)
  p.route = [];
  p.after = null;
  w.leavers = w.leavers.filter((l) => l.p !== p);
  p.vmax = sprintOf(p.info.ratings.speed);
  p.lookAt = null;
  if (isBatter) {
    p.goal = null;
  }
  w.runners.push(r);
  return r;
}

export function placeGhostRunner(w: World, p: PlayerRT): void {
  const seated = p.dug === 'bench';
  const r = makeRunner(w, p, false);
  r.base = 2;
  r.target = 2;
  r.want = 2;
  r.ghost = true;
  r.origin = 2;
  r.touched[2] = true;
  r.reaction = 0;
  if (w.cfg.pace > 0 && w.tick > 0) {
    // the extra-innings runner walks out to second: from the bench, or from wherever he is (he may be jogging in from the field), the break gives him time
    const goal = { x: bpos(2).x, z: bpos(2).z, stop: true, mul: clamp(3.0 / Math.max(1, p.vmax), 0.1, 1) };
    if (seated) {
      p.dug = 'bench';
      p.goal = null;
      leaveDugout(p, [], goal, 3.0);
    } else p.goal = goal;
    return;
  }
  p.x = bpos(2).x;
  p.z = bpos(2).z;
  p.vx = p.vz = 0;
  p.goal = null;
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
  if (r.contactBase && r.contactBase === r.base) return false; // a foot / hand on the bag
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
export function aiLead(req: { runner: { ratings: { speed: number; baserunning: number } }; pitcher: { ratings: { holding: number } }; base: number }): LeadDecision {
  const R = req.runner.ratings;
  // a good runner takes a bigger lead, a pitcher who holds runners well shortens it
  return { lead: clamp(3.0 + 0.035 * (R.speed - 50) + 0.015 * (R.baserunning - 50) + holdingLeadAdjust(req.pitcher.ratings), 1.8, 4.6) * (req.base === 3 ? 0.8 : 1) };
}

/** Runners standing off a base should be able to run through their lead point quickly; snap to base when a play ends. */
export function snapRunnersToBases(w: World): void {
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    if (r.protectTo > r.base) r.protectTo = contact.freeUpTo(w, r, r.protectTo);
    if (r.protectTo > r.base) {
      // obstructed: he is given the base he was running to (if nobody else has it)
      for (let b = r.base + 1; b <= r.protectTo; b++) {
        emit(w, { type: 'runnerAdvance', playerId: r.p.info.id, fromBase: b - 1, toBase: b });
        r.touched[b] = true;
      }
      r.base = r.protectTo;
      if (r.base >= 4) {
        rules.scoreRun(w, r);
        continue;
      }
    }
    if (r.base >= 1) {
      const b = bpos(r.base);
      if (w.cfg.pace > 0 && (Math.hypot(r.p.x - b.x, r.p.z - b.z) > 0.03 || Math.hypot(r.p.vx, r.p.vz) > 0.05)) {
        // not there yet, or still running through the bag (the play was called over): he brakes and walks back to it, nobody stops dead or jumps
        setGoal(r.p, b.x, b.z, true, 0.6);
      } else {
        r.p.x = b.x;
        r.p.z = b.z;
        r.p.vx = r.p.vz = 0;
        r.p.goal = null;
      }
      r.target = r.base;
      r.want = r.base;
      r.overrun = false;
      r.slideKind = null;
      r.contactBase = 0;
      r.dodged = false;
      r.tagWait = false;
      r.retouch = 0;
      r.stealing = false;
      r.dead = false;
      r.awarded = false;
      r.protectTo = 0;
      r.tagLine = null;
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
    const third = clock.disengage(w, 'pickoff'); // (one of his two per plate appearance)
    inplay.beginPickoff(w, r);
    if (third) w.play!.thirdDisengagement = true;
    w.pickoffTick = w.tick;
    return 'thrown';
  }
  return 'none';
}

/** The built-in pitcher's pickoff rule: the more of a running threat, the more often he throws over (a mixed strategy). */
export function aiPickoff(w: World, r: RunnerRT): PickoffDecision {
  const threat = clamp((r.p.info.ratings.speed - 45) / 40, 0, 1) * (r.base === 1 ? 1 : 0.2);
  const p = (r.base === 1 ? 0.012 : 0.002) + (r.base === 1 ? 0.06 : 0.01) * threat;
  // a pitcher with a good move throws over more often
  const q = p * clamp(1 + 0.012 * (w.pitcher.info.ratings.pickoff - 50), 0.6, 1.6);
  if (!clock.clockOn(w)) return { throw: w.aiRng.next() < q };
  // the disengagement limit: he saves his last one; with none left a throw that does not get the runner is a balk, so he throws only at a runner who is
  // surely going (a fast man, a long lead, the base ahead open)
  const left = clock.disengagementsLeft(w);
  if (left >= 2) return { throw: w.aiRng.next() < q };
  if (left === 1) return { throw: w.aiRng.next() < 0.5 * q };
  const lead = Math.hypot(r.p.x - bpos(r.base).x, r.p.z - bpos(r.base).z);
  const going = threat > 0.75 && lead > 3.6 && r.base === 1;
  return { throw: going && w.aiRng.next() < 0.15 };
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
  const exch = catcherExchange(catcher.info.ratings);
  // (+ 0.3: the covering man catches it, sets the glove and makes the sweep)
  const ballTime = windupSecs + 0.44 + exch + D / (armV * 0.9) + 0.3;
  return { ballTime, runnerTime };
}

/** Ask the runner (at the start of the windup) whether he goes. */
export function stageSteals(w: World): boolean {
  const r = stealCandidate(w);
  if (!r) {
    w.prep.steal = null;
    return true;
  }
  // from the stretch, with this pitcher's tempo and holding
  const nominalWindup = deliverySeconds(w.pitcher.info.delivery ?? { style: 'three_quarter', armSlotDeg: 45, tempo: 1 }, w.pitcher.info.ratings, true);
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
      // beside the bag on the catcher's side, out of the runner's lane
      const spot = fielding.coverSpot(nb, w.catcher.x, w.catcher.z);
      setGoal(cover, spot.x, spot.z, true, 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// per-tick runner movement and base touching
// ---------------------------------------------------------------------------------------------

/** How far past first base a runner who is not turning runs through the bag before he pulls up (m). */
const RUN_THROUGH = 6.5;
/** A runner rounding a base starts his arc this far before it (m) and swings this wide (m). */
const ROUND_L = 7;
const ROUND_W = 2.2;

const unit = (x: number, z: number) => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

/** Trot speed of a runner on a dead ball (m/s): a home-run jog, about 22 s around the bases. */
export const trotSpeed = (p: PlayerRT) => clamp(4.9 + 0.012 * (p.info.ratings.speed - 50), 4.3, 5.6);

export function tickRunners(w: World): void {
  for (const r of w.runners) tickRunner(w, r);
  for (const r of w.exiting) tickRunner(w, r);
  if (w.exiting.length) {
    w.exiting = w.exiting.filter((r) => {
      const d = DUGOUT[r.p.team.side];
      const done = Math.hypot(r.p.x - d.x, r.p.z - d.z) < 1.2 || w.tick - r.outTick > 12 * 240;
      if (done) {
        r.p.gait = null;
        toBench(w, r.p); // through the door, down the steps, back to his seat
      }
      return !done;
    });
  }
}

/** A runner who is out or has scored: finish the run-through, celebrate a home run, then walk to the dugout. */
function tickLeaving(w: World, r: RunnerRT): void {
  const p = r.p;
  const d = DUGOUT[p.team.side];
  p.gait = 'trot';
  if (r.state === 'scored' && w.tick < r.celebrateUntil) {
    const h = bpos(4);
    setGoal(p, h.x, h.z, true, 0.5);
    p.gait = null;
    return;
  }
  if (r.exitVia && !r.exitDone) {
    // put out at first before reaching the bag: he still runs through it
    const tp = bpos(r.exitVia);
    const prev = bpos(r.exitVia - 1);
    const dIn = unit(tp.x - prev.x, tp.z - prev.z);
    const along = (p.x - tp.x) * dIn.x + (p.z - tp.z) * dIn.z;
    const speed = Math.hypot(p.vx, p.vz);
    if ((along > 3 && speed < 3.5) || w.tick - r.outTick > 3 * 240) r.exitDone = true;
    else {
      setGoal(p, tp.x + dIn.x * RUN_THROUGH, tp.z + dIn.z * RUN_THROUGH, true, 1);
      p.gait = null;
      return;
    }
  }
  setGoal(p, d.x, d.z, true, 0.5);
}

function tickRunner(w: World, r: RunnerRT): void {
  const p = r.p;
  if (!r.slideKind) p.slideDecel = 0;
  if (r.target <= r.base) {
    // not on his way to a new base: whatever approach he made to one is over
    r.apBase = 0;
    r.nearMiss = 9;
  }
  if (r.state !== 'live') {
    tickLeaving(w, r);
    return;
  }
  p.gait = null;
  if (r.tagWait && !r.stealing) {
    // stay on the bag until the catch
    if (r.base >= 1) {
      const b = bpos(r.base);
      if (Math.hypot(p.x - b.x, p.z - b.z) > 0.3) setGoal(p, b.x, b.z, true, 0.9);
    }
    return;
  }
  if (r.contactBase) {
    const cb = bpos(r.contactBase);
    if (Math.hypot(p.x - cb.x, p.z - cb.z) > 1.7) r.contactBase = 0;
  }
  if (w.tick < r.reaction) {
    // (his decisions wait for his reaction; his feet do not: a runner already on his way still times his steps onto the bag)
    if (r.target > r.base && !r.slideKind) {
      const T = touchPoint(r.target, r.want > r.target && r.target <= 3, wayIn(r.target));
      const plan = aimStep(w, p, T.x, T.z);
      if (plan && p.goal && !p.goal.stop) setGoal(p, plan.bx, plan.bz, false, p.goal.mul);
      checkTouch(w, r);
    }
    return;
  }
  // a runner can never pass, or share a base with, the runner ahead of him
  if (r.want > r.base && !r.dead) {
    for (const q of w.runners) {
      // (the batter-runner always runs for first: the runner there is forced on by him, even before he has been told so)
      if (q !== r && q.state === 'live' && q.base > r.base && q.target === q.base && q.want <= q.base && r.want >= q.base) r.want = Math.max(r.isBatter && r.base === 0 ? 1 : r.base, q.base - 1);
    }
  }
  r.target = r.want > r.base ? r.base + 1 : r.base;
  // attempting to advance gives up the protection of a run-through
  if (r.target > r.base) r.overrun = false;
  const mul = r.dead && r.trot > 0 ? Math.min(1, r.trot / Math.max(p.vmax, 1)) : r.dead ? 0.55 : 1;
  if (r.dead) p.gait = 'trot';
  if (r.target > r.base) {
    const tp = bpos(r.target);
    const prev = bpos(r.target - 1);
    const dIn = unit(tp.x - prev.x, tp.z - prev.z);
    const continuing = r.want > r.target && r.target <= 3;
    let gx = tp.x;
    let gz = tp.z;
    let stop = true;
    let m = mul;
    if (r.target === 1 && r.want === 1 && !r.dead) {
      // run through first base
      gx = tp.x + dIn.x * RUN_THROUGH;
      gz = tp.z + dIn.z * RUN_THROUGH;
    } else if (r.target === 4 && !(r.dead && r.trot > 0)) {
      // he runs across the plate (a foot on it), not to a stop on it; a home-run trot ends at the plate with the celebration
      gx = tp.x + dIn.x * 4;
      gz = tp.z + dIn.z * 4;
      stop = false;
    } else if (continuing) {
      // round the bag: swing wide, cut in to touch it, and leave toward the next base
      stop = false;
      const nx = bpos(r.target + 1);
      const dOut = unit(nx.x - tp.x, nx.z - tp.z);
      const dist = Math.hypot(p.x - tp.x, p.z - tp.z);
      const out = unit(dIn.x - dOut.x, dIn.z - dOut.z);
      const sharp = 1 - (dIn.x * dOut.x + dIn.z * dOut.z); // 0 straight .. 1 right angle
      if (dist > ROUND_L * 0.85) {
        gx = tp.x - dIn.x * ROUND_L + out.x * ROUND_W * sharp;
        gz = tp.z - dIn.z * ROUND_L + out.z * ROUND_W * sharp;
      } else {
        // cut in across the inside of the bag, where his foot comes down
        const T = touchPoint(r.target, true, dIn);
        gx = T.x;
        gz = T.z;
        m *= 1 - 0.1 * sharp;
        if (dist < ROUND_L && Math.hypot(p.vx, p.vz) > 3) p.gait = 'turn';
      }
    }
    if (r.goBack === r.target) {
      // he ran past the bag without a foot on it, and knows it: back to it
      gx = tp.x;
      gz = tp.z;
      stop = true;
      m = Math.max(m, 0.8);
    }
    // a slide: chosen by the state of the play; a hook aims to the side of the bag, away from the glove
    const aim = tagging.updateSlide(w, r);
    if (aim) {
      gx += aim.x;
      gz += aim.z;
    }
    setGoal(p, gx, gz, stop, m);
    p.lookAt = null;
    // he times his last steps so a foot comes down on the bag, and steers his body to pass where that foot lands beside it
    if (!r.slideKind) {
      const T = touchPoint(r.target, continuing && r.goBack !== r.target, dIn);
      const plan = aimStep(w, p, T.x, T.z);
      // (running through first he brakes only well past the bag: he steers onto it all the same)
      const through = !stop || (r.target === 1 && r.want === 1 && !r.dead && r.goBack !== 1);
      if (plan && through) setGoal(p, plan.bx, plan.bz, false, m);
    }
    checkTouch(w, r);
  } else if (r.base >= 1 && !(r.want === r.base && !r.dead && !r.overrun && !r.retouch && !r.isBatter && w.phase !== 'inPlay')) {
    // returning to / staying at the base
    const b = bpos(r.base);
    const dd = Math.hypot(p.x - b.x, p.z - b.z);
    if (r.overrun) {
      // run-through: momentum carries him past the bag, then he jogs back (protected from a tag while he returns)
      const prev = bpos(r.base - 1);
      const dIn = unit(b.x - prev.x, b.z - prev.z);
      const beyond = (p.x - b.x) * dIn.x + (p.z - b.z) * dIn.z > 0.3;
      const sp = Math.hypot(p.vx, p.vz);
      if (beyond && sp > 4) setGoal(p, b.x + dIn.x * RUN_THROUGH, b.z + dIn.z * RUN_THROUGH, true, 1);
      else setGoal(p, b.x, b.z, true, 0.7);
      if (dd < 0.6 && sp < 2.5) r.overrun = false;
    } else if (dd > 0.25 && !r.dead) setGoal(p, b.x, b.z, true, 1);
    else if (dd > 0.25) setGoal(p, b.x, b.z, true, mul);
    if (r.retouch && (standsOn(p, r.base) || footOnBag(r, r.base))) r.retouchDone = true;
    // diving back to the bag with the ball coming
    tagging.updateSlide(w, r);
  }
}

/** The direction of the base path into base b (from the base before it). */
const wayIn = (b: number) => {
  const tp = bpos(b), prev = bpos(b - 1);
  return unit(tp.x - prev.x, tp.z - prev.z);
};

/** A footstrike since the last check that put a shoe on base b's bag (or the plate). */
function footOnBag(r: RunnerRT, b: number): boolean {
  const s = r.p.stride;
  for (const st of [s.prev, s.last]) {
    if (!st || st.tick <= r.strikeSeen) continue;
    if (shoeOn(b, st)) return true;
  }
  return false;
}

/**
 * Has the runner touched the bag he is heading for: a foot came down on it, he is standing on it, or his slide's leading foot / hand
 * reached it. A runner whose body has gone past the bag with no touch has missed it: if he feels it he goes back for it, otherwise he
 * carries on and the base is his, unless the defense appeals.
 */
function checkTouch(w: World, r: RunnerRT): void {
  const p = r.p;
  const b = r.target;
  const s = p.stride;
  for (const st of [s.prev, s.last]) if (st && st.tick > r.strikeSeen) r.nearMiss = Math.min(r.nearMiss, distToBase(b, st.x, st.z));
  const touched = footOnBag(r, b) || standsOn(p, b) || tagging.slideTouches(r, b);
  r.strikeSeen = Math.max(r.strikeSeen, s.last?.tick ?? 0);
  if (touched) {
    r.goBack = 0;
    if (r.slideKind) tagging.bagStops(r);
    touchBase(w, r, b);
    return;
  }
  // past it: the body was close and is now moving away from the bag
  const c = b === 4 ? { x: 0, z: 0.2 } : bpos(b);
  const d = Math.hypot(p.x - c.x, p.z - c.z);
  if (r.apBase !== b) {
    r.apBase = b;
    r.apMin = d;
  }
  r.apMin = Math.min(r.apMin, d);
  // (at a walk he simply steps back onto it: only a man going past at a run can miss a bag)
  if (r.goBack === b || r.apMin > 1.0 || d < r.apMin + 0.45 || r.slideKind || Math.hypot(p.vx, p.vz) < 2.5) return;
  // he went by it: does he know? A foot that came down well off the bag he feels; one that just missed the edge he may not
  const R = p.info.ratings;
  const pKnow = clamp((r.nearMiss - 0.03) / 0.3, 0, 1) * (0.55 + 0.45 * (R.baserunning / 100)) + 0.05;
  if (w.aiRng.next() < pKnow) {
    r.goBack = b;
    emit(w, { type: 'baseMissed', playerId: p.info.id, base: b, knows: true, by: r.nearMiss, pos: { x: p.x, y: 0, z: p.z } });
    return;
  }
  missBase(w, r, b);
}

/** He runs on past base b believing he touched it: the base is his unless the defense appeals; the fielders who saw it know. */
function missBase(w: World, r: RunnerRT, b: number): void {
  const p = r.p;
  let seen = false;
  for (const F of fielding.fielders(w)) {
    const c = b === 4 ? { x: 0, z: 0.2 } : bpos(b);
    const d = Math.hypot(F.x - c.x, F.z - c.z);
    if (d > 35) continue;
    // was he looking that way: the angle between his facing and the bag
    const look = Math.cos(Math.atan2(c.x - F.x, c.z - F.z) - F.facing);
    const pSee = clamp(1 - d / 35, 0, 1) * clamp(0.25 + look, 0, 1) * (0.45 + 0.55 * (F.info.ratings.iq / 100));
    if (w.aiRng.next() < pSee) seen = true;
  }
  w.misses.push({ r, base: b, seen, tick: w.tick, done: false, forced: forced(w, r) });
  emit(w, { type: 'baseMissed', playerId: p.info.id, base: b, knows: false, by: r.nearMiss, seen, pos: { x: p.x, y: 0, z: p.z } });
  touchBase(w, r, b, true);
}

function touchBase(w: World, r: RunnerRT, b: number, missed = false): void {
  if (r.touched[b] && r.base >= b) return;
  const from = r.base;
  r.base = b;
  r.touched[b] = !missed;
  r.contactBase = missed ? 0 : b;
  r.nearMiss = 9;
  r.apBase = 0;
  emit(w, { type: 'runnerAdvance', playerId: r.p.info.id, fromBase: from, toBase: b });
  if (!missed) {
    const st = r.p.stride.last;
    const foot = r.slideKind ? tagging.runnerBody(r) : null;
    emit(w, { type: 'baseTouch', playerId: r.p.info.id, base: b, trot: r.dead, pos: { x: r.p.x, y: 0, z: r.p.z }, ...(foot ? { touch: { x: foot.tx, y: 0, z: foot.tz }, limb: r.slideKind === 'head' || r.slideKind === 'diveBack' ? ('hand' as const) : ('foot' as const) } : st ? { touch: { x: st.x, y: 0, z: st.z }, limb: 'foot' as const } : {}) });
  }
  if (!r.dead && fielding.playNearBase(w, b)) {
    const eta = tagging.fielderETA(w, b);
    emit(w, { type: 'safe', playerId: r.p.info.id, base: b, margin: -eta, closePlay: eta < 0.1 });
    visitsNoteClose(w, r.p.info.id, b, -eta, eta < 0.1);
    scheduleCall(w, b === 4 ? 'plate' : b === 1 ? 'first' : b === 2 ? 'second' : 'third', 'safe', baseCallDelay(eta < 0.1), { atBase: b, playerId: r.p.info.id });
  }
  if (b === 1 && r.isBatter && r.want === 1) r.overrun = true;
  if (b === 4) {
    if (r.dead && r.trot > 0) {
      // a home run (or awarded bases): the run scores with a celebration at the plate
      r.celebrateUntil = w.tick + secToTicks(1.8);
      setAnim(w, r.p, 'celebrate', 1.8);
    }
    rules.scoreRun(w, r);
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
    // the base coach's call comes first (the third-base coach for a runner at or heading for third, the first-base coach for a batter-runner at first)
    if (!r.coachFresh) {
      const cd = staff.consultCoach(w, r, () => {
        const rq = buildRunnerRequest(w, r);
        const full = rq as RunnerRequest;
        return {
          est: rq.ballToBase,
          eta: rq.runnerToBase,
          ball: rq.ball,
          suggest: (bias: number) => {
            const old = r.bias;
            r.bias = bias;
            const want = aiRunner(w, r, full).want;
            r.bias = old;
            return want;
          },
        };
      });
      if (cd === PENDING) {
        pending = true;
        continue;
      }
      r.coachFresh = cd;
    }
    const d = ask(w, `run:${r.p.info.id}`, 'runner', w.battingTeam.side, () => buildRunnerRequest(w, r), { r });
    if (d === PENDING) {
      pending = true;
      continue;
    }
    r.asking = false;
    const cd = r.coachFresh;
    r.coachFresh = null;
    applyRunnerDecision(w, r, d, cd);
    r.lastSig = runnerSig(w, r);
    r.recheckTick = d.recheckSec !== undefined ? w.tick + secToTicks(d.recheckSec) : Infinity;
  }
  if (pending) play.runnerAiNext = w.tick + 1;
}

/** The rules around a runner's decision: forces, tag-up obligations and the point of no return are the sim's, not the provider's. */
function applyRunnerDecision(w: World, r: RunnerRT, d: RunnerDecision, cd: CoachDecision | null = null): void {
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
  want = clamp(staff.applyCoachCall(r, want, cd), r.base, 4); // ... unless he takes the coach's word for it
  const frc = forced(w, r);
  // a runner cannot pass the runner ahead of him
  for (const q of w.runners) if (q !== r && q.state === 'live' && q.base > r.base) want = Math.min(want, Math.max(q.base, q.want) - 1);
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
  // how much margin he wants: the more the situation rewards the risk, the less; ahead late or with nobody out, the more
  const diff = req.situation.scoreDiff;
  const late = w.inning >= 7;
  const safety =
    0.16 + 0.3 * (1 - clamp((p.info.ratings.baserunning + 30) / 100, 0, 1)) + (w.outs === 2 ? -0.1 : 0) + (late && diff <= -1 ? -0.04 : 0) + (late && diff >= 3 ? 0.08 : 0) + (bip?.bunt ? -0.14 : 0); // on a bunt the runners are going: the ball is slow and the play is at first
  const coachExtra = r.base === 2 ? 0.05 : 0; // third-base coach is conservative at the plate
  for (let b = Math.max(r.base + 1, 1); b <= 4; b++) {
    if (b > r.base + 1 && b > want + 0) {
      // extra-base attempt needs the previous base to be attainable
      if (want < b - 1) break;
    }
    const tR = req.runnerToBase[b];
    // an out at third with nobody out is the worst way to lose a runner
    const m = est[b] - tR - r.bias - safety - (b === 4 ? coachExtra : 0) - (b === 3 && w.outs === 0 ? 0.07 : 0);
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
