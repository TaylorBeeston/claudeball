/**
 * Running arms: the gait clips' arm carriage, corrected toward how people run (after the mixer, before the constraint layer).
 *
 * Measured on the gait clips (tools/jank/arms.ts, chest frame): the upper arm hangs straight down from the shoulder (elbow 0-4 cm wider than
 * the shoulder joint, abduction 0-5 deg on most clips), so on the body the elbow rubs the ribs (and sinks into a heavier build's trunk); the
 * forearm angles OUT from the elbow (-10 to -16 deg on average, down to -50), so the hands swing 21-36 cm from the midline, wider than the
 * shoulders; and the elbows fold to 116-126 deg on average (up to 143: the hands near the shoulders). A runner carries the elbow a little away
 * from the side, bent about 90 deg (more folded in front at a sprint, more open behind), the forearms angled in so the hands come toward the
 * sternum in front without crossing it, and past the hip behind. Per arm, weighted by the gait clips' share of the pose:
 * - the elbow's fold past `flexKnee` is eased (the motion kept, its folded end opened);
 * - the elbow is carried outside the trunk by `carry` (the trunk ellipse of armClear.ts, which grows with the build): the upper arm turns out
 *   about the chest's forward axis, as far as needed and no further (a smooth max, so no corner where it starts);
 * - the upper arm turns about itself so the hand comes in toward the midline in front of the trunk (`handFront`) and hangs under the elbow at
 *   the side and behind it; the elbow stays where it is.
 * Pure maths on the pose locals (skeleton.ts), unit-tested; the game and the jank sweeps run it through constrain.ts.
 */
import { DEG, qaxisAngle, qinv, qmul, qrot, qrotInv } from './qmath';
import { B, PARENT, type PoseLocals, type PoseWorld, fk, localPoint, newWorld } from './skeleton';
import type { RestInfo } from './limits';
import type { TorsoVolume } from '../armClear';
import { springStep } from './armIK';

export const GAIT_ARMS = {
  /** elbow flexion (deg from straight) past which the fold is eased: flex' = knee + (flex - knee) * slope */
  flexKnee: 90,
  flexSlope: 0.5,
  /** the elbow joint is carried at least this far outside the trunk ellipse (m): the arm's own half-thickness (~4.5 cm) and a visible gap */
  carry: 0.075,
  /** the smooth max's width (m) */
  carrySoft: 0.02,
  /** the most the upper arm turns out for it (deg) */
  abdMax: 20,
  /** the hand's distance from the midline in front of the chest (m), and how far past the trunk's front the forearm's turn in is complete (m) */
  handFront: 0.13,
  frontRamp: 0.12,
  /** under the elbow at the side and behind: this much inside it (m) */
  sideIn: 0.02,
  /** the upper arm's turn about itself (deg): toward the midline, away from it */
  twistIn: 40,
  twistOut: 10,
  /** past its limit, a turn fades out over this many more degrees */
  twistFade: 30,
  /** the pass is whole while the upper arm's downward share (in the chest frame) is over the first, none under the second: whole to ~63 deg
   *  from hanging, none past ~99 deg (a wide band: an arm rising fast into a throw or a slide sheds the correction over several frames) */
  hang: [-0.45, 0.15],
  /** the fist (this far along the hand bone, m) never closer to the trunk than this (m): the jank validator's body:hand-torso is 0.02 */
  fist: 0.085,
  fistClear: 0.03,
  /** the fastest the correction itself changes (deg/s): the pose under it may already swing an arm near the validator's speed cap in a
   *  switch, and the pass turning on or off there must not add a jolt */
  rate: 600,
  /** the weight follows the gait clips' share of the pose on a critically damped spring (rad/s): an inertialized switch moves the mixer's
   *  weight at once, and a first-order lag still started the arms moving with a jolt (the validator's spikes) */
  ease: 22,
};

/** the pass's weight and its speed, carried from frame to frame */
export interface GaitWeight {
  w: number;
  v: number;
}
/** one step of the pass's weight toward the gait clips' share of the pose (the game and the jank fade sweep both use it) */
export function gaitWeightStep(g: GaitWeight, share: number, dt: number): GaitWeight {
  const r = springStep(g.w, g.v, share, GAIT_ARMS.ease, dt);
  g.w = Math.max(0, Math.min(1, r.pos));
  g.v = r.v;
  return g;
}

export interface GaitArmsOpts {
  /** the gait clips' share of the pose (0..1): the mixer's weight on them */
  w: number;
  /** the trunk (armClear.ts torsoVolume: grows with the build morphs) */
  torso: TorsoVolume;
  /** per arm, how much of it is free (1 - the weight of an IK holding it: a bat, a glove reach) */
  free?: { Left: number; Right: number };
  /** carried from frame to frame (one per character) with the frame's step (s): the correction then changes no faster than `rate` */
  state?: GaitArmsState;
  dt?: number;
}

/** per arm, last frame's correction of the upper arm's and the forearm's local rotations (x, y, z, w each) */
export interface GaitArmsState {
  Left?: number[];
  Right?: number[];
}

const W = newWorld();
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** turn bone i (and everything below it) by `ang` (rad) about the rig-space unit axis, about its own joint */
function turn(L: PoseLocals, w: PoseWorld, R: RestInfo, i: number, axis: number[], ang: number) {
  const p = PARENT[i];
  const pq = p < 0 ? Array.from(L.base.subarray(0, 4)) : Array.from(w.wq.subarray(p * 4, p * 4 + 4));
  const q = qmul(qaxisAngle(axis[0], axis[1], axis[2], ang), Array.from(w.wq.subarray(i * 4, i * 4 + 4)));
  L.lq.set(qmul(qinv(pq), q), i * 4);
  fk(L, w, R.rest);
}

const pos = (w: PoseWorld, i: number) => [w.wp[i * 3], w.wp[i * 3 + 1], w.wp[i * 3 + 2]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** a point's clearance from the trunk (m, < 0 inside), continuous above and below its height band (armClear.ts's is infinite there) */
function trunkClear(x: number, y: number, z: number, T: TorsoVolume): number {
  const ex = x / T.halfW, ez = (z - T.zOff) / T.halfD, r = Math.hypot(ex, ez), l = Math.hypot(x, z - T.zOff);
  const ell = r < 1e-9 ? -Math.min(T.halfW, T.halfD) : l - l / r;
  return Math.max(ell, T.yMin - y, y - T.yMax);
}

/** v turned by `a` (rad) about the unit axis u (Rodrigues) */
function rotAbout(v: number[], u: number[], a: number): number[] {
  const c = Math.cos(a), sn = Math.sin(a), d = dot(u, v) * (1 - c), x = cross(u, v);
  return [v[0] * c + x[0] * sn + u[0] * d, v[1] * c + x[1] * sn + u[1] * d, v[2] * c + x[2] * sn + u[2] * d];
}

/** the solution of A cos x + B sin x = c nearest 0 (or the x that comes closest), rad */
function solveCosSin(A: number, Bc: number, c: number): number {
  const r = Math.hypot(A, Bc);
  const d = Math.atan2(Bc, A);
  const k = Math.acos(Math.max(-1, Math.min(1, c / r)));
  const x1 = wrap(d - k), x2 = wrap(d + k);
  return Math.abs(x1) <= Math.abs(x2) ? x1 : x2;
}

/** Correct both arms of a running pose (in place). Returns a bit mask of the bones it changed. */
export function gaitArms(L: PoseLocals, R: RestInfo, o: GaitArmsOpts): number {
  const st = o.state;
  if (!(o.w > 1e-3) && !st?.Left && !st?.Right) return 0;
  const w = fk(L, W, R.rest);
  let mask = 0;
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1;
    const arm = B[`${side}Arm`], fore = B[`${side}ForeArm`], hand = B[`${side}Hand`];
    const orig = [...L.lq.subarray(arm * 4, arm * 4 + 4), ...L.lq.subarray(fore * 4, fore * 4 + 4)];
    mask |= correct(L, w, R, o, side, s, arm, fore, hand);
    if (st) mask |= limitRate(L, w, R, st, side, arm, fore, orig, o.dt ?? 1 / 60);
  }
  return mask;
}

/**
 * The correction just made to one arm (its upper arm's and forearm's locals vs the pose's own), held to `rate` against last frame's: when
 * it moved further, the locals are set to last frame's correction turned toward the new one by the most allowed.
 */
function limitRate(L: PoseLocals, w: PoseWorld, R: RestInfo, st: GaitArmsState, side: 'Left' | 'Right', arm: number, fore: number, orig: number[], dt: number): number {
  const cur = [arm, fore].flatMap((b, k) => qmul(Array.from(L.lq.subarray(b * 4, b * 4 + 4)), qinv(orig.slice(k * 4, k * 4 + 4))) as number[]);
  const last = st[side] ?? [0, 0, 0, 1, 0, 0, 0, 1];
  const max = GAIT_ARMS.rate * DEG * Math.max(1e-3, dt);
  let changed = 0;
  for (const k of [0, 1]) {
    const c = cur.slice(k * 4, k * 4 + 4), p = last.slice(k * 4, k * 4 + 4);
    // the turn from last frame's correction to this one's
    const d = qmul(c, qinv(p)) as number[];
    if (d[3] < 0) d.forEach((_, i) => (d[i] = -d[i]));
    const ang = 2 * Math.acos(Math.min(1, d[3]));
    if (ang > max) {
      const sn = Math.sqrt(Math.max(1e-12, 1 - d[3] * d[3]));
      const lim = qmul(qaxisAngle(d[0] / sn, d[1] / sn, d[2] / sn, max), p) as number[];
      cur.splice(k * 4, 4, ...lim);
      const b = k ? fore : arm;
      L.lq.set(qmul(lim, orig.slice(k * 4, k * 4 + 4)), b * 4);
      changed |= 1 << b;
    }
  }
  // none left: forget it (an idle arm costs nothing)
  st[side] = Math.abs(cur[3]) > 1 - 1e-9 && Math.abs(cur[7]) > 1 - 1e-9 ? undefined : cur;
  if (changed) fk(L, w, R.rest);
  return changed;
}

/** the pass's three steps on one arm */
function correct(L: PoseLocals, w: PoseWorld, R: RestInfo, o: GaitArmsOpts, side: 'Left' | 'Right', s: number, arm: number, fore: number, hand: number): number {
  const G = GAIT_ARMS, T = o.torso;
  let mask = 0;
  {
    // a running arm hangs from the shoulder: an arm raised toward the horizontal (a throw, a reach, a blend into one) is left to its clip
    const ud = qrotInv(w.wq, w.wp[fore * 3] - w.wp[arm * 3], w.wp[fore * 3 + 1] - w.wp[arm * 3 + 1], w.wp[fore * 3 + 2] - w.wp[arm * 3 + 2], [0, 0, 0], B.Spine2 * 4) as number[];
    const hang = 1 - smooth(G.hang[0], G.hang[1], ud[1] / (Math.hypot(ud[0], ud[1], ud[2]) || 1));
    const wa = o.w * hang * Math.max(0, Math.min(1, o.free?.[side] ?? 1));
    if (wa < 1e-3) return 0;
    // 1. the elbow's fold: the forearm turns about the hinge (the hand goes with it)
    {
      const S = pos(w, arm), E = pos(w, fore), H = pos(w, hand);
      const dU = norm([E[0] - S[0], E[1] - S[1], E[2] - S[2]]), dF = norm([H[0] - E[0], H[1] - E[1], H[2] - E[2]]);
      const flex = Math.acos(Math.max(-1, Math.min(1, dot(dU, dF))));
      const knee = G.flexKnee * DEG;
      const ax = cross(dU, dF);
      if (flex > knee && Math.hypot(ax[0], ax[1], ax[2]) > 1e-6) {
        const open = (flex - (knee + (flex - knee) * G.flexSlope)) * wa;
        turn(L, w, R, fore, norm(ax), -open);
        mask |= 1 << fore;
      }
    }
    // the chest's frame (the trunk ellipse lives in it): positions relative to the chest joint
    const qc = Array.from(w.wq.subarray(B.Spine2 * 4, B.Spine2 * 4 + 4));
    const C = pos(w, B.Spine2);
    const sc = L.base[7] || 1;
    const loc = (p: number[]) => qrotInv(qc, (p[0] - C[0]) / sc, (p[1] - C[1]) / sc, (p[2] - C[2]) / sc, [0, 0, 0]) as number[];
    // 2. the elbow carried clear of the trunk: the upper arm turns out about the chest's forward axis
    {
      const S = loc(pos(w, arm)), E = loc(pos(w, fore));
      const lat = s * E[0];
      const hw = T.halfW + G.carry, hd = T.halfD + G.carry;
      const zz = (E[2] - T.zOff) / hd;
      // (eased off above and below the trunk's height band, as the elbow leaves it)
      const band = smooth(T.yMin - 0.1, T.yMin, E[1]) * (1 - smooth(T.yMax, T.yMax + 0.1, E[1]));
      const need = Math.abs(zz) < 1 ? hw * Math.sqrt(1 - zz * zz) * band : 0;
      const k = G.carrySoft;
      const target = lat + k * Math.log1p(Math.exp((need - lat) / k));
      // the upper arm in "out, down" terms: turning it by b outward gives out' = ox cos b - oy sin b
      const ox = s * (E[0] - S[0]), oy = E[1] - S[1];
      const c = target - s * S[0];
      // (an upper arm pointing straight ahead or back has no sideways lever: eased off)
      const lever = smooth(0.04, 0.1, Math.hypot(ox, oy));
      if (target - lat > 1e-4 && lever > 0) {
        const b = Math.max(0, Math.min(G.abdMax * DEG, solveCosSin(ox, -oy, c))) * wa * lever;
        if (b > 1e-5) {
          turn(L, w, R, arm, qrot(qc, 0, 0, 1, [0, 0, 0]) as number[], s * b);
          mask |= 1 << arm;
        }
      }
    }
    // 3. the hand in toward the midline in front, under the elbow at the side: the upper arm turns about itself (the elbow stays put)
    {
      const S = loc(pos(w, arm)), E = loc(pos(w, fore)), H = loc(pos(w, hand));
      const u = norm([E[0] - S[0], E[1] - S[1], E[2] - S[2]]);
      const p = [H[0] - S[0], H[1] - S[1], H[2] - S[2]];
      const pu = dot(p, u);
      const pp = [p[0] - u[0] * pu, p[1] - u[1] * pu, p[2] - u[2] * pu];
      // a forearm in line with the upper arm cannot be turned in this way (eased off as the elbow straightens)
      const bent = smooth(0.05, 0.12, Math.hypot(pp[0], pp[1], pp[2]));
      if (bent > 0) {
        const qv = cross(u, pp);
        const f = smooth(T.zOff + T.halfD, T.zOff + T.halfD + G.frontRamp, H[2]);
        const target = (s * E[0] - G.sideIn) * (1 - f) + G.handFront * f;
        const A = s * pp[0], Bs = s * qv[0], c = target - s * (S[0] + u[0] * pu);
        let phi = solveCosSin(A, Bs, c);
        // toward the midline (the hand's lateral distance falling) or away from it
        const inward = c < A;
        const lim = (inward ? G.twistIn : G.twistOut) * DEG;
        // a solution far round the circle (the target out of reach on this side) fades to none instead of clamping: two such solutions on
        // either side swap from one frame to the next, and a clamp would turn that into a jump from one limit to the other
        phi = Math.max(-lim, Math.min(lim, phi)) * (1 - smooth(lim, lim + G.twistFade * DEG, Math.abs(phi))) * wa * bent;
        // the fist stays clear of the trunk: no further in than where it would touch (bisection on the turn)
        const F = loc(localPoint(w, hand, 0, G.fist, 0, sc));
        const f0 = [F[0] - S[0], F[1] - S[1], F[2] - S[2]];
        const clearAt = (a: number) => {
          const r = rotAbout(f0, u, a);
          return trunkClear(S[0] + r[0], S[1] + r[1], S[2] + r[2], T);
        };
        const need = Math.min(G.fistClear, clearAt(0));
        if (clearAt(phi) < need) {
          let lo = 0, hi = phi;
          for (let k = 0; k < 10; k++) {
            const m = (lo + hi) / 2;
            if (clearAt(m) >= need) lo = m;
            else hi = m;
          }
          phi = lo;
        }
        if (Math.abs(phi) > 1e-5) {
          turn(L, w, R, arm, qrot(qc, u[0], u[1], u[2], [0, 0, 0]) as number[], phi);
          mask |= 1 << arm;
        }
      }
    }
  }
  return mask;
}
