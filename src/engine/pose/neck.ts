/**
 * Look distribution: a head turned further from the chest than a neck can (clip-authored over-the-shoulder looks of 87-132 deg, or the look-at
 * on top of a clip) keeps looking where it looks, and the excess is taken by the trunk the way a person does it: first the spine twists (up to
 * ~45 deg between chest and pelvis), then the pelvis turns on the legs (up to ~25 deg), with the feet kept where they were (the legs are
 * re-solved). The neck and head share what is left. Pure maths on the locals (skeleton.ts), like constrain.ts.
 */
import { DEG, qaxisAngle, qinv, qmul, qrot, type Q } from './qmath';
import { B, PARENT, type PoseLocals, type PoseWorld, fk, jointRot, newWorld } from './skeleton';
import { axialSwing, type RestInfo } from './limits';
import { softClamp } from './constrain';
import { armRest, solveArm, type ArmRest } from './armIK';

export const NECK = {
  /** head vs chest yaw where the trunk starts to take over, and its easing band (deg) */
  yaw: 70,
  band: 8,
  /** how far the spine (chest vs pelvis) and the pelvis (vs the legs) may twist for it (deg) */
  spine: 42,
  pelvis: 25,
};

const W = newWorld();
const tq = [0, 0, 0, 1], ypr = [0, 0, 0];
const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));

function setRig(L: PoseLocals, w: PoseWorld, rest: PoseWorld, i: number, q: Q) {
  const p = PARENT[i];
  const pq = p < 0 ? Array.from(L.base.subarray(0, 4)) : sl(w.wq, p, 4);
  L.lq.set(qmul(qinv(pq), q), i * 4);
  fk(L, w, rest);
}
/** turn bone i (and so everything below it) by `deg` about the rig axis `a` */
function turn(L: PoseLocals, w: PoseWorld, rest: PoseWorld, i: number, a: number[], deg: number) {
  setRig(L, w, rest, i, qmul(qaxisAngle(a[0], a[1], a[2], deg * DEG), sl(w.wq, i, 4)));
}
/** a bone's anatomical up axis in rig space */
const upOf = (w: PoseWorld, i: number) => qrot(sl(w.aq, i, 4), 0, 1, 0, [0, 0, 0]) as number[];

const legRests = new WeakMap<RestInfo, Record<'Left' | 'Right', ArmRest>>();
function legRest(R: RestInfo, s: 'Left' | 'Right'): ArmRest {
  let r = legRests.get(R);
  if (!r) {
    const mk = (side: 'Left' | 'Right') => {
      const [u, l, f] = [B[`${side}UpLeg`], B[`${side}Leg`], B[`${side}Foot`]];
      return armRest(sl(R.dir, u, 3), sl(R.dir, l, 3), sl(R.rest.wq, u, 4), sl(R.rest.wq, l, 4), sl(R.rest.wq, f, 4), side === 'Left' ? 1 : -1, -1);
    };
    legRests.set(R, (r = { Left: mk('Left'), Right: mk('Right') }));
  }
  return r[s];
}

/** head vs chest yaw (deg) */
export function neckYaw(w: PoseWorld): number {
  jointRot(w, B.Spine2, B.Head, tq);
  return axialSwing(tq, ypr)[0] / DEG;
}

/** Redistribute an over-turned neck (in place). Returns a bit mask of the bones changed. */
export function limitNeck(L: PoseLocals, R: RestInfo): number {
  const w = fk(L, W, R.rest);
  const yaw = neckYaw(w);
  const target = softClamp(yaw, -NECK.yaw, NECK.yaw, NECK.band);
  let excess = yaw - target;
  if (Math.abs(excess) < 0.1) return 0;
  // what must not move: the head's rig rotation (the gaze), the ankles and feet
  const qHead = sl(w.wq, B.Head, 4), qNeck = sl(w.wq, B.Neck, 4);
  const feet = (['Left', 'Right'] as const).map((s) => ({ s, p: sl(w.wp, B[`${s}Foot`], 3), q: sl(w.wq, B[`${s}Foot`], 4) }));
  let mask = (1 << B.Neck) | (1 << B.Head);
  // 1. the spine twists toward the look (chest vs pelvis), split over Spine1 and Spine2
  jointRot(w, B.Hips, B.Spine2, tq);
  const sp = axialSwing(tq, ypr)[0] / DEG;
  const spTo = Math.max(-NECK.spine, Math.min(NECK.spine, sp + excess));
  let ds = Math.sign(excess) === Math.sign(spTo - sp) ? spTo - sp : 0;
  if (Math.abs(ds) > Math.abs(excess)) ds = excess;
  if (Math.abs(ds) > 0.01) {
    const a = upOf(w, B.Hips);
    turn(L, w, R.rest, B.Spine1, a, ds / 2);
    turn(L, w, R.rest, B.Spine2, a, ds / 2);
    mask |= (1 << B.Spine1) | (1 << B.Spine2);
    excess -= ds;
  }
  // 2. the pelvis turns on the legs for what is left
  let dp = Math.max(-NECK.pelvis, Math.min(NECK.pelvis, excess));
  if (Math.abs(dp) < 0.01) dp = 0;
  if (dp) {
    turn(L, w, R.rest, B.Hips, upOf(w, B.Hips), dp);
    mask |= 1 << B.Hips;
    // the feet stay: each leg re-solved to its old ankle with the foot's old rotation
    for (const f of feet) {
      const [u, l, ft] = [B[`${f.s}UpLeg`], B[`${f.s}Leg`], B[`${f.s}Foot`]];
      const out = solveArm(legRest(R, f.s), { S: sl(w.wp, u, 3), E: sl(w.wp, l, 3), H: sl(w.wp, ft, 3), qUpper: sl(w.wq, u, 4), qFore: sl(w.wq, l, 4), qHand: f.q }, { target: f.p, fist: [0, 0, 0], keepEnd: true }, 2);
      setRig(L, w, R.rest, u, out.qUpper);
      setRig(L, w, R.rest, l, out.qFore);
      setRig(L, w, R.rest, ft, out.qHand);
      mask |= (1 << u) | (1 << l) | (1 << ft);
    }
  }
  // 3. the neck turns back half of what the trunk took, the head all of it: the gaze is where it was
  const took = ds + dp;
  const axN = upOf(w, B.Spine2);
  const qN2 = qmul(qaxisAngle(axN[0], axN[1], axN[2], (took / 2) * DEG), qNeck);
  setRig(L, w, R.rest, B.Neck, qN2);
  setRig(L, w, R.rest, B.Head, qHead);
  return mask;
}
