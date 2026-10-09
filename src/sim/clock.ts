/**
 * The pitch clock (MLB 2023-2025, Official Baseball Rules 5.07(c) and the pace-of-play regulations): an enforced, visible rule.
 *
 * - The pitcher must start his delivery before the timer runs out: 15 s with the bases empty, 18 s with a runner on (20 s in 2023, 18 s from 2024);
 *   30 s between batters. A violation is an automatic ball.
 * - The batter must be in the box and alert to the pitcher by the 8-second mark. A violation is an automatic strike (strike three is a strikeout).
 * - The pitcher may disengage (a pickoff throw, a step off the rubber, the defense's time-out) twice per plate appearance; each one resets the timer.
 *   A third that does not retire a runner is a balk. The count resets when a runner advances.
 * - The batter has one time-out per plate appearance (it resets the timer); the umpire denies a second one, and one asked for after the 8-second mark.
 * - Five mound visits per team per game (pitching changes do not count), one more from the ninth inning on; a visit resets the timer.
 * - The clock stops while the ball is in play, during a review and a visit; it starts again only when the pitcher has the ball back on the mound.
 *
 * The clock runs in rule seconds: sim seconds, or sim seconds / `pace` with `pace` > 1 (the waits stretch, so does the clock). `pace: 0` (headless) has no clock at
 * all: nothing here does anything and a pace-0 game is bit-for-bit what it was. What the people do about the clock (when the pitcher goes, how the batter
 * plans his step-out, the time-out, the pickoff with no disengagements left) is in `tempo.ts`, `running.ts` and `visits.ts`; how well each of them reads
 * the clock is a decision-side draw (`aiRng`) made when the clock starts.
 */
import { emit } from './events';
import { clamp } from './math';
import { MOUND_DIST } from './field';
import { SHOULDER_X } from './batting';
import { forget } from './dispatch';
import { scheduleCall } from './umpires';
import { clearLull } from './tempo';
import * as rules from './rules';
import * as flow from './flow';
import type { PitchClockKind, PitchClockSnapshot, TeamSide } from './types';
import type { World } from './world';
import { TICK } from './world';

/** Every constant of the rule (seconds are rule seconds; distances metres). */
export const CLOCK_RULES = {
  /** the pitch timer with the bases empty / with a runner on base */
  pitchBasesEmpty: 15,
  pitchRunnersOn: 18,
  /** between batters (the first pitch of a plate appearance, also the leadoff man after a break) */
  betweenBatters: 30,
  /** the batter must be in the box and alert by this many seconds left */
  batterAlert: 8,
  /** pickoff throws / step-offs / defensive time-outs per plate appearance (a third that gets no out is a balk) */
  disengagements: 2,
  /** the batter's time-outs per plate appearance */
  batterTimeouts: 1,
  /** mound visits per team per game (not counting pitching changes), and one more from the ninth inning on */
  moundVisits: 5,
  moundVisitsNinth: 1,
  /** the timer starts when the pitcher has the ball inside the dirt circle of the mound (18 ft across) ... */
  moundCircle: 2.74,
  /** ... the catcher is in his box ... */
  catcherBox: 1.6,
  /** ... and (between pitches) the batter is inside the dirt circle around home plate (26 ft across) */
  plateCircle: 3.96,
} as const;

export interface ClockRT {
  kind: PitchClockKind;
  /** rule seconds */
  limit: number;
  /** off: no clock (pace 0, the pregame); armed: set, waiting for the start conditions; running; paused (visit, time-out); stopped (the pitch / a play) */
  state: 'off' | 'armed' | 'running' | 'paused' | 'stopped';
  startTick: number;
  /** what the clock shows while it is not running */
  frozen: number;
  /** disengagements used in this plate appearance */
  used: number;
  timeoutUsed: boolean;
  alertChecked: boolean;
  violation: { on: 'pitcher' | 'batter'; result: 'ball' | 'strike'; time: number } | null;
  /** pitches thrown + violations in this plate appearance (the first pitch of the PA is the one with the 30 s timer, the walk-up, the practice swings) */
  paTries: number;
  /** each runner's base when the PA's disengagement count was last checked (a runner who advanced resets it) */
  bases: Record<string, number>;
  /** How far off each man's read of the clock is for this pitch (rule seconds, + = he thinks he has more time): drawn when the clock starts. */
  pBias: number;
  bBias: number;
  /** how rushed the delivery was (0..1): set when he starts the windup */
  rush: number;
}

export const newClock = (): ClockRT => ({ kind: 'pitch', limit: 15, state: 'off', startTick: 0, frozen: 15, used: 0, timeoutUsed: false, alertChecked: false, violation: null, paTries: 0, bases: {}, pBias: 0, bBias: 0, rush: 0 });

export const clockOn = (w: World) => w.cfg.pace > 0;
const liveRunners = (w: World) => w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead);
/** Sim seconds per rule second: 1, longer when `pace` > 1 slows every wait down (a quicker `pace` < 1 shortens the waits; the clips, and the clock, stay). */
export const clockScale = (w: World) => Math.max(1, w.cfg.pace);
const ruleSec = (w: World, ticks: number) => (ticks * TICK) / clockScale(w);

/** The pitch timer for the situation now: 15 s, 18 s with a runner on. */
export const pitchLimit = (w: World) => (liveRunners(w).length ? CLOCK_RULES.pitchRunnersOn : CLOCK_RULES.pitchBasesEmpty);

export function remaining(w: World): number {
  const c = w.clock;
  if (c.state !== 'running') return c.frozen;
  return c.limit - ruleSec(w, w.tick - c.startTick);
}
export const running = (w: World) => w.clock.state === 'running';
export const disengagementsLeft = (w: World) => Math.max(0, CLOCK_RULES.disengagements - w.clock.used);
export const timeoutAvailable = (w: World) => !w.clock.timeoutUsed;
export const firstOfPa = (w: World) => w.clock.paTries === 0;

/** Mound visits a team may still make. */
export function visitsLeft(w: World, side: TeamSide): number {
  const limit = CLOCK_RULES.moundVisits + (w.inning >= 9 ? CLOCK_RULES.moundVisitsNinth : 0);
  return Math.max(0, limit - w.visits[side]);
}

// ---------------------------------------------------------------------------------------------
// the plate appearance and the pitch
// ---------------------------------------------------------------------------------------------

/** A new batter: fresh disengagements and time-out. */
export function newPlateAppearance(w: World): void {
  const c = w.clock;
  c.used = 0;
  c.timeoutUsed = false;
  c.paTries = 0;
  c.bases = basesNow(w);
}

function basesNow(w: World): Record<string, number> {
  const o: Record<string, number> = {};
  for (const r of liveRunners(w)) o[r.p.info.id] = r.base;
  return o;
}

/** The ball is dead and the next pitch is being set up: the timer is set (it starts when the pitcher has the ball, see `tickClock`). */
export function armClock(w: World): void {
  if (!clockOn(w) || w.gameOver) return;
  const c = w.clock;
  // a runner who advanced during the plate appearance resets the disengagements
  const now = basesNow(w);
  if (Object.entries(now).some(([id, b]) => b > (c.bases[id] ?? 0))) c.used = 0;
  c.bases = now;
  c.kind = c.paTries === 0 ? 'betweenBatters' : 'pitch';
  c.limit = c.kind === 'betweenBatters' ? CLOCK_RULES.betweenBatters : pitchLimit(w);
  c.state = 'armed';
  c.frozen = c.limit;
  c.alertChecked = false;
}

/** The start conditions: the pitcher holds the ball on the mound, the catcher is in his box, the batter is near the plate (between pitches). */
function canStart(w: World): boolean {
  const P = w.pitcher;
  if (w.ball.holder !== P || w.ret || w.ball.lob || w.visit || w.change) return false;
  if (Math.hypot(P.x, P.z - MOUND_DIST) > CLOCK_RULES.moundCircle) return false;
  const C = w.catcher;
  if (C.home && Math.hypot(C.x - C.home.x, C.z - C.home.z) > CLOCK_RULES.catcherBox) return false;
  if (w.clock.kind === 'pitch' && w.batter && Math.hypot(w.batter.x, w.batter.z) > CLOCK_RULES.plateCircle) return false;
  return true;
}

/** The batter is in the box (still) and not stepping out / taking a practice swing. */
export function batterAlert(w: World): boolean {
  const b = w.batter;
  if (!b) return true;
  const side = w.batStance === 'R' ? 1 : -1;
  if (Math.hypot(b.x - side * SHOULDER_X, b.z - 0.15) > 0.6 || Math.hypot(b.vx, b.vz) > 0.6) return false;
  const now = w.prep.routine?.bat.now;
  return now !== 'batter_step_out' && now !== 'batter_practice_swing';
}

/**
 * Per tick of the pre-pitch phase (before anything else): start the clock when it may start, check the batter at the 8-second mark and the pitcher at
 * zero. Returns true if a violation was called (the pitch is over: the caller stops).
 */
export function tickClock(w: World): boolean {
  if (!clockOn(w)) return false;
  const c = w.clock;
  if (c.state === 'armed' && canStart(w)) {
    c.state = 'running';
    c.startTick = w.tick;
    // how well each of them reads the clock on this pitch (a rattled pitcher, a nervous hitter less well)
    const P = w.pitcher;
    const B = w.batter;
    const sp = 0.3 + 0.55 * P.rattle + 0.006 * clamp(50 - P.info.ratings.composure, -30, 50);
    c.pBias = w.aiRng.normal(0, sp);
    c.bBias = w.aiRng.normal(0, 0.5 + 0.01 * clamp(50 - (B?.info.ratings.consistency ?? 50), -30, 50));
    emit(w, { type: 'pitchClockStart', kind: c.kind, limitSec: c.limit });
  }
  if (c.state !== 'running' || c.kind === 'break' || c.kind === 'pitchingChange' || c.kind === 'timeout') return false;
  const rem = remaining(w);
  if (!c.alertChecked && rem <= CLOCK_RULES.batterAlert) {
    c.alertChecked = true;
    if (!batterAlert(w)) {
      violation(w, 'batter', rem);
      return true;
    }
  }
  if (rem <= 0) {
    violation(w, 'pitcher', rem);
    return true;
  }
  return false;
}

/** The pitcher starts his delivery: the clock stops (and says how rushed he was). */
export function stopClock(w: World): void {
  if (!clockOn(w)) return;
  const c = w.clock;
  const rem = remaining(w);
  c.rush = c.state === 'running' ? clamp((2.0 - rem) / 2.0, 0, 1) : 0;
  c.frozen = Math.max(0, rem);
  c.state = 'stopped';
  c.paTries++;
}

/** A play started (a pickoff throw, a balk): the clock stops until the ball is dead and back with the pitcher. */
export function haltClock(w: World): void {
  if (!clockOn(w) || w.clock.state === 'off') return;
  w.clock.frozen = Math.max(0, remaining(w));
  w.clock.state = 'stopped';
}

function violation(w: World, on: 'pitcher' | 'batter', rem: number): void {
  const c = w.clock;
  const result = on === 'pitcher' ? 'ball' : 'strike';
  const P = w.pitcher;
  const B = w.batter!;
  c.state = 'stopped';
  c.frozen = Math.max(0, rem);
  c.paTries++;
  c.violation = { on, result, time: w.tick * TICK };
  emit(w, { type: 'pitchClockViolation', on, result, clockSec: Math.max(0, rem), pitcherId: P.info.id, batterId: B.info.id, team: on === 'pitcher' ? w.fieldingTeam.side : w.battingTeam.side });
  // the plate umpire: time, then the ball / strike signal
  scheduleCall(w, 'plate', result === 'ball' ? 'clock_violation_ball' : 'clock_violation_strike', 0.1);
  w.umpQueue.push({ due: w.tick + Math.round(1.2 / TICK), ump: 'plate', kind: result === 'ball' ? 'clock_violation_ball' : 'clock_violation_strike', gesture: result === 'ball' ? 'ump_ball' : 'ump_strike' });
  // the questions about this pitch no longer apply
  forget(w, 'pitch');
  forget(w, 'pickoff');
  clearLull(w);
  w.lastPlay = on === 'pitcher' ? `Pitch clock violation on ${P.info.name}: automatic ball.` : `Pitch clock violation on ${B.info.name}: automatic strike.`;
  rules.applyPitchOutcome(w, result === 'ball' ? 'ball' : 'strikeLooking', { ballLive: false, droppedThird: false });
  if (w.phase === 'prePitch' && w.batter && !w.paDone) flow.resetBatterToBox(w);
}

// ---------------------------------------------------------------------------------------------
// disengagements, time-outs, visits
// ---------------------------------------------------------------------------------------------

/**
 * The pitcher disengages (a pickoff throw, a step off the rubber with a runner on, the defense calls time): one of his two; the timer resets.
 * Returns true if this was a third one (a pickoff that must retire a runner, else it is a balk).
 */
export function disengage(w: World, kind: 'pickoff' | 'stepOff' | 'time'): boolean {
  if (!clockOn(w)) return false;
  const c = w.clock;
  c.used++;
  emit(w, { type: 'disengagement', kind, pitcherId: w.pitcher.info.id, count: c.used, left: disengagementsLeft(w) });
  const third = c.used > CLOCK_RULES.disengagements;
  if (kind === 'pickoff') haltClock(w);
  else resetClock(w, 'disengagement');
  return third;
}

/** The timer starts over (it starts again when its conditions hold). */
export function resetClock(w: World, reason: 'disengagement' | 'timeout' | 'moundVisit'): void {
  if (!clockOn(w)) return;
  armClock(w);
  emit(w, { type: 'pitchClockReset', reason, limitSec: w.clock.limit });
}

/** Someone asks for time. The batter: granted once per PA and only before the 8-second mark (the clock pauses until `endTimeout`). Returns whether it was granted. */
export function requestTimeout(w: World, by: 'batter' | 'catcher' | 'pitcher'): boolean {
  if (!clockOn(w)) return true;
  const c = w.clock;
  const who = by === 'batter' ? w.batter! : by === 'catcher' ? w.catcher : w.pitcher;
  const team = by === 'batter' ? w.battingTeam.side : w.fieldingTeam.side;
  if (by === 'batter') {
    const late = c.state === 'running' && remaining(w) <= CLOCK_RULES.batterAlert;
    if (c.timeoutUsed || late) {
      emit(w, { type: 'timeDenied', by, playerId: who.info.id, reason: c.timeoutUsed ? 'timeoutUsed' : 'tooLate', team });
      return false;
    }
    c.timeoutUsed = true;
    emit(w, { type: 'timeCalled', by, playerId: who.info.id });
    scheduleCall(w, 'plate', 'time', 0.1);
    pauseClock(w);
    return true;
  }
  // the defense's time is a disengagement
  emit(w, { type: 'timeCalled', by, playerId: who.info.id });
  scheduleCall(w, 'plate', 'time', 0.1);
  disengage(w, 'time');
  return true;
}

/** The batter is back in the box after his time-out: a fresh timer. */
export function endTimeout(w: World): void {
  if (!clockOn(w) || w.clock.state !== 'paused') return;
  resetClock(w, 'timeout');
}

/** A visit / a time-out: the clock stops where it is. */
export function pauseClock(w: World): void {
  if (!clockOn(w) || w.clock.state === 'off') return;
  const c = w.clock;
  c.frozen = Math.max(0, remaining(w));
  c.state = 'paused';
  c.kind = 'timeout';
}

/** The display clock of an inning break / a pitching change (no penalty: the sim's sequences are bounded). */
export function showClock(w: World, kind: 'break' | 'pitchingChange', sec: number): void {
  if (!clockOn(w)) return;
  const c = w.clock;
  c.kind = kind;
  c.limit = Math.max(1, Math.round(sec));
  c.frozen = c.limit;
  c.state = 'running';
  c.startTick = w.tick;
}

export function clockSnapshot(w: World): PitchClockSnapshot | null {
  if (!clockOn(w) || w.gameOver || w.clock.state === 'off') return null;
  const c = w.clock;
  return {
    running: c.state === 'running',
    remainingSec: Math.max(0, remaining(w)),
    limitSec: c.limit,
    kind: c.kind,
    disengagementsLeft: disengagementsLeft(w),
    batterAlertBy: CLOCK_RULES.batterAlert,
    timeoutAvailable: timeoutAvailable(w),
    visitsLeft: { home: visitsLeft(w, 'home'), away: visitsLeft(w, 'away') },
    violation: c.violation,
  };
}
