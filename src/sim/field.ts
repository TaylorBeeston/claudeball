import { DEG, FT, clamp, hypot2 } from './math';

/**
 * Field geometry. Coordinates (metres): origin = home plate apex (back point), +Y up,
 * +Z toward center field, +X toward first base. Foul lines are x = +/- z.
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
  { x: BASE_XZ, z: BASE_XZ },
  { x: 0, z: 2 * BASE_XZ },
  { x: -BASE_XZ, z: BASE_XZ },
];

export const RUBBER = { x: 0, z: MOUND_DIST };

export interface FencePoint {
  /** Degrees from center field: 0 = CF, + toward first base, - toward third, +/-180 = behind home. */
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
