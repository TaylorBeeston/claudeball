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
  /** the step in progress is the one aimed at a touch: where his body goes for it (kept until the foot comes down) */
  lock: { bx: number; bz: number; tx: number; tz: number; gait: Gait } | null;
  /** steps to the touch he is aiming at (0 = none): within two he goes for the bag and does not steer around anyone (bodies.ts) */
  aimK: number;
}

export const newStride = (): Stride => ({ next: 0, dist: 0, len: 0, last: null, prev: null, lock: null, aimK: 0 });

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

/**
 * Is he drawn mirrored? The engine mirrors a left-hander's model (a batter by the side he bats from, everyone else by his throwing
 * arm): its left foot is then the clip's right foot, mirrored.
 */
export function mirroredOf(w: World, p: PlayerRT): boolean {
  if (p.role === 'batter') return p.info.bats === 'S' ? w.pitcher.info.throws === 'R' : p.info.bats === 'L';
  return p.info.throws === 'L';
}

/** The clip offsets of foot `foot` (forward, to his left) in this gait, for a plain or a mirrored model. */
function offsets(g: Gait, foot: Foot, mirrored: boolean): { fwd: number; side: number } {
  if (!mirrored) return { fwd: g.fwd[foot], side: g.side[foot] };
  const k = (1 - foot) as Foot;
  return { fwd: g.fwd[k], side: -g.side[k] };
}

/** Where a foot lands for a body at (x, z) facing `facing` moving at `speed`. */
export function footPoint(x: number, z: number, facing: number, speed: number, foot: Foot, turning: boolean, mirrored = false): { x: number; z: number } {
  return footFrom(x, z, facing, gaitFor(speed, turning), foot, mirrored);
}

function footFrom(x: number, z: number, facing: number, g: Gait, foot: Foot, mirrored: boolean): { x: number; z: number } {
  const o = offsets(g, foot, mirrored);
  const fx = Math.sin(facing), fz = Math.cos(facing);
  // the player's left (+X when he faces +Z)
  const lx = fz, lz = -fx;
  return { x: x + fx * o.fwd + lx * o.side, z: z + fz * o.fwd + lz * o.side };
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
  // (the step aimed at a touch lands as planned even if he eased up or sped up on the way: the plan's gait)
  const f = s.lock ? footFrom(x, z, p.facing, s.lock.gait, s.next, mirroredOf(w, p)) : footPoint(x, z, p.facing, speed, s.next, turning, mirroredOf(w, p));
  const strike: Strike = { x: f.x, z: f.z, tick: w.tick, foot: s.next, dir: p.facing };
  s.prev = s.last;
  s.last = strike;
  s.lock = null;
  s.aimK = Math.max(0, s.aimK - 1);
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
/** How a runner times his steps onto a bag: from this many natural steps out, stretching / shortening them within lo..hi of natural. */
export const STEP_AIM = { maxSteps: 4.5, lo: 0.8, hi: 1.2 };

export function aimStep(w: World, p: PlayerRT, tx: number, tz: number, opts: { maxSteps?: number; lo?: number; hi?: number } = {}): { k: number; bx: number; bz: number } | null {
  const s = p.stride;
  const speed = Math.hypot(p.vx, p.vz);
  if (speed < 1.0 || s.len === 0) return null;
  // (the last step before the touch is committed: he does not re-plan it while it is in the air)
  if (s.lock && Math.hypot(s.lock.tx - tx, s.lock.tz - tz) < 0.05) {
    s.aimK = 1;
    return { k: 1, bx: s.lock.bx, bz: s.lock.bz };
  }
  s.aimK = 0;
  const turning = p.gait === 'turn';
  const L = naturalStep(speed, turning);
  const maxSteps = opts.maxSteps ?? STEP_AIM.maxSteps;
  const lo = opts.lo ?? STEP_AIM.lo, hi = opts.hi ?? STEP_AIM.hi;
  const g = gaitFor(speed, turning);
  const mir = mirroredOf(w, p);
  let best = 0, bestErr = Infinity, bestLen = 0, bestX = 0, bestZ = 0;
  for (let k = 1; k <= Math.ceil(maxSteps); k++) {
    const foot: Foot = (k % 2 === 1 ? s.next : 1 - s.next) as Foot;
    // where his body must be when that foot comes down: the foot lands ahead of and beside the body along the way he will be running
    // then, which is toward that very point (he steers there): settle the two in a couple of rounds
    const o = offsets(g, foot, mir);
    let fx = Math.sin(p.facing), fz = Math.cos(p.facing), bx = tx, bz = tz;
    for (let it = 0; it < 3; it++) {
      const ql = Math.hypot(bx - p.x, bz - p.z);
      if (ql > 0.3) {
        fx = (bx - p.x) / ql;
        fz = (bz - p.z) / ql;
      }
      bx = tx - fx * o.fwd - fz * o.side;
      bz = tz - fz * o.fwd + fx * o.side;
    }
    // (heading and body point agree: he runs straight at it, so the distance to it is what his steps must cover)
    const along = (bx - p.x) * fx + (bz - p.z) * fz;
    if (along <= 0) continue;
    if (along > maxSteps * L) break;
    // k steps of length l from here: (l - dist) + (k - 1) l = along
    const l = (along + s.dist) / k;
    if (l <= s.dist + 1e-3) continue;
    // (and how far off his present line that body point is: the foot that lands on the bag from where he is running is the easy one)
    const vl = Math.hypot(p.vx, p.vz) || 1;
    const off = Math.abs((bx - p.x) * (p.vz / vl) - (bz - p.z) * (p.vx / vl));
    const err = Math.abs(Math.log(l / L)) + (off / Math.max(0.5, k * L)) * 1.5;
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
  s.aimK = best;
  if (best === 1) s.lock = { bx: bestX, bz: bestZ, tx, tz, gait: g };
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
/** Half the width of the sole (m): the shoe is on the bag if its sole overlaps it. */
const SOLE_HALF = 0.05;

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
    if (distToBase(b, st.x + fx * a, st.z + fz * a) <= SOLE_HALF) return true;
  }
  return false;
}

/** Standing on (or stepping onto) the bag: a man at rest or moving slowly with his body over it or beside it puts a foot on it. */
export function standsOn(p: PlayerRT, b: number): boolean {
  return Math.hypot(p.vx, p.vz) < 4.0 && distToBase(b, p.x, p.z) <= 0.45;
}

/**
 * The point a runner's ankle aims for at base `b`, coming in along the unit vector `dIn`: the shoe's front just over the near edge
 * of the bag (runners are taught to hit the front of the bag: the shortest way to it), toward its inside corner when he rounds it.
 */
export function touchPoint(b: number, rounding: boolean, dIn: { x: number; z: number }): { x: number; z: number } {
  // (home: the runner from third comes in along the plate's slanted edge, so he aims near its middle)
  const c = b % 4 === 0 ? { x: 0, z: 0.25 } : BASE_POS[b];
  // ankle this far short of the middle: the front of the shoe about half-way onto the bag (a margin either way for a step a little off)
  const back = b % 4 === 0 ? 0.08 : BAG_HALF + TOE - 0.19;
  let x = c.x - dIn.x * back, z = c.z - dIn.z * back;
  if (rounding && b % 4 !== 0) {
    // toward the infield (the mound): the inside half of the bag, where the left foot pushes off into the turn
    const mx = 0 - c.x, mz = 18.44 - c.z;
    const l = Math.hypot(mx, mz) || 1;
    const k = clamp(BAG_HALF * 0.55, 0, BAG_HALF);
    x += (mx / l) * k;
    z += (mz / l) * k;
  }
  return { x, z };
}
