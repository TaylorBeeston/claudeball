/**
 * The pose validator: given one puppet's final pose (rig-space locals + its model's world matrix) per frame, list everything a real body could
 * not do. Pure TS (no three.js): the static / crossfade sweeps run it in Node, the game sweep runs the same code bundled into the page.
 *
 * Checks (each a `kind`, with how far past the limit it is: degrees, metres, m/s or a ratio):
 *   joint:<key>       every range in JOINT_LIMITS (hinge direction and range, cones and twists, neck + head vs chest, spine twist)
 *   len:<bone>        segment length drift vs the rest pose (ratio - 1)
 *   foot:below        a foot's sole under the ground (m); foot:float both feet off the ground while the clip is not airborne (m)
 *   foot:slide        a planted foot moving over the ground (m/s) (game sweep and non-locomotion clips only)
 *   body:hand-torso, body:elbow-torso, body:arm-head   a hand / elbow inside the trunk, an elbow or forearm in the head (m)
 *   bat:grip-L, bat:grip-R  a hand that should hold the bat is off its handle (m); bat:hand-axis its fist turned against the bat (deg)
 *   bat:order         the hand nearest the knob is the wrong one; bat:body / bat:ground the barrel through the body / the ground (m)
 *   bat:lying         a dropped bat floating or sunk (m)
 *   flip:<bone>       a one-frame pop: a joint turns > 25 deg in one frame and > 3x its neighbouring frames
 *   spike:<bone>      a joint's angular speed over a human cap (rad/s)
 *   yaw:travel        running sideways / backwards: hips vs direction of travel (deg)
 */
import { DEG, qdist, qrot, qrotInv } from '../../src/engine/pose/qmath';
import { B, BONES, NB, PARENT, type PoseLocals, type PoseWorld, fk, jointRot, localPoint, newWorld, segLen } from '../../src/engine/pose/skeleton';
import { JOINT_LIMITS, type RestInfo, excess, measureJoints, restInfo } from '../../src/engine/pose/limits';
import { armHeadClearance, headVolume, torsoClearance, torsoVolume, type HeadVolume, type TorsoVolume, type V3 } from '../../src/engine/armClear';

export type BatState = 'sim' | 'held' | 'ondeck' | 'dropped' | 'static';
export interface BatIn {
  state: BatState;
  /** world knob and barrel tip */
  knob: number[];
  tip: number[];
  /** hands that should be on the handle */
  hands: { L: boolean; R: boolean };
}

export interface FrameIn {
  L: PoseLocals;
  /** the model node's world matrix (column-major 4x4, three's Matrix4.elements): position, body yaw, height scale, left-hander mirror */
  model: ArrayLike<number>;
  /** ground height under a world point */
  ground: (x: number, z: number) => number;
  /** animation time step of this frame (s); 0 = paused (no temporal checks) */
  dt: number;
  /** feet may leave the ground (slides, dives, jumps, wall climbs) */
  airborne?: boolean;
  /** a locomotion loop (treadmill in the static sweep: no slide check there) */
  locomotion?: boolean;
  /** world velocity (game): running direction check */
  vel?: { x: number; z: number };
  /** a throwing / pitching / swinging clip: faster arm / trunk caps */
  ballistic?: boolean;
  bat?: BatIn | null;
  /** the puppet teleported (new half inning, replay cut): no temporal checks this frame */
  cut?: boolean;
}

export interface Violation {
  kind: string;
  /** how far past the limit (units per kind) */
  excess: number;
  /** severity 0..3 (excess over the kind's unit, capped) for ranking */
  sev: number;
}

/** what one unit of severity is per kind family */
const UNIT: Record<string, number> = { joint: 15, len: 0.03, foot: 0.05, 'foot:slide': 0.5, body: 0.03, bat: 0.05, 'bat:hand-axis': 20, flip: 30, spike: 0.5, yaw: 30 };
const unitOf = (kind: string) => UNIT[kind] ?? UNIT[kind.split(':')[0]] ?? 1;

/** human angular speed caps (rad/s) of each joint (relative to its parent): normal motion vs ballistic (throw, pitch, swing) */
const SPEED_CAP: Partial<Record<(typeof BONES)[number], [number, number]>> = {
  Hips: [14, 20], Spine1: [12, 25], Spine2: [12, 25], Neck: [12, 16], Head: [14, 18],
  LeftShoulder: [10, 20], RightShoulder: [10, 20], LeftArm: [30, 110], RightArm: [30, 110], LeftForeArm: [30, 60], RightForeArm: [30, 60],
  LeftHand: [30, 45], RightHand: [30, 45], LeftUpLeg: [20, 30], RightUpLeg: [20, 30], LeftLeg: [25, 35], RightLeg: [25, 35], LeftFoot: [25, 35], RightFoot: [25, 35],
};
const TEMPORAL = BONES.map((n, i) => (SPEED_CAP[n] ? i : -1)).filter((i) => i >= 0);

export interface Attachments {
  /** Bat_Grip relative to RightHand: knob position (bone-local, model units) and barrel axis */
  batKnob: number[];
  batAxis: number[];
}

/** Rig description the validator needs: rest pose, attachments, body volumes. */
export interface RigInfo {
  R: RestInfo;
  restLocals: PoseLocals;
  att: Attachments;
  torso: TorsoVolume;
  head: HeadVolume;
  /** rest heights (rig units) of the ankle and toe joints over the sole */
  ankleH: number;
  toeH: number;
}

export function rigInfo(restLocals: PoseLocals, batGrip: { q: number[]; t: number[] }, morphs?: Record<string, number>, helmet = false): RigInfo {
  const rw = fk(restLocals);
  fk(restLocals, rw, rw);
  const R = restInfo(rw);
  const axis = qrot(batGrip.q, 0, 1, 0, [0, 0, 0]) as number[];
  const s = restLocals.base[7];
  return {
    R, restLocals, att: { batKnob: batGrip.t.slice(), batAxis: axis }, torso: torsoVolume(morphs), head: headVolume(morphs, helmet),
    ankleH: (rw.wp[B.LeftFoot * 3 + 1] + rw.wp[B.RightFoot * 3 + 1]) / 2 / s, toeH: (rw.wp[B.LeftToeBase * 3 + 1] + rw.wp[B.RightToeBase * 3 + 1]) / 2 / s,
  };
}

/** per-puppet state carried between frames */
export interface Track {
  prevJ: Float64Array | null;
  /** joint rotations two frames back (out-and-back pops) */
  prevJ2: Float64Array | null;
  /** last two joint deltas per bone (deg) for the flip test */
  d1: Float64Array;
  d2: Float64Array;
  hasD1: boolean;
  hasD2: boolean;
  /** last frame's contact points (world) and whether each foot was planted */
  foot: { x: number; z: number; planted: boolean }[];
  floatT: number;
}
export const newTrack = (): Track => ({ prevJ: null, prevJ2: null, d1: new Float64Array(NB), d2: new Float64Array(NB), hasD1: false, hasD2: false, foot: [0, 1, 2, 3].map(() => ({ x: 0, z: 0, planted: false })), floatT: 0 });

const W = newWorld();
const angles: Record<string, number> = {};
const tv = [0, 0, 0], tv2 = [0, 0, 0], jq = [0, 0, 0, 1];

/** world point = model * rig point */
function toWorld(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
/** rig point = inverse(model) * world point (model = rotation * uniform scale (+ mirror) + translation) */
function toRig(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]) {
  const px = x - m[12], py = y - m[13], pz = z - m[14];
  // columns are orthogonal with equal length s: inverse of the linear part = transpose / s^2
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  out[0] = (m[0] * px + m[1] * py + m[2] * pz) / s2;
  out[1] = (m[4] * px + m[5] * py + m[6] * pz) / s2;
  out[2] = (m[8] * px + m[9] * py + m[10] * pz) / s2;
  return out;
}

/** the point of a hand's fist the handle runs through, and the barrel direction that hand's grip implies (rig space) */
export function fistGrip(w: PoseWorld, rig: RigInfo, side: 'L' | 'R', base: number, pt: number[], dir: number[]) {
  const bi = side === 'R' ? B.RightHand : B.LeftHand;
  const mx = side === 'R' ? 1 : -1; // the left hand's local frame is the right's mirrored, X negated
  const k = rig.att.batKnob, a = rig.att.batAxis;
  const kx = mx * k[0], ax = mx * a[0];
  // the handle point nearest the wrist: knob + s0 * axis
  const s0 = -(kx * ax + k[1] * a[1] + k[2] * a[2]);
  localPoint(w, bi, kx + ax * s0, k[1] + a[1] * s0, k[2] + a[2] * s0, base, pt);
  qrot(w.wq, ax, a[1], a[2], dir, bi * 4);
}

function sev(kind: string, ex: number) {
  return Math.min(3, ex / unitOf(kind));
}

/**
 * Validate one frame. `out` collects the violations; `angles` (exported for the report) holds the measured joint angles.
 */
export function validateFrame(f: FrameIn, rig: RigInfo, tr: Track, out: Violation[]): PoseWorld {
  out.length = 0;
  const push = (kind: string, ex: number) => {
    if (ex > 1e-6) out.push({ kind, excess: ex, sev: sev(kind, ex) });
  };
  const w = fk(f.L, W, rig.R.rest);
  const base = f.L.base[7];
  // ---- joint ranges
  measureJoints(w, rig.R, angles);
  for (const l of JOINT_LIMITS) push(`joint:${l.key}`, excess(l, angles[l.key]));
  // ---- segment lengths
  for (const [a, b] of [[B.LeftArm, B.LeftForeArm], [B.LeftForeArm, B.LeftHand], [B.RightArm, B.RightForeArm], [B.RightForeArm, B.RightHand], [B.LeftUpLeg, B.LeftLeg], [B.LeftLeg, B.LeftFoot], [B.RightUpLeg, B.RightLeg], [B.RightLeg, B.RightFoot]]) {
    const r = segLen(w, a, b) / Math.max(1e-6, rig.R.len[a]);
    push(`len:${BONES[a]}`, Math.abs(r - 1) - 0.02);
  }
  // ---- trunk / head volumes (spine frame: Spine2's anatomical frame, as clearElbows uses it)
  const sp = B.Spine2 * 3;
  const inSpine = (p: number[]) => {
    qrotInv(w.aq, (p[0] - w.wp[sp]) / base, (p[1] - w.wp[sp + 1]) / base, (p[2] - w.wp[sp + 2]) / base, tv2, B.Spine2 * 4);
    return tv2;
  };
  const hv = rig.head;
  const hc = localPoint(w, B.Head, 0, hv.up, hv.fwd, base, [0, 0, 0]);
  const hcS: V3 = [hc[0] / base, hc[1] / base, hc[2] / base];
  for (const s of ['Left', 'Right'] as const) {
    const S = B[`${s}Arm`] * 3, E = B[`${s}ForeArm`] * 3, H = B[`${s}Hand`] * 3;
    const e = inSpine([w.wp[E], w.wp[E + 1], w.wp[E + 2]]);
    push('body:elbow-torso', -torsoClearance(e[0], e[1], e[2], rig.torso) - 0.01);
    const fist = localPoint(w, B[`${s}Hand`], 0, 0.085, 0, base, [0, 0, 0]);
    const h = inSpine(fist);
    push('body:hand-torso', -torsoClearance(h[0], h[1], h[2], rig.torso) - 0.02);
    const v3 = (i: number): V3 => [w.wp[i] / base, w.wp[i + 1] / base, w.wp[i + 2] / base];
    push('body:arm-head', -armHeadClearance(v3(S), v3(E), v3(H), hcS, hv) - 0.01);
  }
  // ---- feet (world)
  const m = f.model;
  const ms = Math.hypot(m[0], m[1], m[2]); // model scale (height)
  const wp = (i: number, o: number[]) => toWorld(m, w.wp[i * 3], w.wp[i * 3 + 1], w.wp[i * 3 + 2], o);
  let lowest = Infinity;
  // contact points: each foot's heel (ankle) and ball (toe), planted when within 3 cm of the ground
  let pi = 0;
  for (const [foot, toe] of [[B.LeftFoot, B.LeftToeBase], [B.RightFoot, B.RightToeBase]]) {
    const a = wp(foot, [0, 0, 0]), t = wp(toe, [0, 0, 0]);
    const ha = a[1] - rig.ankleH * base * ms - f.ground(a[0], a[2]);
    const ht = t[1] - rig.toeH * base * ms - f.ground(t[0], t[2]);
    lowest = Math.min(lowest, ha, ht);
    push('foot:below', -Math.min(ha, ht) - 0.03);
    for (const [P, h] of [[a, ha], [t, ht]] as const) {
      const c = tr.foot[pi++];
      const planted = h < 0.03;
      // a planted heel or ball moving over the ground (in the static sweep the root is fixed: only non-locomotion clips; in the game every clip,
      // locomotion with a looser cap since the stride rate only approximates the ground speed)
      if (planted && c.planted && f.dt > 0 && !f.cut && (f.vel ? true : !f.locomotion && !f.airborne)) push('foot:slide', Math.hypot(P[0] - c.x, P[2] - c.z) / f.dt - (f.locomotion ? 0.6 : 0.35));
      c.x = P[0];
      c.z = P[2];
      c.planted = planted;
    }
  }
  if (!f.airborne) {
    const lim = f.locomotion ? 0.16 : 0.07;
    if (lowest > lim) {
      tr.floatT += f.dt;
      // a float shorter than a running stride's flight is fine
      if (tr.floatT > (f.locomotion ? 0.2 : 0.1)) push('foot:float', lowest - lim);
    } else tr.floatT = 0;
  }
  // ---- running direction
  if (f.vel && f.locomotion) {
    const sp2 = Math.hypot(f.vel.x, f.vel.z);
    if (sp2 > 2.5) {
      qrot(w.aq, 0, 0, 1, tv, B.Hips * 4);
      const fx = m[0] * tv[0] + m[4] * tv[1] + m[8] * tv[2], fz = m[2] * tv[0] + m[6] * tv[1] + m[10] * tv[2];
      const c = (fx * f.vel.x + fz * f.vel.z) / (Math.hypot(fx, fz) * sp2 || 1);
      push('yaw:travel', Math.acos(Math.max(-1, Math.min(1, c))) / DEG - 60);
    }
  }
  // ---- bat
  if (f.bat) checkBat(f.bat, w, rig, m, base, f.ground, push, inSpine);
  // ---- temporal: per-joint rotation change since the last frame
  const J = tr.prevJ ?? new Float64Array(NB * 4);

  if (f.dt > 0 && !f.cut && tr.prevJ) {
    const d0 = new Float64Array(NB);
    for (const i of TEMPORAL) {
      const p = PARENT[i];
      if (p < 0) jq.splice(0, 4, ...Array.from(w.aq.subarray(0, 4)));
      else jointRot(w, p, i, jq);
      const d = qdist(jq, J, 0, i * 4);
      d0[i] = d / DEG;
      const cap = SPEED_CAP[BONES[i]]![f.ballistic ? 1 : 0];
      push(`spike:${BONES[i]}`, d / f.dt / cap - 1);
      // flip: the previous frame jumped far more than both of its neighbours (a step that stays), or jumped out and straight back
      if (tr.hasD1 && tr.hasD2) {
        const mid = tr.d1[i];
        if (mid > 25 && mid > 3 * Math.max(tr.d2[i], d0[i])) push(`flip:${BONES[i]}`, mid);
        else if (mid > 25 && d0[i] > 25 && tr.prevJ2 && qdist(jq, tr.prevJ2, 0, i * 4) / DEG < 0.35 * mid) push(`flip:${BONES[i]}`, mid);
      }
    }
    tr.d2.set(tr.d1);
    tr.hasD2 = tr.hasD1;
    tr.d1.set(d0);
    tr.hasD1 = true;
  } else {
    tr.hasD1 = tr.hasD2 = false;
  }
  // keep the last frame as the one two back, then store this one
  const J2 = tr.prevJ2 ?? new Float64Array(NB * 4);
  J2.set(J);
  for (const i of TEMPORAL) {
    const p = PARENT[i];
    if (p < 0) J.set(w.aq.subarray(0, 4), 0);
    else {
      jointRot(w, p, i, jq);
      J.set(jq, i * 4);
    }
  }
  tr.prevJ = J;
  tr.prevJ2 = J2;
  return w;
}

const BAT_LEN = 0.86;
function checkBat(bat: BatIn, w: PoseWorld, rig: RigInfo, m: ArrayLike<number>, base: number, ground: (x: number, z: number) => number, push: (k: string, e: number) => void, inSpine: (p: number[]) => number[]) {
  const ms = Math.hypot(m[0], m[1], m[2]);
  const K = bat.knob, T = bat.tip;
  const ax = (T[0] - K[0]) / BAT_LEN, ay = (T[1] - K[1]) / BAT_LEN, az = (T[2] - K[2]) / BAT_LEN;
  if (bat.state === 'dropped') {
    // lying on the ground: both ends at the ground (the barrel is ~3 cm in radius)
    for (const P of [K, T]) {
      const h = P[1] - ground(P[0], P[2]);
      push('bat:lying', Math.max(-h - 0.01, h - 0.08));
    }
    return;
  }
  // hands on the handle (world): fist centre distance from the bat's axis, its position along the handle, the grip's own barrel direction
  const pt = [0, 0, 0], dir = [0, 0, 0], wpnt = [0, 0, 0];
  const along: Record<string, number> = {};
  for (const s of ['L', 'R'] as const) {
    fistGrip(w, rig, s, base, pt, dir);
    toWorld(m, pt[0], pt[1], pt[2], wpnt);
    const rx = wpnt[0] - K[0], ry = wpnt[1] - K[1], rz = wpnt[2] - K[2];
    const sAlong = rx * ax + ry * ay + rz * az;
    along[s] = sAlong;
    if (!bat.hands[s]) continue;
    const sc = Math.max(0, Math.min(0.32, sAlong));
    const dist = Math.hypot(rx - ax * sc, ry - ay * sc, rz - az * sc);
    push(`bat:grip-${s}`, dist - 0.03);
    // the grip's barrel direction, mirrored into the world with the model (columns carry the mirror)
    const gx = m[0] * dir[0] + m[4] * dir[1] + m[8] * dir[2], gy = m[1] * dir[0] + m[5] * dir[1] + m[9] * dir[2], gz = m[2] * dir[0] + m[6] * dir[1] + m[10] * dir[2];
    const gl = Math.hypot(gx, gy, gz) || 1;
    const c = (gx * ax + gy * ay + gz * az) / gl;
    push('bat:hand-axis', Math.acos(Math.max(-1, Math.min(1, c))) / DEG - 25);
  }
  // the hand nearer the knob is the model's left one for both batting sides (lefties are mirrored)
  if (bat.hands.L && bat.hands.R) push('bat:order', along.L - along.R);
  // the barrel through the trunk, the head or the ground
  const p = [0, 0, 0], r = [0, 0, 0];
  let worstBody = 0, worstGround = 0;
  for (let s = 0.3; s <= BAT_LEN + 1e-6; s += 0.04) {
    p[0] = K[0] + ax * s;
    p[1] = K[1] + ay * s;
    p[2] = K[2] + az * s;
    worstGround = Math.max(worstGround, ground(p[0], p[2]) - p[1] - 0.01);
    toRig(m, p[0], p[1], p[2], r);
    const q = inSpine(r);
    worstBody = Math.max(worstBody, -torsoClearance(q[0], q[1], q[2], rig.torso) - 0.03);
    const hc = localPoint(w, B.Head, 0, rig.head.up, rig.head.fwd, base, [0, 0, 0]);
    worstBody = Math.max(worstBody, (rig.head.radius * base - Math.hypot(r[0] - hc[0], r[1] - hc[1], r[2] - hc[2])) * ms - 0.03);
  }
  push('bat:body', worstBody);
  push('bat:ground', worstGround);
}

export { angles as lastAngles, toWorld };
