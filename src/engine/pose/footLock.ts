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
import { solveArm, armRest, type ArmRest } from './armIK';
import type { RestInfo } from './limits';
import { qinv, qmul } from './qmath';
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
export function footLock(L: PoseLocals, R: RestInfo, model: ArrayLike<number>, st: FootLockState, dt: number, free = false): number {
  const w: PoseWorld = fk(L, W, R.rest);
  let mask = 0;
  // the body's heading in the world (the rig's +z)
  const yaw = Math.atan2(model[8], model[10]);
  for (const side of ['Left', 'Right'] as const) {
    const ft = B[`${side}Foot`], toe = B[`${side}ToeBase`];
    const F = st.feet[side];
    // the sole's height: the lower of heel and ball above where they are in the rest pose (feet flat on the ground at y = 0)
    const h = Math.min(w.wp[ft * 3 + 1] - R.rest.wp[ft * 3 + 1], w.wp[toe * 3 + 1] - R.rest.wp[toe * 3 + 1]);
    const aw = tw(model, w.wp, ft * 3);
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
      if (h > FOOT_LOCK.liftH || Math.hypot(aw[0] - F.lw[0], aw[2] - F.lw[2]) > FOOT_LOCK.maxDrift || Math.abs(turnedNow) > FOOT_LOCK.maxTurn) letGo();
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
    if (!target || Math.hypot(target[0] - aw[0], target[1] - aw[1], target[2] - aw[2]) < 1e-4) continue;
    const t = toRig(model, target);
    const [u, l] = [B[`${side}UpLeg`], B[`${side}Leg`]];
    const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));
    // (the foot keeps the animation's orientation: it pivots with the body, and steps once the body has turned past FOOT_LOCK.maxTurn over it)
    // the knee's side: the clip's knee, nudged toward the toes (a knee bends over its toes): a standing leg is nearly straight, its knee nearly on
    // the hip -> ankle line, where the clip's own offset alone can flip side between frames (180 deg thigh / foot flips)
    const E0 = sl(w.wp, l, 3), T = sl(w.wp, toe, 3), A0 = sl(w.wp, ft, 3);
    const tl = Math.hypot(T[0] - A0[0], T[2] - A0[2]) || 1;
    const E = [E0[0] + ((T[0] - A0[0]) / tl) * 0.05, E0[1], E0[2] + ((T[2] - A0[2]) / tl) * 0.05];
    const out = solveArm(legRest(R, side), { S: sl(w.wp, u, 3), E, H: sl(w.wp, ft, 3), qUpper: sl(w.wq, u, 4), qFore: sl(w.wq, l, 4), qHand: sl(w.wq, ft, 4) }, { target: t, fist: [0, 0, 0], keepEnd: true, twistLimit: 30, soft: 0.999 }, 2);
    L.lq.set(qmul(qinv(sl(w.wq, PARENT[u], 4)), out.qUpper), u * 4);
    L.lq.set(qmul(qinv(out.qUpper), out.qFore), l * 4);
    L.lq.set(qmul(qinv(out.qFore), out.qHand), ft * 4);
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

/** the let-go offset's weight: 1 -> 0 over FOOT_LOCK.unlock with no velocity jump at either end */
function decay(t: number) {
  const x = Math.min(1, Math.max(0, t / FOOT_LOCK.unlock));
  return 1 - x * x * x * (x * (x * 6 - 15) + 10);
}
