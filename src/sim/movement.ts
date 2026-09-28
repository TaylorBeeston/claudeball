import { clamp } from './math';
import type { PlayerRT, World } from './world';
import { TICK } from './world';

export const sprintSpeed = (speedRating: number) => 6.65 + 0.031 * speedRating; // 50 -> 8.2 m/s (27 ft/s)
export const accelOf = (speedRating: number) => 6.6 + 0.03 * speedRating; // 50 -> 8.1 m/s^2

/** Time (s) for p to reach (tx,tz) from its current state, accounting for acceleration and current velocity. */
export function travelTime(p: { x: number; z: number; vx: number; vz: number; vmax: number; accel: number }, tx: number, tz: number, vmaxMul = 1): number {
  const dx = tx - p.x;
  const dz = tz - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.01) return 0;
  const vmax = p.vmax * vmaxMul;
  const a = p.accel;
  let v0 = (p.vx * dx + p.vz * dz) / d; // speed along the direction of travel
  let t = 0;
  let dist = d;
  if (v0 < 0) {
    // must stop and reverse first
    t += -v0 / a;
    dist += (v0 * v0) / (2 * a);
    v0 = 0;
  }
  v0 = Math.min(v0, vmax);
  const dAcc = (vmax * vmax - v0 * v0) / (2 * a);
  if (dist <= dAcc) {
    // v0 t + a t^2 / 2 = dist
    t += (-v0 + Math.sqrt(v0 * v0 + 2 * a * dist)) / a;
  } else {
    t += (vmax - v0) / a + (dist - dAcc) / vmax;
  }
  return t;
}

/** Advance a player's kinematics one tick toward its goal. */
export function stepPlayer(p: PlayerRT, w: World): void {
  const g = p.goal;
  let dvx = 0;
  let dvz = 0;
  const canMove = w.tick >= p.reactUntil;
  if (g && canMove) {
    const dx = g.x - p.x;
    const dz = g.z - p.z;
    const d = Math.hypot(dx, dz);
    const vmax = p.vmax * g.mul;
    let sp = vmax;
    if (g.stop) sp = Math.min(vmax, Math.sqrt(2 * p.accel * 1.4 * Math.max(0, d - 0.02)));
    if (d < 0.03 && g.stop) sp = 0;
    const tvx = d > 1e-6 ? (dx / d) * sp : 0;
    const tvz = d > 1e-6 ? (dz / d) * sp : 0;
    dvx = tvx - p.vx;
    dvz = tvz - p.vz;
  } else {
    // coast to a stop
    dvx = -p.vx;
    dvz = -p.vz;
  }
  const dvl = Math.hypot(dvx, dvz);
  const maxDv = p.accel * (g && canMove ? 1 : 1.3) * TICK;
  if (dvl > maxDv) {
    const s = maxDv / dvl;
    dvx *= s;
    dvz *= s;
  }
  p.vx += dvx;
  p.vz += dvz;
  p.x += p.vx * TICK;
  p.z += p.vz * TICK;
  const sp = Math.hypot(p.vx, p.vz);
  if (sp > 0.8) {
    const target = Math.atan2(p.vx, p.vz);
    p.facing = turnToward(p.facing, target, 14 * TICK);
  } else if (p.lookAt) {
    const target = Math.atan2(p.lookAt.x - p.x, p.lookAt.z - p.z);
    p.facing = turnToward(p.facing, target, 9 * TICK);
  }
}

export function turnToward(cur: number, target: number, maxStep: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return cur + clamp(d, -maxStep, maxStep);
}

export function setGoal(p: PlayerRT, x: number, z: number, stop = true, mul = 1): void {
  if (p.goal) {
    p.goal.x = x;
    p.goal.z = z;
    p.goal.stop = stop;
    p.goal.mul = mul;
  } else p.goal = { x, z, stop, mul };
}

export function clearGoal(p: PlayerRT): void {
  p.goal = null;
}
