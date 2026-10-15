/**
 * Footsteps. Every player on the field has a stride: which foot lands next, how far through the current step he is, and where
 * each foot came down. A base is touched by a foot that lands on the bag (or a slide's leading foot / hand reaching it), not by
 * the body passing near it: the bag is 15 in square, a sprinter's feet land ~1.9 m apart, so a runner whose body crosses the bag
 * has a foot on it only if he times his steps. Runners do: from a few steps out they lengthen or shorten their steps so a foot
 * comes down on the bag (`aimStep`).
 *
 * The numbers are the shipped gait clips' (`tools/contact/clipfeet.ts` measures them from `player_base.glb`): the engine
 * plays each locomotion clip phase-locked to this stride, so the foot that is drawn on the bag is the footstrike counted here.
 */
import { BASE_POS, PLATE_DEPTH, PLATE_HALF_WIDTH } from './field';
import { clamp } from './math';
import type { PlayerRT, World } from './world';
import { TICK } from './world';

/** 0 = left foot, 1 = right foot. */
export type Foot = 0 | 1;

export interface Strike {
  /** the ankle's ground point when the foot came down */
  x: number;
  z: number;
  tick: number;
  foot: Foot;
  /** heading of the shoe (atan2(x, z), like `facing`) */
  dir: number;
}

export interface Stride {
  /** the foot that lands next */
  next: Foot;
  /** ground distance covered since the last footstrike (m), and the length of the step in progress */
  dist: number;
  len: number;
  last: Strike | null;
  /** the strike before `last` */
  prev: Strike | null;
}

export const newStride = (): Stride => ({ next: 0, dist: 0, len: 0, last: null, prev: null });

/**
 * The gait clips, slowest first: ground speed the clip is authored for (its stance-foot speed), step length (half the distance
 * per cycle), and the ankle's offset from the hips' ground point at touchdown: forward, and to the side (+ = the player's left)
 * for the left and the right foot. The turn clips lean into the turn: both feet land to the right of the hips.
 */
export const GAITS = [
  { name: 'walk', speed: 1.42, step: 0.53, fwd: [0.295, 0.295], side: [0.095, -0.095] },
  { name: 'trot', speed: 2.2, step: 0.825, fwd: [0.345, 0.345], side: [0.1, -0.1] },
  { name: 'jog', speed: 3.5, step: 1.31, fwd: [0.375, 0.375], side: [0.1, -0.1] },
  { name: 'run', speed: 5, step: 1.665, fwd: [0.417, 0.417], side: [0.1, -0.1] },
  { name: 'run_sprint', speed: 7, step: 1.895, fwd: [0.36, 0.248], side: [0.1, -0.1] },
] as const;
export const TURN_GAITS = [
  { name: 'run_turn', speed: 5, step: 1.665, fwd: [0.418, 0.417], side: [-0.05, -0.25] },
  { name: 'run_turn_sprint', speed: 7, step: 1.895, fwd: [0.36, 0.248], side: [-0.05, -0.25] },
] as const;
type Gait = (typeof GAITS)[number] | (typeof TURN_GAITS)[number];

/** The gait clip the engine plays at this ground speed: the one whose authored speed is nearest (in ratio). */
export function gaitFor(speed: number, turning: boolean): Gait {
  const set: readonly Gait[] = turning ? TURN_GAITS : GAITS;
  let best = set[0];
  for (const g of set) if (Math.abs(Math.log(Math.max(0.05, speed) / g.speed)) < Math.abs(Math.log(Math.max(0.05, speed) / best.speed))) best = g;
  return best;
}

/** Natural step length at a ground speed (m): the step of the clip played at that speed. */
export const naturalStep = (speed: number, turning = false) => gaitFor(speed, turning).step;

/** Below this ground speed he is standing (both feet down): no steps are taken. */
const STAND = 0.25;

/** Where a foot lands for a body at (x, z) facing `facing` moving at `speed`. */
export function footPoint(x: number, z: number, facing: number, speed: number, foot: Foot, turning: boolean): { x: number; z: number } {
  const g = gaitFor(speed, turning);
  const fx = Math.sin(facing), fz = Math.cos(facing);
  // the player's left (+X when he faces +Z)
  const lx = fz, lz = -fx;
  return { x: x + fx * g.fwd[foot] + lx * g.side[foot], z: z + fz * g.fwd[foot] + lz * g.side[foot] };
}

/** Advance a player's stride by one tick (after he has moved). Returns the footstrike made this tick, if any. */
export function stepStride(w: World, p: PlayerRT): Strike | null {
  const s = p.stride;
  const speed = Math.hypot(p.vx, p.vz);
  const turning = p.gait === 'turn';
  if (speed < STAND) {
    // standing: he plants both feet; the next step starts from here
    s.dist = 0;
    s.len = 0;
    return null;
  }
  if (s.len === 0) {
    // the first step from a standstill is a short one
    s.len = 0.6 * naturalStep(speed, turning);
    s.dist = 0;
  }
  s.dist += speed * TICK;
  if (s.dist < s.len) return null;
  // the foot comes down: where it is now, less the bit of this tick past the strike
  const back = (s.dist - s.len) / speed;
  const x = p.x - p.vx * back, z = p.z - p.vz * back;
  const f = footPoint(x, z, p.facing, speed, s.next, turning);
  const strike: Strike = { x: f.x, z: f.z, tick: w.tick, foot: s.next, dir: p.facing };
  s.prev = s.last;
  s.last = strike;
  s.next = s.next === 0 ? 1 : 0;
  s.dist -= s.len;
  s.len = naturalStep(speed, turning);
  return strike;
}

/**
 * Time the coming steps so a foot lands on the point (tx, tz) ahead (a runner reaching for a bag). From `maxSteps` natural steps
 * out he changes his step length, within `lo`..`hi` of the natural one, so that one of the next footstrikes lands there; the
 * planned step length is kept for the step in progress and the ones after it. Returns the plan: how many steps to the touch, and the
 * point his body must pass when that foot comes down (the foot lands beside and ahead of the body, so a runner who wants it on the bag
 * steers his body there); null when the point is not ahead or no footstrike can reach it within the limits.
 */
export function aimStep(p: PlayerRT, tx: number, tz: number, opts: { maxSteps?: number; lo?: number; hi?: number } = {}): { k: number; bx: number; bz: number } | null {
  const s = p.stride;
  const speed = Math.hypot(p.vx, p.vz);
  if (speed < 1.0 || s.len === 0) return null;
  const turning = p.gait === 'turn';
  const L = naturalStep(speed, turning);
  const maxSteps = opts.maxSteps ?? 4.5;
  const lo = opts.lo ?? 0.8, hi = opts.hi ?? 1.2;
  const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
  const lx = fz, lz = -fx;
  const g = gaitFor(speed, turning);
  let best = 0, bestErr = Infinity, bestLen = 0, bestX = 0, bestZ = 0;
  for (let k = 1; k <= Math.ceil(maxSteps); k++) {
    const foot: Foot = (k % 2 === 1 ? s.next : 1 - s.next) as Foot;
    // where his body must be when that foot comes down
    const bx = tx - fx * g.fwd[foot] - lx * g.side[foot], bz = tz - fz * g.fwd[foot] - lz * g.side[foot];
    const along = (bx - p.x) * fx + (bz - p.z) * fz;
    if (along <= 0) continue;
    if (along > maxSteps * L) break;
    // k steps of length l from here: (l - dist) + (k - 1) l = along
    const l = (along + s.dist) / k;
    if (l <= s.dist + 1e-3) continue;
    const err = Math.abs(Math.log(l / L));
    if (l >= lo * L && l <= hi * L && err < bestErr) {
      best = k;
      bestErr = err;
      bestLen = l;
      bestX = bx;
      bestZ = bz;
    }
  }
  if (!best) return null;
  s.len = bestLen;
  return { k: best, bx: bestX, bz: bestZ };
}

// ---------------------------------------------------------------------------------------------
// the bags and the plate
// ---------------------------------------------------------------------------------------------

/** Half the side of a bag (15 in square; its edges run along the base paths). */
export const BAG_HALF = (15 * 0.0254) / 2;
/** The shoe from the ankle: heel behind, toe ahead (m). */
const HEEL = 0.07;
const TOE = 0.2;

const PLATE: [number, number][] = [
  [0, 0],
  [-PLATE_HALF_WIDTH, PLATE_HALF_WIDTH],
  [-PLATE_HALF_WIDTH, PLATE_DEPTH],
  [PLATE_HALF_WIDTH, PLATE_DEPTH],
  [PLATE_HALF_WIDTH, PLATE_HALF_WIDTH],
];

/** Distance from (x, z) to base `b`'s bag (1..3) or home plate (0 / 4); 0 on it. */
export function distToBase(b: number, x: number, z: number): number {
  if (b % 4 === 0) {
    // home plate: the pentagon, apex at the origin, 12 in edges at 45 degrees to the corners, the 17 in front edge at z = PLATE_DEPTH
    let inside = true;
    let best = Infinity;
    for (let i = 0; i < PLATE.length; i++) {
      const [ax, az] = PLATE[i], [bx, bz] = PLATE[(i + 1) % PLATE.length];
      const ex = bx - ax, ez = bz - az;
      // (counter-clockwise seen from above: the inside is on the left of each edge)
      if (ex * (z - az) - ez * (x - ax) > 0) inside = false;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1);
      best = Math.min(best, Math.hypot(x - (ax + ex * t), z - (az + ez * t)));
    }
    return inside ? 0 : best;
  }
  const c = BASE_POS[b];
  const dx = x - c.x, dz = z - c.z;
  const u = (dx + dz) / Math.SQRT2, v = (dx - dz) / Math.SQRT2;
  return Math.hypot(Math.max(0, Math.abs(u) - BAG_HALF), Math.max(0, Math.abs(v) - BAG_HALF));
}

/** Is a shoe planted at this strike on base `b` (any part of the sole on the bag / plate)? */
export function shoeOn(b: number, st: { x: number; z: number; dir: number }): boolean {
  const fx = Math.sin(st.dir), fz = Math.cos(st.dir);
  for (let k = 0; k <= 4; k++) {
    const a = -HEEL + ((TOE + HEEL) * k) / 4;
    if (distToBase(b, st.x + fx * a, st.z + fz * a) <= 0.03) return true;
  }
  return false;
}

/** Standing on the bag: a player at rest with his body over it has his feet on it. */
export function standsOn(p: PlayerRT, b: number): boolean {
  return Math.hypot(p.vx, p.vz) < 1.0 && distToBase(b, p.x, p.z) <= 0.12;
}

/** The point a runner's foot aims for at base `b` coming from `from` (a unit vector of his way in): the middle, or the inside corner when he rounds it. */
export function touchPoint(b: number, rounding: boolean): { x: number; z: number } {
  if (b % 4 === 0) return { x: 0, z: PLATE_DEPTH * 0.55 };
  const c = BASE_POS[b];
  if (!rounding) return { x: c.x, z: c.z };
  // toward the infield (the mound): the inside half of the bag, where the left foot pushes off into the turn
  const mx = 0 - c.x, mz = 18.44 - c.z;
  const l = Math.hypot(mx, mz) || 1;
  const k = clamp(BAG_HALF * 0.55, 0, BAG_HALF);
  return { x: c.x + (mx / l) * k, z: c.z + (mz / l) * k };
}
