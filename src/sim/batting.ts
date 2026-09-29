import { BallBody } from './ball';
import { breakingNoiseScale, breakingRecognition, clutchScale, consistencyScale, formContactShift, formPowerShift, gapAttackAngle, gapSpread, pullTimeShift } from './attributes';
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
// Batter's body: the hands (knob) are held within arm's reach of the shoulders. SHOULDER_* match the rendered batter
// (BATTER_X = 0.72 m off the plate centre, shoulders ~1.36 m up and ~0.13 m in front of the feet).
export const SHOULDER_X = 0.72;
export const SHOULDER_Y = 1.36;
export const SHOULDER_Z = 0.13;
export const ARM_REACH = 0.68; // shoulder axis -> knob (the arm reaches ~0.6 to the grip, plus a little lean)
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
  /** Bunt: the bat is squared around and held still at (x, y, z); psi = direction the ball should be deadened toward (rad, + toward third base). */
  bunt?: { psi: number; x: number; y: number; z: number; stance: Stance };
}

export function stanceFor(bats: PlayerInfo['bats'], pitcherThrows: 'L' | 'R'): Stance {
  if (bats === 'S') return pitcherThrows === 'R' ? 'L' : 'R';
  return bats;
}

export const shoulderFor = (stance: Stance): Vec3 => ({ x: stance === 'R' ? SHOULDER_X : -SHOULDER_X, y: SHOULDER_Y, z: SHOULDER_Z });

export const pivotFor = (stance: Stance): Vec3 => ({ x: stance === 'R' ? BODY_X : -BODY_X, y: PIVOT_Y, z: PIVOT_Z });

/** Bat speed at the sweet spot for a swing of normal effort (m/s). */
export function baseBatSpeed(power: number): number {
  return 26.1 + 0.098 * power; // power 50 -> 30.1 m/s (67 mph), 80 -> 33.0, 30 -> 28.1
}

/** Time (s after release) at which the batter must commit: swing or take. */
export const decisionTime = (pitch: ThrownPitch) => Math.max(0.12, pitch.tPlate - TAU_CONTACT - 0.045);

/** What the batter perceives of the pitch at the decision moment (noisy, extrapolated) — the basis of every swing decision. */
export interface SwingObservation {
  /** Time since release at which he committed. */
  tDec: number;
  pivot: Vec3;
  /** Where he thinks the pitch crosses the front of the plate. */
  front: { t: number; x: number; y: number };
  /** Distance outside the zone as he judges it (m; negative inside), including judgement noise. */
  dPerceived: number;
  recognised: boolean;
  speedMph: number;
  /** Extrapolate the observed flight to depth z: time since release, x, y. */
  predictAtZ: (zPlane: number) => { t: number; x: number; y: number };
}

/** Perception: every draw of perception noise happens here, BEFORE any decision is asked, so the noise stream never depends on the answer. */
export function perceivePitch(b: PlayerInfo, stance: Stance, pitch: ThrownPitch, zone: StrikeZone, fbMphSeen: number, rng: Rng): SwingObservation {
  const R = b.ratings;
  const ne = clamp(1.55 - 0.011 * R.eye, 0.55, 1.5); // perception noise multiplier
  const pivot = pivotFor(stance);
  const tDec = decisionTime(pitch);
  const s0 = pitch.path[0];
  const sd = pathAt(pitch.path, tDec);

  // Observed state at the decision moment (noisy)
  const speedNoise = 1 + rng.normal(0, 0.02 * ne);
  // batters lean on expectation (fastball) unless they recognise the pitch: eye -> recognition
  const offspeed = pitch.type === 'CH' || pitch.type === 'FS' || pitch.type === 'SL' || pitch.type === 'CU' || pitch.type === 'SW';
  const pRec = clamp(0.35 + 0.0075 * R.eye + (pitch.type === 'CH' || pitch.type === 'FS' ? -0.12 : 0) + (offspeed ? breakingRecognition(R.breaking) : 0), 0.15, 0.95);
  const bs = offspeed ? breakingNoiseScale(R.breaking) : 1; // a poor breaking-ball eye misreads the movement
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
    const dtF = Math.max(0.05, pitch.tPlate);
    const end = pathAt(pitch.path, pitch.tPlate);
    ax = ((end.vx - s0.vx) / dtF) * (1 + rng.normal(0, 0.18 * ne * bs));
    ay = ((end.vy - s0.vy) / dtF) * (1 + rng.normal(0, 0.12 * ne * bs));
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
  const dPerceived = zoneDistance(zone, front.x, front.y) + rng.normal(0, 0.125 * bs);
  return { tDec, pivot, front, dPerceived, recognised, speedMph: Math.hypot(obs.vx, obs.vy, obs.vz) / 0.44704, predictAtZ };
}

/** The built-in batter's swing / take rule (count, discipline, aggression, situation) applied to what he perceived. */
export function aiSwingDecision(b: PlayerInfo, ctx: BattingContext, dPerceived: number): { swing: boolean; protect: boolean } {
  const R = b.ratings;
  const disc = (R.discipline - 50) / 50;
  let thr = 0.03 - 0.05 * disc;
  if (ctx.strikes === 2) thr += 0.06;
  else if (ctx.balls === 3) thr -= ctx.strikes === 0 ? 0.2 : 0.09;
  else if (ctx.strikes === 0) thr -= ctx.balls === 0 ? 0.05 : 0.035;
  else thr -= 0.02;
  thr += 0.025 * b.traits.aggression * (ctx.strikes < 2 ? 1 : 0.4);
  return { swing: dPerceived <= thr, protect: ctx.strikes === 2 };
}

export interface SwingChoice {
  swing: boolean;
  timing?: number;
  aimX?: number;
  aimY?: number;
  effort?: number;
  protect?: boolean;
}

/** Turn a swing decision into a physical swing: the batter's execution noise (timing, plane, bat speed) is drawn here, AFTER the decision. */
/** What the moment does to the swing: his form today and the pressure he is under. */
export interface SwingMods {
  form: number;
  pressure: number;
}

export function buildSwing(b: PlayerInfo, stance: Stance, pitch: ThrownPitch, obsv: SwingObservation, choice: SwingChoice, ctx: BattingContext, rng: Rng, buntPsi: number | null = null, now = 0, mods: SwingMods = { form: 0, pressure: 0 }): SwingPlan {
  // effective ratings today: form moves contact / power; consistency and composure scale every noise term below
  const R = { ...b.ratings, contact: clamp(b.ratings.contact + formContactShift(mods.form), 20, 90), power: clamp(b.ratings.power + formPowerShift(mods.form), 20, 90) };
  const noise = consistencyScale(R.consistency) * clutchScale(R.clutch, mods.pressure) * Math.exp(rng.normal(0, 0.12 * consistencyScale(R.consistency)));
  const { pivot, tDec, front, predictAtZ } = obsv;
  const protect = choice.protect ?? ctx.strikes === 2;
  const baseInfo = { perceivedX: front.x, perceivedY: front.y, decisionTime: tDec };
  if (!choice.swing) {
    return { swing: false, ...baseInfo, startTime: 0, plannedContactTime: 0, pivot, rh: 0, thetaC: 0, epsC: 0, omegaPk: 0, alpha: 0, sgn: 0, tauC: 0, batSpeed: 0, protect };
  }
  const late = choice.timing ?? 0;

  if (buntPsi !== null) {
    // Bunt: square around and present the bat at the predicted location; the ball's speed is absorbed by the bat.
    // a bunter tracks the ball almost to the bat, so his estimate is much better than a full swing's
    const tB = timeAtZ(pitch.path, 0.7);
    const tr = pathAt(pitch.path, tB);
    const pb = { t: tB, x: tr.x, y: tr.y };
    const sk = 1.5 - R.contact / 100;
    const px = pb.x + rng.normal(0, 0.012 * sk) + (choice.aimX ?? 0);
    const py = pb.y + 0.0 + rng.normal(0, 0.014 * sk) + (choice.aimY ?? 0);
    return {
      swing: true,
      ...baseInfo,
      startTime: Math.max(now, pb.t - 0.34 + late),
      plannedContactTime: pb.t,
      pivot,
      rh: 0,
      thetaC: 0,
      epsC: 0,
      omegaPk: 0,
      alpha: 0,
      sgn: 0,
      tauC: 0.34,
      batSpeed: 0,
      protect,
      bunt: { psi: buntPsi + rng.normal(0, 0.035 * sk), x: px, y: py, z: 0.7, stance },
    };
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
  const aim = { x: pred.x + (choice.aimX ?? 0), y: pred.y - b.traits.aimBelow + (choice.aimY ?? 0), z: zc };
  const dx = aim.x - pivot.x;
  const dy = aim.y - pivot.y;
  const dz = aim.z - pivot.z;
  const r3 = Math.hypot(dx, dy, dz);
  const rh = clamp(r3 - S_AIM, 0.3, 0.82);
  const thetaC = Math.atan2(dx, dz);
  const epsC = Math.atan2(dy, Math.hypot(dx, dz)) + rng.normal(0, (0.009 * (1.5 - R.contact / 100) * (protect ? 0.9 : 1.0) + 0.004) * noise);

  const effort = clamp(choice.effort ?? (protect ? 0.965 : 1.0), 0.6, 1);
  const batSpeed = baseBatSpeed(R.power) * effort * (1 + rng.normal(0, 0.03 * noise));
  const rSweet = rh + BAT_S_NODE;
  // a gap hitter's bat path is level and repeatable: drawn toward ~11 deg with less spread
  const alpha = (gapAttackAngle(b.traits.attackAngleDeg, R.gap) + rng.normal(0, 3.2 * gapSpread(R.gap) * consistencyScale(R.consistency))) * DEG;
  const omegaPk = (batSpeed * Math.cos(alpha)) / (rSweet * Math.max(0.5, Math.cos(epsC)));
  const sigmaT = 0.0148 * (1.5 - R.contact / 100) * (protect ? 0.9 : 1) * noise;
  const timeErr = rng.normal(0, sigmaT) + rng.normal(0, 0.0011);
  // a puller gets the bat out front (contact earlier), an opposite-field hitter lets it travel
  const startTime = Math.max(now, pred.t - TAU_CONTACT + timeErr + late + pullTimeShift(R.pull));
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

/** Perceive, decide with the built-in rule and plan in one go (lab scripts and tests; the game asks a DecisionProvider in between). */
export function planSwing(b: PlayerInfo, stance: Stance, pitch: ThrownPitch, zone: StrikeZone, ctx: BattingContext, fbMphSeen: number, rng: Rng, buntPsi: number | null = null): SwingPlan {
  const obs = perceivePitch(b, stance, pitch, zone, fbMphSeen, rng);
  return buildSwing(b, stance, pitch, obs, aiSwingDecision(b, ctx, obs.dPerceived), ctx, rng, buntPsi);
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
    if (this.plan.bunt) {
      this.tau += dt;
      if (this.tau > 0.8) this.done = true;
      return;
    }
    const w = this.omega(this.tau + dt * 0.5);
    this.theta += this.plan.sgn * w * dt;
    this.eps += Math.tan(this.plan.alpha) * w * dt;
    this.tau += dt;
    if (this.tau > this.plan.tauC * 2.1) this.done = true;
  }

  /** 0..1 progress through the swing, for animation. */
  get progress(): number {
    return this.plan.bunt ? clamp(this.tau / 0.6, 0, 1) : clamp(this.tau / (this.plan.tauC * 1.9), 0, 1);
  }

  pose(): BatPose {
    const { theta, eps } = this;
    const p = this.plan;
    if (p.bunt) {
      const bu = p.bunt;
      // bat axis horizontal, perpendicular to the desired ball direction; the knob is on the batter's side
      const sgn = bu.stance === 'R' ? 1 : -1;
      const dir = { x: -sgn * Math.cos(bu.psi), y: 0, z: sgn * Math.sin(bu.psi) };
      const s = 0.5;
      const knob = { x: bu.x - dir.x * s, y: bu.y, z: bu.z - dir.z * s };
      // soft hands: the bat gives slightly away from the ball, deadening it
      const still = { x: -Math.sin(bu.psi) * 1.5, y: 0, z: -Math.cos(bu.psi) * 1.5 };
      return { knob, tip: { x: knob.x + dir.x * BAT_LEN, y: bu.y, z: knob.z + dir.z * BAT_LEN }, dir, velAt: () => still };
    }
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
    // The rotation axis is a virtual pivot (it lets the bat meet the ball squarely); the hands themselves cannot leave the
    // batter's reach, so the knob is pulled toward the shoulders when the arc would take it farther out (early in the
    // swing, long before the ball arrives; at contact the hands are within reach and this is a no-op).
    const sh = shoulderFor(p.sgn > 0 ? 'R' : 'L');
    let kx = pv.x + rh * dir.x, ky = pv.y + rh * dir.y, kz = pv.z + rh * dir.z;
    const dS = Math.hypot(kx - sh.x, ky - sh.y, kz - sh.z);
    if (dS > ARM_REACH) {
      const f = ARM_REACH / dS;
      kx = sh.x + (kx - sh.x) * f;
      ky = sh.y + (ky - sh.y) * f;
      kz = sh.z + (kz - sh.z) * f;
    }
    return {
      knob: { x: kx, y: ky, z: kz },
      tip: { x: kx + BAT_LEN * dir.x, y: ky + BAT_LEN * dir.y, z: kz + BAT_LEN * dir.z },
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
