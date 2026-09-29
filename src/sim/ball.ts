import { BALL_MASS, BALL_RADIUS, FenceConfig, fenceAt, fenceNormalAt, groundHeight, surfaceAt, Surface } from './field';
import { Rng } from './rng';
import { hypot2 } from './math';

/** Mutable ball state used by the integrator. */
export interface BallBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Angular velocity (rad/s), right-hand rule, sim axes. */
  wx: number;
  wy: number;
  wz: number;
  /** Rolling on the ground without bouncing. */
  rolling: boolean;
}

export interface Environment {
  rho: number; // air density kg/m^3
  windX: number;
  windY: number;
  windZ: number;
  fence: FenceConfig;
  /** Multiplier on drag coefficient (tuning). */
  cdScale: number;
  /** Multiplier on lift coefficient (tuning). */
  clScale: number;
}

export const DEFAULT_ENV = (fence: FenceConfig): Environment => ({
  rho: 1.2,
  windX: 0,
  windY: 0,
  windZ: 0,
  fence,
  cdScale: 1,
  clScale: 1,
});

export const G = 9.80665;
const AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const I_K = 0.4; // moment of inertia factor (I = k m r^2)

export interface BallStepFlags {
  bounced: boolean;
  bounceSpeed: number;
  surface: Surface;
  wallHit: boolean;
  wallSpeed: number;
  /** Crossed the top of the fence line this step (over the wall). */
  overFence: boolean;
}

export const newFlags = (): BallStepFlags => ({
  bounced: false,
  bounceSpeed: 0,
  surface: 'grass',
  wallHit: false,
  wallSpeed: 0,
  overFence: false,
});

export function dragCoefficient(speed: number): number {
  // Slightly higher at low Reynolds numbers, ~0.32 at hit-ball speeds (Nathan / Sawicki range).
  return 0.36 + 0.22 * Math.exp(-((speed / 18) ** 2));
}

export function liftCoefficient(spinParam: number): number {
  // CL = 1 / (2.32 + 0.4 / S)   (Nathan 2008 fit)
  return spinParam / (2.32 * spinParam + 0.4);
}

const acc = [0, 0, 0];
function accel(vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, env: Environment) {
  const rx = vx - env.windX;
  const ry = vy - env.windY;
  const rz = vz - env.windZ;
  const s = Math.sqrt(rx * rx + ry * ry + rz * rz);
  let ax = 0;
  let ay = -G;
  let az = 0;
  if (s > 1e-6) {
    const kd = (0.5 * env.rho * AREA * dragCoefficient(s) * env.cdScale * s) / BALL_MASS;
    ax -= kd * rx;
    ay -= kd * ry;
    az -= kd * rz;
    // Magnus: direction = normalize(w x v_rel), magnitude from transverse spin.
    const cx = wy * rz - wz * ry;
    const cy = wz * rx - wx * rz;
    const cz = wx * ry - wy * rx;
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz); // = |w_perp| * s
    if (cl > 1e-9) {
      const spinParam = (BALL_RADIUS * cl) / (s * s); // r |w_perp| / s
      const CL = liftCoefficient(spinParam) * env.clScale;
      const km = (0.5 * env.rho * AREA * CL * s * s) / BALL_MASS / cl;
      ax += km * cx;
      ay += km * cy;
      az += km * cz;
    }
  }
  acc[0] = ax;
  acc[1] = ay;
  acc[2] = az;
}

/** Advance pure flight (no ground/wall) by dt with RK4. */
export function flightStep(b: BallBody, dt: number, env: Environment): void {
  const { wx, wy, wz } = b;
  const x0 = b.x, y0 = b.y, z0 = b.z, vx0 = b.vx, vy0 = b.vy, vz0 = b.vz;
  accel(vx0, vy0, vz0, wx, wy, wz, env);
  const a1x = acc[0], a1y = acc[1], a1z = acc[2];
  const v2x = vx0 + 0.5 * dt * a1x, v2y = vy0 + 0.5 * dt * a1y, v2z = vz0 + 0.5 * dt * a1z;
  accel(v2x, v2y, v2z, wx, wy, wz, env);
  const a2x = acc[0], a2y = acc[1], a2z = acc[2];
  const v3x = vx0 + 0.5 * dt * a2x, v3y = vy0 + 0.5 * dt * a2y, v3z = vz0 + 0.5 * dt * a2z;
  accel(v3x, v3y, v3z, wx, wy, wz, env);
  const a3x = acc[0], a3y = acc[1], a3z = acc[2];
  const v4x = vx0 + dt * a3x, v4y = vy0 + dt * a3y, v4z = vz0 + dt * a3z;
  accel(v4x, v4y, v4z, wx, wy, wz, env);
  const a4x = acc[0], a4y = acc[1], a4z = acc[2];
  b.x = x0 + (dt / 6) * (vx0 + 2 * v2x + 2 * v3x + v4x);
  b.y = y0 + (dt / 6) * (vy0 + 2 * v2y + 2 * v3y + v4y);
  b.z = z0 + (dt / 6) * (vz0 + 2 * v2z + 2 * v3z + v4z);
  b.vx = vx0 + (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
  b.vy = vy0 + (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
  b.vz = vz0 + (dt / 6) * (a1z + 2 * a2z + 2 * a3z + a4z);
}

const SURF = {
  grass: { e0: 0.6, eSlope: 0.010, eMin: 0.22, mu: 0.55, roll: 0.16, tilt: 0.035 },
  dirt: { e0: 0.56, eSlope: 0.007, eMin: 0.28, mu: 0.5, roll: 0.11, tilt: 0.035 },
};

/** Ground impact with sliding/sticking friction, spin coupling and (physical) surface irregularity. */
export function groundBounce(b: BallBody, surface: Surface, rng: Rng | null): void {
  const p = SURF[surface];
  // Surface normal, tilted by irregularity (bad hops). Predictions pass rng=null (flat ground).
  let nx = 0;
  let nz = 0;
  if (rng) {
    nx = rng.normal(0, p.tilt);
    nz = rng.normal(0, p.tilt);
  }
  const nl = Math.sqrt(1 + nx * nx + nz * nz);
  nx /= nl;
  const ny = 1 / nl;
  nz /= nl;
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn >= 0) return;
  const e = Math.max(p.eMin, p.e0 - p.eSlope * -vn);
  const jn = -(1 + e) * vn; // impulse per unit mass along +n
  // contact-point velocity: v + w x (-r n)
  const rcx = -BALL_RADIUS * nx, rcy = -BALL_RADIUS * ny, rcz = -BALL_RADIUS * nz;
  let ux = b.vx + (b.wy * rcz - b.wz * rcy);
  let uy = b.vy + (b.wz * rcx - b.wx * rcz);
  let uz = b.vz + (b.wx * rcy - b.wy * rcx);
  const un = ux * nx + uy * ny + uz * nz;
  ux -= un * nx;
  uy -= un * ny;
  uz -= un * nz;
  const ut = Math.sqrt(ux * ux + uy * uy + uz * uz);
  let jtx = 0, jty = 0, jtz = 0;
  if (ut > 1e-9) {
    const jt = Math.min(p.mu * jn, ut / (1 + 1 / I_K));
    jtx = (-ux / ut) * jt;
    jty = (-uy / ut) * jt;
    jtz = (-uz / ut) * jt;
  }
  b.vx += jn * nx + jtx;
  b.vy += jn * ny + jty;
  b.vz += jn * nz + jtz;
  // torque: (r_c x J) / (k r^2)   (per unit mass)
  const k = I_K * BALL_RADIUS * BALL_RADIUS;
  b.wx += (rcy * jtz - rcz * jty) / k;
  b.wy += (rcz * jtx - rcx * jtz) / k;
  b.wz += (rcx * jty - rcy * jtx) / k;
}

/** Step one ball with ground contact, rolling and (optionally) the outfield wall. */
export function stepBall(b: BallBody, dt: number, env: Environment, rng: Rng | null, flags: BallStepFlags, checkFence = true): void {
  flags.bounced = false;
  flags.wallHit = false;
  flags.overFence = false;
  if (b.rolling) {
    rollStep(b, dt, env);
  } else {
    flightStep(b, dt, env);
    const gy = groundHeight(b.x, b.z); // the pitcher's mound is higher than the rest of the field
    if (b.y <= gy + BALL_RADIUS && b.vy < 0) {
      const surface = surfaceAt(b.x, b.z);
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
      b.y = gy + BALL_RADIUS;
      groundBounce(b, surface, rng);
      flags.bounced = true;
      flags.bounceSpeed = speed;
      flags.surface = surface;
      if (b.vy < 0.9) {
        b.vy = 0;
        b.rolling = true;
      }
    }
  }
  if (checkFence) wallCheck(b, env, flags, rng);
}

function rollStep(b: BallBody, dt: number, env: Environment): void {
  const surface = surfaceAt(b.x, b.z);
  const hs = hypot2(b.vx, b.vz);
  b.y = groundHeight(b.x, b.z) + BALL_RADIUS;
  b.vy = 0;
  if (hs < 1e-4) {
    b.vx = b.vz = 0;
    b.wx = b.wy = b.wz = 0;
    return;
  }
  const dec = SURF[surface].roll * G + 0.5 * (0.5 * env.rho * AREA * dragCoefficient(hs) * hs * hs) / BALL_MASS / Math.max(hs, 1);
  const nhs = Math.max(0, hs - dec * dt);
  const dx = b.vx / hs;
  const dz = b.vz / hs;
  const avg = 0.5 * (hs + nhs);
  b.x += dx * avg * dt;
  b.z += dz * avg * dt;
  b.vx = dx * nhs;
  b.vz = dz * nhs;
  // pure rolling: w = (yhat x v) / r
  b.wx = (1 * b.vz - 0) / BALL_RADIUS;
  b.wy = 0;
  b.wz = (0 - 1 * b.vx) / BALL_RADIUS;
}

function wallCheck(b: BallBody, env: Environment, flags: BallStepFlags, rng: Rng | null): void {
  const rho = hypot2(b.x, b.z);
  if (rho < 15) return;
  const f = fenceAt(env.fence, b.x, b.z);
  if (rho < f.distance) return;
  const rx = b.x / rho;
  const rz = b.z / rho;
  // the wall runs straight between the fence points: its normal is not the radial direction (a ball skimming along a slanted
  // stretch of wall must not slip out of the park)
  const wn = fenceNormalAt(env.fence, b.x, b.z);
  const vn0 = b.vx * wn.x + b.vz * wn.z;
  const top = b.y > f.height + BALL_RADIUS;
  const px = f.distance - BALL_RADIUS * 1.5;
  if (vn0 <= 0) {
    // moving along / back into the park but not yet inside: pin it to the wall surface
    if (!top) {
      b.x = rx * px;
      b.z = rz * px;
    }
    return;
  }
  if (top) {
    flags.overFence = true;
    return;
  }
  // wall impact: the panels are not perfectly flat, so the real ball leaves at a slightly different angle than the
  // predicted one (predictions pass rng = null: a flat wall). Reflect the outward component, damp the rest.
  let nx = wn.x;
  let nz = wn.z;
  if (rng) {
    const a = rng.normal(0, WALL_ROUGHNESS);
    const c = Math.cos(a);
    const s = Math.sin(a);
    nx = wn.x * c - wn.z * s;
    nz = wn.x * s + wn.z * c;
  }
  const vn = b.vx * nx + b.vz * nz;
  const e = WALL_RESTITUTION;
  if (vn > 0) {
    b.vx -= (1 + e) * vn * nx;
    b.vz -= (1 + e) * vn * nz;
  }
  b.vx *= 0.9;
  b.vz *= 0.9;
  b.vy *= 0.9;
  b.x = rx * px;
  b.z = rz * px;
  if (b.rolling && b.vy > 0) b.rolling = false;
  flags.wallHit = true;
  flags.wallSpeed = vn0;
}

/** Wall restitution and panel roughness (rad of normal jitter for the real ball; the fielders' predictions assume a flat wall). */
export const WALL_RESTITUTION = 0.38;
export const WALL_ROUGHNESS = 0.11;

export interface PathSample {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rolling: boolean;
  /** Set on the step where the ball meets the outfield wall: 'hit' (rebounds) or 'over' (clears the top). */
  wall?: 'hit' | 'over';
}

/** Deterministic forward prediction (no surface irregularity). Stops at rest / out of park / tMax. */
export function predictPath(b: BallBody, env: Environment, tMax: number, dt = 1 / 60): PathSample[] {
  const c: BallBody = { ...b };
  const out: PathSample[] = [];
  const flags = newFlags();
  let t = 0;
  out.push({ t, x: c.x, y: c.y, z: c.z, vx: c.vx, vy: c.vy, vz: c.vz, rolling: c.rolling });
  while (t < tMax) {
    stepBall(c, dt, env, null, flags);
    t += dt;
    const smp: PathSample = { t, x: c.x, y: c.y, z: c.z, vx: c.vx, vy: c.vy, vz: c.vz, rolling: c.rolling };
    if (flags.overFence) smp.wall = 'over';
    else if (flags.wallHit) smp.wall = 'hit';
    out.push(smp);
    if (flags.overFence) break;
    if (c.rolling && c.vx * c.vx + c.vz * c.vz < 0.0004) break;
  }
  return out;
}
