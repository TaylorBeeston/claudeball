/**
 * Camera-relative spatialisation, pure maths (unit-tested). The listener is the active broadcast camera; positional sounds
 * are panned by where they are relative to the camera's right vector and attenuated / darkened with distance.
 *
 * A TV mix has "effects mics" at the plate and the bases rather than at the camera, so the roll-off is gentle: a bat crack
 * heard from the centre-field camera is quieter and duller, but still clearly there.
 */
import type { Vec3 } from './types';

export interface Listener {
  pos: Vec3;
  /** unit vectors */
  right: Vec3;
  fwd: Vec3;
}

export interface Spatial {
  gain: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  /** low-pass cutoff (Hz): air absorption and "behind the camera" */
  cutoff: number;
  dist: number;
}

const REF = 14;
const ROLLOFF = 0.5;
const MIN_GAIN = 0.12;

export function spatialize(l: Listener, p: Vec3): Spatial {
  const dx = p.x - l.pos.x;
  const dy = p.y - l.pos.y;
  const dz = p.z - l.pos.z;
  const dist = Math.hypot(dx, dy, dz);
  const gain = Math.max(MIN_GAIN, REF / (REF + ROLLOFF * Math.max(0, dist - REF)));
  let pan = 0;
  let behind = 0;
  if (dist > 1e-3) {
    const inv = 1 / dist;
    pan = (dx * l.right.x + dy * l.right.y + dz * l.right.z) * inv;
    behind = (dx * l.fwd.x + dy * l.fwd.y + dz * l.fwd.z) * inv;
  }
  // very close sources stay centred (no hard swings when the camera passes over them)
  pan = Math.max(-0.9, Math.min(0.9, pan * 0.9 * Math.min(1, dist / 5)));
  const cutoff = Math.max(2500, 18000 / (1 + dist / 60)) * (behind < 0 ? 1 + 0.35 * behind : 1);
  return { gain, pan, cutoff, dist };
}

export const DEFAULT_LISTENER: Listener = { pos: { x: 0, y: 2, z: -20 }, right: { x: 1, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 1 } };

/** Listener from a column-major world matrix (three.js `camera.matrixWorld.elements`): right = col 0, forward = -col 2. */
export function listenerFromMatrix(e: ArrayLike<number>): Listener {
  return {
    pos: { x: e[12], y: e[13], z: e[14] },
    right: { x: e[0], y: e[1], z: e[2] },
    fwd: { x: 0 - e[8] || 0, y: 0 - e[9] || 0, z: 0 - e[10] || 0 },
  };
}
