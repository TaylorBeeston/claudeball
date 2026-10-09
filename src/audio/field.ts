/**
 * The playing surface and the fence for the foley (pure, tested): what the ball or a cleat lands on at a point, how far the fence is
 * at a direction, and where a foul fly ball comes down (the sim calls a foul dead the moment it is decided, so a ball into the stands
 * never flies there in the snapshot: its landing is worked out from the contact).
 *
 * Coordinates are the sim's: origin home plate, +Z toward centre field, +X toward third base. Bases 27.43 m apart.
 */
import { DEFAULT_FENCE } from '../sim/field';
import type { Vec3 } from './types';

export type Surface = 'grass' | 'dirt' | 'track' | 'plate' | 'mound';

const MOUND = { x: 0, z: 18.44 };
/** the skin's edge: 95 ft from the front of the pitcher's rubber */
const SKIN_R = 28.96;
const BASE = 19.4; // half the diagonal of the 27.43 m square
const BASES = [
  { x: -BASE, z: BASE },
  { x: 0, z: 2 * BASE },
  { x: BASE, z: BASE },
];

/** distance from a point to the segment a-b (x/z) */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax, vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - ax - t * vx, pz - az - t * vz);
}

/** fence distance (m) and height at a direction (degrees from centre field, + toward third base), interpolated */
export function fenceAt(angleDeg: number): { distance: number; height: number } {
  const pts = DEFAULT_FENCE.points;
  const a = Math.max(-180, Math.min(180, angleDeg));
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (a <= p1.angleDeg) {
      const k = (a - p0.angleDeg) / Math.max(1e-6, p1.angleDeg - p0.angleDeg);
      return { distance: p0.distance + (p1.distance - p0.distance) * k, height: p0.height + (p1.height - p0.height) * k };
    }
  }
  const l = pts[pts.length - 1];
  return { distance: l.distance, height: l.height };
}

/** what is underfoot / under the ball at (x, z) */
export function surfaceAt(x: number, z: number): Surface {
  const r = Math.hypot(x, z);
  const ang = (Math.atan2(x, z) * 180) / Math.PI;
  if (r > fenceAt(ang).distance - 4.6) return 'track';
  if (Math.abs(x) < 0.3 && z > -0.1 && z < 0.45) return 'plate';
  if (Math.hypot(x - MOUND.x, z - MOUND.z) < 2.75) return 'mound';
  // the dirt circle around home, the cut-outs at the bases, the base paths
  if (r < 3.96) return 'dirt';
  for (const b of BASES) if (Math.hypot(x - b.x, z - b.z) < 3.96) return 'dirt';
  const path = Math.min(segDist(x, z, 0, 0, BASES[0].x, BASES[0].z), segDist(x, z, 0, 0, BASES[2].x, BASES[2].z), segDist(x, z, BASES[0].x, BASES[0].z, BASES[1].x, BASES[1].z), segDist(x, z, BASES[2].x, BASES[2].z, BASES[1].x, BASES[1].z));
  if (path < 0.9) return 'dirt';
  // the skin behind the bags: inside the 95 ft arc around the rubber, outside the infield grass square, in fair territory
  const fair = Math.abs(ang) <= 45;
  const inGrass = Math.abs(x) + Math.abs(z - BASE) <= BASE - 1.3;
  if (fair && Math.hypot(x - MOUND.x, z - MOUND.z) < SKIN_R && !inGrass) return 'dirt';
  return 'grass';
}

/** the foley bucket of a bounce or a step on a surface */
export const surfaceBounce = (s: Surface): { id: 'ground_bounce' | 'dirt_thud' | 'plate_bounce'; bucket: number } =>
  s === 'grass' ? { id: 'ground_bounce', bucket: 0 } : s === 'track' ? { id: 'dirt_thud', bucket: 1 } : s === 'plate' || s === 'mound' ? { id: 'plate_bounce', bucket: 0 } : { id: 'dirt_thud', bucket: 0 };
export const surfaceStep = (s: Surface): number => (s === 'grass' ? 0 : s === 'track' ? 2 : 1);

/** rough carry (m) and hang time (s) of a batted ball (vacuum range with a drag allowance, as the crowd model's) */
export function carry(exitMph: number, launchDeg: number): { dist: number; hang: number } {
  const v = exitMph * 0.44704;
  const th = (launchDeg * Math.PI) / 180;
  return { dist: ((v * v * Math.sin(2 * th)) / 9.81) * 0.62, hang: Math.max(0.6, Math.min(7, ((2 * v * Math.sin(th)) / 9.81) * 0.85)) };
}

/**
 * Where a foul fly ball ends up: in the seats (beyond the fence at its direction: the side walls, the stands), into the backstop net
 * (straight back), or neither (it comes down on the field). `t` is the time of flight to there.
 */
export function foulLanding(exitMph: number, launchDeg: number, sprayDeg: number): { where: 'seats' | 'net' | 'field'; pos: Vec3; t: number } {
  const c = carry(exitMph, launchDeg);
  const s = (sprayDeg * Math.PI) / 180;
  const f = fenceAt(sprayDeg);
  if (launchDeg < 10 || c.dist < f.distance) {
    const d = Math.max(0, c.dist);
    return { where: 'field', pos: { x: Math.sin(s) * d, y: 0, z: Math.cos(s) * d }, t: c.hang };
  }
  // past the fence: the net behind home stops it, elsewhere it drops a few rows in
  if (Math.abs(sprayDeg) > 120 && f.height > 6) return { where: 'net', pos: { x: Math.sin(s) * f.distance, y: Math.min(f.height, 6), z: Math.cos(s) * f.distance }, t: c.hang * (f.distance / Math.max(1, c.dist)) };
  const d = Math.min(c.dist, f.distance + 18);
  return { where: 'seats', pos: { x: Math.sin(s) * d, y: 3 + (d - f.distance) * 0.45, z: Math.cos(s) * d }, t: c.hang * Math.min(1, d / Math.max(1, c.dist)) };
}
