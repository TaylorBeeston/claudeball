import { emit } from './events';
import { fenceAt } from './field';
import { LEGS_PER_SPRINT_SECOND, brakeDecel, LEGS_RECOVERY_PER_SECOND, legsSpeedFactor } from './attributes';
import { clamp } from './math';
import type { PlayerRT, World } from './world';
import { TICK } from './world';

/** Distance a player's centre stays from the outfield wall (body radius + glove). */
export const WALL_STAND = 0.5;

/** Keep (x, z) at least `margin` inside the outfield wall; returns the (possibly moved) point. */
export function insideFence(w: World, x: number, z: number, margin = WALL_STAND): { x: number; z: number } {
  const rho = Math.hypot(x, z);
  if (rho < 15) return { x, z };
  const lim = fenceAt(w.env.fence, x, z).distance - margin;
  if (rho <= lim) return { x, z };
  return { x: (x / rho) * lim, z: (z / rho) * lim };
}

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
    const vmax = p.vmax * g.mul * legsSpeedFactor(p.legs, p.info.ratings.durability);
    let sp = vmax;
    // plan the stop with the braking a person can actually do, starting far enough out to arrive near the spot at a walk
    if (g.stop) sp = Math.min(vmax, Math.sqrt(2 * Math.min(brakeDecel(p.info.ratings), p.accel * 0.9) * Math.max(0, d - 0.02)));
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
  // the outfield wall is solid: nobody runs through it
  const rho = Math.hypot(p.x, p.z);
  if (rho > 15 && p.onField) {
    const lim = fenceAt(w.env.fence, p.x, p.z).distance - WALL_STAND;
    if (rho > lim) {
      const nx = p.x / rho;
      const nz = p.z / rho;
      const vn = p.vx * nx + p.vz * nz;
      p.x = nx * lim;
      p.z = nz * lim;
      if (vn > 0) {
        p.vx -= vn * nx;
        p.vz -= vn * nz;
        if (vn > 1.5 && w.tick - p.wallTick > 120) {
          emit(w, { type: 'wallContact', who: 'fielder', fielderId: p.info.id, pos: { x: p.x, y: 0, z: p.z }, speed: vn });
        }
      }
      if (vn > 0.3) p.wallTick = w.tick;
    }
  }
  const sp = Math.hypot(p.vx, p.vz);
  // hard running tires the legs (durability decides how much it costs); walking and standing recover
  if (sp > 0.85 * p.vmax) p.legs = Math.min(1, p.legs + TICK * LEGS_PER_SPRINT_SECOND);
  else if (sp < 0.5 * p.vmax) p.legs = Math.max(0, p.legs - TICK * LEGS_RECOVERY_PER_SECOND);
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

export const sprintSpeedOf = (p: { info: { ratings: { speed: number } } }) => sprintSpeed(p.info.ratings.speed);
