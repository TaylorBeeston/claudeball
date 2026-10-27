/**
 * The head look-at as a pose pass (pure maths on the locals, like neck.ts): where the head points and how a look turns it.
 *
 * Done in a LEVEL frame: yaw about the rig's vertical, measured from the chest's heading on the ground plane, and pitch about the head's horizontal
 * axis. A crouched fielder's chest leans 50-70 deg forward; the look used to yaw the neck and head about that chest's own up axis, which rolled
 * the head onto a shoulder (a yaw psi about an axis tilted theta forward rolls the ears by asin(sin theta sin psi): 60-90 deg in the ready crouch)
 * and, measured in that tilted frame, the yaw itself blew up near its pole. A person keeps the eyes level (the righting reflex): the head's
 * rotation is set directly in rig space, so whatever the trunk does, the look adds no roll beyond a few degrees of natural tilt into the turn.
 */
import { DEG, qaxisAngle, qinv, qmul, qrot, type Q, type V } from './qmath';
import { B, PARENT, type PoseLocals, type PoseWorld, fk, newWorld } from './skeleton';
import type { RestInfo } from './limits';

export const LOOK = {
  /** share of the neck + head turn the neck bone takes (the head the rest) */
  neck: 0.4,
  /** natural tilt into the turn: the head's ear on the side it turns to dips by this share of the yaw (cervical coupling), capped (deg) */
  tilt: 0.06,
  tiltMax: 5,
  /** how far the head may tip back (up) / forward (down) from the chest (deg), inside the validator's neck range (-70..65) with a margin for the
   *  neck's share and blends: in a ready crouch the chest leans 40-70 deg forward, so a level head is already well back */
  up: 60,
  down: 55,
};

const W = newWorld();
const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));

/**
 * The head's roll off the horizon (deg): how far its ear-to-ear axis tips out of the horizontal plane, > 0 when the left ear is up. Rig space is
 * upright (the model node only yaws, scales and mirrors), so this is the roll a viewer sees.
 */
export function headRoll(w: PoseWorld): number {
  const l = qrot(w.aq, 1, 0, 0, [0, 0, 0], B.Head * 4);
  return Math.asin(Math.max(-1, Math.min(1, l[1]))) / DEG;
}

/** how far (deg) the chest's up axis leans off the vertical */
export function chestLean(w: PoseWorld): number {
  const u = qrot(w.aq, 0, 1, 0, [0, 0, 0], B.Spine2 * 4);
  return Math.acos(Math.max(-1, Math.min(1, u[1]))) / DEG;
}

/** The level look frame of a pose: the chest's heading on the ground plane (unit, y = 0) and its left axis. */
export interface LookFrame {
  fwd: number[];
  left: number[];
}

/**
 * The chest's heading: its forward and up axes projected on the ground plane and summed, so it stays defined from upright (forward) to bent
 * double (the up axis then points where the chest faces); +Z of the rig when both vanish.
 */
export function lookFrame(w: PoseWorld, out: LookFrame = { fwd: [0, 0, 1], left: [1, 0, 0] }): LookFrame {
  const z = qrot(w.aq, 0, 0, 1, [0, 0, 0], B.Spine2 * 4), y = qrot(w.aq, 0, 1, 0, [0, 0, 0], B.Spine2 * 4);
  let fx = z[0] + y[0], fz = z[2] + y[2];
  const n = Math.hypot(fx, fz);
  if (n < 1e-3) [fx, fz] = [0, 1];
  else [fx, fz] = [fx / n, fz / n];
  out.fwd = [fx, 0, fz];
  // left = up x fwd
  out.left = [fz, 0, -fx];
  return out;
}

/** a rig-space direction as yaw (about the vertical, > 0 toward the frame's left) and pitch (> 0 below the horizon), radians */
export function yawPitchIn(f: LookFrame, d: V, out: number[] = [0, 0]): number[] {
  const x = d[0] * f.left[0] + d[2] * f.left[2], z = d[0] * f.fwd[0] + d[2] * f.fwd[2];
  out[0] = Math.atan2(x, z);
  out[1] = Math.atan2(-d[1], Math.hypot(x, z));
  return out;
}

/** where the head points (its anatomical +Z) in rig space */
export const gazeOf = (w: PoseWorld, out: V = [0, 0, 0]): V => qrot(w.aq, 0, 0, 1, out, B.Head * 4);

function setRig(L: PoseLocals, w: PoseWorld, rest: PoseWorld, i: number, q: Q) {
  const p = PARENT[i];
  const pq = p < 0 ? Array.from(L.base.subarray(0, 4)) : sl(w.wq, p, 4);
  L.lq.set(qmul(qinv(pq), q), i * 4);
  fk(L, w, rest);
}

/** a fraction of a rotation (shortest arc) */
function qpart(q: Q, k: number): Q {
  const s = q[3] < 0 ? -1 : 1;
  const ang = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
  const n = Math.hypot(q[0], q[1], q[2]);
  if (n < 1e-9 || ang < 1e-9) return [0, 0, 0, 1];
  return qaxisAngle((s * q[0]) / n, (s * q[1]) / n, (s * q[2]) / n, ang * k);
}

/**
 * Turn the head by a look offset from the clip's pose (in place): `spineYaw` twists the chest about its own long axis (the trunk helps), then the
 * head's gaze is turned by `yaw` about the vertical and `pitch` about its horizontal axis, the neck taking `LOOK.neck` of the way. Angles in
 * radians, yaw > 0 toward the model's left, pitch > 0 down. Returns a bit mask of the bones changed.
 */
export function applyLook(L: PoseLocals, R: RestInfo, yaw: number, pitch: number, spineYaw = 0): number {
  if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4 && Math.abs(spineYaw) < 1e-4) return 0;
  const w = fk(L, W, R.rest);
  const qHead = sl(w.wq, B.Head, 4);
  const g = gazeOf(w);
  let mask = (1 << B.Neck) | (1 << B.Head);
  // the trunk's share: a twist of the chest about its own axis (it carries the shoulders; the head is set below, so it cannot roll it)
  if (Math.abs(spineYaw) > 1e-4) {
    const a = qrot(w.aq, 0, 1, 0, [0, 0, 0], B.Spine2 * 4);
    setRig(L, w, R.rest, B.Spine2, qmul(qaxisAngle(a[0], a[1], a[2], spineYaw), sl(w.wq, B.Spine2, 4)));
    mask |= 1 << B.Spine2;
  }
  // the head's goal: pitch about the gaze's horizontal axis, yaw about the vertical, a little tilt into the turn about the new gaze
  const h = Math.hypot(g[0], g[2]);
  const lx = h > 1e-6 ? g[2] / h : 1, lz = h > 1e-6 ? -g[0] / h : 0;
  const qP = qaxisAngle(lx, 0, lz, pitch), qY = qaxisAngle(0, 1, 0, yaw);
  let qD = qmul(qY, qP);
  const g2 = qrot(qD, g[0], g[1], g[2]);
  const tilt = Math.max(-LOOK.tiltMax, Math.min(LOOK.tiltMax, (LOOK.tilt * yaw) / DEG)) * DEG;
  qD = qmul(qaxisAngle(g2[0], g2[1], g2[2], -tilt), qD);
  const goal = qmul(qD, qHead);
  // the neck takes its share of what is left to turn after the trunk, the head the rest (set to the goal: its rig rotation, so level)
  const left = qmul(goal, qinv(sl(w.wq, B.Head, 4)));
  setRig(L, w, R.rest, B.Neck, qmul(qpart(left, LOOK.neck), sl(w.wq, B.Neck, 4)));
  setRig(L, w, R.rest, B.Head, goal);
  return mask;
}

/**
 * A look target (rig-space point) in the level frame of a pose: the target's offset from the head as (left, up, forward) components, ready for
 * headLook's lookTarget, and where the clip already points the head (yaw, pitch in radians, same frame).
 */
export function lookInput(L: PoseLocals, R: RestInfo, target: V, out = { dx: 0, dy: 0, dz: 0, clipYaw: 0, clipPitch: 0, chest: 0 }) {
  const w = fk(L, W, R.rest);
  const f = lookFrame(w);
  const h = B.Head * 3;
  const x = target[0] - w.wp[h], y = target[1] - w.wp[h + 1], z = target[2] - w.wp[h + 2];
  out.dx = x * f.left[0] + z * f.left[2];
  out.dy = y;
  out.dz = x * f.fwd[0] + z * f.fwd[2];
  const yp = yawPitchIn(f, gazeOf(w));
  out.clipYaw = yp[0];
  out.clipPitch = yp[1];
  // the chest's forward lean along its heading (rad, > 0 leaning forward): its up axis tipped toward the heading
  const u = qrot(w.aq, 0, 1, 0, [0, 0, 0], B.Spine2 * 4);
  out.chest = Math.atan2(u[0] * f.fwd[0] + u[2] * f.fwd[2], u[1]);
  return out;
}

/**
 * Keep a look's pitch (radians, the offset from the clip's, > 0 down) inside what the neck can do from the chest: a head turned by `yaw` from the
 * chest's heading tips back against a chest leaning `chest` forward by about chest x cos(yaw). The look never tips it past that range further
 * than the clip itself holds it (the hands-on-knees crouch keeps a level head ~80 deg back: that is the clip's, not pulled down). Returns the
 * clamped offset.
 */
export function neckPitch(pitch: number, yaw: number, li: { clipYaw: number; clipPitch: number; chest: number }): number {
  const lean = li.chest * Math.cos(li.clipYaw + yaw);
  const lo = Math.min(li.clipPitch, lean - LOOK.up * DEG), hi = Math.max(li.clipPitch, lean + LOOK.down * DEG);
  return Math.max(lo, Math.min(hi, li.clipPitch + pitch)) - li.clipPitch;
}
