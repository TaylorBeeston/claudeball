/**
 * The constraint layer: after the mixer, the look-at and the IK, every frame, joints are put back inside a human range. Pure maths on the
 * locals (skeleton.ts), unit-tested; the puppet reads its bones into a PoseLocals, calls `constrainPose` and writes the changed bones back.
 *
 * - elbows and knees are hinges: the bend is a rotation about the anatomical hinge axis, clamped to [0, max] (no bending backwards, no past
 *   full flexion); the out-of-plane part is eased toward a small allowance (the carrying angle); the bone's own twist is kept;
 * - forearm pronation (the twist of the hand vs the upper arm, about the forearm) is clamped to the human range and shared half and half
 *   between forearm and hand (the rig has no twist bones), without moving the hand when nothing is clamped;
 * - the wrist's bend and the ankle's bend and twist are limited.
 *
 * Limits are soft: an angle eases into its limit over a margin (a smooth curve), so a clip passing through a limit has no kink and no pop.
 * Everything else (shoulders, hips, spine, neck) is left to the clips and the look-at (headLook) for now.
 */
import { DEG, qaxisAngle, qinv, qmul, twistAngle, type Q } from './qmath';
import { B, NB, PARENT, type PoseLocals, type PoseWorld, fk, newWorld } from './skeleton';
import type { RestInfo } from './limits';

/** ease x into [lo, hi]: unchanged inside [lo + m, hi - m], approaching the limit asymptotically past it (C1-continuous) */
export function softClamp(x: number, lo: number, hi: number, m: number): number {
  if (x > hi - m) return hi - m + m * Math.tanh((x - (hi - m)) / m);
  if (x < lo + m) return lo + m - m * Math.tanh((lo + m - x) / m);
  return x;
}

export const CONSTRAINT = {
  elbow: { lo: 0, hi: 150, off: 18 },
  knee: { lo: 0, hi: 150, off: 12 },
  /** pronation / supination from neutral (deg) */
  pron: 95,
  sup: 95,
  wrist: 80,
  ankle: 55,
  ankleTwist: 30,
  /** easing margins (deg) */
  margin: 12,
  restPron: 20,
};

const tq = [0, 0, 0, 1], sw = [0, 0, 0, 1];
const W = newWorld();

/** the world rotation of bone i's parent in rig space (identity-free: Hips' parent is the base) */
function parentQ(L: PoseLocals, w: PoseWorld, i: number): number[] {
  const p = PARENT[i];
  return p < 0 ? Array.from(L.base.subarray(0, 4)) : Array.from(w.wq.subarray(p * 4, p * 4 + 4));
}

/** set bone i's rig rotation (its children follow): local = parent^-1 * q, then refresh the chain below */
function setRig(L: PoseLocals, w: PoseWorld, rest: PoseWorld, i: number, q: Q) {
  L.lq.set(qmul(qinv(parentQ(L, w, i)), q), i * 4);
  fk(L, w, rest);
}

const anatQ = (w: PoseWorld, i: number) => Array.from(w.aq.subarray(i * 4, i * 4 + 4));
const restQ = (rest: PoseWorld, i: number) => Array.from(rest.wq.subarray(i * 4, i * 4 + 4));

/**
 * A hinge joint (parent segment `up`, hinge bone `mid`): split its anatomical rotation relative to `up` into swing + twist about the bone's rest
 * direction; the swing into the hinge part (about u x flexion side) and the rest; clamp the bend, ease the off-plane part, keep the twist.
 * Returns true when it changed the pose.
 */
function hinge(L: PoseLocals, w: PoseWorld, R: RestInfo, up: number, mid: number, flexZ: number, lim: { lo: number; hi: number; off: number }, m: number): boolean {
  const u = Array.from(R.dir.subarray(up * 3, up * 3 + 3)), uf = Array.from(R.dir.subarray(mid * 3, mid * 3 + 3));
  // flexion side perpendicular to u, hinge axis
  const n = [-flexZ * u[2] * u[0], -flexZ * u[2] * u[1], flexZ - flexZ * u[2] * u[2]];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  n[0] /= nl;
  n[1] /= nl;
  n[2] /= nl;
  const a = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]];
  const aU = anatQ(w, up), aM = anatQ(w, mid);
  const rel = qmul(qinv(aU), aM);
  const tw = twistAngle(rel, uf[0], uf[1], uf[2], sw);
  // swing as axis * angle
  const s = Math.hypot(sw[0], sw[1], sw[2]);
  const ang = 2 * Math.atan2(s, Math.abs(sw[3])) * (sw[3] < 0 ? -1 : 1);
  const ax = s > 1e-9 ? [sw[0] / s, sw[1] / s, sw[2] / s] : [a[0], a[1], a[2]];
  const v = [ax[0] * ang, ax[1] * ang, ax[2] * ang];
  // bend about the hinge axis (sign: toward the flexion side is positive), and the rest; the rest pose's own bend is the zero
  const restBend = Math.atan2(uf[0] * n[0] + uf[1] * n[1] + uf[2] * n[2], uf[0] * u[0] + uf[1] * u[1] + uf[2] * u[2]);
  const bend = (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) / DEG;
  const ox = [v[0] - a[0] * bend * DEG, v[1] - a[1] * bend * DEG, v[2] - a[2] * bend * DEG];
  const off = Math.hypot(ox[0], ox[1], ox[2]) / DEG;
  const flex = bend + restBend / DEG;
  const flex2 = softClamp(flex, lim.lo, lim.hi, m);
  const off2 = off > lim.off - m ? softClamp(off, -1e9, lim.off, m) : off;
  if (Math.abs(flex2 - flex) < 0.05 && Math.abs(off2 - off) < 0.05) return false;
  const k = off > 1e-9 ? off2 / off : 0;
  const v2 = [a[0] * (flex2 - restBend / DEG) * DEG + ox[0] * k, a[1] * (flex2 - restBend / DEG) * DEG + ox[1] * k, a[2] * (flex2 - restBend / DEG) * DEG + ox[2] * k];
  const g = Math.hypot(v2[0], v2[1], v2[2]);
  const swing2 = g > 1e-9 ? qaxisAngle(v2[0] / g, v2[1] / g, v2[2] / g, g) : [0, 0, 0, 1];
  const rel2 = qmul(swing2, qaxisAngle(uf[0], uf[1], uf[2], tw));
  setRig(L, w, R.rest, mid, qmul(qmul(aU, rel2), restQ(R.rest, mid)));
  return true;
}

/** forearm pronation clamped and shared between forearm and hand; the wrist's bend limited */
function forearm(L: PoseLocals, w: PoseWorld, R: RestInfo, side: 'Left' | 'Right', m: number): boolean {
  const sg = side === 'Left' ? 1 : -1;
  const up = B[`${side}Arm`], fo = B[`${side}ForeArm`], ha = B[`${side}Hand`];
  const uf = Array.from(R.dir.subarray(fo * 3, fo * 3 + 3));
  const aU = anatQ(w, up), aF = anatQ(w, fo), aH = anatQ(w, ha);
  const relF = qmul(qinv(aU), aF), relH = qmul(qinv(aF), aH);
  const swF = [0, 0, 0, 1], swH = [0, 0, 0, 1];
  const tf = twistAngle(relF, uf[0], uf[1], uf[2], swF) / DEG, th = twistAngle(relH, uf[0], uf[1], uf[2], swH) / DEG;
  let total = tf + th;
  const pr = sg * total - CONSTRAINT.restPron;
  let pr2 = pr - 360 * Math.round(pr / 360);
  pr2 = softClamp(pr2, -CONSTRAINT.sup, CONSTRAINT.pron, m);
  const total2 = sg * (pr2 + CONSTRAINT.restPron);
  // the wrist's bend
  const s = Math.hypot(swH[0], swH[1], swH[2]);
  const ang = 2 * Math.atan2(s, Math.abs(swH[3]));
  const ang2 = softClamp(ang / DEG, -1e9, CONSTRAINT.wrist, m) * DEG;
  const splitOk = Math.abs(tf - th) < 8;
  if (Math.abs(total2 - total) < 0.05 && Math.abs(ang2 - ang) < 0.001 && splitOk) return false;
  total = total2;
  const half = total / 2;
  // forearm: its swing (the elbow's bend) with half the twist; hand: its swing (wrist bend, limited) with the other half
  const relF2 = qmul(swF, qaxisAngle(uf[0], uf[1], uf[2], half * DEG));
  let swH2: Q = swH;
  if (ang > 1e-9 && Math.abs(ang2 - ang) > 1e-6) {
    const ax = [swH[0] / s, swH[1] / s, swH[2] / s];
    swH2 = qaxisAngle(ax[0], ax[1], ax[2], ang2 * (swH[3] < 0 ? -1 : 1));
  }
  const relH2 = qmul(swH2, qaxisAngle(uf[0], uf[1], uf[2], (total - half) * DEG));
  const aF2 = qmul(aU, relF2);
  setRig(L, w, R.rest, fo, qmul(aF2, restQ(R.rest, fo)));
  setRig(L, w, R.rest, ha, qmul(qmul(aF2, relH2), restQ(R.rest, ha)));
  return true;
}

/** the ankle: bend and twist about the shin limited */
function ankle(L: PoseLocals, w: PoseWorld, R: RestInfo, side: 'Left' | 'Right', m: number): boolean {
  const sh = B[`${side}Leg`], ft = B[`${side}Foot`];
  const us = Array.from(R.dir.subarray(sh * 3, sh * 3 + 3));
  const rel = qmul(qinv(anatQ(w, sh)), anatQ(w, ft));
  const tw = twistAngle(rel, us[0], us[1], us[2], sw) / DEG;
  const s = Math.hypot(sw[0], sw[1], sw[2]);
  const ang = (2 * Math.atan2(s, Math.abs(sw[3]))) / DEG;
  const tw2 = softClamp(tw, -CONSTRAINT.ankleTwist, CONSTRAINT.ankleTwist, m);
  const ang2 = softClamp(ang, -1e9, CONSTRAINT.ankle, m);
  if (Math.abs(tw2 - tw) < 0.05 && Math.abs(ang2 - ang) < 0.05) return false;
  const swing = s > 1e-9 ? qaxisAngle(sw[0] / s, sw[1] / s, sw[2] / s, ang2 * DEG * (sw[3] < 0 ? -1 : 1)) : [0, 0, 0, 1];
  const rel2 = qmul(swing, qaxisAngle(us[0], us[1], us[2], tw2 * DEG));
  setRig(L, w, R.rest, ft, qmul(qmul(anatQ(w, sh), rel2), restQ(R.rest, ft)));
  return true;
}

export interface ConstrainOpts {
  arms?: boolean;
  legs?: boolean;
}

/**
 * Put the pose's elbows, knees, forearms, wrists and ankles back inside their ranges (in place). Returns a bit mask of the bones it changed
 * (bit i = bone i) so the caller writes back only those.
 */
export function constrainPose(L: PoseLocals, R: RestInfo, o: ConstrainOpts = { arms: true, legs: true }): number {
  const w = fk(L, W, R.rest);
  const m = CONSTRAINT.margin;
  let mask = 0;
  for (const side of ['Left', 'Right'] as const) {
    if (o.arms !== false) {
      if (hinge(L, w, R, B[`${side}Arm`], B[`${side}ForeArm`], 1, CONSTRAINT.elbow, m)) mask |= 1 << B[`${side}ForeArm`];
      if (forearm(L, w, R, side, m)) mask |= (1 << B[`${side}ForeArm`]) | (1 << B[`${side}Hand`]);
    }
    if (o.legs !== false) {
      if (hinge(L, w, R, B[`${side}UpLeg`], B[`${side}Leg`], -1, CONSTRAINT.knee, m)) mask |= 1 << B[`${side}Leg`];
      if (ankle(L, w, R, side, m)) mask |= 1 << B[`${side}Foot`];
    }
  }
  void NB;
  return mask;
}
