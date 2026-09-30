import { DEG, FT, clamp, hypot2 } from './math';

/**
 * Field geometry. Coordinates (metres): origin = home plate apex (back point), +Y up,
 * +Z toward center field, +X toward THIRD base (first base is at -X). Right-handed; from behind
 * the plate looking toward center, first base is on the right. Foul lines are x = +/- z.
 */
export const BASE_DIST = 90 * FT; // 27.432 m
export const BASE_XZ = BASE_DIST / Math.SQRT2; // 19.399 m
export const MOUND_DIST = 60.5 * FT; // 18.44 m: plate apex -> front of pitching rubber
export const PLATE_HALF_WIDTH = (17 / 2) * 0.0254; // 0.2159 m
export const PLATE_DEPTH = 17 * 0.0254; // 0.4318 m (apex at z=0, front edge at z=PLATE_DEPTH)
export const BALL_RADIUS = 0.0366;
export const BALL_MASS = 0.145;

/** Base index: 0 = home, 1 = first, 2 = second, 3 = third. */
export const BASE_POS: readonly { x: number; z: number }[] = [
  { x: 0, z: 0 },
  { x: -BASE_XZ, z: BASE_XZ }, // first base
  { x: 0, z: 2 * BASE_XZ },
  { x: BASE_XZ, z: BASE_XZ }, // third base
];

export const RUBBER = { x: 0, z: MOUND_DIST };

export interface FencePoint {
  /** Degrees from center field: 0 = CF, + toward third base (+X), - toward first base, +/-180 = behind home. */
  angleDeg: number;
  /** Distance from home plate apex (m). */
  distance: number;
  /** Wall height (m). */
  height: number;
}

export interface FenceConfig {
  points: FencePoint[];
}

export const DEFAULT_FENCE: FenceConfig = {
  points: [
    { angleDeg: -180, distance: 21, height: 14 },
    { angleDeg: -135, distance: 26, height: 3 },
    { angleDeg: -90, distance: 36, height: 2.4 },
    { angleDeg: -60, distance: 52, height: 2.4 },
    { angleDeg: -50, distance: 75, height: 2.4 },
    { angleDeg: -45, distance: 100.6, height: 2.4 }, // 330 ft LF pole
    { angleDeg: -30, distance: 110, height: 2.4 },
    { angleDeg: -15, distance: 118, height: 2.4 },
    { angleDeg: 0, distance: 121.9, height: 2.4 }, // 400 ft CF
    { angleDeg: 15, distance: 118, height: 2.4 },
    { angleDeg: 30, distance: 110, height: 2.4 },
    { angleDeg: 45, distance: 100.6, height: 2.4 }, // 330 ft RF pole
    { angleDeg: 50, distance: 75, height: 2.4 },
    { angleDeg: 60, distance: 52, height: 2.4 },
    { angleDeg: 90, distance: 36, height: 2.4 },
    { angleDeg: 135, distance: 26, height: 3 },
    { angleDeg: 180, distance: 21, height: 14 },
  ],
};

export function fenceAt(fence: FenceConfig, x: number, z: number): { distance: number; height: number } {
  const ang = Math.atan2(x, z) / DEG;
  const pts = fence.points;
  if (ang <= pts[0].angleDeg) return { distance: pts[0].distance, height: pts[0].height };
  for (let i = 1; i < pts.length; i++) {
    if (ang <= pts[i].angleDeg) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (ang - a.angleDeg) / (b.angleDeg - a.angleDeg);
      return { distance: a.distance + (b.distance - a.distance) * t, height: a.height + (b.height - a.height) * t };
    }
  }
  const l = pts[pts.length - 1];
  return { distance: l.distance, height: l.height };
}

/** Fair territory test for a ground position (foul lines run along x = +/- z from the apex). */
export function isFairXZ(x: number, z: number): boolean {
  return z >= 0 && Math.abs(x) <= z + 1e-9;
}

export type Surface = 'dirt' | 'grass';

/** Infield skin: home circle, mound, base cut-outs, base paths, and the infield arc. */
export function surfaceAt(x: number, z: number): Surface {
  if (hypot2(x, z) < 8.2) return 'dirt';
  if (hypot2(x, z - MOUND_DIST) < 2.75) return 'dirt';
  for (let b = 1; b <= 3; b++) {
    if (hypot2(x - BASE_POS[b].x, z - BASE_POS[b].z) < 3.2) return 'dirt';
  }
  // base paths (home-1B, 1B-2B, 2B-3B, 3B-home)
  for (let b = 0; b < 4; b++) {
    const a = BASE_POS[b];
    const c = BASE_POS[(b + 1) % 4];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
    if (hypot2(x - (a.x + dx * t), z - (a.z + dz * t)) < 0.6) return 'dirt';
  }
  // infield arc (dirt beyond the grass cut-out, 95 ft from the rubber)
  const dm = hypot2(x, z - MOUND_DIST);
  if (dm < 28.96 && dm > 22.5 && z > MOUND_DIST - 6) return 'dirt';
  return 'grass';
}

/** Outward unit normal of the fence segment at a ground position (the wall runs between the polyline's points, not along a circle). */
export function fenceNormalAt(fence: FenceConfig, x: number, z: number): { x: number; z: number } {
  const ang = Math.atan2(x, z) / DEG;
  const pts = fence.points;
  let i = 1;
  while (i < pts.length - 1 && ang > pts[i].angleDeg) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const ax = a.distance * Math.sin(a.angleDeg * DEG);
  const az = a.distance * Math.cos(a.angleDeg * DEG);
  const bx = b.distance * Math.sin(b.angleDeg * DEG);
  const bz = b.distance * Math.cos(b.angleDeg * DEG);
  let nx = bz - az;
  let nz = -(bx - ax);
  const l = Math.hypot(nx, nz) || 1;
  nx /= l;
  nz /= l;
  if (nx * x + nz * z < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { x: nx, z: nz };
}

// ---------------------------------------------------------------------------------------------
// the pitcher's mound
// ---------------------------------------------------------------------------------------------

/** The rubber is 10 inches above home plate level. */
export const MOUND_HEIGHT = 10 * 0.0254; // 0.254 m
// The profile is the one the stadium model is built with (assets/src/field.py `mound_h`): an 18 ft diameter circle centred 59 ft from the plate apex; a level
// area 5 ft wide and 34 in long whose front edge is 6 in in front of the rubber's front edge (rubber front edge 60 ft 6 in from the apex); from that
// rectangle the surface falls 1 in per foot in every direction; the height is min(that cone, a smoothstep skirt over the last 1.5 ft of the
// 18 ft circle), so the mound ends on its circle (h = max(0, min(H - 1in/ft * d, H * smoothstep((9 ft - r) / 1.5 ft)))).
const FT_M = 0.3048;
const IN_M = 0.0254;
const MOUND_CX = 0;
const MOUND_CZ = 59 * FT_M;
const MOUND_R = 9 * FT_M;
const LEVEL_X = 2.5 * FT_M;
const LEVEL_Z0 = 60.0 * FT_M;
const LEVEL_Z1 = 60.0 * FT_M + 34 * IN_M;

/**
 * Height of the ground (m) at a field position. Flat everywhere except the pitcher's mound (MLB spec, and the stadium model): a level top 10 in
 * above home plate around the rubber, falling 1 in per foot away from it on every side (toward the plate, the sides and behind) to the field level at the
 * edge of the 18 ft circle. Players standing on it, the ball's bounce and the pitcher's release height are all measured from here.
 */
export function groundHeight(x: number, z: number): number {
  if (z < 13 || z > 24 || x < -5.5 || x > 5.5) return 0;
  const dx = Math.max(Math.abs(x) - LEVEL_X, 0);
  const dz = Math.max(LEVEL_Z0 - z, z - LEVEL_Z1, 0);
  const d = Math.hypot(dx, dz);
  const r = Math.hypot(x - MOUND_CX, z - MOUND_CZ);
  let e = Math.min(1, Math.max(0, (MOUND_R - r) / (1.5 * FT_M)));
  e = e * e * (3 - 2 * e);
  return Math.max(0, Math.min(MOUND_HEIGHT - d * (IN_M / FT_M), MOUND_HEIGHT * e));
}
