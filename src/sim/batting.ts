import { BallBody } from './ball';
import { BALL_MASS, BALL_RADIUS, PLATE_DEPTH } from './field';
import { DEG, Vec3, clamp } from './math';
import { PitchSample, StrikeZone, ThrownPitch, pathAt, timeAtZ, zoneDistance } from './pitching';
import { Rng } from './rng';
import type { PlayerInfo } from './types';

// --- batter geometry & bat properties -------------------------------------------------------
export const BODY_X = 0.98; // bat rotation axis, lateral distance from plate centre (model parameter)
export const PIVOT_Y = 1.05;
export const PIVOT_Z = 0.05;
export const BAT_LEN = 0.84;
const BAT_MASS = 0.88;
const BAT_I_CM = 0.05;
const BAT_S_CM = 0.55;
const BAT_S_NODE = 0.66; // best point on the barrel (from knob)
const S_AIM = 0.635;
const TAU_CONTACT = 0.155; // swing start -> contact
const MU_BAT = 0.45;
const I_K = 0.4;

export const batRadius = (s: number) => 0.0145 + 0.0188 * clamp((s - 0.1) / 0.45, 0, 1);

export type Stance = 'L' | 'R';

export interface BattingContext {
  balls: number;
  strikes: number;
  outs: number;
  runnersOn: boolean;
  scoringPosition: boolean;
  inning: number;
  scoreDiff: number; // batting team runs - fielding team runs
}

export interface SwingPlan {
  swing: boolean;
  /** What the batter perceived at the decision moment (for debugging / overlays). */
  perceivedX: number;
  perceivedY: number;
  decisionTime: number;
  // when swing === true:
  startTime: number; // time since release at which the swing begins
  plannedContactTime: number;
  pivot: Vec3;
  rh: number;
  thetaC: number;
  epsC: number;
  omegaPk: number;
  alpha: number;
  sgn: number;
  tauC: number;
  batSpeed: number;
  protect: boolean;
}

export function stanceFor(bats: PlayerInfo['bats'], pitcherThrows: 'L' | 'R'): Stance {
  if (bats === 'S') return pitcherThrows === 'R' ? 'L' : 'R';
  return bats;
}

export const pivotFor = (stance: Stance): Vec3 => ({ x: stance === 'R' ? BODY_X : -BODY_X, y: PIVOT_Y, z: PIVOT_Z });

/** Bat speed at the sweet spot for a swing of normal effort (m/s). */
export function baseBatSpeed(power: number): number {
  return 26.4 + 0.098 * power; // power 50 -> 30.1 m/s (67 mph), 80 -> 33.0, 30 -> 28.1
}

/** Perception + decision: does the batter swing, and if so how. Uses only what a real hitter could know at the decision point. */
export function planSwing(b: PlayerInfo, stance: Stance, pitch: ThrownPitch, zone: StrikeZone, ctx: BattingContext, fbMphSeen: number, rng: Rng): SwingPlan {
  const R = b.ratings;
  const ne = clamp(1.55 - 0.011 * R.eye, 0.55, 1.5); // perception noise multiplier
  const pivot = pivotFor(stance);
  const tPlate = pitch.tPlate;
  const tDec = Math.max(0.12, tPlate - TAU_CONTACT - 0.045);
  const s0 = pitch.path[0];
  const sd = pathAt(pitch.path, tDec);

  // Observed state at the decision moment (noisy)
  const speedNow = Math.hypot(sd.vx, sd.vy, sd.vz);
  const speedNoise = 1 + rng.normal(0, 0.02 * ne);
  // batters lean on expectation (fastball) unless they recognise the pitch: eye -> recognition
  const pRec = clamp(0.35 + 0.0075 * R.eye + (pitch.type === 'CH' || pitch.type === 'FS' ? -0.12 : 0), 0.15, 0.95);
  const recognised = rng.next() < pRec;
  let vz = sd.vz;
  if (!recognised) {
    // pulled toward the expected fastball velocity
    const expectedVz = -(fbMphSeen * 0.44704) * 0.93;
    vz = vz * 0.55 + expectedVz * 0.45;
  }
  const obs = {
    x: sd.x + rng.normal(0, 0.016 * ne),
    y: sd.y + rng.normal(0, 0.012 * ne),
    z: sd.z + rng.normal(0, 0.03 * ne),
    vx: sd.vx * speedNoise + rng.normal(0, 0.12 * ne),
    vy: sd.vy * speedNoise + rng.normal(0, 0.12 * ne),
    vz: vz * speedNoise,
  };
  // acceleration model: z from observation (drag), x/y from expected pitch behaviour
  const az = (sd.vz - s0.vz) / tDec;
  let ax: number;
  let ay: number;
  if (recognised) {
    const dtF = Math.max(0.05, tPlate);
    const end = pathAt(pitch.path, tPlate);
    ax = ((end.vx - s0.vx) / dtF) * (1 + rng.normal(0, 0.18 * ne));
    ay = ((end.vy - s0.vy) / dtF) * (1 + rng.normal(0, 0.12 * ne));
  } else {
    // assumes a typical (mostly straight, slightly rising) fastball
    ax = rng.normal(0, 0.8);
    ay = -4.4;
  }
  const predictAtZ = (zPlane: number): { t: number; x: number; y: number } => {
    // solve obs.z + vz*t + 0.5*az*t^2 = zPlane
    const c = obs.z - zPlane;
    const disc = obs.vz * obs.vz - 2 * az * c;
    let t: number;
    if (Math.abs(az) < 1e-6) t = -c / obs.vz;
    else {
      const sq = Math.sqrt(Math.max(0, disc));
      const t1 = (-obs.vz - sq) / az;
      const t2 = (-obs.vz + sq) / az;
      t = Math.min(...[t1, t2].filter((v) => v > 0).concat([9]));
    }
    return { t: tDec + t, x: obs.x + obs.vx * t + 0.5 * ax * t * t, y: obs.y + obs.vy * t + 0.5 * ay * t * t };
  };
  const front = predictAtZ(PLATE_DEPTH);

  // --- decision -------------------------------------------------------------------------
  const disc = (R.discipline - 50) / 50;
  let thr = 0.035 - 0.05 * disc;
  if (ctx.strikes === 2) thr += 0.055;
  else if (ctx.balls === 3) thr -= ctx.strikes === 0 ? 0.2 : 0.09;
  else if (ctx.strikes === 0) thr -= ctx.balls === 0 ? 0.05 : 0.035;
  else thr -= 0.02;
  thr += 0.025 * b.traits.aggression * (ctx.strikes < 2 ? 1 : 0.4);
  const dPerceived = zoneDistance(zone, front.x, front.y) + rng.normal(0, 0.085);
  const protect = ctx.strikes === 2;
  const baseInfo = { perceivedX: front.x, perceivedY: front.y, decisionTime: tDec };
  if (dPerceived > thr) {
    return { swing: false, ...baseInfo, startTime: 0, plannedContactTime: 0, pivot, rh: 0, thetaC: 0, epsC: 0, omegaPk: 0, alpha: 0, sgn: 0, tauC: 0, batSpeed: 0, protect };
  }

  // --- swing planning ---------------------------------------------------------------------
  // choose the contact depth from the geometry so the sweet spot meets the ball at a comfortable hand extension
  let zc = 0.9;
  let pred = predictAtZ(zc);
  for (let i = 0; i < 4; i++) {
    const dx = pred.x - pivot.x;
    const dy = pred.y - pivot.y;
    const rTarget = 0.5 + S_AIM;
    const dz2 = rTarget * rTarget - dx * dx - dy * dy;
    zc = clamp(PIVOT_Z + Math.sqrt(Math.max(dz2, 0.04)), 0.1, 1.5);
    pred = predictAtZ(zc);
  }
  const aim = { x: pred.x, y: pred.y - b.traits.aimBelow, z: zc };
  const dx = aim.x - pivot.x;
  const dy = aim.y - pivot.y;
  const dz = aim.z - pivot.z;
  const r3 = Math.hypot(dx, dy, dz);
  const rh = clamp(r3 - S_AIM, 0.3, 0.82);
  const thetaC = Math.atan2(dx, dz);
  const epsC = Math.atan2(dy, Math.hypot(dx, dz)) + rng.normal(0, 0.009 * (1.5 - R.contact / 100) * (protect ? 0.9 : 1.0) + 0.004);

  const effort = protect ? 0.965 : 1.0;
  const batSpeed = baseBatSpeed(R.power) * effort * (1 + rng.normal(0, 0.03));
  const rSweet = rh + BAT_S_NODE;
  const alpha = (b.traits.attackAngleDeg + rng.normal(0, 3.2)) * DEG;
  const omegaPk = (batSpeed * Math.cos(alpha)) / (rSweet * Math.max(0.5, Math.cos(epsC)));
  const sigmaT = 0.0125 * (1.5 - R.contact / 100) * (protect ? 0.9 : 1);
  const timeErr = rng.normal(0, sigmaT) + rng.normal(0, 0.0011);
  const startTime = pred.t - TAU_CONTACT + timeErr;
  return {
    swing: true,
    ...baseInfo,
    startTime,
    plannedContactTime: pred.t,
    pivot,
    rh,
    thetaC,
    epsC,
    omegaPk,
    alpha,
    sgn: stance === 'R' ? 1 : -1,
    tauC: TAU_CONTACT,
    batSpeed,
    protect,
  };
}

// --- the bat in motion -----------------------------------------------------------------------
export interface BatPose {
  knob: Vec3;
  tip: Vec3;
  dir: Vec3; // unit vector knob -> tip
  /** Velocity of the bat point at distance s from the knob. */
  velAt(s: number): Vec3;
}

export class BatSwing {
  tau = 0; // time since swing start
  theta: number;
  eps: number;
  done = false;
  contacted = false;
  private rampExp = 1.6;

  constructor(readonly plan: SwingPlan) {
    const ac = (plan.omegaPk * plan.tauC) / (this.rampExp + 1);
    this.theta = plan.thetaC - plan.sgn * ac;
    this.eps = plan.epsC - Math.tan(plan.alpha) * ac;
  }

  omega(tau: number): number {
    const u = tau / this.plan.tauC;
    if (u <= 0) return 0;
    if (u <= 1) return this.plan.omegaPk * Math.pow(u, this.rampExp);
    return this.plan.omegaPk * Math.max(0, 1 - (u - 1) / 0.9);
  }

  /** Advance the swing by dt seconds. */
  advance(dt: number): void {
    const w = this.omega(this.tau + dt * 0.5);
    this.theta += this.plan.sgn * w * dt;
    this.eps += Math.tan(this.plan.alpha) * w * dt;
    this.tau += dt;
    if (this.tau > this.plan.tauC * 2.1) this.done = true;
  }

  /** 0..1 progress through the swing, for animation. */
  get progress(): number {
    return clamp(this.tau / (this.plan.tauC * 1.9), 0, 1);
  }

  pose(): BatPose {
    const { theta, eps } = this;
    const p = this.plan;
    const ce = Math.cos(eps);
    const se = Math.sin(eps);
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    const dir = { x: ce * st, y: se, z: ce * ct };
    const w = this.omega(this.tau);
    const th = p.sgn * w;
    const ep = Math.tan(p.alpha) * w;
    const dd = { x: -se * st * ep + ce * ct * th, y: ce * ep, z: -se * ct * ep - ce * st * th };
    const pv = p.pivot;
    const rh = p.rh;
    return {
      knob: { x: pv.x + rh * dir.x, y: pv.y + rh * dir.y, z: pv.z + rh * dir.z },
      tip: { x: pv.x + (rh + BAT_LEN) * dir.x, y: pv.y + (rh + BAT_LEN) * dir.y, z: pv.z + (rh + BAT_LEN) * dir.z },
      dir,
      velAt: (s: number) => {
        const r = rh + s;
        return { x: r * dd.x, y: r * dd.y, z: r * dd.z };
      },
    };
  }
}

export interface ContactResult {
  /** Distance from the knob to the contact point (m). */
  s: number;
  exitSpeed: number;
  launchDeg: number;
  sprayDeg: number; // 0 = up the middle (+z), + toward third base (+x, pull side for a righty)
  spinRpm: number;
  /** Normal offset (vertical, m) of the ball centre from the bat axis, + = above. */
  offsetY: number;
}

/**
 * Sphere vs capsule bat test. If the ball is touching an approaching bat, apply the impulse
 * (effective bat mass, position-dependent COR, Coulomb friction -> spin) and return the result.
 */
export function batBallCollision(ball: BallBody, bat: BatPose): ContactResult | null {
  const K = bat.knob;
  const d = bat.dir;
  const rx = ball.x - K.x;
  const ry = ball.y - K.y;
  const rz = ball.z - K.z;
  const sRaw = rx * d.x + ry * d.y + rz * d.z;
  const s = clamp(sRaw, 0, BAT_LEN);
  const qx = K.x + d.x * s;
  const qy = K.y + d.y * s;
  const qz = K.z + d.z * s;
  let nx = ball.x - qx;
  let ny = ball.y - qy;
  let nz = ball.z - qz;
  const dist = Math.hypot(nx, ny, nz);
  const rBat = batRadius(s);
  if (dist > BALL_RADIUS + rBat) return null;
  const bv = bat.velAt(s);
  if (dist < 1e-6) {
    const bl = Math.hypot(bv.x, bv.y, bv.z) || 1;
    nx = bv.x / bl;
    ny = bv.y / bl;
    nz = bv.z / bl;
  } else {
    nx /= dist;
    ny /= dist;
    nz /= dist;
  }
  const un = (ball.vx - bv.x) * nx + (ball.vy - bv.y) * ny + (ball.vz - bv.z) * nz;
  if (un >= 0) return null; // separating
  const dCm = s - BAT_S_CM;
  const mEff = 1 / (1 / BAT_MASS + (dCm * dCm) / BAT_I_CM);
  const r = BALL_MASS / mEff;
  const e = clamp(0.5 - 1.1 * Math.abs(s - BAT_S_NODE), 0.05, 0.5);
  const jn = ((1 + e) * -un) / (1 + r); // impulse per unit ball mass along +n
  // tangential slip at the contact point (ball surface velocity relative to bat surface)
  const rcx = -BALL_RADIUS * nx, rcy = -BALL_RADIUS * ny, rcz = -BALL_RADIUS * nz;
  let ux = ball.vx + (ball.wy * rcz - ball.wz * rcy) - bv.x;
  let uy = ball.vy + (ball.wz * rcx - ball.wx * rcz) - bv.y;
  let uz = ball.vz + (ball.wx * rcy - ball.wy * rcx) - bv.z;
  const unn = ux * nx + uy * ny + uz * nz;
  ux -= unn * nx;
  uy -= unn * ny;
  uz -= unn * nz;
  const ut = Math.hypot(ux, uy, uz);
  let jtx = 0, jty = 0, jtz = 0;
  if (ut > 1e-9) {
    const jt = Math.min(MU_BAT * jn, ut / (1 + 1 / I_K));
    jtx = (-ux / ut) * jt;
    jty = (-uy / ut) * jt;
    jtz = (-uz / ut) * jt;
  }
  ball.vx += jn * nx + jtx;
  ball.vy += jn * ny + jty;
  ball.vz += jn * nz + jtz;
  const k = I_K * BALL_RADIUS * BALL_RADIUS;
  ball.wx += (rcy * jtz - rcz * jty) / k;
  ball.wy += (rcz * jtx - rcx * jtz) / k;
  ball.wz += (rcx * jty - rcy * jtx) / k;
  // separate the ball from the bat surface
  const pen = BALL_RADIUS + rBat + 0.001;
  ball.x = qx + nx * pen;
  ball.y = qy + ny * pen;
  ball.z = qz + nz * pen;
  const sp = Math.hypot(ball.vx, ball.vy, ball.vz);
  return {
    s,
    exitSpeed: sp,
    launchDeg: Math.asin(clamp(ball.vy / sp, -1, 1)) / DEG,
    sprayDeg: Math.atan2(ball.vx, ball.vz) / DEG,
    spinRpm: Math.hypot(ball.wx, ball.wy, ball.wz) / ((2 * Math.PI) / 60),
    offsetY: ball.y - qy,
  };
}

// keep helper exports referenced
export type { PitchSample };
export { timeAtZ };
