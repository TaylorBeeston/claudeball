import { BallBody, Environment, flightStep, newFlags, stepBall } from './ball';
import { BALL_RADIUS, MOUND_DIST, PLATE_DEPTH, PLATE_HALF_WIDTH } from './field';
import { DEG, MPH, RPM, Vec3, clamp, cross, dot, norm, scale, sub } from './math';
import { Rng } from './rng';
import type { PitchSpec, PitchType, PlayerInfo } from './types';

/** Plane where pitch location is reported (front edge of the plate). */
export const PLATE_FRONT_Z = PLATE_DEPTH;

export interface StrikeZone {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** Rulebook zone: knees to midpoint between shoulders and belt, over the plate (ball radius added at judgement). */
export function strikeZoneFor(batterHeight: number, crouch = 0.97): StrikeZone {
  return {
    left: -PLATE_HALF_WIDTH,
    right: PLATE_HALF_WIDTH,
    bottom: 0.275 * batterHeight * crouch,
    top: 0.535 * batterHeight * crouch,
  };
}

/** Is a ball centre at (x,y) over the plate touching the zone? (ball radius included) */
export function zoneContains(z: StrikeZone, x: number, y: number, margin = BALL_RADIUS): boolean {
  return x >= z.left - margin && x <= z.right + margin && y >= z.bottom - margin && y <= z.top + margin;
}

/** Signed distance outside the zone rectangle (m); negative = inside (depth to nearest edge). */
export function zoneDistance(z: StrikeZone, x: number, y: number): number {
  const dx = Math.max(z.left - x, x - z.right);
  const dy = Math.max(z.bottom - y, y - z.top);
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

export interface ArmSlot {
  /** Lateral release offset from rubber centre (m; + toward third base). */
  x: number;
  /** Release height (m). */
  y: number;
  /** Extension: how far in front of the rubber the ball is released (m). */
  ext: number;
}

export interface PitchSample {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface ThrownPitch {
  spec: PitchSpec;
  type: PitchType;
  targetX: number;
  targetY: number;
  release: Vec3;
  vel: Vec3;
  spin: Vec3;
  mph: number;
  rpm: number;
  /** Nominal flight (no ground contact) from release until behind the plate; used for perception and bookkeeping. */
  path: PitchSample[];
  /** Time from release to crossing the plate front plane. */
  tPlate: number;
  plateX: number;
  plateY: number;
  plateVy: number;
  /** Ball touches the zone (any part, over any part of the plate). */
  inZone: boolean;
  /** Approach angle of the pitch through the zone (deg below horizontal). */
  approachDeg: number;
}

/** Build the spin vector for a pitch heading along vhat: force direction = spin x v. */
export function spinVector(vhat: Vec3, spec: PitchSpec, rpm: number, eff: number, breakDirDeg: number): Vec3 {
  const th = breakDirDeg * DEG;
  let m: Vec3 = { x: Math.sin(th), y: Math.cos(th), z: 0 };
  const md = dot(m, vhat);
  m = norm({ x: m.x - md * vhat.x, y: m.y - md * vhat.y, z: m.z - md * vhat.z });
  const axis = cross(vhat, m); // omega direction such that (omega x v) points along m
  const w = rpm * RPM;
  const e = clamp(eff, 0, 1);
  const gyro = Math.sqrt(1 - e * e);
  return {
    x: w * (e * axis.x + gyro * vhat.x),
    y: w * (e * axis.y + gyro * vhat.y),
    z: w * (e * axis.z + gyro * vhat.z),
  };
}

function simulatePitch(
  rel: Vec3,
  dir: Vec3,
  speed: number,
  spec: PitchSpec,
  rpm: number,
  eff: number,
  breakDir: number,
  env: Environment,
  dt: number,
  collect: PitchSample[] | null,
): { x: number; y: number; t: number; vy: number; ok: boolean } {
  const vhat = norm(dir);
  const w = spinVector(vhat, spec, rpm, eff, breakDir);
  const b: BallBody = { x: rel.x, y: rel.y, z: rel.z, vx: vhat.x * speed, vy: vhat.y * speed, vz: vhat.z * speed, wx: w.x, wy: w.y, wz: w.z, rolling: false };
  let t = 0;
  if (collect) collect.push({ t, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz });
  let res = { x: 0, y: 0, t: 0, vy: 0, ok: false };
  for (let i = 0; i < 3000; i++) {
    const px = b.x, py = b.y, pz = b.z, pvy = b.vy;
    flightStep(b, dt, env);
    t += dt;
    if (collect) collect.push({ t, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz });
    if (!res.ok && pz > PLATE_FRONT_Z && b.z <= PLATE_FRONT_Z) {
      const f = (pz - PLATE_FRONT_Z) / (pz - b.z);
      res = { x: px + (b.x - px) * f, y: py + (b.y - py) * f, t: t - dt + dt * f, vy: pvy + (b.vy - pvy) * f, ok: true };
      if (!collect) return res;
    }
    if (res.ok && (!collect || b.z < -1.6 || b.y < BALL_RADIUS)) break;
    if (b.y < 0 || b.z < -3) break;
  }
  return res;
}

export interface ThrowContext {
  fatigue: number; // 0 fresh .. 1+ gassed
  rng: Rng;
  env: Environment;
}

/**
 * Throw a pitch: the pitcher solves (with an internal model of ball flight) the release direction
 * that would put the nominal pitch at the target, then execution noise (release point, direction,
 * speed, spin) — scaled by control, pitch difficulty and fatigue — decides where it really goes.
 */
export function throwPitch(p: PlayerInfo, slot: ArmSlot, spec: PitchSpec, targetX: number, targetY: number, ctx: ThrowContext): ThrownPitch {
  const { rng, env } = ctx;
  const f = ctx.fatigue;
  const rel: Vec3 = { x: slot.x, y: slot.y, z: MOUND_DIST - slot.ext };
  const mphNominal = spec.mph - 2.6 * f * f - 0.8 * f;
  const speed = Math.max(24, (mphNominal + rng.normal(0, 0.55)) * MPH);
  const rpm = spec.rpm * (1 + rng.normal(0, 0.025)) * (1 - 0.03 * f);
  const eff = clamp(spec.efficiency + rng.normal(0, 0.025), 0.1, 0.99);
  const breakDir = spec.breakDirDeg + rng.normal(0, 3.2 + 2 * f);

  // Internal aiming model: fixed-point shift of the aim point so the *nominal* pitch hits the target.
  const nomSpeed = spec.mph * MPH;
  const tGuess = (rel.z - PLATE_FRONT_Z) / nomSpeed;
  let ax = targetX;
  let ay = targetY + 0.5 * 9.8 * tGuess * tGuess; // start with a gravity-compensated aim point
  let dir: Vec3 = norm({ x: ax - rel.x, y: ay - rel.y, z: PLATE_FRONT_Z - rel.z });
  for (let it = 0; it < 10; it++) {
    dir = norm({ x: ax - rel.x, y: ay - rel.y, z: PLATE_FRONT_Z - rel.z });
    const r = simulatePitch(rel, dir, nomSpeed, spec, spec.rpm, spec.efficiency, spec.breakDirDeg, env, 1 / 90, null);
    if (!r.ok) {
      ay += 0.5;
      continue;
    }
    const ex = targetX - r.x;
    const ey = targetY - r.y;
    ax += ex;
    ay += ey;
    if (Math.abs(ex) < 0.0015 && Math.abs(ey) < 0.0015) break;
  }
  dir = norm({ x: ax - rel.x, y: ay - rel.y, z: PLATE_FRONT_Z - rel.z });

  // Execution error (angular, in radians). Control 50 ~ 0.17 m 1-sigma at the plate.
  const ctl = p.ratings.control;
  let sigmaPos = 0.185 - 0.00105 * ctl; // ctl 50 -> 0.133 m 1-sigma at the plate; 80 -> 0.101; 30 -> 0.154
  sigmaPos *= 1 + 0.9 * f;
  if (spec.type === 'CU' || spec.type === 'SL' || spec.type === 'SW') sigmaPos *= 1.12;
  if (spec.type === 'FS' || spec.type === 'CH') sigmaPos *= 1.05;
  const sigmaAng = sigmaPos / (rel.z - PLATE_FRONT_Z);
  // horizontal miss is a bit smaller than vertical for most pitchers
  dir = norm({ x: dir.x + rng.normal(0, sigmaAng * 0.95), y: dir.y + rng.normal(0, sigmaAng * 1.1), z: dir.z });
  const relN: Vec3 = { x: rel.x + rng.normal(0, 0.03), y: rel.y + rng.normal(0, 0.035), z: rel.z + rng.normal(0, 0.03) };

  const path: PitchSample[] = [];
  const res = simulatePitch(relN, dir, speed, spec, rpm, eff, breakDir, env, 1 / 240, path);
  const w = spinVector(dir, spec, rpm, eff, breakDir);
  // zone judgement (front plane and mid-plate)
  let midX = res.x;
  let midY = res.y;
  for (let i = 1; i < path.length; i++) {
    if (path[i].z <= PLATE_DEPTH * 0.5 && path[i - 1].z > PLATE_DEPTH * 0.5) {
      const fr = (path[i - 1].z - PLATE_DEPTH * 0.5) / (path[i - 1].z - path[i].z);
      midX = path[i - 1].x + (path[i].x - path[i - 1].x) * fr;
      midY = path[i - 1].y + (path[i].y - path[i - 1].y) * fr;
      break;
    }
  }
  const vAtPlate = Math.hypot(0, 1);
  void vAtPlate;
  return {
    spec,
    type: spec.type,
    targetX,
    targetY,
    release: relN,
    vel: scale(dir, speed),
    spin: w,
    mph: speed / MPH,
    rpm,
    path,
    tPlate: res.t,
    plateX: res.x,
    plateY: res.y,
    plateVy: res.vy,
    inZone: false, // filled by the game once the batter's zone is known
    approachDeg: Math.atan2(-res.vy, speed * Math.abs(dir.z)) / DEG,
  } as ThrownPitch & { midX?: number };
}

/** Position of the pitch at the plate mid-plane and front plane, for zone judgement. */
export function pitchZoneCrossings(pitch: ThrownPitch): { front: { x: number; y: number }; mid: { x: number; y: number } } {
  const path = pitch.path;
  let mid = { x: pitch.plateX, y: pitch.plateY };
  for (let i = 1; i < path.length; i++) {
    if (path[i].z <= PLATE_DEPTH * 0.5 && path[i - 1].z > PLATE_DEPTH * 0.5) {
      const fr = (path[i - 1].z - PLATE_DEPTH * 0.5) / (path[i - 1].z - path[i].z);
      mid = { x: path[i - 1].x + (path[i].x - path[i - 1].x) * fr, y: path[i - 1].y + (path[i].y - path[i - 1].y) * fr };
      break;
    }
  }
  return { front: { x: pitch.plateX, y: pitch.plateY }, mid };
}

export function pitchTouchesZone(pitch: ThrownPitch, zone: StrikeZone): boolean {
  const c = pitchZoneCrossings(pitch);
  return zoneContains(zone, c.front.x, c.front.y) || zoneContains(zone, c.mid.x, c.mid.y);
}

/** Sample the nominal path at time t (linear interpolation). */
export function pathAt(path: PitchSample[], t: number): PitchSample {
  const dt = path.length > 1 ? path[1].t - path[0].t : 1;
  let i = Math.floor(t / dt);
  i = clamp(i, 0, path.length - 2);
  const a = path[i];
  const b = path[i + 1];
  const f = clamp((t - a.t) / (b.t - a.t), 0, 1);
  return {
    t,
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
    vx: a.vx + (b.vx - a.vx) * f,
    vy: a.vy + (b.vy - a.vy) * f,
    vz: a.vz + (b.vz - a.vz) * f,
  };
}

/** Time at which the nominal path reaches depth z (first crossing going toward home). */
export function timeAtZ(path: PitchSample[], z: number): number {
  for (let i = 1; i < path.length; i++) {
    if (path[i].z <= z && path[i - 1].z > z) {
      const f = (path[i - 1].z - z) / (path[i - 1].z - path[i].z);
      return path[i - 1].t + (path[i].t - path[i - 1].t) * f;
    }
  }
  return path[path.length - 1].t;
}

// (helpers kept exported for tests)
export { stepBall, newFlags, sub };
