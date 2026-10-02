/**
 * Tempo: the real game's non-pitch time. Between two pitches the batter digs in, takes practice swings and steps out of the box; the catcher flashes signs, the
 * pitcher looks in, may shake him off, rubs up the ball, steps off the rubber, checks the runner. All of it is real, timed state (hints on the people, events with
 * their timing) that the pitch waits for; `GameConfig.tempo` says how much of it there is (`quick` ~ a quarter, `standard` ~ 60 %, `broadcast` all), and `pace: 0`
 * (headless) skips it entirely.
 *
 * What is decided (whether he steps out, calls time, shakes off, which pitch he throws instead) goes through `aiRng` / the pitch decision; what is only show
 * (how long he fiddles with the rosin bag, how many practice swings) is drawn from `propRng`, which nothing in the physics or the decisions reads.
 */
import { emit } from './events';
import { clamp } from './math';
import { askPitch } from './flow';
import { MOUND_DIST } from './field';
import { PENDING } from './decisions';
import { setGoal } from './movement';
import { scheduleCall } from './umpires';
import { setAnim } from './util';
import type { AnimHint, LullKind, PitchType } from './types';
import type { PlayerRT, World } from './world';
import { secToTicks } from './world';

/** Share of the real game's non-pitch time modelled at each tempo: the waiting parts of rituals (`ritual`) and the long lulls — visits, changes, breaks (`lull`). */
export const TEMPO_RITUAL = { quick: 0.1, standard: 0.6, broadcast: 1 } as const;
export const TEMPO_LULL = { quick: 0.25, standard: 0.6, broadcast: 1 } as const;

export const ritualScale = (w: World) => (w.cfg.pace === 0 ? 0 : TEMPO_RITUAL[w.cfg.tempo] * w.cfg.pace);
export const lullScale = (w: World) => (w.cfg.pace === 0 ? 0 : TEMPO_LULL[w.cfg.tempo] * w.cfg.pace);
/** Probability that an optional bit of ritual (a step-out, the rosin bag, the signs at `quick`) is shown: all of them from `standard` up. */
export const showP = (w: World) => (w.cfg.pace === 0 ? 0 : clamp(TEMPO_RITUAL[w.cfg.tempo] / 0.6, 0.25, 1));
export const rticks = (w: World, sec: number) => Math.max(1, secToTicks(sec * ritualScale(w)));
export const lticks = (w: World, sec: number) => Math.max(1, secToTicks(sec * lullScale(w)));

// ---------------------------------------------------------------------------------------------
// lulls
// ---------------------------------------------------------------------------------------------

export function setLull(w: World, kind: LullKind, detail: string, sec: number): void {
  w.lull = { kind, detail, start: w.tick, sec };
}
export function clearLull(w: World): void {
  w.lull = null;
}

/** The batter's tic (a deterministic routine style per player, from his appearance seed): what he does with his hands in the box. */
export type Tic = 'tap_plate' | 'adjust_helmet' | 'rock_bat' | 'stretch';
export const TICS: Tic[] = ['tap_plate', 'adjust_helmet', 'rock_bat', 'stretch'];
export const ticOf = (p: PlayerRT): Tic => TICS[Math.abs(Math.floor(p.info.appearance.seed)) % TICS.length];
/** How many practice swings / taps he does (1-2, again by his seed). */
export const ticCount = (p: PlayerRT) => 1 + (Math.floor(p.info.appearance.seed / 4) % 2);

// ---------------------------------------------------------------------------------------------
// the routine of one pitch
// ---------------------------------------------------------------------------------------------

type Stage = 'ritual' | 'infield' | 'signs' | 'shake' | 'nod' | 'look' | 'settle' | 'done';

interface Item {
  p: PlayerRT;
  hint: AnimHint;
  /** Clip length (s): a clip is never cut short by the tempo. */
  clip: number;
  /** Total time this item occupies (s, already scaled): >= clip. */
  sec: number;
  goal?: { x: number; z: number; mul: number } | null;
  look?: { x: number; z: number } | null;
}
interface Lane {
  items: Item[];
  until: number;
  /** What the person on this lane is doing now (the snapshot's `phaseDetail`). */
  now: string | null;
}

export interface Routine {
  stage: Stage;
  until: number;
  bat: Lane;
  pit: Lane;
  /** Pitch types he shook off so far (the second decision excludes them). */
  shook: PitchType[];
  /** The pitch decision waiting for the answer after a shake-off. */
  asking: boolean;
  firstOfPa: boolean;
  /** Tick by which the whole routine is finished anyway (nobody waits forever). */
  deadline: number;
  settleBy: number;
  planned: number;
  /** The signs were shown for this pitch (a pitcher can only shake off a sign that was given). */
  signed: boolean;
}

const lane = (): Lane => ({ items: [], until: 0, now: null });

function push(l: Lane, it: Item): void {
  l.items.push(it);
}

/** An item that lasts `sec` (broadcast seconds, scaled by the ritual scale) but never less than its clip. */
function item(w: World, p: PlayerRT, hint: AnimHint, clip: number, wait: number, extra: Partial<Item> = {}): Item {
  return { p, hint, clip, sec: Math.max(clip, wait * ritualScale(w)), ...extra };
}

const boxXY = (w: World) => ({ x: (w.batStance === 'R' ? 1 : -1) * 0.72, z: 0.15 });

function runLane(w: World, l: Lane): void {
  if (w.tick < l.until) return;
  const it = l.items.shift();
  if (!it) {
    l.now = null;
    return;
  }
  setAnim(w, it.p, it.hint, it.clip);
  l.until = w.tick + secToTicks(it.sec);
  l.now = it.hint;
  if (it.goal !== undefined) {
    if (it.goal) setGoal(it.p, it.goal.x, it.goal.z, true, it.goal.mul);
    else it.p.goal = null;
  }
  if (it.look) it.p.lookAt = it.look;
}

const laneBusy = (w: World, l: Lane) => l.items.length > 0 || w.tick < l.until;

/** Seconds a lane still needs (for the lull estimate). */
const laneSecs = (l: Lane) => l.items.reduce((a, i) => a + i.sec, 0);

/** Did the last pitch go foul / was the last thing a pickoff / hard-hit foul: the batter and pitcher reset more after those. */
function afterFoul(w: World): boolean {
  const c = w.lastCall;
  return !!c && c.kind === 'foul' && w.tick / 240 - c.time < 25;
}

/**
 * Start the routine for this pitch: decide who does what (the batter's step-out and the time he calls, the pitcher's step-off), and lay out the two lanes.
 */
function startRoutine(w: World): Routine {
  const B = w.batter!;
  const P = w.pitcher;
  const C = w.catcher;
  const runnersOn = w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead);
  const first = w.paPitches === 0;
  const foul = afterFoul(w);
  const show = showP(w);
  const R: Routine = { stage: 'ritual', until: 0, bat: lane(), pit: lane(), shook: [], asking: false, firstOfPa: first, deadline: w.tick + secToTicks(70), settleBy: 0, planned: 0, signed: false };
  const box = boxXY(w);
  const side = w.batStance === 'R' ? 1 : -1;
  const out = { x: side * 1.95, z: 0.15, mul: clamp(1.9 / Math.max(1, B.vmax), 0.1, 1) };
  const inn = { x: box.x, z: box.z, mul: clamp(1.7 / Math.max(1, B.vmax), 0.1, 1) };
  const cons = B.info.ratings.consistency;
  const tic = ticOf(B);

  // --- the batter: the first pitch of his turn (practice swings on the way in, dig in), or between pitches (sometimes out of the box)
  if (first) {
    const swings = Math.max(1, Math.round(ticCount(B) * (0.5 + 0.5 * show)));
    if (w.propRng.next() < 0.4 + 0.6 * show) {
      for (let i = 0; i < swings; i++) {
        push(R.bat, item(w, B, 'batter_practice_swing', 1.2, 1.5, { goal: null, look: { x: 0, z: MOUND_DIST } }));
      }
    }
    if (tic === 'adjust_helmet' || tic === 'stretch' || w.propRng.next() < 0.5) push(R.bat, item(w, B, 'batter_adjust', 1.5, 1.8));
    push(R.bat, item(w, B, 'batter_step_in', 1.1, 1.3, { goal: inn }));
  } else {
    // he steps out: after a foul, a close pitch, at two strikes, deep in the count; a steady hitter (consistency) less
    const p = clamp(0.1 + (foul ? 0.18 : 0) + (w.count.strikes === 2 ? 0.1 : 0) + (w.paPitches >= 5 ? 0.08 : 0) + 0.18 * (1 - cons / 100) + (w.count.balls === 3 ? 0.05 : 0), 0.05, 0.6);
    if (w.aiRng.next() < p * show) {
      const wait = 1.8 + 3.2 * w.propRng.next(); // 3-8 s in all with the step out and back in
      push(R.bat, item(w, B, 'batter_step_out', 1.0, 1.0, { goal: out }));
      push(R.bat, item(w, B, 'batter_adjust', 1.8, wait));
      push(R.bat, item(w, B, 'batter_step_in', 1.1, 1.3, { goal: inn }));
    } else if (w.propRng.next() < 0.35 * show) {
      push(R.bat, item(w, B, 'batter_adjust', 1.5, 1.8));
    }
  }

  // --- time called (a batter who is not ready, a catcher with his gear): the umpire grants it
  const tp = (0.012 + (foul ? 0.01 : 0) + (w.count.strikes === 2 ? 0.008 : 0)) * show;
  if (!first && w.aiRng.next() < tp) {
    const by: 'batter' | 'catcher' | 'pitcher' = w.aiRng.next() < 0.7 ? 'batter' : w.aiRng.next() < 0.6 ? 'catcher' : 'pitcher';
    const who = by === 'batter' ? B : by === 'catcher' ? C : P;
    emit(w, { type: 'timeCalled', by, playerId: who.info.id });
    scheduleCall(w, 'plate', 'time', 0.1);
    if (by === 'batter' && R.bat.items.length === 0) {
      push(R.bat, item(w, B, 'batter_step_out', 1.0, 1.0, { goal: out }));
      push(R.bat, item(w, B, 'batter_adjust', 1.8, 3.5));
      push(R.bat, item(w, B, 'batter_step_in', 1.1, 1.3, { goal: inn }));
    } else if (by !== 'batter') {
      push(R.pit, item(w, P, 'pitcher_adjust', 1.4, 3.5));
    }
  }

  // --- the pitcher: gets the ball back, works his routine: the rosin bag, the cap, a step off the rubber
  const tempo = clamp(P.info.delivery?.tempo ?? 1, 0.75, 1.25);
  const wait = (4.2 + 3.6 * w.propRng.next()) / Math.pow(tempo, 1.4);
  const rattled = 1 + 0.2 * P.rattle;
  const base = wait * rattled * (foul ? 1.1 : 1) * (runnersOn ? 1.15 : 1);
  const r1 = w.propRng.next();
  if (r1 < 0.4 * show) push(R.pit, item(w, P, 'pitcher_rosin', 2.0, 2.2));
  else if (r1 < 0.75 * show) push(R.pit, item(w, P, 'pitcher_adjust', 1.4, 1.6));
  const stepOffP = clamp((R.pit.items.length ? 0.1 : 0.14) + (w.tick - w.pickoffTick < 240 * 30 ? 0.6 : 0) + (foul ? 0.2 : 0) + (runnersOn ? 0.08 : 0), 0, 0.9);
  if (w.aiRng.next() < stepOffP * show) {
    const home = { x: 0, z: MOUND_DIST };
    push(R.pit, item(w, P, 'pitcher_step_off', 1.8, 2.0, { goal: { x: 0.2, z: MOUND_DIST - 0.9, mul: 0.25 } }));
    push(R.pit, item(w, P, 'pitcher_adjust', 1.2, 1.6, { goal: { x: home.x, z: home.z, mul: 0.25 } }));
  }
  const used = laneSecs(R.pit);
  // whatever of his routine time the rituals did not fill is simply him looking in at the catcher
  R.pit.items.push({ p: P, hint: 'idle', clip: 0.2, sec: Math.max(0.2, base * ritualScale(w) - used), goal: null, look: { x: C.x, z: C.z } });
  R.planned = Math.max(laneSecs(R.bat), laneSecs(R.pit));
  return R;
}

/** The sign sequence for a pitch: an indicator and the pitch's own code (a runner on second: decoys around them, the sequence the catcher changes). */
export function signSequence(pitchNo: number, type: PitchType, complex: boolean, seed: number): number[] {
  const code: Record<PitchType, number> = { FF: 1, FT: 2, SI: 2, FC: 3, SL: 3, SW: 3, CU: 4, CH: 5, FS: 5 };
  const c = code[type];
  if (!complex) return [c];
  const ind = 1 + ((pitchNo * 7 + seed) % 4);
  return [ind, 1 + ((pitchNo * 3 + seed + 2) % 5), c, 1 + ((pitchNo + seed) % 3)];
}

function giveSigns(w: World, R: Routine, reshown: boolean): void {
  const C = w.catcher;
  const P = w.pitcher;
  const type = w.prep.pitch!.pitchType;
  const onSecond = w.runners.some((r) => r.state === 'live' && r.base === 2 && !r.dead);
  const complex = onSecond;
  const sec = (reshown ? 0.9 : 1.2 + 1.2 * w.propRng.next()) + (complex ? 1.0 : 0);
  const clip = Math.min(sec, 2.6);
  setAnim(w, C, 'catcher_signs', clip);
  P.lookAt = { x: C.x, z: C.z };
  R.until = w.tick + secToTicks(sec);
  R.signed = true;
  emit(w, { type: 'signsGiven', catcherId: C.info.id, pitcherId: P.info.id, pitchType: type, complex, seq: signSequence(P.pitchCount, type, complex, C.info.appearance.seed), ...(reshown ? { reshown: true } : {}) });
}

/** The chance he shakes off the sign: shakier when he is rattled, when his composure is low, when the call is not one of his better pitches. */
function shakeP(w: World, R: Routine): number {
  const P = w.pitcher;
  const usage = (t: PitchType) => P.info.arsenal.find((a) => a.type === t)?.usage ?? 0;
  const top = Math.max(...P.info.arsenal.map((a) => a.usage));
  const mismatch = usage(w.prep.pitch!.pitchType) < 0.5 * top ? 0.05 : 0;
  const p = 0.03 + 0.12 * P.rattle + 0.0008 * (50 - P.info.ratings.composure) + mismatch;
  return clamp(p, 0.01, 0.2) * (R.shook.length ? 0.3 : 1);
}

/**
 * Per tick of the pre-pitch phase once the pitch is chosen: runs the routine; returns true when everybody is ready for the windup. `pace: 0` skips it.
 */
export function routineStage(w: World): boolean {
  if (w.cfg.pace === 0 || !w.batter) return true;
  let R = w.prep.routine;
  if (!R) {
    R = startRoutine(w);
    w.prep.routine = R;
    const first = R.firstOfPa;
    const est = Math.max(laneSecs(R.bat), laneSecs(R.pit)) + 2.4 * Math.min(1, showP(w)) + 0.8;
    setLull(w, first ? 'walkup' : 'betweenPitches', first ? 'batterRoutine' : 'pitcherRoutine', est);
  }
  const P = w.pitcher;
  const C = w.catcher;
  // the lanes run alongside whichever stage is on
  runLane(w, R.bat);
  runLane(w, R.pit);
  if (w.tick > R.deadline) R.stage = 'done'; // (never wait forever)
  switch (R.stage) {
    case 'ritual': {
      if (laneBusy(w, R.bat) || laneBusy(w, R.pit)) break;
      // the catcher sometimes stands and signals the infield with a runner on and less than two out
      const runnersOn = w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead);
      R.stage = 'infield';
      if (runnersOn && w.outs < 2 && w.aiRng.next() < 0.22 * showP(w)) {
        setAnim(w, C, 'catcher_signal_infield', 1.5);
        R.until = w.tick + rticks(w, 1.8);
      } else R.until = w.tick;
      break;
    }
    case 'infield':
      if (w.tick < R.until) break;
      R.stage = 'signs';
      if (showP(w) >= 0.5 || w.aiRng.next() < showP(w)) giveSigns(w, R, false);
      else R.until = w.tick;
      break;
    case 'signs': {
      if (w.tick < R.until) break;
      if (R.asking) break;
      // does he shake it off? (a decision of his: the choice is made before the signs and again after a shake-off)
      if (R.signed && w.aiRng.next() < shakeP(w, R)) {
        const rejected = w.prep.pitch!.pitchType;
        R.shook.push(rejected);
        setAnim(w, P, 'pitcher_shake_off', 1.3);
        R.until = w.tick + secToTicks(1.4);
        R.stage = 'shake';
        emit(w, { type: 'shakeOff', pitcherId: P.info.id, catcherId: C.info.id, rejected });
        break;
      }
      R.stage = 'nod';
      if (R.signed) {
        setAnim(w, P, 'pitcher_nod', 0.6);
        R.until = w.tick + secToTicks(0.7);
      } else R.until = w.tick;
      break;
    }
    case 'shake': {
      if (w.tick < R.until) break;
      const d = askPitch(w, `pitch:shake${R.shook.length}:${w.paPitches}:${P.pitchCount}`, [...R.shook]);
      if (d === PENDING) break;
      w.prep.pitch = d;
      R.stage = 'signs';
      giveSigns(w, R, true);
      break;
    }
    case 'nod': {
      if (w.tick < R.until) break;
      const runners = w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead);
      R.stage = 'look';
      if (runners.length && w.aiRng.next() < 0.8 * showP(w)) {
        const r = runners[0];
        setAnim(w, P, 'pitcher_look_runner', 1.3);
        P.lookAt = { x: r.p.x, z: r.p.z };
        R.until = w.tick + rticks(w, 1.5);
      } else R.until = w.tick;
      break;
    }
    case 'look':
      if (w.tick < R.until) break;
      P.lookAt = { x: C.x, z: C.z };
      R.stage = 'settle';
      R.settleBy = w.tick + secToTicks(6);
      break;
    case 'settle': {
      // everybody is back where the pitch needs him (bounded)
      const b = w.batter;
      const bx = boxXY(w);
      const inBox = Math.hypot(b.x - bx.x, b.z - bx.z) < 0.35 && Math.hypot(b.vx, b.vz) < 0.4;
      const onRubber = Math.hypot(P.x, P.z - MOUND_DIST) < 0.45 && Math.hypot(P.vx, P.vz) < 0.4;
      if ((inBox && onRubber) || w.tick > R.settleBy) R.stage = 'done';
      break;
    }
    case 'done':
      break;
  }
  if (R.stage === 'done') {
    clearLull(w);
    return true;
  }
  return false;
}

/** What the game is showing in the pre-pitch phase (the snapshot's `phaseDetail`). */
export function routineDetail(w: World): string | null {
  const R = w.prep.routine;
  if (!R || w.phase !== 'prePitch') return null;
  switch (R.stage) {
    case 'signs':
      return 'signs';
    case 'shake':
      return 'shakeOff';
    case 'ritual':
      return R.bat.now && R.bat.now.startsWith('batter') ? 'batterRoutine' : 'pitcherRoutine';
    default:
      return null;
  }
}
