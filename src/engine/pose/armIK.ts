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
  /** the frame's step (s), for a tracked grip's springs */
  dt?: number;
  /**
   * the grip's state from last frame (elbow swivel, fist roll, pronation and their speeds): the swivel and the roll then follow the best ones
   * near them on damped springs (no elbow hops, no hand flipping to the other end of its twist range); without it every swivel is searched.
   */
  track?: GripTrack;
}

/** the grip state carried from frame to frame (deg, deg/s); a grip being taken starts from the clip's: { pole: 0, roll: 0 } */
export interface GripTrack {
  pole: number;
  roll: number;
  /** last frame's pronation (unset on the first frame of a grip) */
  pron?: number;
  vPole?: number;
  vRoll?: number;
  /** degrees past the hand's range last frame (read by the caller; the solver ignores it) */
  over?: number;
}

export interface ArmOut {
  qUpper: number[];
  qFore: number[];
  qHand: number[];
  elbow: number[];
  wrist: number[];
  /** how far the fist ended from the target (rig units): > 0 when out of reach */
  miss: number;
  /** the elbow swivel used (deg from the clip's) */
  pole: number;
  /** the fist's roll about the grip line (deg from the clip's) and the forearm's pronation (deg from neutral) used */
  roll: number;
  pron: number;
  /** the swivel's and the roll's speeds (deg/s; tracked grips) */
  vPole: number;
  vRoll: number;
  /** degrees the hand still needed past the pronation / wrist range (0: the grip is held inside a human range) */
  over: number;
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
  /** how far the fist may roll about a round handle from the clip's grip, deg */
  roll: 90,
  /** while a grip is held: how far from last frame's the best swivel / roll is looked for, deg */
  poleStep: 30,
  rollStep: 40,
  /** a held grip's swivel and roll follow those best values as critically damped springs (rad/s natural frequency), no faster than this
   *  (deg/s). A traced swing (tools/jank trace, 4 s): capped 30 / 40 deg steps 12 flips (956 deg), springs at 45 rad/s 6 (756), at 90 5 (371),
   *  fist-axis excess about as with the unlimited search; the capped steps saturating and releasing were the hops */
  follow: 90,
  followMax: 1500,
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

/**
 * One step of a critically damped spring toward `target` (exact, so stable at any frequency `w`, rad/s), its speed capped at `vmax` (units/s):
 * a position that follows a jumping target without a step and without overshoot.
 */
export function springStep(pos: number, vel: number, target: number, w: number, dt: number, vmax = Infinity): { pos: number; v: number } {
  const y = pos - target, j = vel + w * y, e = Math.exp(-w * dt);
  const v = (vel - w * j * dt) * e;
  if (Math.abs(v) <= vmax) return { pos: target + (y + j * dt) * e, v };
  const vc = Math.sign(v) * vmax;
  return { pos: pos + vc * dt, v: vc };
}

/** total twist of the hand vs the upper arm about the forearm axis (deg) -> pronation from neutral (> 0 pronated), as limits.ts measures it */
const pronOf = (total: number, side: number) => side * total - ARM_LIMITS.restPron;
/** the limits in force (a harness may override them through globalThis.__armLimits to measure what they cost) */
const limits = () => ((globalThis as { __armLimits?: typeof ARM_LIMITS }).__armLimits ?? ARM_LIMITS);

/**
 * With a grip line to follow, the elbow's swivel (the upper arm's rotation about the shoulder -> wrist line) and the fist's roll about the
 * handle (a handle is round) are chosen too: a bat at an angle the forearm alone cannot reach (it would need more than the pronation / wrist
 * range) is reached the way a hitter does it, by moving the elbow and turning the handle in the fist. When the grip is taken every swivel is
 * tried; while it is held (`goal.track`), the swivel and the roll follow last frame's within a few degrees per frame (a local minimum, refined
 * continuously): a hand that cannot stay in range drifts there instead of hopping to another solution.
 */
export function solveArm(rest: ArmRest, pose: ArmPose, goal: ArmGoal, iters = 3): ArmOut {
  if (!goal.gripDir || !goal.gripLocal) return solveArmPole(rest, pose, goal, iters, 0).out;
  const LIM = limits();
  const tr = goal.track;
  // degrees past the hand's range cost most; a swivel away from the clip's costs a little
  const cost = (r: { over: number }, ang: number) => r.over * 4 + Math.abs(ang) * 0.3;
  if (tr) {
    // held: the best swivel near last frame's (a parabola through three samples a step apart), the best roll there; both then followed by a
    // critically damped spring: no step in the elbow or the fist (a capped step that saturates and releases is the one-frame hop the flip
    // detector sees), at the cost of trailing a very fast bat by a few degrees
    const dt = Math.max(1e-3, Math.min(0.1, goal.dt ?? 1 / 60));
    const s = LIM.poleStep ?? 30;
    const p0 = Math.max(-120, Math.min(120, tr.pole));
    const c0 = cost(solveArmPole(rest, pose, goal, iters, p0), p0);
    const cm = cost(solveArmPole(rest, pose, goal, iters, p0 - s), p0 - s), cp = cost(solveArmPole(rest, pose, goal, iters, p0 + s), p0 + s);
    const curv = cm - 2 * c0 + cp;
    let x = curv > 1e-9 ? (s * (cm - cp)) / (2 * curv) : cm < cp ? -s : s;
    if (curv <= 1e-9 && Math.min(cm, cp) >= c0) x = 0;
    x = Math.max(-s, Math.min(s, x));
    const follow = (pos: number, vel: number, target: number) => springStep(pos, vel, target, LIM.follow ?? 90, dt, LIM.followMax ?? 1500);
    const P = follow(p0, tr.vPole ?? 0, p0 + x);
    const pole = Math.max(-120, Math.min(120, P.pos));
    // the roll that is best at that swivel, then followed the same way
    const rT = solveArmPole(rest, pose, goal, iters, pole).out.roll;
    const Rl = follow(tr.roll, tr.vRoll ?? 0, rT);
    const out = solveArmPole(rest, pose, goal, iters, pole, Rl.pos).out;
    out.vPole = P.v;
    out.vRoll = Rl.v;
    return out;
  }
  const base = solveArmPole(rest, pose, goal, iters, 0);
  if (base.over < 1) return base.out;
  let best = base, bestCost = cost(base, 0);
  for (let i = 0; i < 24; i++) {
    const ang = (i % 2 ? -1 : 1) * (Math.floor(i / 2) + 1) * 10;
    const r = solveArmPole(rest, pose, goal, iters, ang);
    const c = cost(r, ang);
    if (c < bestCost) {
      best = r;
      bestCost = c;
    }
  }
  return best.out;
}

function solveArmPole(rest: ArmRest, pose: ArmPose, goal: ArmGoal, iters: number, poleDeg: number, rollFix?: number): { out: ArmOut; over: number } {
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
  // the twist the result is unwrapped toward: last frame's; a grip being taken, the clip's own (the IK pose is blended in from the clip's, and a
  // twist 360 deg away from it would swing the hand the short way round mid-blend)
  const pronRef = goal.track ? goal.track.pron ?? pronOf(twistAngle(relF, uf[0], uf[1], uf[2]) / DEG + twistAngle(relH, uf[0], uf[1], uf[2]) / DEG, side) : undefined;
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
  let over = 0, roll = 0, pron = 0;
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
    if (poleDeg) p = qrot(qaxisAngle(dir[0], dir[1], dir[2], poleDeg * DEG), p[0], p[1], p[2]) as number[];
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
      const relGoal0 = qmul(qinv(aF0), anat(qHandGoal, rest.qHand));
      const LIM = limits();
      // a handle is round: the fist may roll about the grip line (here in the forearm's frame) to keep the forearm and wrist in range
      const gF = norm(qrot(qinv(aF0), goal.gripDir![0], goal.gripDir![1], goal.gripDir![2]) as number[]);
      roll = rollFix ?? pickRoll(relGoal0, gF, uf, side, LIM, goal.track, pronRef);
      const relGoal = roll ? qmul(qaxisAngle(gF[0], gF[1], gF[2], roll * DEG), relGoal0) : relGoal0;
      const sw = [0, 0, 0, 1];
      let total = twistAngle(relGoal, uf[0], uf[1], uf[2], sw) / DEG;
      let pr = pronOf(total, side);
      // held: the same turn as last frame's, not 360 deg away (past the range, the hand stays at the limit it was at instead of flipping)
      if (pronRef !== undefined) pr += Math.round((pronRef - pr) / 360) * 360;
      over = Math.max(0, pr - LIM.pron, -LIM.sup - pr);
      pron = Math.max(-LIM.sup, Math.min(LIM.pron, pr));
      total = side * (pron + ARM_LIMITS.restPron);
      // wrist bend limited
      const sAng = 2 * Math.acos(Math.min(1, Math.abs(sw[3])));
      over += Math.max(0, sAng / DEG - LIM.wrist);
      if (sAng > LIM.wrist * DEG) {
        const k = (LIM.wrist * DEG) / sAng;
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
  return { out: { qUpper, qFore, qHand, elbow: E, wrist: W, miss, pole: poleDeg, roll, pron, over, vPole: 0, vRoll: 0 }, over };
}

/** degrees past the pronation / supination and wrist-bend range of a forearm -> hand rotation (`pronRef`: unwrap toward it) */
function overOf(rel: Q, uf: number[], side: number, LIM: typeof ARM_LIMITS, pronRef?: number) {
  const sw = [0, 0, 0, 1];
  let pr = pronOf(twistAngle(rel, uf[0], uf[1], uf[2], sw) / DEG, side);
  if (pronRef !== undefined) pr += Math.round((pronRef - pr) / 360) * 360;
  const sAng = (2 * Math.acos(Math.min(1, Math.abs(sw[3])))) / DEG;
  return Math.max(0, pr - LIM.pron, -LIM.sup - pr) + Math.max(0, sAng - LIM.wrist);
}

/**
 * The fist's roll about the grip line (deg from the clip's grip). Taking the grip: the clip's roll when that keeps the forearm and wrist in
 * range, else the in-range roll nearest it (its edge found by bisection), else the roll leaving the least past range. Holding it: within a
 * step of last frame's, the best of a few samples refined by a parabola, with a slight pull back toward the clip's.
 */
function pickRoll(rel0: Q, g: number[], uf: number[], side: number, LIM: typeof ARM_LIMITS, tr?: GripTrack, pronRef?: number): number {
  const lim = LIM.roll ?? 0;
  if (lim <= 0) return 0;
  const at = (r: number) => overOf(r ? qmul(qaxisAngle(g[0], g[1], g[2], r * DEG), rel0) : rel0, uf, side, LIM, pronRef);
  const cost = (r: number, o: number) => o * 4 + Math.abs(r) * 0.1;
  if (tr) {
    const s = LIM.rollStep ?? 40, r0 = Math.max(-lim, Math.min(lim, tr.roll));
    const lo = Math.max(-lim, r0 - s), hi = Math.min(lim, r0 + s);
    // five samples across the window, then a parabola through the best and its neighbours
    const xs = [lo, (lo + r0) / 2, r0, (r0 + hi) / 2, hi], cs = xs.map((x) => cost(x, at(x)));
    let k = 0;
    for (let i = 1; i < 5; i++) if (cs[i] < cs[k]) k = i;
    if (k === 0 || k === 4) return xs[k];
    const h1 = xs[k] - xs[k - 1], h2 = xs[k + 1] - xs[k];
    if (h1 < 1e-6 || h2 < 1e-6) return xs[k];
    // vertex of the parabola through three unevenly spaced points
    const d1 = (cs[k] - cs[k - 1]) / h1, d2 = (cs[k + 1] - cs[k]) / h2, c2 = (d2 - d1) / (h1 + h2);
    if (c2 <= 1e-12) return xs[k];
    const x = (xs[k - 1] + xs[k]) / 2 - d1 / (2 * c2);
    return Math.max(xs[k - 1], Math.min(xs[k + 1], x));
  }
  if (at(0) < 1e-3) return 0;
  const N = Math.ceil(lim / 10), step = lim / N;
  const grid: { r: number; o: number }[] = [];
  for (let i = -N; i <= N; i++) grid.push({ r: i * step, o: at(i * step) });
  let best = 0, bestC = cost(0, grid[N].o);
  const tryR = (r: number, o: number) => {
    const c = cost(r, o);
    if (c < bestC) {
      best = r;
      bestC = c;
    }
  };
  for (let i = 0; i < grid.length; i++) {
    tryR(grid[i].r, grid[i].o);
    // the edge of an in-range interval: bisect between an in-range and an out-of-range neighbour
    const j = i + 1;
    if (j < grid.length && grid[i].o < 1e-3 !== grid[j].o < 1e-3) {
      let a = grid[i].r, b = grid[j].r;
      const aIn = grid[i].o < 1e-3;
      for (let k = 0; k < 6; k++) {
        const m = (a + b) / 2;
        if (at(m) < 1e-3 === aIn) a = m;
        else b = m;
      }
      const e = aIn ? a : b;
      tryR(e, at(e));
    }
  }
  return best;
}
