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

/** clips whose feet are off the ground or not standing on it (slides, dives, jumps, sitting) and the sprints (laid on the sim's footsteps): no
 *  foot locking */
export const FREE_FEET = /^(slide|dive|catch_jump|pop_up|coach_slide|bench_sit|ballkid_sit|bench_cheer|celebrate|run_sprint|run_turn_sprint)/;

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
  /**
   * A step the body forces (it turned or moved over the foot, not the animation lifting it): the foot clears the ground by at least `stepMin` m,
   * leaves from where it stood and lands where the animation has it by then (`stepLand` of the way: lifted first, travelling in the middle,
   * set down last), not carried along by the turning body while it is still barely off the ground (t-0039: those were the skates of a turn)
   */
  stepMin: 0.05,
  stepLand: [0.1, 0.9] as const,
  /**
   * A turn on the spot while the other foot is in its step: this one pivots on the ball (its ball stays put, the heel comes up `pivotHeel` m and
   * the foot turns with the body) instead of being dragged round or let go too; at most while the body moves slower than `pivotSpeed` m/s
   */
  pivotHeel: 0.045,
  pivotSpeed: 1.0,
  /**
   * how fast a planted foot's own heading gives way to the body's (rad/s): a slow turn (a catcher settling between pitches) turns the foot with
   * the shin as before, never winding the ankle up; only a quick one (a turn on the spot, a pivot into a throw) leaves the foot behind
   */
  relax: 1.0,
  /** and only on a fairly straight leg: fully up to the first knee flexion (deg), not at all past the second (a catcher's or umpire's crouch,
   *  where the ankle is near the end of its range already and the foot turns with the shin as before) */
  holdKnee: [35, 55] as const,
};

interface Foot {
  locked: boolean;
  /** pivoting on the ball (locked): the ball's world point; and the heel's lift now (m, eased) */
  pivot: number[] | null;
  heel: number;
  /** a step the body forced (see FOOT_LOCK.stepMin): where it left from (world ankle), the longest way it has had to go (m) */
  from: number[] | null;
  stepD: number;
  /**
   * The foot's own turn on the ground (rad, world yaw) off the animation's, which turns with the body: a planted foot does not turn with the hips
   * (its ball would sweep round the ankle); it keeps up to FOOT_LOCK.maxTurn of the body's turn, pivots with it at that lag, and a step takes
   * it back to the animation's (`th0`: where the step started)
   */
  th: number;
  th0: number;
  /** the ankle in the rig when it locked: a drift the body carried (the root moved or turned) is told from one the clip's own foot made */
  lr: number[];
  /** the animation's ankle last frame in the rig (its speed in the body's own frame) */
  prevR: number[] | null;
  /** the body's heading last frame (rad) */
  yawPrev: number | null;
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
  /** the root's world position last frame (its ground speed decides whether a turn may pivot) */
  root: number[] | null;
}
const newFoot = (): Foot => ({ locked: false, lw: [0, 0, 0], prev: null, off: [0, 0, 0], offT: 1e9, yaw: 0, pivot: null, heel: 0, from: null, stepD: 0, th: 0, th0: 0, lr: [0, 0, 0], prevR: null, yawPrev: null });
export const newFootLock = (): FootLockState => ({ feet: { Left: newFoot(), Right: newFoot() }, root: null });

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
 * locking, any lock is let go); `turnHold`: a planted foot may keep its own heading and pivot (FOOT_LOCK.relax, holdKnee; off: the foot turns with
 * the shin, as for an umpire or a catcher in his stance). Returns the bit mask of the bones it changed.
 */
export function footLock(L: PoseLocals, R: RestInfo, model: ArrayLike<number>, st: FootLockState, dt: number, free = false, ground?: (x: number, z: number) => number, turnHold = true): number {
  const w: PoseWorld = fk(L, W, R.rest);
  let mask = 0;
  // the body's heading in the world (the rig's +z), and how fast the root travels over the ground
  const yaw = Math.atan2(model[8], model[10]);
  // a left-hander's model is mirrored: a turn about the vertical goes the other way in the rig
  const det = Math.sign(model[0] * (model[5] * model[10] - model[6] * model[9]) - model[4] * (model[1] * model[10] - model[2] * model[9]) + model[8] * (model[1] * model[6] - model[2] * model[5])) || 1;
  const maxTurn = (FOOT_LOCK.maxTurn * Math.PI) / 180;
  const rootV = st.root && dt > 0 ? Math.hypot(model[12] - st.root[0], model[14] - st.root[2]) / dt : 0;
  st.root = [model[12], model[13], model[14]];
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
    // how fast the animation's foot moves over the ground, and in the body's own frame: a foot is landing when either is slow (a stance foot of a
    // gait is still on the ground while the body moves over it; a foot the turning body carries round is still in the body's frame)
    const arig0 = [w.wp[ft * 3], w.wp[ft * 3 + 1], w.wp[ft * 3 + 2]];
    const speedW = F.prev && dt > 0 ? Math.hypot(aw[0] - F.prev[0], aw[2] - F.prev[2]) / dt : 0;
    const speedR = F.prevR && dt > 0 ? (Math.hypot(arig0[0] - F.prevR[0], arig0[2] - F.prevR[2]) * Math.hypot(model[0], model[1], model[2])) / dt : 0;
    // (in the body's frame only on the spot: a running stride's foot stops in the body's frame at each end of its swing, at full speed over the ground)
    const speed = rootV < FOOT_LOCK.pivotSpeed ? Math.min(speedW, speedR) : speedW;
    F.prev = aw;
    F.prevR = arig0;
    const turnedNow = (((yaw - F.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * (180 / Math.PI);
    F.yawPrev ??= yaw;
    // the foot (ankle -> ball, world) as the animation has it, and turned by the foot's own turn on the ground
    const toeA = tw(model, w.wp, toe * 3);
    const fA = [toeA[0] - aw[0], toeA[2] - aw[2]];
    const fR = () => [fA[0] * Math.cos(F.th) + fA[1] * Math.sin(F.th), fA[1] * Math.cos(F.th) - fA[0] * Math.sin(F.th)];
    // the drawn ankle where the lock holds it (the pivot: the ankle round the ball's point)
    const lockAt = () => {
      if (!F.pivot) return [F.lw[0], aw[1], F.lw[2]];
      const f = fR();
      return [F.pivot[0] - f[0], aw[1], F.pivot[2] - f[1]];
    };
    // the animation lifted it (it steps the clip's own step back), or the body forced it (a step of its own: FOOT_LOCK.stepMin)
    const letGo = (forced = false) => {
      const at = lockAt();
      F.locked = false;
      F.pivot = null;
      F.off = [at[0] - aw[0], 0, at[2] - aw[2]];
      F.offT = 0;
      F.from = forced ? [at[0], at[1], at[2]] : null;
      F.stepD = Math.hypot(F.off[0], F.off[2]);
      F.th0 = F.th;
    };
    // the body carried the foot away from its lock (the root moved or turned under it), not the clip moving its own foot: a step of its own
    const arig = [w.wp[ft * 3], w.wp[ft * 3 + 1], w.wp[ft * 3 + 2]];
    const bodyCarried = (worldDrift: number) => Math.hypot(arig[0] - F.lr[0], arig[2] - F.lr[2]) * sc < 0.5 * worldDrift;
    const kneeFlex = (() => {
      const [u0, l0] = [B[`${side}UpLeg`], B[`${side}Leg`]];
      const v1 = [w.wp[l0 * 3] - w.wp[u0 * 3], w.wp[l0 * 3 + 1] - w.wp[u0 * 3 + 1], w.wp[l0 * 3 + 2] - w.wp[u0 * 3 + 2]];
      const v2 = [w.wp[ft * 3] - w.wp[l0 * 3], w.wp[ft * 3 + 1] - w.wp[l0 * 3 + 1], w.wp[ft * 3 + 2] - w.wp[l0 * 3 + 2]];
      const c = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (Math.hypot(v1[0], v1[1], v1[2]) * Math.hypot(v2[0], v2[1], v2[2]) || 1);
      return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
    })();
    // how straight the leg is (1: up to holdKnee[0] of flexion, 0: past holdKnee[1], a crouch): the heading hold, the pivot and a forced step's
    // minimum lift are for a standing leg (a crouched ankle is near the end of its range)
    const straight = Math.max(0, Math.min(1, (FOOT_LOCK.holdKnee[1] - kneeFlex) / (FOOT_LOCK.holdKnee[1] - FOOT_LOCK.holdKnee[0])));
    const hold = turnHold ? straight : 0;
    const other = st.feet[side === 'Left' ? 'Right' : 'Left'];
    if (free) {
      if (F.locked) letGo();
    } else if (F.locked) {
      // a turn steps one foot at a time: while the other one is off the ground this one pivots on its ball (turning on the spot), or waits (up to
      // twice the turn) while the body travels, so the feet alternate
      const otherDown = other.locked || other.offT >= FOOT_LOCK.unlock;
      const pivotOk = !otherDown && rootV < FOOT_LOCK.pivotSpeed && hold > 0.5;
      if (F.pivot && other.locked) {
        // the other foot is down again: this one stands where it pivoted to, its heel coming back down
        const at = lockAt();
        F.pivot = null;
        F.lw = [at[0], at[1], at[2]];
        F.lr = arig;
        F.yaw = yaw + F.th;
      } else if (!F.pivot && pivotOk && Math.abs(turnedNow) > FOOT_LOCK.maxTurn) {
        const f = fR();
        F.pivot = [F.lw[0] + f[0], 0, F.lw[2] + f[1]];
      }
      const turnOut = !F.pivot && Math.abs(turnedNow) > (otherDown ? FOOT_LOCK.maxTurn : 2 * FOOT_LOCK.maxTurn);
      const at = lockAt();
      const drift = Math.hypot(aw[0] - at[0], aw[2] - at[2]);
      if (h > FOOT_LOCK.liftH) letGo();
      else if (turnOut) letGo(true);
      else if (drift > FOOT_LOCK.maxDrift) letGo(bodyCarried(drift));
    } else if (h < FOOT_LOCK.downH && speed < FOOT_LOCK.lockSpeed && F.offT >= FOOT_LOCK.unlock) {
      F.locked = true;
      F.lw = [aw[0], aw[1], aw[2]];
      F.lr = arig;
      F.yaw = yaw;
      F.offT = 1e9;
      F.from = null;
      F.th = 0;
    }
    // the foot's own turn: planted, it keeps its heading up to maxTurn of the body's turn (pivoting, it turns with the body at that lag); stepping,
    // it comes back to the animation's with the step; lifted by the animation, the animation's. Only on a fairly straight leg: in a crouch (a
    // catcher, an umpire) the ankle is near the end of its range already, and the foot turns with the shin as before
    if (F.locked) {
      // (it gives way at FOOT_LOCK.relax, and never lags the body by more than maxTurn: the pivot turns it with the body at that lag)
      const r = FOOT_LOCK.relax * dt;
      F.th = Math.max(-maxTurn * hold, Math.min(maxTurn * hold, F.th + wrapPi(F.yawPrev - yaw)));
      F.th = Math.abs(F.th) <= r ? 0 : F.th - Math.sign(F.th) * r;
      if (F.pivot) F.yaw = yaw + F.th;
    } else if (F.offT < FOOT_LOCK.unlock) {
      const x = Math.min(1, F.offT / FOOT_LOCK.unlock);
      F.th = F.th0 * (F.from ? 1 - smoother((x - FOOT_LOCK.stepLand[0]) / (FOOT_LOCK.stepLand[1] - FOOT_LOCK.stepLand[0])) : decay(F.offT));
    } else F.th = 0;
    F.yawPrev = yaw;
    // the heel: up while the foot pivots on its ball, back down after (over ~0.1 s)
    F.heel += ((F.locked && F.pivot ? FOOT_LOCK.pivotHeel : 0) - F.heel) * (1 - Math.exp(-dt * 30));
    if (F.heel < 1e-4) F.heel = 0;
    // the ankle's target (world): the lock's ground point at the animation's height (a heel rising keeps rising), or the step
    let target: number[] | null = null;
    if (F.locked) {
      const at = lockAt();
      target = [at[0], aw[1] + F.heel, at[2]];
    } else if (F.offT < FOOT_LOCK.unlock) {
      const x = Math.min(1, F.offT / FOOT_LOCK.unlock);
      F.offT += dt;
      if (F.from) {
        // forced: from where it stood to where the animation has it now, lifted first and set down last, clear of the ground in between
        const [a, b] = FOOT_LOCK.stepLand;
        const u = smoother((x - a) / (b - a));
        F.stepD = Math.max(F.stepD, Math.hypot(aw[0] - F.from[0], aw[2] - F.from[2]));
        const lift = Math.max(FOOT_LOCK.stepMin * straight, Math.min(FOOT_LOCK.stepH, F.stepD * FOOT_LOCK.stepK)) * Math.sin(Math.PI * x);
        target = [F.from[0] + (aw[0] - F.from[0]) * u, aw[1] + lift, F.from[2] + (aw[2] - F.from[2]) * u];
      } else {
        const k = decay(F.offT - dt);
        const lift = Math.min(FOOT_LOCK.stepH, Math.hypot(F.off[0], F.off[2]) * FOOT_LOCK.stepK) * Math.sin(Math.PI * x);
        target = [aw[0] + F.off[0] * k, aw[1] + lift, aw[2] + F.off[2] * k];
      }
    }
    // a sole below the ground (a lean, a blend, a clip) is lifted onto it, locked or not
    if (h < -0.002 && !free) {
      const up = -h * sc;
      target = target ? [target[0], target[1] + up, target[2]] : [aw[0], aw[1] + up, aw[2]];
    }
    const turned = Math.abs(F.th) > 1e-4 || F.heel > 0;
    if (!turned && (!target || Math.hypot(target[0] - aw[0], target[1] - aw[1], target[2] - aw[2]) < 1e-4)) continue;
    target ??= aw;
    const t = toRig(model, target);
    const [u, l] = [B[`${side}UpLeg`], B[`${side}Leg`]];
    const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));
    // (the foot keeps the animation's orientation turned by its own turn on the ground (`th`): it stays put while the body turns up to
    // FOOT_LOCK.maxTurn over it, then steps, or pivots on its ball while the other foot steps)
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
    // a pivot's heel up: the foot pitched toe-down about the ankle by as much, so the ball stays on the ground
    // the foot's own turn about the vertical (rig: the mirror turns it the other way), then a pivot's heel up: the foot pitched toe-down about the
    // ankle by as much, so the ball stays on the ground
    const qTh = Math.abs(F.th) > 1e-6 ? (qaxisAngle(0, 1, 0, F.th * det) as number[]) : null;
    let qF2 = qTh ? (qmul(qTh, qF) as number[]) : qF;
    if (F.heel > 1e-4) {
      const T0 = sl(w.wp, toe, 3);
      const f0 = [T0[0] - A[0], T0[1] - A[1], T0[2] - A[2]];
      const f = qTh ? (qrot(qTh, f0[0], f0[1], f0[2]) as number[]) : f0;
      const fl = Math.hypot(f[0], f[1], f[2]);
      // the axis up x f (rig space, +y up): turning the foot about it by +angle lowers the toe
      const ax = norm3([f[2], 0, -f[0]]);
      if (fl > 1e-4 && Math.hypot(f[0], f[2]) > 1e-4) qF2 = qmul(qaxisAngle(ax[0], ax[1], ax[2], Math.asin(Math.min(0.9, F.heel / sc / fl))), qF2) as number[];
    }
    L.lq.set(qmul(qinv(sl(w.wq, PARENT[u], 4)), qU3), u * 4);
    L.lq.set(qmul(qinv(qU3), qL3), l * 4);
    L.lq.set(qmul(qinv(qL3), qF2), ft * 4);
    const out = { miss: Math.max(0, dT - (L1 + L2 - 1e-4)) };
    fk(L, w, R.rest);
    mask |= (1 << u) | (1 << l) | (1 << ft);
    // a lock the leg cannot reach any more (the body has moved on): let go from where the foot is drawn now
    if (F.locked && out.miss > FOOT_LOCK.maxMiss) {
      F.locked = false;
      F.pivot = null;
      const d = tw(model, w.wp, ft * 3);
      F.off = [d[0] - aw[0], 0, d[2] - aw[2]];
      F.offT = 0;
      F.stepD = Math.hypot(F.off[0], F.off[2]);
      F.from = bodyCarried(F.stepD) ? [d[0], d[1], d[2]] : null;
      F.th0 = F.th;
    }
  }
  return mask;
}

const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

const norm3 = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** 0 -> 1 with no velocity jump at either end (clamped) */
function smoother(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** the let-go offset's weight: 1 -> 0 over FOOT_LOCK.unlock with no velocity jump at either end */
function decay(t: number) {
  const x = Math.min(1, Math.max(0, t / FOOT_LOCK.unlock));
  return 1 - x * x * x * (x * (x * 6 - 15) + 10);
}
