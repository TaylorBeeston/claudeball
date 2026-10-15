/**
 * One analytic two-bone arm solver for every reach (bat grip, glove, tag), in rig space on plain arrays (unit-tested without three.js).
 *
 * What the old aim-based solver got wrong (measured by tools/jank): it aimed the upper arm and then the forearm along the shortest arc, so the
 * elbow hinge could end up bent sideways (up to 64 deg out of its plane) and the forearm twisted while the hand did not (the wrist wrung up to
 * 213 deg); it put the WRIST, not the fist, on the target; and it never turned the hand, so a bat ran across the knuckles instead of through
 * the fist. Here:
 * - the FIST point (a hand-local offset: the grip on a bat handle, the glove pocket) goes to the target;
 * - the elbow keeps the swivel the clip gives it (the pole is the clip's elbow), with a soft clamp near full extension, so the arm never snaps
 *   straight and the body keeps its pose (no hip drop: an unreachable target is simply not reached);
 * - the upper arm's twist is chosen so the forearm bends only in its anatomical hinge plane, toward its flexion side;
 * - with a grip axis, the hand turns so its grip line runs along the target axis (a bat's barrel toward the thumb), the twist that takes
 *   shared half and half by forearm and hand (the rig has no twist bones; the clips share it the same way), pronation and wrist bend clamped
 *   to a human range; without one, the hand keeps the clip's wrist pose.
 *
 * Frames: an ANATOMICAL frame is a bone's rig rotation times the inverse of its rest rotation (skeleton.ts), so in the rest pose all are the
 * identity in body axes (+Z forward, +Y up, +X the model's left).
 */
import { DEG, qaxisAngle, qfromTo, qinv, qmul, qrot, twistAngle, type Q } from './qmath';

export type V3 = [number, number, number] | number[];

/** rest data of one arm (rig space, the rest pose) */
export interface ArmRest {
  /** rest unit directions: shoulder -> elbow, elbow -> wrist */
  u: number[];
  uf: number[];
  /** unit flexion side of the elbow (anterior), perpendicular to u */
  n: number[];
  /** rest rig rotations of the upper arm, forearm and hand bones */
  qUpper: number[];
  qFore: number[];
  qHand: number[];
  /** +1 the model's left arm, -1 the right */
  side: 1 | -1;
}

export interface ArmPose {
  /** shoulder joint (the upper arm bone's origin), elbow, wrist: rig space */
  S: V3;
  E: V3;
  H: V3;
  /** rig rotations of upper arm, forearm, hand (the pose the clip gave) */
  qUpper: Q;
  qFore: Q;
  qHand: Q;
}

export interface ArmGoal {
  /** where the fist point should go (rig space) */
  target: V3;
  /** the fist point in the hand bone's frame, already in rig units */
  fist: V3;
  /** optional: the hand-local grip line and the rig-space direction it should run along */
  gripLocal?: V3;
  gripDir?: V3;
  /** keep the end bone's rig rotation (a planted foot keeps its orientation) */
  keepEnd?: boolean;
  /** limit the middle bone's own twist (deg; a shin's twist about itself) */
  twistLimit?: number;
}

export interface ArmOut {
  qUpper: number[];
  qFore: number[];
  qHand: number[];
  elbow: number[];
  wrist: number[];
  /** how far the fist ended from the target (rig units): > 0 when out of reach */
  miss: number;
}

export const ARM_LIMITS = {
  /** soft clamp: the last few percent of reach approach full extension asymptotically */
  soft: 0.96,
  /** pronation (from neutral, thumb-forward) and supination limits, deg; the wrist's bend limit, deg */
  pron: 88,
  sup: 88,
  wrist: 72,
  /** the rest pose is this many degrees from neutral (limits.ts PRON_REST) */
  restPron: 20,
};

export function armRest(restU: number[], restUf: number[], qUpper: number[], qFore: number[], qHand: number[], side: 1 | -1, flexZ: 1 | -1 = 1): ArmRest {
  const u = norm(restU.slice());
  // the flexion side made perpendicular to the upper segment: anterior (+Z) for an elbow, posterior (-Z) for a knee
  const n = norm([-flexZ * u[2] * u[0], -flexZ * u[2] * u[1], flexZ - flexZ * u[2] * u[2]]);
  return { u, uf: norm(restUf.slice()), n, qUpper: qUpper.slice(), qFore: qFore.slice(), qHand: qHand.slice(), side };
}

const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
function norm(a: number[]): number[] {
  const l = len(a) || 1;
  a[0] /= l;
  a[1] /= l;
  a[2] /= l;
  return a;
}
const perp = (v: V3, axis: V3) => {
  const d = dot(v, axis);
  return [v[0] - axis[0] * d, v[1] - axis[1] * d, v[2] - axis[2] * d];
};
const qq = (q: Q) => [q[0], q[1], q[2], q[3]];
/** anatomical frame from a rig rotation: q * inverse(rest) */
const anat = (q: Q, rest: number[]) => qmul(qq(q), qinv(rest));

/** the rotation taking the orthonormal pair (a1, a2) onto (b1, b2) */
export function alignPair(a1: V3, a2: V3, b1: V3, b2: V3): number[] {
  const r1 = qfromTo(a1, b1) as number[];
  const a2r = qrot(r1, a2[0], a2[1], a2[2]) as number[];
  // the twist about b1 bringing a2r onto b2
  const x = perp(a2r, b1), y = perp(b2, b1);
  const ang = Math.atan2(dot(cross(x, y), b1), dot(x, y));
  return qmul(qaxisAngle(b1[0], b1[1], b1[2], ang), r1) as number[];
}

/** soft reach (Holden): distances past soft * max approach max smoothly instead of locking the joint straight */
export function softReach(d: number, max: number, soft = ARM_LIMITS.soft): number {
  const da = max * soft;
  if (d <= da) return d;
  const r = max - da;
  return da + r * (1 - Math.exp(-(d - da) / r));
}

/** total twist of the hand vs the upper arm about the forearm axis (deg) -> pronation from neutral (> 0 pronated), as limits.ts measures it */
const pronOf = (total: number, side: number) => side * total - ARM_LIMITS.restPron;

export function solveArm(rest: ArmRest, pose: ArmPose, goal: ArmGoal, iters = 3): ArmOut {
  const S = pose.S;
  const L1 = len(sub(pose.E, S)), L2 = len(sub(pose.H, pose.E));
  const { u, uf, n, side } = rest;
  const hinge = norm(cross(u, n));
  // the clip's frames, its forearm twist about the forearm axis and its wrist (hand vs forearm)
  const aUc = anat(pose.qUpper, rest.qUpper), aFc = anat(pose.qFore, rest.qFore), aHc = anat(pose.qHand, rest.qHand);
  const relF = qmul(qinv(aUc), aFc);
  let twClip = twistAngle(relF, uf[0], uf[1], uf[2]) / DEG;
  if (goal.twistLimit !== undefined) twClip = Math.max(-goal.twistLimit, Math.min(goal.twistLimit, twClip));
  const relH = qmul(qinv(aFc), aHc);
  // the hand's target rig rotation: the smallest turn from the clip's hand that puts its grip line along the target axis
  let qHandGoal: number[] | null = null;
  if (goal.gripLocal && goal.gripDir) {
    const g = qrot(pose.qHand, goal.gripLocal[0], goal.gripLocal[1], goal.gripLocal[2]) as number[];
    qHandGoal = qmul(qfromTo(norm(g), norm(qq(goal.gripDir))), qq(pose.qHand)) as number[];
  }
  // the clip's flexion side, for a straight arm with no swivel information of its own
  const nCur = qrot(aUc, n[0], n[1], n[2]) as number[];
  let qHand = qq(pose.qHand), qUpper = qq(pose.qUpper), qFore = qq(pose.qFore);
  let E = pose.E.slice(), W = pose.H.slice();
  for (let it = 0; it < iters; it++) {
    // the wrist that puts the fist on the target with the current hand estimate
    const fo = qrot(qHand, goal.fist[0], goal.fist[1], goal.fist[2]) as number[];
    const Wt = sub(goal.target, fo);
    const D = sub(Wt, S);
    const d = len(D);
    if (d < 1e-6) break;
    const dir = [D[0] / d, D[1] / d, D[2] / d];
    const dEff = Math.max(Math.abs(L1 - L2) + 1e-4, softReach(d, L1 + L2));
    const a = (L1 * L1 - L2 * L2 + dEff * dEff) / (2 * dEff);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // pole: the clip's elbow around the shoulder -> wrist line (keeps the clip's swivel), else away from the flexion side
    let p = perp(sub(pose.E, S), dir);
    if (len(p) < 0.02 * L1) p = perp([-nCur[0], -nCur[1], -nCur[2]], dir);
    if (len(p) < 1e-6) p = perp([0, -1, 0], dir);
    norm(p);
    E = [S[0] + dir[0] * a + p[0] * h, S[1] + dir[1] * a + p[1] * h, S[2] + dir[2] * a + p[2] * h];
    W = [S[0] + dir[0] * dEff, S[1] + dir[1] * dEff, S[2] + dir[2] * dEff];
    // upper arm: its direction, twisted so the forearm bends toward the elbow's flexion side (in the hinge plane)
    const dU = norm(sub(E, S)), dF = norm(sub(W, E));
    let nD = perp(dF, dU);
    if (len(nD) < 1e-4) nD = perp(nCur, dU);
    norm(nD);
    const aU = alignPair(u, n, dU, nD);
    qUpper = qmul(aU, rest.qUpper) as number[];
    // forearm: a pure hinge rotation from the upper arm, plus the forearm's share of the twist
    const fl = qrot(qinv(aU), dF[0], dF[1], dF[2]) as number[];
    const theta = Math.atan2(dot(fl, n), dot(fl, u)) - Math.atan2(dot(uf, n), dot(uf, u));
    const flex = qaxisAngle(hinge[0], hinge[1], hinge[2], theta);
    let twF = twClip, relHand = relH;
    if (qHandGoal) {
      // the twist the hand needs about the forearm axis (forearm without its own twist first), then shared and clamped
      const aF0 = qmul(aU, flex);
      const relGoal = qmul(qinv(aF0), anat(qHandGoal, rest.qHand));
      const sw = [0, 0, 0, 1];
      let total = twistAngle(relGoal, uf[0], uf[1], uf[2], sw) / DEG;
      const pr = pronOf(total, side);
      const prC = Math.max(-ARM_LIMITS.sup, Math.min(ARM_LIMITS.pron, pr));
      total = side * (prC + ARM_LIMITS.restPron);
      // wrist bend limited
      const sAng = 2 * Math.acos(Math.min(1, Math.abs(sw[3])));
      if (sAng > ARM_LIMITS.wrist * DEG) {
        const k = (ARM_LIMITS.wrist * DEG) / sAng;
        const ax = norm([sw[0], sw[1], sw[2]]);
        const sg = Math.sign(sw[3]) || 1;
        const lim = qaxisAngle(ax[0], ax[1], ax[2], sAng * k * sg);
        sw.splice(0, 4, ...lim);
      }
      twF = total / 2;
      // aF0 * sw * twist(total) = aF * relHand with aF = aF0 * twist(twF)
      relHand = qmul(qmul(qaxisAngle(uf[0], uf[1], uf[2], -twF * DEG), sw), qaxisAngle(uf[0], uf[1], uf[2], total * DEG));
    }
    const aF = qmul(qmul(aU, flex), qaxisAngle(uf[0], uf[1], uf[2], twF * DEG));
    qFore = qmul(aF, rest.qFore) as number[];
    qHand = goal.keepEnd ? qq(pose.qHand) : (qmul(qmul(aF, relHand), rest.qHand) as number[]);
  }
  const fo = qrot(qHand, goal.fist[0], goal.fist[1], goal.fist[2]) as number[];
  const miss = len(sub([W[0] + fo[0], W[1] + fo[1], W[2] + fo[2]], goal.target));
  return { qUpper, qFore, qHand, elbow: E, wrist: W, miss };
}
