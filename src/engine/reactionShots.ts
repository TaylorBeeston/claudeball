/**
 * Reaction shots: after a big moment a broadcast cuts to the person it happened to, while his face still shows it (the strikeout victim's
 * frustration, the pitcher's yell, the runner arguing a close call, the pitcher watching a home run leave). The faces (face/emotion.ts) hold an
 * expression through a person-shot that starts within 0.5 s of it, so the cut has to come while the reaction runs.
 *
 * Pure (no rendering, no clock of its own): the director turns the game's events into `Moment`s (who the moment is about, how big it is) and
 * asks `pickReaction` for the best person to show now, given what each face is showing (`ReactionNow`) and the pace rules (a cap per half
 * inning, a minimum gap, never the same person twice in a row, variety of roles); `reactionCamera` finds a clear close-up of that person's face
 * or says there is none (then there is no shot: better none than a bad one).
 */
import { Vector3 } from 'three';
import { blocker, type Box, type P3 } from './sightLines';
import type { PlayerSnap } from './types';

export type Pace = 'broadcast' | 'standard' | 'quick';

export type MomentKind =
  | 'strikeout' | 'walk' | 'hitByPitch' | 'brushback' | 'hit' | 'extraBase' | 'doublePlay' | 'homeRun' | 'robbedHomer' | 'error' | 'closeOut'
  | 'closeSafe' | 'run' | 'pitchingChange' | 'challenge';

/** someone standing somewhere (every puppet: the sim's players and the side cast, ball kids, coaches) */
export interface Body {
  id: string;
  pos: P3;
}

/** a moment worth a reaction: who it is about (most likely to react first) and when it happened (director clock) */
export interface Moment {
  kind: MomentKind;
  at: number;
  people: string[];
  /** 0..1.2: how big (the base weight of the kind, raised by the leverage of the moment) */
  weight: number;
}

/** the face's running reaction (FaceState.reactionInfo) */
export interface ReactionNow {
  name: string;
  strength: number;
  age: number;
  /** seconds of its hold left (< 0: releasing) */
  left: number;
  pendingIn: number | null;
}

/** how big each kind of moment is */
export const MOMENT_WEIGHT: Record<MomentKind, number> = {
  homeRun: 1, robbedHomer: 1, closeOut: 0.9, challenge: 0.9, hitByPitch: 0.85, brushback: 0.8, error: 0.8, doublePlay: 0.75, strikeout: 0.7,
  pitchingChange: 0.7, extraBase: 0.65, closeSafe: 0.6, walk: 0.55, run: 0.5, hit: 0.45,
};

/** the reactions each kind of moment may show (a brushback is a flinch, not the batter's concentration on the next pitch) */
const NAMES: Partial<Record<MomentKind, string[]>> = {
  brushback: ['flinch', 'glare', 'concern'],
  hitByPitch: ['wince', 'glare', 'concern'],
  closeOut: ['argue', 'frustration'],
  closeSafe: ['relief'],
  challenge: ['argue'],
};

/** how well a reaction reads on camera (a calm nod or concentration is barely an expression) */
const NAME_WEIGHT: Record<string, number> = { nod: 0.4, concentration: 0.35, relief: 0.8, concern: 0.8, grin: 0.9, smirk: 0.7 };

/** pace rules per tempo: shots per half inning, seconds between two, the smallest moment worth one */
export const PACE: Record<Pace, { perHalf: number; gap: number; minWeight: number }> = {
  broadcast: { perHalf: 3, gap: 18, minWeight: 0 },
  standard: { perHalf: 2, gap: 30, minWeight: 0.6 },
  quick: { perHalf: 1, gap: 60, minWeight: 0.8 },
};

/** a moment is stale this long after it happened (its reactions are over) */
export const MOMENT_TTL = 7;
/** the big ones are shown whatever the pace (the cap and the gap do not apply) */
export const MUST_SHOW = new Set<MomentKind>(['homeRun', 'robbedHomer', 'closeOut', 'challenge']);

export type RoleClass = 'pitcher' | 'batter' | 'catcher' | 'fielder' | 'runner' | 'dugout' | 'manager' | 'other';

export function roleClass(role: string): RoleClass {
  if (role === 'pitcher' || role === 'catcher' || role === 'batter' || role === 'runner' || role === 'manager') return role;
  if (/^(first|second|third|short|left|center|right)/.test(role)) return 'fielder';
  if (/^(bench|pitchcoach|bullpen|reliever)/.test(role)) return 'dugout';
  return 'other';
}

export interface RecentShot {
  id: string;
  cls: RoleClass;
  at: number;
}

export interface PickContext {
  now: number;
  moments: readonly Moment[];
  /** the face's running reaction of a person (null: none) */
  lookup: (id: string) => ReactionNow | null;
  players: readonly PlayerSnap[];
  /** the reaction shots shown so far (and the dugout reaction shots), newest last */
  recent: readonly RecentShot[];
  shownThisHalf: number;
  pace: Pace;
  /** the subject of the shot before (a B-roll face close-up): not him again straight away */
  avoid?: string;
  /** only these kinds (a stage of the home-run sequence, the close play) */
  kinds?: readonly MomentKind[];
}

export interface Pick {
  id: string;
  moment: Moment;
  cls: RoleClass;
  reaction: string;
  score: number;
}

/** Every person worth a reaction shot now, best first (empty: none, or the pace rules say not yet). */
export function rankReactions(ctx: PickContext): Pick[] {
  const P = PACE[ctx.pace];
  const last = ctx.recent[ctx.recent.length - 1];
  const prev = ctx.recent[ctx.recent.length - 2];
  const paced = ctx.shownThisHalf < P.perHalf && (!last || ctx.now - last.at >= P.gap);
  const out: Pick[] = [];
  for (const m of ctx.moments) {
    if (ctx.now - m.at > MOMENT_TTL || ctx.now < m.at) continue;
    if (ctx.kinds && !ctx.kinds.includes(m.kind)) continue;
    if (!MUST_SHOW.has(m.kind) && (!paced || m.weight < P.minWeight)) continue;
    m.people.forEach((id, rank) => {
      if ((last && last.id === id) || ctx.avoid === id) return; // never the same person twice in a row
      if (out.some((o) => o.id === id)) return;
      const r = ctx.lookup(id);
      // over (the face would not hold it), or too faint to read
      if (!r || r.left < -0.3 || r.strength < 0.3) return;
      const names = NAMES[m.kind];
      if (names && !names.includes(r.name)) return;
      const p = ctx.players.find((q) => q.id === id);
      // a masked face (the catcher and the plate umpire in their gear) shows nothing
      if (!p || p.role === 'catcher' || p.role === 'umpire') return;
      const cls = roleClass(p.role);
      let score = m.weight * Math.min(1.2, r.strength) * (NAME_WEIGHT[r.name] ?? 1) * (1 - 0.12 * rank);
      // variety: not the same kind of person as the last two reaction shots
      if (last && last.cls === cls) score *= 0.5;
      if (prev && prev.cls === cls) score *= 0.75;
      // a reaction that has most of its hold left beats one about to fade
      if (r.left < 0.6) score *= 0.7;
      if (score >= 0.2) out.push({ id, moment: m, cls, reaction: r.name, score });
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---- the camera ---------------------------------------------------------------------------------------------------------------

/** the close-up: this far from the face, this wide a picture at the face (head about a quarter of the picture height in 16:9) */
export const REACT_DIST = 7;
export const REACT_WIDTH = 1.5;
/** nobody this close to the lens (they would fill the frame or be cut by the near plane) */
const LENS_CLEAR = 1.4;
/** nobody this close to the line of sight between the lens and the face */
const SIGHT_CLEAR = 0.5;
/** a key light at the face: the direction toward it and how strong it is there (any unit: only the ratios matter) */
export interface KeyLight {
  dir: P3;
  w: number;
}
/** the visible side of the face must get at least this share of the strongest light's full, head-on illuminance */
export const LIT_MIN = 0.3;

/**
 * How lit the side of the face the camera sees is, 0..1: the strongest light on it (relative to the strongest light there at all) times the
 * cosine between that light and the visible side (halfway between where he looks and the camera).
 */
export function litShare(facing: P3, toCam: P3, lights: readonly KeyLight[]): number {
  let nx = facing.x + toCam.x, nz = facing.z + toCam.z;
  const l = Math.hypot(nx, nz) || 1;
  nx /= l;
  nz /= l;
  const top = Math.max(...lights.map((k) => k.w), 1e-9);
  let best = 0;
  for (const k of lights) best = Math.max(best, (k.w / top) * Math.max(0, nx * k.dir.x + nz * k.dir.z + 0.2 * k.dir.y));
  return best;
}

/** angles (deg) tried around the way the face looks, best first */
const ANGLES = [0, 20, -20, 40, -40, 60, -60];

/** a point inside the park where a camera operator can stand: on the field or the foul ground in front of the stands, not behind the backstop */
export function inPark(x: number, z: number): boolean {
  if (z < -15.5) return false;
  const r = Math.hypot(x, z);
  const phi = Math.atan2(x, z);
  if (Math.abs(phi) <= Math.PI / 4) return r < 96; // fair: in front of the warning track of the shortest fence
  // foul ground: within 13 m of the line
  const foul = Math.abs(x) * Math.SQRT1_2 - z * Math.SQRT1_2;
  return foul < 13 && r < 92;
}

/**
 * A clear camera position for a close-up of `subject`'s face at `head`: in front of where he looks (or walks), at eye level, inside the park,
 * not in a dugout or behind the batter's eye, nobody near the lens or across the line of sight, and (given the key lights) on the lit side of his
 * face. Returns the camera's offset from the face (so a walking subject is followed at the same angle), or null when no placement works.
 */
export function reactionCamera(subject: PlayerSnap, head: Vector3, bodies: readonly Body[], occluders: readonly Box[], out = new Vector3(), lights?: readonly KeyLight[]): Vector3 | null {
  const sp = Math.hypot(subject.vel.x, subject.vel.z);
  const yaw = sp > 0.6 ? Math.atan2(subject.vel.x, subject.vel.z) : subject.facing;
  const cam = new Vector3();
  const look = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  for (const dist of [REACT_DIST, REACT_DIST + 2.5]) {
    for (const a of ANGLES) {
      const y = yaw + (a * Math.PI) / 180;
      cam.set(head.x + Math.sin(y) * dist, Math.max(1.2, head.y - 0.08), head.z + Math.cos(y) * dist);
      if (!inPark(cam.x, cam.z)) continue;
      if (blocker(cam, head, occluders)) continue;
      if (!sightClear(cam, head, subject.id, bodies)) continue;
      if (lights?.length && litShare(look, { x: Math.sin(y), y: 0, z: Math.cos(y) }, lights) < LIT_MIN) continue;
      return out.copy(cam).sub(head);
    }
  }
  return null;
}

/** nobody but the subject near the lens or across the line of sight (XZ; everybody is taller than a camera at eye level) */
export function sightClear(cam: P3, head: P3, subjectId: string, bodies: readonly Body[]): boolean {
  const dx = head.x - cam.x, dz = head.z - cam.z;
  const len = Math.hypot(dx, dz) || 1;
  for (const p of bodies) {
    if (p.id === subjectId || p.pos.y < -0.6) continue; // (the dugout pit is below the line)
    const px = p.pos.x - cam.x, pz = p.pos.z - cam.z;
    if (Math.hypot(px, pz) < LENS_CLEAR) return false;
    const t = (px * dx + pz * dz) / (len * len);
    // up to just short of the face (someone right beside him is in the picture with him, not in front of the lens)
    if (t <= 0 || t >= 1 - 0.6 / len) continue;
    if (Math.abs(px * dz - pz * dx) / len < SIGHT_CLEAR) return false;
  }
  return true;
}
