/**
 * Foot locking (after theorangeduck.com "Inverse Kinematics Foot Locking"): a foot the animation puts on the ground stays where it landed. While
 * it is down the leg is re-solved (the two-bone solver, foot orientation kept) so the ankle stays on that spot; when the animation lifts it, or
 * the body has carried it out of the leg's reach, it is let go and eased back onto the animation as a short step (lifted on an arc) instead of
 * snapping or sliding: a body turned or pushed while standing steps with it.
 *
 * What it fixes (tools/jank): planted feet sliding over the ground in blends (two clips with the feet in different places), in clips played at a
 * speed that does not match the ground speed, and when the root moves or turns under a standing player (foot:slide / foot:skate).
 *
 * Pure maths on the locals (skeleton.ts) and a rig -> world matrix (column-major 4x4: the puppet's model matrix; identity in the sweeps).
 */
import { armRest, type ArmRest } from './armIK';
import type { RestInfo } from './limits';
import { qaxisAngle, qfromTo, qinv, qmul, qrot } from './qmath';
import { B, PARENT, fk, newWorld, type PoseLocals, type PoseWorld } from './skeleton';

export const FOOT_LOCK = {
  /** a sole this close to the ground (m, rig units) may lock; one lifted past `liftH` lets go */
  downH: 0.035,
  liftH: 0.07,
  /** a foot moving faster than this over the ground (m/s, world) is not landing: it does not lock */
  lockSpeed: 0.9,
  /** let go when the animation's foot is this far from the lock (m, world), or the leg cannot reach the lock within `maxMiss` (m, rig) */
  maxDrift: 0.25,
  maxMiss: 0.015,
  /** let go (step) when the body has turned this far (deg) over a planted foot (the hips and the ankle would wind up past their range) */
  maxTurn: 15,
  /** the way back onto the animation after letting go (s): a step, the foot lifted on an arc (up to `stepH` m, `stepK` x the distance) */
  unlock: 0.25,
  stepH: 0.08,
  stepK: 0.35,
};

interface Foot {
  locked: boolean;
  /** the lock's world point (ankle), and the animation's ankle last frame (world) */
  lw: number[];
  prev: number[] | null;
  /** after letting go: the world offset from the animation that decays to nothing */
  off: number[];
  offT: number;
  /** the body's heading (rad, world) when the foot locked */
  yaw: number;
}
export interface FootLockState {
  feet: Record<'Left' | 'Right', Foot>;
}
export const newFootLock = (): FootLockState => ({
  feet: {
    Left: { locked: false, lw: [0, 0, 0], prev: null, off: [0, 0, 0], offT: 1e9, yaw: 0 },
    Right: { locked: false, lw: [0, 0, 0], prev: null, off: [0, 0, 0], offT: 1e9, yaw: 0 },
  },
});

const legRests = new WeakMap<RestInfo, Record<'Left' | 'Right', ArmRest>>();
function legRest(R: RestInfo, side: 'Left' | 'Right'): ArmRest {
  let r = legRests.get(R);
  if (!r) {
    const mk = (s: 'Left' | 'Right') => {
      const [u, l, f] = [B[`${s}UpLeg`], B[`${s}Leg`], B[`${s}Foot`]];
      const d = (i: number) => Array.from(R.dir.subarray(i * 3, i * 3 + 3));
      const q = (i: number) => Array.from(R.rest.wq.subarray(i * 4, i * 4 + 4));
      return armRest(d(u), d(l), q(u), q(l), q(f), s === 'Left' ? 1 : -1, -1);
    };
    legRests.set(R, (r = { Left: mk('Left'), Right: mk('Right') }));
  }
  return r[side];
}

const W = newWorld();
const tw = (m: ArrayLike<number>, p: ArrayLike<number>, o = 0) => [
  m[0] * p[o] + m[4] * p[o + 1] + m[8] * p[o + 2] + m[12],
  m[1] * p[o] + m[5] * p[o + 1] + m[9] * p[o + 2] + m[13],
  m[2] * p[o] + m[6] * p[o + 1] + m[10] * p[o + 2] + m[14],
];
/** world -> rig through the inverse of an affine matrix (scale / mirror included) */
function toRig(m: ArrayLike<number>, p: number[]): number[] {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
  const x = p[0] - m[12], y = p[1] - m[13], z = p[2] - m[14];
  return [
    ((a[4] * a[8] - a[5] * a[7]) * x - (a[3] * a[8] - a[5] * a[6]) * y + (a[3] * a[7] - a[4] * a[6]) * z) / det,
    (-(a[1] * a[8] - a[2] * a[7]) * x + (a[0] * a[8] - a[2] * a[6]) * y - (a[0] * a[7] - a[1] * a[6]) * z) / det,
    ((a[1] * a[5] - a[2] * a[4]) * x - (a[0] * a[5] - a[2] * a[3]) * y + (a[0] * a[4] - a[1] * a[3]) * z) / det,
  ];
}

/**
 * Lock the feet of pose L (in place). `model`: rig -> world; `dt`: the frame's step (s); `free`: the clip is airborne / a slide / seated (no
 * locking, any lock is let go). Returns the bit mask of the bones it changed.
 */
export function footLock(L: PoseLocals, R: RestInfo, model: ArrayLike<number>, st: FootLockState, dt: number, free = false, ground?: (x: number, z: number) => number): number {
  const w: PoseWorld = fk(L, W, R.rest);
  let mask = 0;
  // the body's heading in the world (the rig's +z)
  const yaw = Math.atan2(model[8], model[10]);
  for (const side of ['Left', 'Right'] as const) {
    const ft = B[`${side}Foot`], toe = B[`${side}ToeBase`];
    const F = st.feet[side];
    // the sole's height (rig units): the lower of heel and ball above where they are in the rest pose (feet flat on the ground), over the ground
    // under each (`ground`, world: the mound's slope) or the rig's y = 0
    const aw = tw(model, w.wp, ft * 3);
    const sc = Math.hypot(model[4], model[5], model[6]) || 1;
    const solH = (i: number) => {
      const r = w.wp[i * 3 + 1] - R.rest.wp[i * 3 + 1];
      if (!ground) return r;
      const p = tw(model, w.wp, i * 3);
      return (p[1] - R.rest.wp[i * 3 + 1] * sc - ground(p[0], p[2])) / sc;
    };
    const h = Math.min(solH(ft), solH(toe));
    const speed = F.prev && dt > 0 ? Math.hypot(aw[0] - F.prev[0], aw[2] - F.prev[2]) / dt : 0;
    F.prev = aw;
    const turnedNow = (((yaw - F.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * (180 / Math.PI);
    const letGo = () => {
      F.locked = false;
      F.off = [F.lw[0] - aw[0], 0, F.lw[2] - aw[2]];
      F.offT = 0;
    };
    if (free) {
      if (F.locked) letGo();
    } else if (F.locked) {
      // a turn steps one foot at a time: while the other one is off the ground this one waits (up to twice the turn), so the feet alternate
      const other = st.feet[side === 'Left' ? 'Right' : 'Left'];
      const otherDown = other.locked || other.offT >= FOOT_LOCK.unlock;
      const turnOut = Math.abs(turnedNow) > (otherDown ? FOOT_LOCK.maxTurn : 2 * FOOT_LOCK.maxTurn);
      if (h > FOOT_LOCK.liftH || Math.hypot(aw[0] - F.lw[0], aw[2] - F.lw[2]) > FOOT_LOCK.maxDrift || turnOut) letGo();
    } else if (h < FOOT_LOCK.downH && speed < FOOT_LOCK.lockSpeed && F.offT >= FOOT_LOCK.unlock) {
      F.locked = true;
      F.lw = [aw[0], aw[1], aw[2]];
      F.yaw = yaw;
      F.offT = 1e9;
    }
    // the ankle's target (world): the lock's ground point at the animation's height (a heel rising keeps rising), or the decaying offset
    let target: number[] | null = null;
    if (F.locked) target = [F.lw[0], aw[1], F.lw[2]];
    else if (F.offT < FOOT_LOCK.unlock) {
      const k = decay(F.offT);
      const lift = Math.min(FOOT_LOCK.stepH, Math.hypot(F.off[0], F.off[2]) * FOOT_LOCK.stepK) * Math.sin(Math.PI * Math.min(1, F.offT / FOOT_LOCK.unlock));
      F.offT += dt;
      target = [aw[0] + F.off[0] * k, aw[1] + lift, aw[2] + F.off[2] * k];
    }
    // a sole below the ground (a lean, a blend, a clip) is lifted onto it, locked or not
    if (h < -0.002 && !free) {
      const up = -h * sc;
      target = target ? [target[0], target[1] + up, target[2]] : [aw[0], aw[1] + up, aw[2]];
    }
    if (!target || Math.hypot(target[0] - aw[0], target[1] - aw[1], target[2] - aw[2]) < 1e-4) continue;
    const t = toRig(model, target);
    const [u, l] = [B[`${side}UpLeg`], B[`${side}Leg`]];
    const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));
    // (the foot keeps the animation's orientation: it pivots with the body, and steps once the body has turned past FOOT_LOCK.maxTurn over it)
    // the least change of the clip's leg that puts the ankle on the target: the knee bent (about its own hinge) to the hip -> target distance, then
    // the thigh swung onto it by the shortest turn; the thigh's twist and the foot's orientation stay the clip's. A full re-solve rebuilt the
    // thigh's twist from its own knee side, which on a near-straight standing leg differed from the clip's: a jump when a lock began or ended
    const S = sl(w.wp, u, 3), E = sl(w.wp, l, 3), A = sl(w.wp, ft, 3);
    const qU = sl(w.wq, u, 4), qL = sl(w.wq, l, 4), qF = sl(w.wq, ft, 4);
    const L1 = Math.hypot(E[0] - S[0], E[1] - S[1], E[2] - S[2]), L2 = Math.hypot(A[0] - E[0], A[1] - E[1], A[2] - E[2]);
    const dT = Math.hypot(t[0] - S[0], t[1] - S[1], t[2] - S[2]);
    const d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min(L1 + L2 - 1e-4, dT));
    const d0 = Math.hypot(A[0] - S[0], A[1] - S[1], A[2] - S[2]);
    const knee = (x: number) => Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - x * x) / (2 * L1 * L2))));
    // the knee's hinge axis: the thigh's own (its rest hinge carried by its rotation), so it is defined for a straight leg too
    const lr = legRest(R, side);
    const hRest = [lr.u[1] * lr.n[2] - lr.u[2] * lr.n[1], lr.u[2] * lr.n[0] - lr.u[0] * lr.n[2], lr.u[0] * lr.n[1] - lr.u[1] * lr.n[0]];
    const hAx = qrot(qmul(qU, qinv(lr.qUpper)), hRest[0], hRest[1], hRest[2]) as number[];
    // bend: a smaller interior angle shortens the leg; turn the shin about the hinge by the change
    const dk = knee(d0) - knee(d);
    let qL2 = qL, A2 = A;
    if (Math.abs(dk) > 1e-6) {
      const tryBend = (sg: number) => {
        const q = qaxisAngle(hAx[0], hAx[1], hAx[2], sg * dk);
        const v = qrot(q, A[0] - E[0], A[1] - E[1], A[2] - E[2]) as number[];
        return { q, a: [E[0] + v[0], E[1] + v[1], E[2] + v[2]] };
      };
      // (flexion is the positive turn about the hinge, from the rest frames: a straight leg shortens the same either way, only one is a knee)
      const pick = tryBend(1);
      qL2 = qmul(pick.q, qL) as number[];
      A2 = pick.a;
    }
    // swing the whole leg about the hip onto the target
    const sw = qfromTo(norm3([A2[0] - S[0], A2[1] - S[1], A2[2] - S[2]]), norm3([t[0] - S[0], t[1] - S[1], t[2] - S[2]])) as number[];
    const qU3 = qmul(sw, qU) as number[], qL3 = qmul(sw, qL2) as number[];
    L.lq.set(qmul(qinv(sl(w.wq, PARENT[u], 4)), qU3), u * 4);
    L.lq.set(qmul(qinv(qU3), qL3), l * 4);
    L.lq.set(qmul(qinv(qL3), qF), ft * 4);
    const out = { miss: Math.max(0, dT - (L1 + L2 - 1e-4)) };
    fk(L, w, R.rest);
    mask |= (1 << u) | (1 << l) | (1 << ft);
    // a lock the leg cannot reach any more (the body has moved on): let go from where the foot is drawn now
    if (F.locked && out.miss > FOOT_LOCK.maxMiss) {
      F.locked = false;
      const d = tw(model, w.wp, ft * 3);
      F.off = [d[0] - aw[0], 0, d[2] - aw[2]];
      F.offT = 0;
    }
  }
  return mask;
}

const norm3 = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** the let-go offset's weight: 1 -> 0 over FOOT_LOCK.unlock with no velocity jump at either end */
function decay(t: number) {
  const x = Math.min(1, Math.max(0, t / FOOT_LOCK.unlock));
  return 1 - x * x * x * (x * (x * 6 - 15) + 10);
}
