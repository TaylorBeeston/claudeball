import { BallBody } from './ball';
import { breakingNoiseScale, breakingRecognition, clutchScale, consistencyScale, formContactShift, formPowerShift, gapAttackAngle, gapSpread, pullDepth } from './attributes';
import { BALL_MASS, BALL_RADIUS, PLATE_DEPTH } from './field';
import { DEG, Vec3, clamp } from './math';
import { PitchSample, StrikeZone, ThrownPitch, pathAt, timeAtZ, zoneDistance } from './pitching';
import { Rng } from './rng';
import type { PlayerInfo } from './types';

// --- the batter's body and the bat ------------------------------------------------------------------------------------------
// The batter the engine draws: the `swing` clip on the 1.85 m model, its root in the box (SHOULDER_X off the plate centre, z BOX_Z; a righty
// on +x, a lefty the mirror image), scaled by his height (engine/playerLook.ts). The bat's path is laid on that body: where its hands are
// at each phase of the swing (tools/swing/clipbat.ts measures the clip; tools/swing/run.ts checks that two hands can hold the bat there).
// Body points below are relative to the root, for a righty, at 1.85 m (x < 0 is toward the plate, z > 0 toward the pitcher).
export const SHOULDER_X = 0.72; // the box: his root, metres off the plate centre (flow.ts BATTER_X)
export const BOX_Z = 0.15;
const MODEL_HEIGHT = 1.85;
/** The drawn body's size: the model scaled by his height (engine/playerLook.ts). */
export const bodyScale = (heightM: number) => clamp(heightM / MODEL_HEIGHT, 0.88, 1.14);
/**
 * The clip's bat from its launch (0.583 s, knob over the rear shoulder, bat up and back) to its contact frame (0.917 s), 24 fps: the engine
 * lays these frames on the sim's swing from its start to contact (gltfCharacter.ts batterTiming), so early in the swing, while the engine is
 * still blending the arms from the clip's onto the bat, the bat follows the clip's (tools/swing/clipbat.ts --table).
 */
export const CLIP_SWING: { knob: Vec3; dir: Vec3 }[] = [
  { knob: { x: -0.159, y: 1.409, z: -0.262 }, dir: { x: 0.088, y: 0.807, z: -0.584 } },
  { knob: { x: -0.182, y: 1.397, z: -0.236 }, dir: { x: 0.005, y: 0.791, z: -0.612 } },
  { knob: { x: -0.232, y: 1.371, z: -0.181 }, dir: { x: -0.189, y: 0.727, z: -0.66 } },
  { knob: { x: -0.283, y: 1.344, z: -0.126 }, dir: { x: -0.379, y: 0.629, z: -0.679 } },
  { knob: { x: -0.307, y: 1.332, z: -0.102 }, dir: { x: -0.458, y: 0.576, z: -0.677 } },
  { knob: { x: -0.333, y: 1.301, z: -0.031 }, dir: { x: -0.616, y: 0.536, z: -0.578 } },
  { knob: { x: -0.385, y: 1.243, z: 0.103 }, dir: { x: -0.857, y: 0.4, z: -0.325 } },
  { knob: { x: -0.414, y: 1.211, z: 0.177 }, dir: { x: -0.933, y: 0.31, z: -0.18 } },
  { knob: { x: -0.393, y: 1.206, z: 0.248 }, dir: { x: -0.871, y: 0.224, z: 0.438 } },
];
export const FINISH = { knob: { x: -0.006, y: 1.553, z: 0.221 }, dir: { x: 0.824, y: 0.5, z: -0.268 } };
/** The drawn body's shoulders at contact (the clip at 0.917 s: rear, lead). */
export const SHOULDERS_C = { rear: { x: -0.213, y: 1.324, z: 0.095 }, lead: { x: 0.101, y: 1.326, z: 0.289 } };
export const ARM_REACH = 0.64; // shoulder -> fist on the handle (the model's arm nearly straight: 0.62 to the wrist, the fist beyond it)

/**
 * The shape of the swing (all lengths for the 1.85 m model; tools/swing tunes and checks these against the drawn body):
 * - hands: the knob at contact, toward the plate (fwd) and toward the pitcher (lat) from the root; its height follows from the bat's angle;
 * - vba: the bat's elevation at contact (deg, negative = barrel below the hands) for a pitch at height y: v0 + slope * (y - 0.8), clamped;
 *   real hitters: about -10 for a high pitch, -25 to -35 mid-zone, -40 to -45 low (Statcast "vertical bat angle"); flatter here (-13 mid-zone,
 *   -26 low, -3 high): the drawn body's top hand holds a level bat, not a steep one (tools/swing, docs/swing-kinematics.md);
 * - rh: the bat turns about a point this far behind the knob along the bat (the hands lead the barrel: knob speed rh * omega, ~5 m/s at
 *   contact; real hands are 4-7 m/s at impact, slowing as the barrel releases);
 * - ramp: the turn rate rises as (tau / tauC)^ramp to contact, then dies over 0.9 tauC;
 * - via: on its way from the clip's launch the bat is turned off the clip's own path (by dAz / dEl, the knob moved by dKnob, all in full at
 *   the share `at` of tauC) to where both fists can hold it on the drawn body (its top hand cannot hold the clip's own bat in range);
 * - inStart, turnStart, blendIn: the bat leaves that path for the swing plane, reached at blendIn: the knob from inStart on a cubic that leaves
 *   the early path and meets the plane's knob each at its own velocity (the hands drop and come forward at an even pace, no step in their
 *   speed), the bat's direction from turnStart (the barrel lays back; turned later than the hands move so the top hand keeps the bat in
 *   range, and over enough frames that it does not jump: tools/swing/steps.ts, docs/swing-kinematics.md);
 * - outStart: tau / tauC at which the follow-through starts to wrap toward the clip's finish (reached at 2.1 tauC);
 * - extMax: how far the hands reach out toward a pitch the bat cannot meet from the nominal hands;
 * - timeErr: scale of his timing error: a bat on plane forgives a timing error in height (the barrel stays on the ball's line), so the error
 *   is larger than the old cone-shaped path needed for the same whiff rate (calibrated: 200 games, docs/swing-kinematics.md);
 * - attackAdd: added to every hitter's attack angle (deg): the plane rising to meet the pitch's descent (league attack angle ~15 deg at
 *   contact, a gap hitter's drawn toward GAP_ANGLE_DEG).
 */
export const SWING = {
  hands: { fwd: 0.08, lat: 0.18 },
  vba: { v0: -13, slope: 45, min: -40, max: -3 },
  rh: 0.12,
  ramp: 1.6,
  via: { dKnob: { x: -0.12, y: -0.12, z: 0.09 }, dAz: 30, dEl: 2, at: 0.45 },
  inStart: 0.1,
  turnStart: 0.3,
  blendIn: 0.8,
  outStart: 1.3,
  extMax: 0.15,
  timeErr: 1.15,
  attackAdd: 7,
  finish: { dKnob: { x: -0.297, y: -0.4, z: 0.191 }, dAz: 74.9, dEl: 19.3 },
};

/** A body point (root-relative, righty, 1.85 m) in the world for this stance and size. */
export function bodyPoint(stance: Stance, sc: number, p: Vec3): Vec3 {
  const sg = stance === 'R' ? 1 : -1;
  return { x: sg * (SHOULDER_X + sc * p.x), y: sc * p.y, z: BOX_Z + sc * p.z };
}
export const bodyDir = (stance: Stance, d: Vec3): Vec3 => ({ x: (stance === 'R' ? 1 : -1) * d.x, y: d.y, z: d.z });

/** The bat's elevation at contact for a pitch at height y (rad), on a body of size sc. */
export function contactVba(y: number, sc = 1): number {
  const v = SWING.vba;
  return clamp(v.v0 + v.slope * (y / sc - 0.8), v.min, v.max) * DEG;
}

export const HAND_FRONT = 0.05; // the bottom fist: this far along the bat from the knob (engine gripBottom)
export const HAND_REAR = 0.135; // the top fist (engine gripTop)
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
  /** The point the bat turns about near contact (rh behind the knob along the bat). */
  pivot: Vec3;
  rh: number;
  /** The bat at contact: knob, direction (azimuth thetaC from +z, elevation epsC), and the swing plane's second axis (the sweet spot's heading). */
  knobC: Vec3;
  dirC: Vec3;
  planeC: Vec3;
  thetaC: number;
  epsC: number;
  /** Turn rate at contact (rad/s). */
  omegaC: number;
  alpha: number;
  sgn: number;
  tauC: number;
  batSpeed: number;
  /** The drawn body's size (bodyScale). */
  scale: number;
  protect: boolean;
  /** Bunt: the bat is squared around and held still at (x, y, z); psi = direction the ball should be deadened toward (rad, + toward third base). */
  bunt?: { psi: number; x: number; y: number; z: number; stance: Stance };
}

export function stanceFor(bats: PlayerInfo['bats'], pitcherThrows: 'L' | 'R'): Stance {
  if (bats === 'S') return pitcherThrows === 'R' ? 'L' : 'R';
  return bats;
}

/** The hands' reference point at contact (the knob for a pitch he meets comfortably, before its height is set by the bat's angle). */
export const pivotFor = (stance: Stance, sc = 1): Vec3 => bodyPoint(stance, sc, { x: -SWING.hands.fwd, y: 1.0, z: SWING.hands.lat });

/** The clip's bat at the share u of the way from its launch to contact (world, this stance and size). */
export function clipBat(stance: Stance, sc: number, u: number): { knob: Vec3; dir: Vec3 } {
  const f = clamp(u, 0, 1) * (CLIP_SWING.length - 1);
  const i = Math.min(CLIP_SWING.length - 2, Math.floor(f)), k = f - i;
  const a = CLIP_SWING[i], b = CLIP_SWING[i + 1];
  const knob = { x: a.knob.x + (b.knob.x - a.knob.x) * k, y: a.knob.y + (b.knob.y - a.knob.y) * k, z: a.knob.z + (b.knob.z - a.knob.z) * k };
  return { knob: bodyPoint(stance, sc, knob), dir: bodyDir(stance, slerpDir(a.dir, b.dir, k)) };
}
/** The swing's start: the clip's load (bat cocked over the rear shoulder) in world coordinates for this stance and size. */
export const loadPose = (stance: Stance, sc = 1) => clipBat(stance, sc, 0);
export function finishPose(stance: Stance, sc = 1): { knob: Vec3; dir: Vec3 } {
  const F = SWING.finish;
  const knob = bodyPoint(stance, sc, { x: FINISH.knob.x + F.dKnob.x, y: FINISH.knob.y + F.dKnob.y, z: FINISH.knob.z + F.dKnob.z });
  const az = Math.atan2(FINISH.dir.x, FINISH.dir.z) + F.dAz * DEG, el = Math.asin(FINISH.dir.y) + F.dEl * DEG;
  return { knob, dir: bodyDir(stance, { x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: Math.cos(el) * Math.cos(az) }) };
}

/** Bat speed at the sweet spot for a swing of normal effort (m/s). */
export function baseBatSpeed(power: number): number {
  return 25.8 + 0.098 * power; // power 50 -> 30.1 m/s (67 mph), 80 -> 33.0, 30 -> 28.1
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
  const pivot = pivotFor(stance, bodyScale(b.height));
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
  let thr = 0.035 - 0.05 * disc;
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
  const still = { pivot, rh: 0, knobC: pivot, dirC: { x: 0, y: 1, z: 0 }, planeC: { x: 0, y: 0, z: 1 }, thetaC: 0, epsC: 0, omegaC: 0, alpha: 0, sgn: 0, batSpeed: 0, scale: bodyScale(b.height) };
  if (!choice.swing) {
    return { swing: false, ...baseInfo, ...still, startTime: 0, plannedContactTime: 0, tauC: 0, protect };
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
      ...still,
      tauC: 0.34,
      protect,
      bunt: { psi: buntPsi + rng.normal(0, 0.035 * sk), x: px, y: py, z: 0.7, stance },
    };
  }

  // --- swing planning ---------------------------------------------------------------------
  // Where he meets the ball: the hands go to their reference point (lower for a low pitch: the bat's angle at contact follows the pitch
  // height, contactVba), the sweet spot S_AIM out along the bat. The depth follows from that geometry (an inside pitch is met further out in
  // front, a pitch off the plate deeper, the hands reaching out for it).
  const sc = bodyScale(b.height);
  const sg = stance === 'R' ? 1 : -1;
  const hRef = pivotFor(stance, sc);
  let zc = hRef.z + 0.4;
  let pred = predictAtZ(zc);
  let ext = 0;
  for (let i = 0; i < 5; i++) {
    const rH = S_AIM * Math.cos(contactVba(pred.y, sc));
    const dx = Math.abs(pred.x - hRef.x);
    ext = clamp(dx - 0.98 * rH, 0, SWING.extMax * sc);
    const dxe = dx - ext;
    zc = clamp(hRef.z + Math.sqrt(Math.max(rH * rH - dxe * dxe, 0.04 * rH * rH)), 0.1, 1.5);
    pred = predictAtZ(zc);
  }
  // a puller meets the ball further out in front, an opposite-field hitter deeper (the depth sets the bat's angle at contact)
  zc = clamp(zc + pullDepth(R.pull), 0.1, 1.5);
  pred = predictAtZ(zc);
  const aim = { x: pred.x + (choice.aimX ?? 0), y: pred.y - b.traits.aimBelow + (choice.aimY ?? 0), z: zc };
  // the knob: S_AIM back along the bat from the aim, horizontally toward the hands (reaching out by ext for a pitch he cannot meet from them)
  const hx = hRef.x + Math.sign(aim.x - hRef.x) * ext;
  const ux0 = aim.x - hx, uz0 = aim.z - hRef.z, ul = Math.hypot(ux0, uz0) || 1;
  const ux = ux0 / ul, uz = uz0 / ul;
  const v = contactVba(aim.y, sc);
  const knobC = { x: aim.x - S_AIM * Math.cos(v) * ux, y: aim.y - S_AIM * Math.sin(v), z: aim.z - S_AIM * Math.cos(v) * uz };
  const thetaC = Math.atan2(ux, uz);
  // the arms reach no farther than they reach: a pitch beyond them is met further out on the barrel (or not at all)
  const lead = bodyPoint(stance, sc, SHOULDERS_C.lead), rear = bodyPoint(stance, sc, SHOULDERS_C.rear);
  const bx = Math.cos(v) * ux, by = Math.sin(v), bz = Math.cos(v) * uz;
  for (let it = 0; it < 3; it++) {
    for (const [off, sh] of [[HAND_FRONT, lead], [HAND_REAR, rear]] as const) {
      const px = knobC.x + off * bx - sh.x, py = knobC.y + off * by - sh.y, pz = knobC.z + off * bz - sh.z;
      const d = Math.hypot(px, py, pz), reach = ARM_REACH * sc;
      if (d > reach) {
        const f = (d - reach) / d;
        knobC.x -= px * f;
        knobC.y -= py * f;
        knobC.z -= pz * f;
      }
    }
  }
  // his plane error: the bat comes through a little steeper or flatter than he meant (the sweet spot passes above / below the ball)
  const epsC = v + rng.normal(0, (0.012 * (1.5 - R.contact / 100) * (protect ? 0.9 : 1.0) + 0.004) * noise);
  const dirC = { x: Math.cos(epsC) * ux, y: Math.sin(epsC), z: Math.cos(epsC) * uz };

  const effort = clamp(choice.effort ?? (protect ? 0.965 : 1.0), 0.6, 1);
  const batSpeed = baseBatSpeed(R.power) * effort * (1 + rng.normal(0, 0.03 * noise));
  const rh = SWING.rh;
  // a gap hitter's bat path is level and repeatable: drawn toward ~11 deg with less spread
  const alpha = (gapAttackAngle(b.traits.attackAngleDeg + SWING.attackAdd, R.gap) + rng.normal(0, 3.2 * gapSpread(R.gap) * consistencyScale(R.consistency))) * DEG;
  // the swing plane at contact: the bat and the sweet spot's heading (across the bat, toward the pitcher, rising at the attack angle)
  const hd = { x: sg * Math.cos(thetaC), y: 0, z: -sg * Math.sin(thetaC) };
  const up = { x: -Math.sin(epsC) * Math.sin(thetaC), y: Math.cos(epsC), z: -Math.sin(epsC) * Math.cos(thetaC) };
  const beta = Math.asin(clamp(Math.sin(alpha) / Math.cos(epsC), -1, 1));
  const planeC = { x: Math.cos(beta) * hd.x + Math.sin(beta) * up.x, y: Math.cos(beta) * hd.y + Math.sin(beta) * up.y, z: Math.cos(beta) * hd.z + Math.sin(beta) * up.z };
  const omegaC = batSpeed / (rh + BAT_S_NODE);
  const sigmaT = 0.0125 * (1.5 - R.contact / 100) * (protect ? 1.0 : 1) * noise * SWING.timeErr;
  const timeErr = rng.normal(0, sigmaT) + rng.normal(0, 0.0011);
  const startTime = Math.max(now, pred.t - TAU_CONTACT + timeErr + late);
  return {
    swing: true,
    ...baseInfo,
    startTime,
    plannedContactTime: pred.t,
    pivot: { x: knobC.x - rh * dirC.x, y: knobC.y - rh * dirC.y, z: knobC.z - rh * dirC.z },
    rh,
    knobC,
    dirC,
    planeC,
    thetaC,
    epsC,
    omegaC,
    alpha,
    sgn: sg,
    tauC: TAU_CONTACT,
    batSpeed,
    scale: sc,
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

function smooth(u: number): number {
  const v = clamp(u, 0, 1);
  return v * v * (3 - 2 * v);
}
/** Unit vectors a -> b by the share t of the angle between them. */
function slerpDir(a: Vec3, b: Vec3, t: number): Vec3 {
  const c = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const th = Math.acos(c);
  if (th < 1e-4) return b;
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return { x: a.x * ka + b.x * kb, y: a.y * ka + b.y * kb, z: a.z * ka + b.z * kb };
}

/**
 * The swing: the bat leaves the clip's load pose (over the rear shoulder) and drops into the swing plane, turns in that plane about a point
 * rh behind the knob (the plane holds the bat at contact and the sweet spot's heading, rising at the attack angle: the barrel lies back
 * toward the catcher a little below the hands, comes round under them through the zone and rises into the follow-through), and wraps
 * toward the clip's finish over the lead shoulder. The pose is a function of the time since the swing started; the bat's velocity is its
 * true rate of change (the collision sees the bat as drawn, the hands' travel included).
 */
export class BatSwing {
  tau = 0; // time since swing start
  done = false;
  contacted = false;
  private readonly st: Stance;
  private readonly fin: { knob: Vec3; dir: Vec3 } | null;
  private ends?: { A: Vec3; VA: Vec3; B: Vec3; VB: Vec3 };

  constructor(readonly plan: SwingPlan) {
    this.st = plan.sgn < 0 ? 'L' : 'R';
    this.fin = plan.bunt ? null : finishPose(this.st, plan.scale);
  }

  /** Turn rate in the swing plane (rad/s). */
  omega(tau: number): number {
    const u = tau / this.plan.tauC;
    if (u <= 0) return 0;
    if (u <= 1) return this.plan.omegaC * Math.pow(u, SWING.ramp);
    return this.plan.omegaC * Math.max(0, 1 - (u - 1) / 0.9);
  }

  /** Angle turned in the plane from the bat at contact (rad; negative before contact). */
  phi(tau: number): number {
    const { tauC, omegaC } = this.plan;
    const n = SWING.ramp;
    const u = clamp(tau / tauC, 0, 2.1);
    if (u <= 1) return ((-omegaC * tauC) / (n + 1)) * (1 - Math.pow(u, n + 1));
    const D = 0.9 * tauC, d = Math.min((u - 1) * tauC, D);
    return omegaC * (d - (d * d) / (2 * D));
  }

  /** Advance the swing by dt seconds. */
  advance(dt: number): void {
    this.tau += dt;
    if (this.plan.bunt) {
      if (this.tau > 0.8) this.done = true;
      return;
    }
    if (this.tau > this.plan.tauC * 2.1) this.done = true;
  }

  /** 0..1 progress through the swing, for animation. */
  get progress(): number {
    return this.plan.bunt ? clamp(this.tau / 0.6, 0, 1) : clamp(this.tau / (this.plan.tauC * 1.9), 0, 1);
  }

  /** The early swing at the share u of tauC: the clip's bat, turned off its path toward the holdable (SWING.via). */
  early(u: number): { knob: Vec3; dir: Vec3 } {
    const c = clipBat(this.st, this.plan.scale, u);
    const V = SWING.via, w = smooth(u / V.at);
    if (w <= 0) return c;
    const sg = this.st === 'R' ? 1 : -1, sc = this.plan.scale;
    const az = Math.atan2(sg * c.dir.x, c.dir.z) + V.dAz * DEG * w, el = Math.asin(clamp(c.dir.y, -1, 1)) + V.dEl * DEG * w;
    return {
      knob: { x: c.knob.x + sg * sc * V.dKnob.x * w, y: c.knob.y + sc * V.dKnob.y * w, z: c.knob.z + sc * V.dKnob.z * w },
      dir: { x: sg * Math.cos(el) * Math.sin(az), y: Math.sin(el), z: Math.cos(el) * Math.cos(az) },
    };
  }

  /** The bat on the swing plane at time tau (turned phi from the bat at contact about the pivot). */
  plane(tau: number): { knob: Vec3; dir: Vec3 } {
    const p = this.plan;
    const f = this.phi(tau);
    const c = Math.cos(f), s = Math.sin(f);
    const d = { x: c * p.dirC.x + s * p.planeC.x, y: c * p.dirC.y + s * p.planeC.y, z: c * p.dirC.z + s * p.planeC.z };
    const pv = p.pivot;
    return { knob: { x: pv.x + p.rh * d.x, y: pv.y + p.rh * d.y, z: pv.z + p.rh * d.z }, dir: d };
  }

  /** The knob's blend into the plane: where it leaves the early path (u = inStart) and meets the plane (blendIn), with each path's velocity there
   * (per unit of the blend's share, so the cubic's tangents). */
  private blendEnds(): { A: Vec3; VA: Vec3; B: Vec3; VB: Vec3 } {
    const p = this.plan, e = 0.0005, tA = SWING.inStart * p.tauC, tB = SWING.blendIn * p.tauC, m = (tB - tA) / (2 * e);
    const v = (a: Vec3, b: Vec3) => ({ x: (b.x - a.x) * m, y: (b.y - a.y) * m, z: (b.z - a.z) * m });
    const early = (t: number) => this.early(t / p.tauC).knob, plane = (t: number) => this.plane(t).knob;
    return { A: early(tA), VA: v(early(tA - e), early(tA + e)), B: plane(tB), VB: v(plane(tB - e), plane(tB + e)) };
  }

  /** The bat at time tau of the swing: knob and unit direction. */
  at(tau: number): { knob: Vec3; dir: Vec3 } {
    const p = this.plan;
    let { knob: k, dir: d } = this.plane(tau);
    // the clip's own swing first, then into the plane (the hands drop and come forward, the barrel lays back)
    const u = tau / p.tauC, u0 = SWING.inStart, t0 = SWING.turnStart, u1 = SWING.blendIn;
    if (u < u1) {
      const L = this.early(u);
      d = slerpDir(L.dir, d, smooth((u - t0) / (u1 - t0)));
      if (u <= u0) k = L.knob;
      else {
        // the knob on a cubic (Hermite) from the early path's at u0 to the plane's at u1, each end at its own path's velocity
        const { A, VA, B, VB } = (this.ends ??= this.blendEnds());
        const s = (u - u0) / (u1 - u0), s2 = s * s, s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = 3 * s2 - 2 * s3, h11 = s3 - s2;
        const H = (a: number, va: number, b: number, vb: number) => h00 * a + h10 * va + h01 * b + h11 * vb;
        k = { x: H(A.x, VA.x, B.x, VB.x), y: H(A.y, VA.y, B.y, VB.y), z: H(A.z, VA.z, B.z, VB.z) };
      }
    }
    // the follow-through wraps toward the finish over the lead shoulder
    const h = smooth((tau / p.tauC - SWING.outStart) / (2.1 - SWING.outStart));
    if (h > 0 && this.fin) {
      const F = this.fin;
      d = slerpDir(d, F.dir, h);
      k = { x: k.x + (F.knob.x - k.x) * h, y: k.y + (F.knob.y - k.y) * h, z: k.z + (F.knob.z - k.z) * h };
    }
    return { knob: k, dir: d };
  }

  pose(): BatPose {
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
    const tau = Math.min(this.tau, p.tauC * 2.1);
    const { knob, dir } = this.at(tau);
    // velocity: the pose's rate of change (central difference; one-sided at the start)
    const hs = 0.0004;
    const t0 = Math.max(0, tau - hs), t1 = tau + hs;
    const a = this.at(t0), b = this.at(t1);
    const k = this.done ? 0 : 1 / (t1 - t0);
    return {
      knob,
      tip: { x: knob.x + BAT_LEN * dir.x, y: knob.y + BAT_LEN * dir.y, z: knob.z + BAT_LEN * dir.z },
      dir,
      velAt: (s: number) => ({
        x: (b.knob.x + s * b.dir.x - a.knob.x - s * a.dir.x) * k,
        y: (b.knob.y + s * b.dir.y - a.knob.y - s * a.dir.y) * k,
        z: (b.knob.z + s * b.dir.z - a.knob.z - s * a.dir.z) * k,
      }),
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
