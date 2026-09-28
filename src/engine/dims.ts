import { Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from './types';

/** Real MLB dimensions in metres. */
export const FT = 0.3048;
export const IN = 0.0254;

export const DIM = {
  baseLine: 90 * FT, // 27.432
  moundDist: 60.5 * FT, // rubber front to plate back point ≈ 18.44
  moundRadius: 9 * FT,
  moundHeight: 10 * IN,
  rubberLen: 24 * IN,
  rubberWid: 6 * IN,
  baseSize: 15 * IN,
  plateWidth: 17 * IN,
  skinRadius: 95 * FT,
  polesDist: 330 * FT,
  centerDist: 400 * FT,
  wallHeight: 3.0,
  warningTrack: 4.6,
  ballRadius: 0.0364,
  ballMass: 0.145,
  zoneBottom: 0.5,
  zoneTop: 1.05,
} as const;

/** Fence distance from home plate along angle phi (0 = dead center, ±π/4 = foul poles). */
export function wallDistance(phi: number): number {
  const a = Math.min(1, Math.abs(phi) / (Math.PI / 4));
  const base = DIM.polesDist + (DIM.centerDist - DIM.polesDist) * (1 - a * a);
  // slight asymmetry + power-alley notch, like a real park
  const notch = Math.exp(-Math.pow((phi + 0.32) / 0.14, 2)) * 5.5;
  return base + notch + (phi > 0 ? 2.5 * a : 0);
}

export const BASES = [
  { x: DIM.baseLine / Math.SQRT2, z: DIM.baseLine / Math.SQRT2 }, // first (sim x)
  { x: 0, z: DIM.baseLine * Math.SQRT2 }, // second
  { x: -DIM.baseLine / Math.SQRT2, z: DIM.baseLine / Math.SQRT2 }, // third
] as const;

/** sim → scene: the sim's +X (first base side) is on the right when looking at center field. */
export const toScene = (v: Vec3, out = new Vector3()): Vector3 => out.set(-v.x, v.y, v.z);
export const facingToScene = (yaw: number) => -yaw;
export const quatToScene = (q: Quat, out = new Quaternion()): Quaternion => out.set(q.x, -q.y, -q.z, q.w);

export const MPS_TO_MPH = 2.2369363;
export const M_TO_FT = 3.28084;

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
