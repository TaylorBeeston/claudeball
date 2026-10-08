/**
 * Broadcast B-roll planner. During the sim's non-pitch time ("lulls": batter walk-ups, between pitches, mound visits, pitching changes, the
 * break between half-innings, a review) a real broadcast does not stay on the pitch camera: it shows the batter walking up, his face, the
 * on-deck circle, the dugout, the catcher's signs, a runner's lead, the coaches, the bullpen, the crowd, the scoreboard, the sky and so on.
 *
 * This module is pure (no rendering, no clock of its own): `availableKinds` says which shots the current state can support, `planNext` picks
 * the next one with the variety rules (no repeats inside a window, 2.5-6 s holds, never longer than the lull has left, skipped when the lull
 * is too short), and `computeRig` turns a planned shot into camera numbers for the director to fly.
 */
import { MathUtils, Vector3 } from 'three';
import type { GameState, LullKind, PlayerSnap } from './types';

export type BrollKind =
  | 'walkup' | 'batterFace' | 'onDeck' | 'dugout' | 'dugoutReaction' | 'pitcherFace' | 'catcherSigns' | 'shakeOff' | 'leadOff'
  | 'coachSigns' | 'bullpen' | 'crowd' | 'scoreboard' | 'aerial' | 'sky' | 'moundWide' | 'moundHuddle' | 'managerWalk' | 'bullpenDoor'
  | 'relieverJog' | 'relieverFace' | 'umpires' | 'infieldDrill' | 'outfieldCatch';

/** the label the HUD / audio see for a B-roll shot, and whether the shot is about a person who gets a name card */
export function shotLabel(shot: BrollShot): { kind: import('./types').ShotLabel; card: boolean } {
  switch (shot.kind) {
    case 'batterFace': case 'pitcherFace': return { kind: 'faceCloseup', card: true };
    case 'walkup': case 'onDeck': case 'shakeOff': case 'leadOff': case 'relieverJog': case 'relieverFace': case 'catcherSigns':
      return { kind: shot.kind === 'onDeck' ? 'ondeck' : shot.kind, card: shot.kind !== 'catcherSigns' };
    default: return { kind: shot.kind as import('./types').ShotLabel, card: false };
  }
}

export type Transition = 'cut' | 'dissolve';

export interface BrollShot {
  kind: BrollKind;
  /** the player the shot is about, when it is about one */
  subject?: string;
  /** which of several framings / crowd shots / sides (0..n) */
  variant: number;
  /** seconds on screen */
  hold: number;
  /** how it comes in: a cut, or a short dissolve from the previous picture */
  transition: Transition;
  /** the team the shot is about (0 away, 1 home) for dugout shots */
  team?: number;
}

export interface Landmarks {
  crowdShots: { pos: Vector3; target: Vector3 }[];
  /** [3B side (+X), 1B side (−X)] */
  dugoutShots: { pos: Vector3; target: Vector3 }[];
  scoreboard?: Vector3 | null;
  /** bullpens: [away (−X), home (+X)] */
  bullpens: [Vector3, Vector3];
}

export const DEFAULT_BULLPENS: [Vector3, Vector3] = [new Vector3(-49.5, 0, 38.2), new Vector3(49.5, 0, 38.2)];
const MOUND = new Vector3(0, 0, 18.44);
const CF_CAM = new Vector3(-2.6, 10.5, 121);

/** [min, max] seconds on screen per kind */
const HOLD: Record<BrollKind, [number, number]> = {
  walkup: [3, 4.5], batterFace: [2.8, 4], onDeck: [3, 4.5], dugout: [3, 5], dugoutReaction: [3, 4.5], pitcherFace: [2.6, 3.8], catcherSigns: [2.6, 3.6],
  shakeOff: [2.6, 3.6], leadOff: [2.6, 3.8], coachSigns: [2.8, 4], bullpen: [3, 5], crowd: [3, 5], scoreboard: [3, 4.5], aerial: [4, 6], sky: [3.5, 5.5],
  moundWide: [2.6, 3.6], moundHuddle: [3, 5], infieldDrill: [3, 4.5], outfieldCatch: [3, 4.5], managerWalk: [3, 4.5], bullpenDoor: [3, 4.5], relieverJog: [3, 4.5], relieverFace: [2.6, 3.6], umpires: [3, 4.5],
};

/** shots that are scenery rather than the game: they melt in instead of cutting */
const DISSOLVE = new Set<BrollKind>(['crowd', 'scoreboard', 'aerial', 'sky', 'bullpenDoor']);

/** weight of each kind per lull; a kind missing from a lull is never picked in it */
const WEIGHTS: Record<LullKind, Partial<Record<BrollKind, number>>> = {
  walkup: { walkup: 4, batterFace: 3, onDeck: 2, dugout: 2, pitcherFace: 1.5, coachSigns: 1, leadOff: 1, crowd: 1, scoreboard: 0.5 },
  betweenPitches: { pitcherFace: 3, catcherSigns: 3, shakeOff: 3, leadOff: 3, coachSigns: 1.5, batterFace: 1.5, crowd: 0.6, dugout: 0.6 },
  moundVisit: { moundWide: 5, moundHuddle: 5, dugout: 1, crowd: 0.7, batterFace: 0.7, bullpen: 0.7 },
  pitchingChange: { managerWalk: 4, bullpenDoor: 2.5, relieverJog: 4, relieverFace: 3, bullpen: 3, moundHuddle: 4, moundWide: 1.5, pitcherFace: 1.5, dugout: 1.5, crowd: 0.7 },
  break: { infieldDrill: 3.5, outfieldCatch: 2.5, aerial: 3, scoreboard: 2.5, crowd: 3, sky: 2, dugout: 1.5, onDeck: 1.5, bullpen: 1, batterFace: 1 },
  review: { umpires: 5, crowd: 1.5, scoreboard: 1, dugout: 1, batterFace: 1 },
};

/** the order a lull of this kind prefers to open with (when available), before the weighted picks */
const OPENERS: Partial<Record<LullKind, BrollKind[]>> = {
  moundVisit: ['moundWide', 'moundHuddle'],
  pitchingChange: ['managerWalk', 'bullpenDoor', 'relieverJog', 'relieverFace'],
  walkup: ['walkup', 'batterFace'],
  break: ['aerial'],
};

export interface PlanContext {
  lull: { kind: LullKind; remaining: number };
  available: Set<BrollKind>;
  /** the last shots shown, newest last */
  recent: { kind: BrollKind; subject?: string }[];
  /** deterministic randomness: any number that changes per planning step */
  seed: number;
  /** a run / home run / big play just happened: open with the dugout that is celebrating */
  reactionTeam?: number | null;
  /** how many shots this lull has already shown */
  shownThisLull: number;
  subjects?: Partial<Record<BrollKind, string | undefined>>;
}

export const MIN_HOLD = 2.5;
/** a lull this short (s) is not worth a cutaway: the viewer would be taken away and brought straight back */
export const MIN_LULL = 3.4;
/** seconds kept free at the end of a lull to be back on the pitch camera */
export const RETURN_MARGIN = 0.8;
/** how many shots back a kind may not repeat */
export const NO_REPEAT_WINDOW = 4;

export function rand01(seed: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The next shot of a lull, or null when the lull is too short / nothing suitable is left (the director goes back to the pitch camera). */
export function planNext(ctx: PlanContext): BrollShot | null {
  const room = ctx.lull.remaining - RETURN_MARGIN;
  if (room < MIN_HOLD) return null;
  if (ctx.shownThisLull === 0 && ctx.lull.remaining < MIN_LULL) return null;
  const recentKinds = ctx.recent.slice(-NO_REPEAT_WINDOW).map((r) => r.kind);
  const recentSubjects = ctx.recent.slice(-3).map((r) => r.subject).filter(Boolean);
  const subjectOf = (k: BrollKind) => ctx.subjects?.[k];
  const ok = (k: BrollKind) => ctx.available.has(k) && !recentKinds.includes(k) && !(subjectOf(k) && recentSubjects.includes(subjectOf(k)));
  const lullKind: LullKind = ctx.lull.kind in WEIGHTS ? ctx.lull.kind : 'betweenPitches'; // a kind the sim adds later still gets sensible B-roll
  const weights = WEIGHTS[lullKind];
  let kind: BrollKind | null = null;
  let team: number | undefined;
  if (ctx.shownThisLull === 0 && ctx.reactionTeam != null && ctx.available.has('dugoutReaction') && lullKind !== 'review') {
    kind = 'dugoutReaction';
    team = ctx.reactionTeam;
  }
  if (!kind) {
    // a lull with a natural order (mound visit: wide, then the huddle) takes its opener first
    const order = OPENERS[lullKind];
    const o = order?.find((k) => ctx.available.has(k) && !ctx.recent.slice(-ctx.shownThisLull).some((r) => r.kind === k));
    if (o && ctx.shownThisLull < (order?.length ?? 0) && (lullKind !== 'walkup' && lullKind !== 'break' ? true : ctx.shownThisLull === 0 || o === 'batterFace')) kind = o;
  }
  if (!kind) {
    const pool = (Object.entries(weights) as [BrollKind, number][]).filter(([k]) => ok(k));
    const total = pool.reduce((s, [, w]) => s + w, 0);
    if (!pool.length || total <= 0) return null;
    let r = rand01(ctx.seed) * total;
    for (const [k, w] of pool) {
      r -= w;
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    kind ??= pool[pool.length - 1][0];
  }
  const [lo, hi] = HOLD[kind];
  const want = lo + rand01(ctx.seed * 7 + 3) * (hi - lo);
  const hold = Math.min(want, room);
  if (hold < MIN_HOLD) return null;
  return {
    kind,
    subject: subjectOf(kind),
    variant: Math.floor(rand01(ctx.seed * 13 + 5) * 1000),
    hold: Math.round(hold * 20) / 20,
    transition: DISSOLVE.has(kind) ? 'dissolve' : 'cut',
    team,
  };
}

// ---- what the current state can show -----------------------------------------------------------

const near = (a: { x: number; z: number }, b: { x: number; z: number }, r: number) => Math.hypot(a.x - b.x, a.z - b.z) < r;

export interface Availability {
  available: Set<BrollKind>;
  subjects: Partial<Record<BrollKind, string>>;
}

export function availableKinds(s: GameState, lm: Landmarks, flags: { reaction?: boolean } = {}): Availability {
  const av = new Set<BrollKind>();
  const subjects: Partial<Record<BrollKind, string>> = {};
  const batter = s.players.find((p) => p.role === 'batter');
  const pitcher = s.players.find((p) => p.role === 'pitcher');
  const catcher = s.players.find((p) => p.role === 'catcher');
  if (batter) {
    av.add('batterFace');
    subjects.batterFace = batter.id;
    if (Math.hypot(batter.vel.x, batter.vel.z) > 0.4 || batter.anim === 'batter_step_in' || batter.anim === 'walk') {
      av.add('walkup');
      subjects.walkup = batter.id;
    }
  }
  const od = s.players.find((p) => p.role === 'ondeck' && p.pos.y > -0.3);
  if (od) {
    av.add('onDeck');
    subjects.onDeck = od.id;
  }
  if (lm.dugoutShots.length) av.add('dugout');
  if (flags.reaction && lm.dugoutShots.length) av.add('dugoutReaction');
  if (pitcher) {
    av.add('pitcherFace');
    subjects.pitcherFace = pitcher.id;
    if (pitcher.anim === 'pitcher_shake_off' || pitcher.anim === 'pitcher_nod') av.add('shakeOff');
  }
  if (catcher) {
    av.add('catcherSigns');
    subjects.catcherSigns = catcher.id;
  }
  const lead = s.players.find((p) => p.role === 'runner' && p.team >= 0 && Math.hypot(p.vel.x, p.vel.z) < 1.2 && p.pos.z > 5);
  if (lead) {
    av.add('leadOff');
    subjects.leadOff = lead.id;
  }
  const coach = s.players.find((p) => p.anim === 'coach_signs') ?? s.players.find((p) => p.role === 'coach3b' || p.role === 'coach1b');
  if (coach) {
    av.add('coachSigns');
    subjects.coachSigns = coach.id;
  }
  const warming = s.players.find((p) => (p.role === 'bench' || p.role === 'pitcher') && (p.anim === 'bullpen_throw' || p.anim === 'warmup_pitch') && p.pos.z > 25);
  if (warming) {
    av.add('bullpen');
    subjects.bullpen = warming.id;
  }
  if (lm.crowdShots.length) av.add('crowd');
  av.add('scoreboard');
  av.add('aerial');
  av.add('sky');
  av.add('moundWide');
  if (pitcher) av.add('moundHuddle');
  const mgr = s.players.find((p) => p.role === 'manager' || p.anim === 'manager_walk');
  if (mgr) {
    av.add('managerWalk');
    subjects.managerWalk = mgr.id;
  }
  av.add('bullpenDoor');
  const rel = s.players.find((p) => p.role !== 'runner' && p.role !== 'batter' && p.team >= 0 && p.id !== pitcher?.id && (p.role === 'pitcher' || p.role === 'bench') && Math.hypot(p.vel.x, p.vel.z) > 2 && !near(p.pos, MOUND, 4));
  if (rel) {
    av.add('relieverJog');
    av.add('relieverFace');
    subjects.relieverJog = rel.id;
    subjects.relieverFace = rel.id;
  }
  // the warm-up between innings: balls rolling around the infield, outfielders playing catch
  const xb = s.extraBalls ?? [];
  if (xb.some((b) => b.z < 48 && Math.abs(b.x) < 36)) av.add('infieldDrill');
  if (xb.some((b) => b.z >= 48)) av.add('outfieldCatch');
  const ump = s.players.filter((p) => p.role === 'umpire');
  if (ump.length >= 2) av.add('umpires');
  return { available: av, subjects };
}

// ---- camera rigs -------------------------------------------------------------------------------

export interface BrollRig {
  pos: Vector3;
  tgt: Vector3;
  fov: number;
  /** the point to keep in focus (rack focus targets move over the shot) */
  focus: Vector3;
  /** half-depth of the sharp slab around the focus point */
  slab: number;
  lp: number;
  lt: number;
  lf: number;
}

export interface RigView {
  state: GameState;
  lm: Landmarks;
  /** seconds into the shot */
  t: number;
  aspect: number;
  /** the camera's current position (some shots keep a distance from it) */
  battingSide: number;
  /** where a player's face is (from the puppet's head bone), when known */
  face?: (id: string, out: Vector3) => Vector3 | null;
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();
const tele = (width: number, dist: number, aspect: number) => MathUtils.radToDeg(2 * Math.atan(width / aspect / 2 / Math.max(dist, 0.5)));
const sc = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);
const find = (s: GameState, id: string | undefined, pred?: (p: PlayerSnap) => boolean) => (id ? s.players.find((p) => p.id === id) : undefined) ?? (pred ? s.players.find(pred) : undefined);
const headY = (p: PlayerSnap) => p.pos.y + (p.physique?.heightM ?? 1.85) * 0.93;
/** face centre: the puppet's own head position when the view can tell, else a standing estimate */
const faceOf = (v: RigView, p: PlayerSnap, out: Vector3) => v.face?.(p.id, out) ?? out.set(p.pos.x, headY(p) - 0.05, p.pos.z);

function makeRig(): BrollRig {
  return { pos: new Vector3(), tgt: new Vector3(), fov: 30, focus: new Vector3(), slab: 6, lp: 6, lt: 8, lf: 6 };
}

/** Where the camera stands and what it looks at for a planned shot. Always returns something usable (falls back to the pitch camera's view). */
export function computeRig(shot: BrollShot, v: RigView, out: BrollRig = makeRig()): BrollRig {
  const s = v.state;
  const r = out;
  r.lp = 6; r.lt = 8; r.lf = 6; r.slab = 5;
  const fallback = () => {
    r.pos.copy(CF_CAM);
    r.tgt.set(0, 1.05, 8.2);
    r.fov = tele(8.6, r.pos.distanceTo(r.tgt), v.aspect);
    r.focus.copy(r.tgt);
    r.slab = 5;
    return r;
  };
  const rnd = (k: number) => rand01(shot.variant * 31 + k);
  const side = rnd(1) < 0.5 ? -1 : 1;
  switch (shot.kind) {
    case 'walkup': {
      const b = find(s, shot.subject, (p) => p.role === 'batter');
      if (!b) return fallback();
      const bp = sc(b.pos);
      const sp = Math.hypot(b.vel.x, b.vel.z);
      // ahead of him, low, a little to the side: he walks into the lens
      const dir = sp > 0.3 ? _a.set(b.vel.x, 0, b.vel.z).normalize() : _a.set(Math.sin(b.facing), 0, Math.cos(b.facing));
      r.pos.copy(bp).addScaledVector(dir, 4.6).addScaledVector(_b.set(-dir.z, 0, dir.x), 1.6 * side).setY(0.85);
      r.tgt.copy(bp).setY(1.2);
      r.fov = tele(2.6, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 2.2;
      r.lp = 7; r.lt = 9; r.lf = 6;
      return r;
    }
    case 'batterFace': {
      const b = find(s, shot.subject, (p) => p.role === 'batter');
      if (!b) return fallback();
      const head = faceOf(v, b, _c).clone();
      // from the pitcher's side, a little off-axis: the face he turns toward the mound
      const toMound = _a.set(MOUND.x - head.x, 0, MOUND.z - head.z).normalize();
      r.pos.copy(head).addScaledVector(toMound, 6.5).addScaledVector(_b.set(-toMound.z, 0, toMound.x), 1.1 * side).setY(head.y + 0.03);
      r.tgt.copy(head);
      r.fov = tele(0.95, r.pos.distanceTo(r.tgt), v.aspect);
      // rack focus: starts on the background behind him, settles on his face after about a second
      const back = head.clone().addScaledVector(toMound, -3.2);
      const k = MathUtils.smoothstep(v.t, 0.7, 1.3);
      r.focus.copy(back).lerp(head, k);
      r.slab = 0.6;
      r.lp = 3; r.lt = 4; r.lf = 4;
      return r;
    }
    case 'onDeck': {
      const od = find(s, shot.subject, (p) => p.role === 'ondeck');
      const sign = v.battingSide === 1 ? 1 : -1;
      const o = od ? sc(od.pos) : new Vector3(sign * 11.3, 0, 0);
      const f = od ? od.facing : Math.atan2(-sign, 0.3);
      const fwd = _a.set(Math.sin(f), 0, Math.cos(f));
      r.pos.copy(o).addScaledVector(fwd, 7).addScaledVector(_b.set(-fwd.z, 0, fwd.x), 2.2 + Math.sin(v.t * 0.3) * 0.4).setY(1.5);
      r.tgt.copy(o).setY(1.0);
      r.fov = tele(4.6, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 4;
      r.lp = r.lt = r.lf = 20;
      return r;
    }
    case 'dugout':
    case 'dugoutReaction': {
      const team = shot.team ?? v.battingSide;
      const shots = v.lm.dugoutShots;
      const d = shots[team === 1 ? 0 : 1] ?? shots[0];
      if (!d) return fallback();
      const close = shot.kind === 'dugoutReaction' || rnd(2) < 0.5;
      const inward = _a.copy(d.pos).sub(d.target).setY(0).normalize();
      if (close) {
        // from above the rail, looking down into the pit: the players on the bench and the manager at the rail
        r.pos.copy(d.target).addScaledVector(inward, 11).setY(3.4).x += Math.sin(v.t * 0.25) * 0.5;
        r.tgt.copy(d.target).setY(-0.3);
        r.fov = tele(9, r.pos.distanceTo(r.tgt), v.aspect);
        r.slab = 4.5;
      } else {
        r.pos.copy(d.pos).x += Math.sin(v.t * 0.25) * 0.6;
        r.tgt.copy(d.target);
        r.fov = 26;
        r.slab = 7;
      }
      r.focus.copy(d.target);
      r.lp = r.lt = r.lf = 20;
      return r;
    }
    case 'pitcherFace': {
      const p = find(s, shot.subject, (q) => q.role === 'pitcher');
      const head = p ? faceOf(v, p, _c).clone() : new Vector3(0, 1.9, 18.44);
      // the high-home camera behind the plate (the centre-field camera is behind the pitcher: it framed the back of his head and the catcher /
      // batter beyond); raised so the line of sight clears the umpire, catcher and batter (~2.4 m over the plate)
      r.pos.set(1.6 * side, 3.3, -26);
      r.tgt.copy(head);
      r.fov = tele(2.0, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(head);
      r.slab = 1.2;
      r.lp = r.lt = r.lf = 6;
      return r;
    }
    case 'shakeOff': {
      const p = find(s, shot.subject, (q) => q.role === 'pitcher');
      const head = p ? faceOf(v, p, _c).clone() : new Vector3(0, 1.9, 18.44);
      // three-quarter close-up from the dugout side: the shake of the head reads from the side
      r.pos.set(head.x + 9 * side, 2.0, head.z - 9.5);
      r.tgt.copy(head);
      r.fov = tele(1.7, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(head);
      r.slab = 1;
      r.lp = r.lt = r.lf = 5;
      return r;
    }
    case 'catcherSigns': {
      const c = find(s, shot.subject, (p) => p.role === 'catcher');
      const cp = c ? sc(c.pos) : new Vector3(0, 0, -1.2);
      // the signs as the pitcher sees them: a long lens from centre field on the hand between his knees (from the side his thigh hid the hand and the
      // shot was his glove and forearm), offset a few metres so the line of sight passes beside the pitcher
      r.pos.set(8 * side, 5.5, 121);
      r.tgt.set(cp.x - 0.04, 0.42, cp.z + 0.32);
      r.fov = tele(0.75, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 0.7;
      r.lp = r.lt = r.lf = 6;
      return r;
    }
    case 'leadOff': {
      const run = find(s, shot.subject, (p) => p.role === 'runner');
      if (!run) return fallback();
      const rp = sc(run.pos);
      // the base he is leading from: the nearest of the three
      const bases = [new Vector3(-19.13, 0, 19.4), new Vector3(0, 0, 38.8), new Vector3(19.13, 0, 19.4)];
      const bs = bases.reduce((a, b) => (a.distanceTo(rp) < b.distanceTo(rp) ? a : b));
      const along = _a.copy(rp).sub(bs).setY(0);
      const l = along.length() || 1;
      along.divideScalar(l);
      const out = _c.set(bs.x, 0, bs.z).sub(MOUND).setY(0).normalize();
      r.pos.copy(rp).addScaledVector(out, 3.2).addScaledVector(_b.set(-along.z, 0, along.x), 4.6 * side).setY(0.9);
      r.tgt.copy(rp).setY(1.0);
      r.fov = tele(3.8, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 3;
      r.lp = 5; r.lt = 7; r.lf = 6;
      return r;
    }
    case 'coachSigns': {
      const c = find(s, shot.subject, (p) => p.role === 'coach3b' || p.role === 'coach1b');
      if (!c) return fallback();
      const cp = sc(c.pos);
      const toPlate = _a.set(-cp.x, 0, -cp.z).normalize();
      r.pos.copy(cp).addScaledVector(toPlate, 6.5).addScaledVector(_b.set(-toPlate.z, 0, toPlate.x), 1.3 * side).setY(1.55);
      r.tgt.copy(cp).setY(1.3);
      r.fov = tele(2.4, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 2;
      r.lp = r.lt = r.lf = 6;
      return r;
    }
    case 'bullpen': {
      const w = find(s, shot.subject);
      const bp = w ? sc(w.pos) : (shot.team === 1 ? v.lm.bullpens[1] : v.lm.bullpens[0]).clone();
      const sgn = Math.sign(bp.x) || 1;
      r.pos.set(bp.x - sgn * 14, 2.2, bp.z - 8);
      r.tgt.copy(bp).setY(1.2);
      r.fov = tele(7, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 4;
      r.lp = r.lt = r.lf = 6;
      return r;
    }
    case 'bullpenDoor': {
      const b = v.lm.bullpens[v.battingSide === 1 ? 0 : 1]; // the fielding team's pen
      const sgn = Math.sign(b.x) || 1;
      r.pos.set(b.x - sgn * 20, 3.0, b.z - 14);
      r.tgt.copy(b).setY(1.3);
      r.fov = tele(13, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 9;
      r.lp = r.lt = r.lf = 8;
      return r;
    }
    case 'crowd': {
      const cs = v.lm.crowdShots;
      if (!cs.length) return fallback();
      const c = cs[shot.variant % cs.length];
      r.pos.copy(c.pos).x += Math.sin(v.t * 0.2) * 1.0;
      r.tgt.copy(c.target);
      r.fov = 12 + (shot.variant % 3) * 3;
      r.focus.copy(r.tgt);
      r.slab = 6;
      r.lp = r.lt = r.lf = 20;
      return r;
    }
    case 'scoreboard': {
      const sb = v.lm.scoreboard ?? new Vector3(0, 20, 150);
      r.pos.set(sb.x * 0.15, 5.5 + v.t * 0.3, 20);
      r.tgt.copy(sb);
      r.fov = tele(46, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 0; // wide: deep focus
      r.lp = r.lt = r.lf = 20;
      return r;
    }
    case 'aerial': {
      // the high camera behind home plate drifting across, the park laid out below (like the old wide cutaway)
      const k = Math.min(1, v.t / 6);
      const dirn = rnd(3) < 0.5 ? -1 : 1;
      // high enough to clear the upper deck's back wall (40 m at z = -71): at 46 m the near stands filled the lower half of the frame
      r.pos.set(dirn * (-34 + 68 * k), 64 - 6 * k, -84);
      r.tgt.set(0, 0, 58);
      r.fov = 38;
      r.focus.copy(r.tgt);
      r.slab = 0;
      r.lp = r.lt = r.lf = 20;
      return r;
    }
    case 'sky': {
      // low over the infield toward the outfield wall and up: the roofline, the flags and the sky, a slow tilt
      const k = Math.min(1, v.t / 5);
      r.pos.set(-12 + rnd(6) * 24, 3.0, 36);
      r.tgt.set(r.pos.x * 0.4, 20 + k * 22, 200);
      r.fov = 40;
      r.focus.copy(r.tgt);
      r.slab = 0;
      r.lp = r.lt = r.lf = 20;
      return r;
    }
    case 'infieldDrill':
    case 'outfieldCatch': {
      const deep = shot.kind === 'outfieldCatch';
      const xb = (s.extraBalls ?? []).filter((b) => (deep ? b.z >= 48 : b.z < 48 && Math.abs(b.x) < 36)).map(sc);
      const c = xb.length ? xb.reduce((a, b) => a.add(b), new Vector3()).divideScalar(xb.length) : new Vector3(0, 0, deep ? 70 : 28);
      // from the foul-territory side, low: the balls and the people throwing them
      r.pos.set(c.x + 16 * side * (deep ? 1.2 : 1), deep ? 2.4 : 2.0, c.z - (deep ? 20 : 13));
      r.tgt.copy(c).setY(1.0);
      r.fov = tele(deep ? 22 : 17, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = deep ? 10 : 7;
      r.lp = 3; r.lt = 4; r.lf = 4;
      return r;
    }
    case 'moundWide': {
      r.pos.set(-7, 9.5, -16);
      r.tgt.set(0, 1.3, MOUND.z);
      r.fov = tele(24, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 12;
      r.lp = r.lt = r.lf = 5;
      return r;
    }
    case 'moundHuddle': {
      // the group on the mound: centroid of the players around it
      const g = s.players.filter((p) => p.team >= 0 && near(p.pos, MOUND, 6));
      const c = g.length ? g.reduce((a, p) => a.add(sc(p.pos)), new Vector3()).divideScalar(g.length) : MOUND.clone();
      r.pos.set(c.x + 9 * side, 1.9, c.z - 11);
      r.tgt.copy(c).setY(1.4);
      r.fov = tele(6.5, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 3.5;
      r.lp = r.lt = r.lf = 4;
      return r;
    }
    case 'managerWalk': {
      const m = find(s, shot.subject, (p) => p.role === 'manager' || p.anim === 'manager_walk');
      if (!m) return fallback();
      const mp = sc(m.pos);
      const dir = Math.hypot(m.vel.x, m.vel.z) > 0.3 ? _a.set(m.vel.x, 0, m.vel.z).normalize() : _a.set(Math.sin(m.facing), 0, Math.cos(m.facing));
      const pit = mp.y < -0.3; // still in the dugout pit: look down into it from above the rail
      r.pos.copy(mp).addScaledVector(dir, pit ? 9 : 6.5).addScaledVector(_b.set(-dir.z, 0, dir.x), 1.6 * side).setY(pit ? 3.4 : 1.4);
      r.tgt.copy(mp).setY(pit ? mp.y + 1.0 : 1.25);
      r.fov = tele(pit ? 4.5 : 3.2, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 2.6;
      r.lp = 6; r.lt = 8; r.lf = 6;
      return r;
    }
    case 'relieverJog':
    case 'relieverFace': {
      const p = find(s, shot.subject);
      if (!p) return fallback();
      const pp = sc(p.pos);
      const dir = Math.hypot(p.vel.x, p.vel.z) > 0.5 ? _a.set(p.vel.x, 0, p.vel.z).normalize() : _a.set(Math.sin(p.facing), 0, Math.cos(p.facing));
      if (shot.kind === 'relieverJog') {
        r.pos.copy(pp).addScaledVector(dir, 7).addScaledVector(_b.set(-dir.z, 0, dir.x), 2 * side).setY(1.2);
        r.tgt.copy(pp).setY(1.1);
        r.fov = tele(3.4, r.pos.distanceTo(r.tgt), v.aspect);
        r.slab = 2.6;
      } else {
        const head = faceOf(v, p, _c).clone();
        r.pos.copy(head).addScaledVector(dir, 6).addScaledVector(_b.set(-dir.z, 0, dir.x), 0.9 * side).setY(head.y);
        r.tgt.copy(head);
        r.fov = tele(1.0, r.pos.distanceTo(r.tgt), v.aspect);
        r.slab = 0.8;
      }
      r.focus.copy(r.tgt);
      r.lp = 6; r.lt = 8; r.lf = 6;
      return r;
    }
    case 'umpires': {
      const u = s.players.filter((p) => p.role === 'umpire');
      const c = u.length ? u.reduce((a, p) => a.add(sc(p.pos)), new Vector3()).divideScalar(u.length) : new Vector3(0, 0, 25);
      r.pos.set(c.x + 12 * side, 2.2, c.z - 10);
      r.tgt.copy(c).setY(1.3);
      r.fov = tele(14, r.pos.distanceTo(r.tgt), v.aspect);
      r.focus.copy(r.tgt);
      r.slab = 6;
      r.lp = r.lt = r.lf = 5;
      return r;
    }
  }
  return fallback();
}
