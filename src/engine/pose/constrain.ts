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
import { armRest, solveArm, type ArmRest } from './armIK';
import { gaitArms, type GaitArmsOpts, type GaitArmsState } from './gaitArms';
import { torsoVolume } from '../armClear';

/**
 * Soft limit: x unchanged inside [lo, hi] (a valid pose is never touched); past a limit it eases into an overshoot band of width m, approaching
 * lo - m / hi + m asymptotically (C1-continuous, so a clip sweeping through a limit has no kink).
 */
export function softClamp(x: number, lo: number, hi: number, m: number): number {
  if (x > hi) return hi + m * Math.tanh((x - hi) / m);
  if (x < lo) return lo - m * Math.tanh((lo - x) / m);
  return x;
}

/** where the soft limits start (deg); each eases into `margin` more (so the hard ranges are these + margin) */
export const CONSTRAINT = {
  elbow: { lo: 0, hi: 145, off: 14 },
  knee: { lo: 0, hi: 147, off: 10, twist: 30 },
  /** pronation / supination from neutral (deg) */
  pron: 88,
  sup: 88,
  wrist: 72,
  ankle: 50,
  ankleTwist: 24,
  /** easing band (deg) */
  margin: 6,
  restPron: 20,
  /** the fastest a forearm turns (deg/s; pitchers reach about this in the release) */
  pronSpeed: 1800,
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
function hinge(L: PoseLocals, w: PoseWorld, R: RestInfo, up: number, mid: number, flexZ: number, lim: { lo: number; hi: number; off: number; twist?: number }, m: number): boolean {
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
  const off2 = softClamp(off, -1e9, lim.off, m);
  // the bone's twist about itself: kept (the elbow's is pronation, handled with the hand), limited for the shin
  const twD = tw / DEG;
  const tw2 = lim.twist !== undefined ? softClamp(twD, -lim.twist, lim.twist, m) : twD;
  if (Math.abs(flex2 - flex) < 0.05 && Math.abs(off2 - off) < 0.05 && Math.abs(tw2 - twD) < 0.05) return false;
  const k = off > 1e-9 ? off2 / off : 0;
  const v2 = [a[0] * (flex2 - restBend / DEG) * DEG + ox[0] * k, a[1] * (flex2 - restBend / DEG) * DEG + ox[1] * k, a[2] * (flex2 - restBend / DEG) * DEG + ox[2] * k];
  const g = Math.hypot(v2[0], v2[1], v2[2]);
  const swing2 = g > 1e-9 ? qaxisAngle(v2[0] / g, v2[1] / g, v2[2] / g, g) : [0, 0, 0, 1];
  const rel2 = qmul(swing2, qaxisAngle(uf[0], uf[1], uf[2], tw2 * DEG));
  setRig(L, w, R.rest, mid, qmul(qmul(aU, rel2), restQ(R.rest, mid)));
  return true;
}

/**
 * Forearm pronation clamped and shared between forearm and hand; the wrist's bend limited. With `st` (the pose's last frame), the twist is
 * continuous in time: of the angles 360 deg apart that a rotation's twist could be, the one the clamp changes least (what the clip shows,
 * ties to last frame's), and the result moves toward it no faster than a forearm can turn. Without that, a twist the clip carries past 180 deg
 * (the jog / run clips' ~210 deg pop) switched the clamp from one end of the range to the other: a one-frame hand flip.
 */
function forearm(L: PoseLocals, w: PoseWorld, R: RestInfo, side: 'Left' | 'Right', m: number, st?: ConstrainState, dt = 1 / 60): boolean {
  const sg = side === 'Left' ? 1 : -1;
  const up = B[`${side}Arm`], fo = B[`${side}ForeArm`], ha = B[`${side}Hand`];
  const uf = Array.from(R.dir.subarray(fo * 3, fo * 3 + 3));
  const aU = anatQ(w, up), aF = anatQ(w, fo), aH = anatQ(w, ha);
  const relF = qmul(qinv(aU), aF), relH = qmul(qinv(aF), aH);
  const swF = [0, 0, 0, 1], swH = [0, 0, 0, 1];
  const tf = twistAngle(relF, uf[0], uf[1], uf[2], swF) / DEG, th = twistAngle(relH, uf[0], uf[1], uf[2], swH) / DEG;
  let total = tf + th;
  let pr = sg * total - CONSTRAINT.restPron;
  const clampOf = (x: number) => softClamp(x, -CONSTRAINT.sup, CONSTRAINT.pron, m);
  const prev = st?.pron[side];
  // the twist a turn of 360 deg either way would also be: the one the clamp changes least (ties: nearest last frame's)
  let best = pr, bestC = Infinity;
  for (const c of [pr - 360, pr, pr + 360]) {
    const cost = Math.abs(c - clampOf(c)) + (prev === undefined ? 0 : Math.abs(clampOf(c) - prev) * 1e-3);
    if (cost < bestC - 1e-9) {
      best = c;
      bestC = cost;
    }
  }
  pr = best;
  let pr2 = clampOf(pr);
  // no faster than a forearm turns (a wrap or a clip's pop becomes a quick turn over a few frames instead of a one-frame flip)
  if (prev !== undefined) {
    const step = CONSTRAINT.pronSpeed * Math.max(1e-3, dt);
    pr2 = prev + Math.max(-step, Math.min(step, pr2 - prev));
  }
  if (st) st.pron[side] = pr2;
  const total2 = sg * (pr2 + CONSTRAINT.restPron);
  total = sg * (pr + CONSTRAINT.restPron);
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
function ankle(L: PoseLocals, w: PoseWorld, R: RestInfo, side: 'Left' | 'Right', m: number, bend: boolean): boolean {
  const sh = B[`${side}Leg`], ft = B[`${side}Foot`];
  const us = Array.from(R.dir.subarray(sh * 3, sh * 3 + 3));
  const rel = qmul(qinv(anatQ(w, sh)), anatQ(w, ft));
  const tw = twistAngle(rel, us[0], us[1], us[2], sw) / DEG;
  const s = Math.hypot(sw[0], sw[1], sw[2]);
  const ang = (2 * Math.atan2(s, Math.abs(sw[3]))) / DEG;
  const tw2 = softClamp(tw, -CONSTRAINT.ankleTwist, CONSTRAINT.ankleTwist, m);
  const ang2 = bend ? softClamp(ang, -1e9, CONSTRAINT.ankle, m) : ang;
  if (Math.abs(tw2 - tw) < 0.05 && Math.abs(ang2 - ang) < 0.05) return false;
  const swing = s > 1e-9 ? qaxisAngle(sw[0] / s, sw[1] / s, sw[2] / s, ang2 * DEG * (sw[3] < 0 ? -1 : 1)) : [0, 0, 0, 1];
  const rel2 = qmul(swing, qaxisAngle(us[0], us[1], us[2], tw2 * DEG));
  setRig(L, w, R.rest, ft, qmul(qmul(anatQ(w, sh), rel2), restQ(R.rest, ft)));
  return true;
}

const legRests = new WeakMap<RestInfo, Record<'Left' | 'Right', ArmRest>>();
function legRest(R: RestInfo, side: 'Left' | 'Right'): ArmRest {
  let r = legRests.get(R);
  if (!r) {
    const mk = (s: 'Left' | 'Right') => {
      const [u, l, f] = [B[`${s}UpLeg`], B[`${s}Leg`], B[`${s}Foot`]];
      const d = (i: number) => Array.from(R.dir.subarray(i * 3, i * 3 + 3));
      return armRest(d(u), d(l), restQ(R.rest, u), restQ(R.rest, l), restQ(R.rest, f), s === 'Left' ? 1 : -1, -1);
    };
    legRests.set(R, (r = { Left: mk('Left'), Right: mk('Right') }));
  }
  return r[side];
}

/**
 * A knee bent sideways, backwards or twisted: re-solve the leg with the two-bone solver so the knee bends in its hinge plane at the clip's
 * swivel, with the ankle where it was and the foot keeping its orientation (a planted foot stays planted). A knee folded past full flexion
 * cannot be opened without moving the foot and is left alone (slides).
 */
function leg(L: PoseLocals, w: PoseWorld, R: RestInfo, side: 'Left' | 'Right'): boolean {
  const [u, l, f] = [B[`${side}UpLeg`], B[`${side}Leg`], B[`${side}Foot`]];
  const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));
  // measure: the bend's out-of-plane part and the shin's own twist (as hinge() does), and hyperextension
  const lr = legRest(R, side);
  const aU = anatQ(w, u), aM = anatQ(w, l);
  const rel = qmul(qinv(aU), aM);
  const tw = twistAngle(rel, lr.uf[0], lr.uf[1], lr.uf[2], sw) / DEG;
  const d = [w.wp[f * 3] - w.wp[l * 3], w.wp[f * 3 + 1] - w.wp[l * 3 + 1], w.wp[f * 3 + 2] - w.wp[l * 3 + 2]];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const t: number[] = [0, 0, 0];
  const qa = aU;
  // the shin direction in the thigh's anatomical frame
  const x = d[0] / dl, y = d[1] / dl, z = d[2] / dl;
  const iq = qinv(qa);
  const tx = 2 * (iq[1] * z - iq[2] * y), ty = 2 * (iq[2] * x - iq[0] * z), tz = 2 * (iq[0] * y - iq[1] * x);
  t[0] = x + iq[3] * tx + (iq[1] * tz - iq[2] * ty);
  t[1] = y + iq[3] * ty + (iq[2] * tx - iq[0] * tz);
  t[2] = z + iq[3] * tz + (iq[0] * ty - iq[1] * tx);
  const a = [lr.u[1] * lr.n[2] - lr.u[2] * lr.n[1], lr.u[2] * lr.n[0] - lr.u[0] * lr.n[2], lr.u[0] * lr.n[1] - lr.u[1] * lr.n[0]];
  const off = Math.asin(Math.max(-1, Math.min(1, t[0] * a[0] + t[1] * a[1] + t[2] * a[2]))) / DEG;
  const flex = Math.atan2(t[0] * lr.n[0] + t[1] * lr.n[1] + t[2] * lr.n[2], t[0] * lr.u[0] + t[1] * lr.u[1] + t[2] * lr.u[2]) / DEG;
  const lim = CONSTRAINT.knee;
  if (Math.abs(off) <= lim.off && Math.abs(tw) <= lim.twist && flex >= lim.lo - 0.5) return false;
  const out = solveArm(lr, { S: sl(w.wp, u, 3), E: sl(w.wp, l, 3), H: sl(w.wp, f, 3), qUpper: sl(w.wq, u, 4), qFore: sl(w.wq, l, 4), qHand: sl(w.wq, f, 4) }, { target: sl(w.wp, f, 3), fist: [0, 0, 0], keepEnd: true, twistLimit: lim.twist }, 2);
  setRig(L, w, R.rest, u, out.qUpper);
  setRig(L, w, R.rest, l, out.qFore);
  setRig(L, w, R.rest, f, out.qHand);
  return true;
}

export interface ConstrainOpts {
  arms?: boolean;
  legs?: boolean;
  /** forearm pronation per side (off for a hand holding a bat on its grip: turning that hand would turn the bat away from the other hand) */
  pron?: { Left: boolean; Right: boolean };
  /** the ankle's bend and twist (off by default: on a planted foot either moves the toes into / off the ground; correcting it needs the leg IK
   *  of phase B2, which can move the twist up to the hip) */
  ankles?: boolean;
  /** the running arms' carriage (gaitArms.ts), first: its weight is the gait clips' share of the pose */
  gait?: GaitArmsOpts;
  /** what the last frame's constraint did (pass the same object every frame of one character for time-continuous twists); `dt` its step (s) */
  state?: ConstrainState;
  dt?: number;
}

/** per character, carried from frame to frame */
export interface ConstrainState {
  /** the forearm pronation (deg from neutral) last frame's pose ended with, per side */
  pron: { Left?: number; Right?: number };
  /** the running-arm pass's last correction (gaitArms.ts) */
  gait?: GaitArmsState;
}
export const newConstrainState = (): ConstrainState => ({ pron: {}, gait: {} });

/**
 * Put the pose's elbows, knees, forearms, wrists and ankles back inside their ranges (in place). Returns a bit mask of the bones it changed
 * (bit i = bone i) so the caller writes back only those.
 */
export function constrainPose(L: PoseLocals, R: RestInfo, o: ConstrainOpts = {}): number {
  let mask = o.gait && o.arms !== false && !(globalThis as { __noGaitArms?: boolean }).__noGaitArms ? gaitArms(L, R, { ...o.gait, state: o.state?.gait, dt: o.dt }) : 0;
  const w = fk(L, W, R.rest);
  const m = CONSTRAINT.margin;
  for (const side of ['Left', 'Right'] as const) {
    if (o.arms !== false) {
      if (hinge(L, w, R, B[`${side}Arm`], B[`${side}ForeArm`], 1, CONSTRAINT.elbow, m)) mask |= 1 << B[`${side}ForeArm`];
      if (o.pron?.[side] ?? true) {
        if (forearm(L, w, R, side, m, o.state, o.dt)) mask |= (1 << B[`${side}ForeArm`]) | (1 << B[`${side}Hand`]);
      } else if (o.state) delete o.state.pron[side];
    }
    if (o.legs !== false) {
      if (leg(L, w, R, side)) mask |= (1 << B[`${side}UpLeg`]) | (1 << B[`${side}Leg`]) | (1 << B[`${side}Foot`]);
      if (o.ankles && ankle(L, w, R, side, m, true)) mask |= 1 << B[`${side}Foot`];
    }
  }
  void NB;
  return mask;
}

/** clips that hold a bat on its grip (their hands' twist is left alone: it would turn the bat away from the other hand) */
const BAT_HELD = /^(batting_stance|swing|batter_|ondeck_)/;
/** slides, dives and pop-ups fold the legs past what the leg solver can fix without moving the feet (they need re-authored clips, phase B2) */
const LEGS_FREE = /^(slide|dive|pop_up|coach_slide)/;

/** what the constraint layer does to a clip by its name (the game and the static sweep agree) */
export function constrainOptsFor(clip: string, holdsBat = BAT_HELD.test(clip)): ConstrainOpts {
  // the gait clips' ankles bent past their range (B2 game A/B: ankle swing -62 %, total -7 %, no cost: the foot lock re-plants the feet after)
  const ankles = GAIT_ANKLES.test(clip) && !(globalThis as { __noGaitAnkles?: boolean }).__noGaitAnkles;
  const gait = isGaitClip(clip) ? { w: 1, torso: TORSO } : undefined;
  return { arms: true, legs: !LEGS_FREE.test(clip), pron: { Left: !holdsBat, Right: !holdsBat }, ankles, gait };
}
/** the clips whose arms the running-arm pass (gaitArms.ts) corrects: the running gaits (a walk's arms swing low and loose, left to the clip) */
export const isGaitClip = (clip: string) => /^(trot|jog|run|run_sprint|run_turn|run_turn_sprint)$/.test(clip);
/** the average build's trunk (the game passes each player's own) */
const TORSO = torsoVolume(undefined);
/** the gait clips (their ankles clamped) */
const GAIT_ANKLES = /^(walk|trot|jog|run|run_sprint|run_turn|run_turn_sprint)$/;
