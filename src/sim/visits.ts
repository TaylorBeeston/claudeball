/**
 * The real game's long stops: a visit to the mound (the catcher, the pitching coach, the manager, the infielders), the manager's walk out for a pitching
 * change (the hand-over of the ball, the reliever's jog in from the bullpen and his warm-up pitches, the throw down to second, the plate umpire brushing
 * off the plate), and a managerial challenge of a close play. Each is a state machine of timed steps with hints on the people, events with their timing and
 * a `lull` for the cameras / announcers; `pace: 0` skips them all. What triggers them is the state of the game (the pitcher's trouble, the count of pitches,
 * the score, runners in scoring position), decided with `aiRng`; how long people talk is show (`propRng`).
 */
import { emit } from './events';
import { BASE_POS } from './field';
import { MOUND_DIST } from './field';
import { clamp } from './math';
import { setGoal } from './movement';
import { leverage } from './flow';
import { lobBall, returnBallTo, sendHome, sendToDugout } from './handling';
import { lticks, lullScale, setLull, clearLull } from './tempo';
import { BRUSH_FACE, BRUSH_SPOT, scheduleCall } from './umpires';
import { giveBall, releaseBall, setAnim } from './util';
import { DEFAULT_SPOTS } from './setup';
import { bullpenSpot, dugDoor, dugStep, managerSpot, moundRing, moundVisitor, pitchCoachSpot, umpHuddle } from './venue';
import type { AnimHint, MoundVisitPurpose, TeamSide } from './types';
import type { PlayerRT, StaffRT, TeamRT, World } from './world';
import { TICK, secToTicks } from './world';

/** Walking speed that makes a stroll take `lullScale` of its real time but never turns it into a sprint. */
export const walkSpeed = (w: World, base: number) => Math.min(base * 2.6, base / Math.sqrt(Math.max(0.01, lullScale(w))));

const staffOf = (w: World, side: TeamSide, role: StaffRT['role']) => w.staff.find((s) => s.team === side && s.role === role)!;
const near = (a: { x: number; z: number }, b: { x: number; z: number }, r: number) => Math.hypot(a.x - b.x, a.z - b.z) < r;

function staffAnim(w: World, s: StaffRT, anim: AnimHint, sec: number): void {
  s.anim = anim;
  s.animStart = w.tick;
  s.animUntil = w.tick + secToTicks(sec);
}
/** Keep a looping hint going on a player / staff member (re-armed whenever it runs out). */
function loopP(w: World, p: PlayerRT, hint: AnimHint): void {
  if (p.anim !== hint || w.tick >= p.animUntil) setAnim(w, p, hint, 2.0);
}
function loopS(w: World, s: StaffRT, hint: AnimHint): void {
  if (s.anim !== hint || w.tick >= s.animUntil) staffAnim(w, s, hint, 2.0);
}
const walkTo = (w: World, p: PlayerRT, x: number, z: number, speed: number) => {
  setGoal(p, x, z, true, clamp(speed / Math.max(1, p.vmax), 0.08, 1));
  p.gait = 'walk';
};
const faceStaff = (s: StaffRT, x: number, z: number) => {
  s.facing = Math.atan2(x - s.x, z - s.z);
};

/** The way a man in the dugout goes to the mound / comes back: up the steps, through the door, then straight there. */
const routeOut = (side: TeamSide, to: { x: number; z: number }) => [dugStep(side), dugDoor(side), { x: to.x + (side === 'home' ? 6 : -6), z: to.z - 5 }, to];
const routeBack = (side: TeamSide, rail: { x: number; z: number }) => [dugDoor(side), dugStep(side), rail];

const teamPitches = (t: TeamRT) => [...t.players.values()].reduce((a, p) => a + p.pitchCount, 0);

// ---------------------------------------------------------------------------------------------
// mound visits
// ---------------------------------------------------------------------------------------------

export interface MoundVisit {
  by: 'catcher' | 'pitchingCoach' | 'manager' | 'infielders';
  purpose: MoundVisitPurpose;
  team: TeamRT;
  stage: 'out' | 'talk' | 'back';
  until: number;
  deadline: number;
  visitorP: PlayerRT | null;
  visitorS: StaffRT | null;
  /** The infielders who gather, and where they stand. */
  ring: { p: PlayerRT; x: number; z: number }[];
  startTick: number;
}

/** A visit to the mound, if the state of the game calls for one now (and the limits allow it). Returns true if one started. */
function maybeStartVisit(w: World): boolean {
  const t = w.fieldingTeam;
  const side = t.side;
  const P = w.pitcher;
  if (w.visits[side] >= 4 || w.change || w.review) return false;
  const pitches = teamPitches(t);
  if (pitches - w.visits.lastPitchNo[side] < 14) return false;
  const on = w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead);
  const loaded = on.length >= 3;
  const risp = on.some((r) => r.base >= 2);
  const late = w.inning >= 7;
  const close = Math.abs(w.battingTeam.runs - w.fieldingTeam.runs) <= 2;
  const fatigue = Math.max(0, (P.pitchCount - 70) / 30);
  const walked = /walk/.test(w.lastPlay) && on.length >= 2;
  const p = 0.002 + 0.08 * P.rattle * P.rattle + (loaded ? 0.012 : 0) + (risp && w.outs === 2 && late && close ? 0.01 : 0) + (w.inningRuns >= 2 ? 0.01 : 0) + (walked ? 0.012 : 0) + 0.014 * clamp(fatigue, 0, 1);
  if (w.aiRng.next() >= p) return false;
  // why, and who goes
  const purpose: MoundVisitPurpose = walked ? 'walks' : P.rattle > 0.5 ? 'rattled' : fatigue > 0.4 ? 'pitchCount' : loaded || risp ? 'scoringPosition' : late && close ? 'keyAtBat' : 'trouble';
  const x = w.aiRng.next();
  const wCatcher = 0.58;
  const wCoach = 0.2 + 0.25 * clamp(fatigue, 0, 1) + 0.1 * P.rattle;
  const wMgr = (loaded || P.rattle > 0.6 ? 0.18 : 0.06) + 0.06 * clamp(fatigue, 0, 1);
  const wInf = 0.07;
  const tot = wCatcher + wCoach + wMgr + wInf;
  let by: MoundVisit['by'] = 'catcher';
  if (x * tot > wCatcher) by = x * tot < wCatcher + wCoach ? 'pitchingCoach' : x * tot < wCatcher + wCoach + wMgr ? 'manager' : 'infielders';
  const join = by === 'infielders' ? 1 : w.aiRng.next() < 0.3 ? 0.9 : 0;
  const ring: MoundVisit['ring'] = [];
  if (join) for (const pos of ['1B', '2B', 'SS', '3B'] as const) {
    const F = t.defense.get(pos);
    if (F && F.onField && !(by === 'infielders' && pos === 'SS')) ring.push({ p: F, ...moundRing[pos] });
  }
  const v: MoundVisit = {
    by,
    purpose,
    team: t,
    stage: 'out',
    until: 0,
    deadline: w.tick + secToTicks(80),
    visitorP: by === 'catcher' ? w.catcher : by === 'infielders' ? (t.defense.get('SS') ?? w.catcher) : null,
    visitorS: by === 'pitchingCoach' ? staffOf(w, side, 'pitchcoach') : by === 'manager' ? staffOf(w, side, 'manager') : null,
    ring,
    startTick: w.tick,
  };
  w.visits[side]++;
  w.visits.lastPitchNo[side] = pitches;
  w.visit = v;
  // time is called; the umpire grants it
  scheduleCall(w, 'plate', 'time', 0.1);
  const sp = walkSpeed(w, 1.7);
  if (v.visitorP) walkTo(w, v.visitorP, moundVisitor.x, moundVisitor.z, walkSpeed(w, 2.0));
  if (v.visitorS) {
    v.visitorS.path = routeOut(side, moundVisitor);
    v.visitorS.speed = sp;
    staffAnim(w, v.visitorS, 'manager_walk', 3);
  }
  for (const r of ring) walkTo(w, r.p, r.x, r.z, walkSpeed(w, 2.0));
  const est = (v.visitorS ? 26 / 1.7 : 12 / 2.0) * 2 + 18.5 * lullScale(w);
  setLull(w, 'moundVisit', 'moundVisit', est);
  emit(w, { type: 'moundVisit', by, purpose, visitorId: v.visitorP?.info.id ?? v.visitorS!.id, team: side, start: w.tick / 240, end: w.tick / 240 + est });
  return true;
}

function visitorPos(v: MoundVisit) {
  return v.visitorP ? { x: v.visitorP.x, z: v.visitorP.z } : { x: v.visitorS!.x, z: v.visitorS!.z };
}

function tickVisit(w: World): boolean {
  const v = w.visit!;
  const P = w.pitcher;
  const side = v.team.side;
  switch (v.stage) {
    case 'out': {
      if (v.visitorS) loopS(w, v.visitorS, 'manager_walk');
      const arrived = near(visitorPos(v), moundVisitor, 0.9) && v.ring.every((r) => near(r.p, r, 1.0));
      if (arrived || w.tick > v.deadline - secToTicks(50)) {
        v.stage = 'talk';
        v.until = w.tick + lticks(w, 12 + 13 * w.propRng.next());
        for (const r of v.ring) r.p.gait = null;
        if (v.visitorP) v.visitorP.gait = null;
      }
      break;
    }
    case 'talk': {
      // they face each other and talk; the pitcher listens
      if (v.visitorP) {
        v.visitorP.lookAt = { x: P.x, z: P.z };
        loopP(w, v.visitorP, 'mound_talk');
      }
      if (v.visitorS) {
        faceStaff(v.visitorS, P.x, P.z);
        loopS(w, v.visitorS, 'mound_talk');
      }
      P.lookAt = visitorPos(v);
      loopP(w, P, 'mound_talk_listen');
      for (const r of v.ring) {
        r.p.lookAt = { x: P.x, z: P.z };
        loopP(w, r.p, 'mound_talk_listen');
      }
      if (v.by !== 'catcher') loopP(w, w.catcher, 'mound_talk_listen');
      if (w.tick < v.until) break;
      // done: the pitcher is steadier for it; everyone goes back
      P.rattle *= v.by === 'manager' ? 0.6 : 0.72;
      v.stage = 'back';
      P.lookAt = { x: w.catcher.x, z: w.catcher.z };
      if (v.visitorP) {
        const h = v.visitorP.home ?? DEFAULT_SPOTS.C;
        walkTo(w, v.visitorP, h.x, h.z, walkSpeed(w, 2.0));
        v.visitorP.lookAt = { x: 0, z: 0 };
      }
      if (v.visitorS) {
        v.visitorS.path = routeBack(side, v.by === 'manager' ? managerSpot(side) : pitchCoachSpot(side));
        v.visitorS.speed = walkSpeed(w, 1.7);
      }
      for (const r of v.ring) {
        sendHome(w, r.p, false);
        r.p.gait = null;
      }
      P.anim = 'idle';
      P.animUntil = 0;
      break;
    }
    case 'back': {
      if (v.visitorS) loopS(w, v.visitorS, 'manager_walk');
      const home = v.visitorP ? (v.visitorP.home ?? DEFAULT_SPOTS.C) : null;
      const back = v.visitorP ? near(v.visitorP, home!, 1.0) : v.visitorS!.path.length === 0;
      const ringBack = v.ring.every((r) => !r.p.home || near(r.p, r.p.home, 1.3));
      if ((back && ringBack) || w.tick > v.deadline) {
        if (v.visitorP) v.visitorP.gait = null;
        if (v.visitorS) {
          v.visitorS.anim = 'idle';
          v.visitorS.animUntil = 0;
        }
        emit(w, { type: 'moundVisitEnd', by: v.by, team: side });
        w.visit = null;
        clearLull(w);
        return true;
      }
      break;
    }
  }
  return false;
}

/**
 * Per tick of the pre-pitch phase, once the ball is back with the pitcher: a mound visit if one is called for (decided once per pitch) and until it is over.
 * Returns true when the game may go on to the next stage.
 */
export function visitStage(w: World): boolean {
  if (w.cfg.pace === 0) return true;
  if (w.visit) return tickVisit(w);
  if (w.prep.lullDone) return true;
  w.prep.lullDone = true;
  if (w.batter && maybeStartVisit(w)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// the pitching change
// ---------------------------------------------------------------------------------------------

type ChangeStage = 'wait' | 'signal' | 'walk' | 'talk' | 'handoff' | 'await' | 'warm' | 'brush';

export interface ChangeSeq {
  stage: ChangeStage;
  until: number;
  deadline: number;
  team: TeamRT;
  np: PlayerRT;
  old: PlayerRT;
  mgr: StaffRT;
  gathered: { p: PlayerRT; x: number; z: number }[];
  /** The manager holds the ball (between taking it from the old pitcher and giving it to the new one). */
  mgrBall: boolean;
  warmTotal: number;
  warmDone: number;
  wstep: 'start' | 'throw' | 'flight' | 'back' | 'down' | 'downBack' | 'end';
  wuntil: number;
  cover: PlayerRT | null;
}

/** The mound-side spot where the reliever waits for the manager, and where the old pitcher stands for the talk. */
const WAIT = { x: 1.3, z: 17.1 };

/** Start a pitching change (the manager has decided): returns false until it is all over. */
export function beginChange(w: World, t: TeamRT, np: PlayerRT): boolean {
  const ch: ChangeSeq = {
    stage: 'wait',
    until: 0,
    deadline: w.tick + secToTicks(300),
    team: t,
    np,
    old: t.pitcher,
    mgr: staffOf(w, t.side, 'manager'),
    gathered: [],
    mgrBall: false,
    warmTotal: Math.max(1, Math.round((5 + Math.floor(3.999 * w.propRng.next())) * clamp(lullScale(w), 0, 1))),
    warmDone: 0,
    wstep: 'start',
    wuntil: 0,
    cover: null,
  };
  w.change = ch;
  return false;
}

const mgrHand = (m: StaffRT) => ({ x: m.x + Math.sin(m.facing) * 0.4, y: 1.15, z: m.z + Math.cos(m.facing) * 0.4 });

export function changeTick(w: World): boolean {
  const c = w.change!;
  const side = c.team.side;
  const m = c.mgr;
  const P = c.old;
  // (the ball travels with the manager while he has it)
  if (c.mgrBall) {
    const h = mgrHand(m);
    const b = w.ball.body;
    b.x = h.x;
    b.y = h.y;
    b.z = h.z;
    b.vx = b.vy = b.vz = 0;
  }
  if (w.tick > c.deadline && c.stage !== 'warm' && c.stage !== 'brush') c.stage = 'warm'; // never wait forever
  switch (c.stage) {
    case 'wait': {
      // the return of the last ball has to be over first
      if (w.ret || w.ball.lob || w.ball.holder !== P) {
        if (w.tick < c.deadline - secToTicks(280)) return false;
      }
      c.stage = 'signal';
      staffAnim(w, m, 'manager_signal', 1.6);
      faceStaff(m, 0, 40);
      c.until = w.tick + Math.max(secToTicks(1.7), lticks(w, 2.0));
      // the reliever starts in from the bullpen as the manager signals
      const np = c.np;
      np.role = 'pitcher';
      if (np.dug !== 'bullpen') {
        // (a reliever who was not in view: he is in the bullpen, out of the picture, until now)
        const bs = bullpenSpot(side, 0);
        np.x = bs.x;
        np.z = bs.z;
        np.vx = np.vz = 0;
      }
      np.dug = 'toMound';
      np.onField = false;
      np.gait = 'trot';
      np.route = [{ x: (side === 'home' ? 1 : -1) * 22, z: 34 }, { x: WAIT.x + (side === 'home' ? 3 : -3), z: WAIT.z + 6 }, WAIT];
      np.routeMul = clamp(walkSpeed(w, 4.2) / Math.max(1, np.vmax), 0.1, 1);
      np.after = null;
      emit(w, { type: 'pitchingChangeStart', team: side, outId: P.info.id, inId: np.info.id, managerId: m.id });
      setLull(w, 'pitchingChange', 'pitchingChange', 75 * lullScale(w) + 20);
      scheduleCall(w, 'plate', 'time', 0.2);
      break;
    }
    case 'signal':
      if (w.tick < c.until) break;
      c.stage = 'walk';
      m.path = routeOut(side, WAIT);
      m.speed = walkSpeed(w, 1.9);
      break;
    case 'walk': {
      loopS(w, m, 'manager_walk');
      if (m.path.length === 0 && near(m, WAIT, 1.0)) {
        c.stage = 'talk';
        c.until = w.tick + lticks(w, 4.5 + 3.5 * w.propRng.next());
        faceStaff(m, P.x, P.z);
        if (w.propRng.next() < 0.5) {
          const t = c.team;
          for (const pos of ['1B', '2B', 'SS', '3B'] as const) {
            const F = t.defense.get(pos);
            if (F && F.onField) {
              c.gathered.push({ p: F, ...moundRing[pos] });
              walkTo(w, F, moundRing[pos].x, moundRing[pos].z, walkSpeed(w, 2.0));
            }
          }
        }
      }
      break;
    }
    case 'talk': {
      faceStaff(m, P.x, P.z);
      loopS(w, m, 'mound_talk');
      P.lookAt = { x: m.x, z: m.z };
      loopP(w, P, 'mound_talk_listen');
      for (const g of c.gathered) {
        g.p.lookAt = { x: P.x, z: P.z };
        if (near(g.p, g, 1.0)) {
          g.p.gait = null;
          loopP(w, g.p, 'mound_talk_listen');
        }
      }
      if (w.tick < c.until) break;
      c.stage = 'handoff';
      setAnim(w, P, 'pitcher_handoff', 1.6);
      staffAnim(w, m, 'pitcher_handoff', 1.6);
      c.until = w.tick + secToTicks(1.7);
      break;
    }
    case 'handoff': {
      // the ball goes from his glove to the manager's hand half way through
      if (!c.mgrBall && w.tick >= c.until - secToTicks(0.8)) {
        releaseBall(w);
        w.ball.mode = 'held';
        c.mgrBall = true;
      }
      if (w.tick < c.until) break;
      c.stage = 'await';
      // the old pitcher leaves for the dugout, the infielders go back
      sendToDugout(w, P);
      for (const g of c.gathered) {
        sendHome(w, g.p, false);
        g.p.gait = null;
      }
      faceStaff(m, WAIT.x, WAIT.z);
      break;
    }
    case 'await': {
      loopS(w, m, 'mound_talk');
      const np = c.np;
      if (!(near(np, WAIT, 1.2) || w.tick > c.deadline - secToTicks(120))) break;
      // he takes the mound: the manager gives him the ball and walks back
      np.gait = null;
      np.route = [];
      np.dug = null;
      c.mgrBall = false;
      substituteInPlace(w, c.team, np);
      m.path = routeBack(side, managerSpot(side));
      m.speed = walkSpeed(w, 1.9);
      staffAnim(w, m, 'manager_walk', 3);
      c.stage = 'warm';
      c.wstep = 'start';
      // the second baseman / shortstop covers the bag for the throw down after the last warm-up
      c.cover = c.team.defense.get('SS') ?? c.team.defense.get('2B') ?? null;
      break;
    }
    case 'warm':
      if (!warmTick(w, c)) break;
      c.stage = 'brush';
      {
        const u = w.umpires.find((q) => q.key === 'plate')!;
        u.hold = BRUSH_SPOT;
        u.face = BRUSH_FACE;
        c.until = w.tick + secToTicks(3.8);
      }
      break;
    case 'brush': {
      const u = w.umpires.find((q) => q.key === 'plate')!;
      if (!near(u, u.hold ?? u, 0.35) && w.tick < c.until - secToTicks(1.0)) break;
      if (u.anim !== 'umpire_brush_plate' || w.tick >= u.animUntil) {
        u.anim = 'umpire_brush_plate';
        u.animStart = w.tick;
        u.animUntil = w.tick + secToTicks(2.0);
      }
      if (w.tick < c.until) break;
      u.hold = null;
      u.face = null;
      if (m.path.length === 0 || w.tick > c.deadline) {
        w.change = null;
        clearLull(w);
        return true;
      }
      break;
    }
  }
  loopManagerBack(w, c);
  return false;
}

function loopManagerBack(w: World, c: ChangeSeq): void {
  if (c.stage === 'warm' || c.stage === 'brush') {
    if (c.mgr.path.length) loopS(w, c.mgr, 'manager_walk');
    else if (c.mgr.anim === 'manager_walk') {
      c.mgr.anim = 'idle';
      c.mgr.animUntil = 0;
    }
  }
}

/** The change is made: he is the pitcher now (the new man is already on the mound, the old one is on his way off). */
function substituteInPlace(w: World, t: TeamRT, np: PlayerRT): void {
  const old = t.pitcher;
  np.inGame = true;
  np.used = true;
  np.fieldPos = 'P';
  old.inGame = false;
  old.hasBall = false;
  t.defense.set('P', np);
  t.pitcher = np;
  const slot = t.lineup.find((s) => s.player === old);
  if (slot) slot.player = np;
  t.bullpen = t.bullpen.filter((b) => b !== np);
  const spot = DEFAULT_SPOTS.P;
  np.onField = true;
  np.role = 'pitcher';
  np.home = { x: spot.x, z: spot.z };
  np.lookAt = { x: 0, z: 0 };
  np.goal = { x: spot.x, z: spot.z, stop: true, mul: 0.4 };
  if (t === w.fieldingTeam) {
    w.pitcher = np;
    giveBall(w, np);
  }
  emit(w, { type: 'pitchingChange', team: t.side, inId: np.info.id, outId: old.info.id });
  emit(w, { type: 'substitution', team: t.side, inId: np.info.id, outId: old.info.id, reason: 'pitching change' });
}

/**
 * The reliever's warm-up pitches to the catcher (5-8 at `broadcast`), each one thrown, caught (`catch_pitch`) and returned; the last is followed by the
 * catcher's throw down to second. Returns true when it is over.
 */
export interface WarmCtx {
  np: PlayerRT;
  cover: PlayerRT | null;
  warmTotal: number;
  warmDone: number;
  wstep: 'start' | 'throw' | 'flight' | 'back' | 'down' | 'downBack' | 'end';
  wuntil: number;
  deadline: number;
}

export function warmTick(w: World, c: WarmCtx): boolean {
  const np = c.np;
  const C = w.catcher;
  const b = w.ball;
  switch (c.wstep) {
    case 'start':
      // everybody gets in place (the new man on the rubber, the catcher in his crouch), then the first one
      if (!(near(np, DEFAULT_SPOTS.P, 0.5) && near(C, DEFAULT_SPOTS.C, 1.0)) && w.tick < c.deadline - secToTicks(60)) {
        if (b.holder === np) np.lookAt = { x: C.x, z: C.z };
        break;
      }
      if (c.cover) walkTo(w, c.cover, BASE_POS[2].x - 0.3, BASE_POS[2].z + 0.5, walkSpeed(w, 3));
      c.wstep = 'throw';
      c.wuntil = 0;
      break;
    case 'throw':
      if (b.holder !== np) break;
      if (c.wuntil === 0) {
        setAnim(w, np, 'warmup_pitch', 1.3);
        c.wuntil = w.tick + secToTicks(0.75);
      }
      if (w.tick < c.wuntil) break;
      lobBall(w, np, C, 0.62, 0.35, 'pitch');
      c.wstep = 'flight';
      break;
    case 'flight':
      if (b.lob || b.holder !== C) break;
      c.warmDone++;
      if (c.warmDone >= c.warmTotal) {
        if (c.warmTotal >= 2 && c.cover) {
          // the last one: the catcher throws it down to second
          c.wstep = 'down';
          c.wuntil = w.tick + secToTicks(0.9);
          setAnim(w, C, 'throw', 0.8);
        } else {
          returnBallTo(w, C, np);
          c.wstep = 'end';
        }
      } else {
        returnBallTo(w, C, np);
        c.wstep = 'back';
      }
      break;
    case 'back':
      if (w.ret || b.lob || b.holder !== np) break;
      c.wstep = 'throw';
      c.wuntil = 0;
      break;
    case 'down':
      if (w.tick < c.wuntil) break;
      if (!c.cover || !near(c.cover, { x: BASE_POS[2].x - 0.3, z: BASE_POS[2].z + 0.5 }, 1.5) && w.tick < c.deadline - secToTicks(60)) break;
      lobBall(w, C, c.cover!, 38 / 33 + 0.1, 1.2, 'throw');
      c.wstep = 'downBack';
      break;
    case 'downBack':
      if (b.lob || b.holder !== c.cover) break;
      returnBallTo(w, c.cover!, np);
      sendHome(w, c.cover!, false);
      c.cover!.gait = null;
      c.wstep = 'end';
      break;
    case 'end':
      if (w.ret || b.lob || b.holder !== np) break;
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// the challenge
// ---------------------------------------------------------------------------------------------

export interface Review {
  stage: 'signal' | 'huddle';
  until: number;
  team: TeamSide;
  mgr: StaffRT;
  call: 'out' | 'safe';
  runnerId: string;
  base: number;
  margin: number;
}

/** Remember a close call at a base (an `out` or a `safe` with a small margin) so a manager can challenge it once the play is over. */
export function noteClose(w: World, call: 'out' | 'safe', runnerId: string, base: number, margin: number): void {
  if (w.cfg.pace === 0 || base < 1 || Math.abs(margin) >= 0.1) return;
  w.lastClose = { tick: w.tick, call, runnerId, base, margin, used: false };
}

/**
 * After a play: a manager may challenge a close call that went against him (twice per team per game at most, more likely the closer it was and the more it
 * matters); the umpires huddle, the review takes a minute or so (`lull` kind `review`) and the call is confirmed or overturned from the play's own margin:
 * an `out` whose runner would have beaten the tag, a `safe` that the ball beat. (The sim's calls come from the physics, so they stand: the check exists but
 * cannot fail until the umpires get something wrong.) Returns true when nothing is going on.
 */
export function reviewStage(w: World): boolean {
  if (w.cfg.pace === 0) return true;
  const r = w.review;
  if (r) return tickReview(w, r);
  const lc = w.lastClose;
  if (!lc || lc.used) return true;
  lc.used = true;
  if (w.tick - lc.tick > 240 * 40 || w.gameOver) return true;
  const runner = [...w.runners, ...w.exiting].find((q) => q.p.info.id === lc.runnerId);
  if (!runner) return true;
  // the call went against the team that bats (an out) / the team in the field (a safe)
  const side: TeamSide = lc.call === 'out' ? w.battingTeam.side : w.fieldingTeam.side;
  if (w.challenges[side] >= 2) return true;
  const closeness = 1 - Math.abs(lc.margin) / 0.1;
  const lev = leverage(w);
  const p = 0.35 * closeness * (0.5 + 0.5 * lev);
  if (w.aiRng.next() >= p) return true;
  w.challenges[side]++;
  const mgr = staffOf(w, side, 'manager');
  const nr: Review = { stage: 'signal', until: w.tick + secToTicks(2.2), team: side, mgr, call: lc.call, runnerId: lc.runnerId, base: lc.base, margin: lc.margin };
  w.review = nr;
  staffAnim(w, mgr, 'manager_signal', 2.0);
  emit(w, { type: 'challenge', team: side, managerId: mgr.id, base: lc.base, runnerId: lc.runnerId, call: lc.call, margin: lc.margin });
  setLull(w, 'review', 'review', (45 + 70 * 0.5) * lullScale(w) + 3);
  return false;
}

function tickReview(w: World, r: Review): boolean {
  switch (r.stage) {
    case 'signal':
      if (w.tick < r.until) break;
      r.stage = 'huddle';
      r.until = w.tick + lticks(w, 45 + 70 * w.propRng.next());
      w.umpires.forEach((u, k) => {
        u.hold = umpHuddle(k);
      });
      break;
    case 'huddle': {
      for (const u of w.umpires) {
        if (near(u, u.hold ?? u, 0.7) && (u.anim !== 'ump_huddle' || w.tick >= u.animUntil)) {
          u.anim = 'ump_huddle';
          u.animStart = w.tick;
          u.animUntil = w.tick + secToTicks(3);
        }
      }
      if (w.tick < r.until) break;
      // the verdict, from what the play's own margin says
      const wrong = (r.call === 'out' && r.margin < 0) || (r.call === 'safe' && r.margin > 0);
      emit(w, { type: 'challengeResult', team: r.team, overturned: wrong, runnerId: r.runnerId, margin: r.margin });
      const final: 'out' | 'safe' = wrong ? (r.call === 'out' ? 'safe' : 'out') : r.call;
      scheduleCall(w, 'plate', final === 'out' ? 'out' : 'safe', 0.2, { atBase: r.base, playerId: r.runnerId });
      for (const u of w.umpires) u.hold = null;
      w.review = null;
      clearLull(w);
      return true;
    }
  }
  void TICK;
  void MOUND_DIST;
  return false;
}
