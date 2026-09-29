export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sq = (v: number) => v * v;
export const hypot2 = (x: number, z: number) => Math.sqrt(x * x + z * z);

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: Vec3) => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const dist2D = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
export const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / l);
};
/**
 * Plain component cross product. The sim frame (+X toward 3B, +Y up, +Z toward CF) is right-handed,
 * so angular velocity follows the ordinary right-hand rule (Magnus force = omega x v).
 */
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** Facing angle: atan2(x, z) — 0 faces +Z (center field), +90deg faces +X (third base side). */
export const facingTo = (dx: number, dz: number) => Math.atan2(dx, dz);

export const KMH_PER_MPH = 1.609344;
export const MPH = 0.44704; // m/s per mph
export const FT = 0.3048;
export const RPM = (2 * Math.PI) / 60; // rad/s per rpm
export const DEG = Math.PI / 180;
