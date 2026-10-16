/**
 * Inertialization (the "offset blending" form of Holden's inertialization) instead of a crossfade: when a puppet switches clip, the new clip plays
 * at full weight at once and the difference between the pose that was showing and the new clip's first frame is kept as a per-bone offset that
 * decays to nothing over the transition (a smootherstep: no velocity jump at either end).
 *
 * Why (tools/jank): three's crossfade slerps two live clips every frame along the shortest path, and when the two poses are far apart that
 * shortest path can switch sides mid-fade: a 180 deg one-frame arm flip in run-gait switches. A fixed offset captured once decays along one
 * path. Only the old pose at the switch is needed, not a second clip evaluated through the fade.
 */
import { NB, type PoseLocals } from './skeleton';

const smootherstep = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

export class Inertia {
  /** per-bone local rotation offsets (x, y, z, w) and the Hips' local position offset */
  readonly off = new Float64Array(NB * 4);
  readonly offP = new Float64Array(3);
  private src = new Float64Array(NB * 4);
  private srcP = new Float64Array(3);
  t = 0;
  dur = 0;
  active = false;
  pending = false;

  /** a clip switch: remember the pose that was showing (locals), decay over `dur` s */
  start(lq: ArrayLike<number>, hipsPos: ArrayLike<number>, dur: number) {
    for (let i = 0; i < NB * 4; i++) this.src[i] = lq[i];
    for (let k = 0; k < 3; k++) this.srcP[k] = hipsPos[k];
    this.dur = Math.max(0.05, dur);
    this.pending = true;
    this.active = false;
  }

  /** the new clip's first frame (locals): offset = source * inverse(target), the shortest way */
  capture(L: PoseLocals) {
    for (let i = 0; i < NB; i++) {
      const o = i * 4;
      const ax = this.src[o], ay = this.src[o + 1], az = this.src[o + 2], aw = this.src[o + 3];
      const bx = -L.lq[o], by = -L.lq[o + 1], bz = -L.lq[o + 2], bw = L.lq[o + 3];
      let x = aw * bx + ax * bw + ay * bz - az * by, y = aw * by - ax * bz + ay * bw + az * bx, z = aw * bz + ax * by - ay * bx + az * bw, w = aw * bw - ax * bx - ay * by - az * bz;
      if (w < 0) {
        x = -x;
        y = -y;
        z = -z;
        w = -w;
      }
      this.off[o] = x;
      this.off[o + 1] = y;
      this.off[o + 2] = z;
      this.off[o + 3] = w;
    }
    for (let k = 0; k < 3; k++) this.offP[k] = this.srcP[k] - L.lp[k];
    this.pending = false;
    this.active = true;
    this.t = 0;
  }

  /** apply the decaying offset to the clip's pose (in place); call every frame after the mixer */
  apply(L: PoseLocals, dt: number) {
    if (this.pending) this.capture(L);
    if (!this.active) return;
    const w = 1 - smootherstep(Math.min(1, this.t / this.dur));
    this.t += dt;
    if (w <= 1e-4) {
      this.active = false;
      return;
    }
    for (let i = 0; i < NB; i++) {
      const o = i * 4;
      // slerp(identity, off, w) for a unit quaternion with w >= 0: scale the rotation angle
      const ow = Math.min(1, this.off[o + 3]);
      const ang = 2 * Math.acos(ow);
      let qx = 0, qy = 0, qz = 0, qw = 1;
      if (ang > 1e-6) {
        const s = Math.sin((ang * w) / 2) / Math.sin(ang / 2);
        qx = this.off[o] * s;
        qy = this.off[o + 1] * s;
        qz = this.off[o + 2] * s;
        qw = Math.cos((ang * w) / 2);
      }
      // offset * clip
      const bx = L.lq[o], by = L.lq[o + 1], bz = L.lq[o + 2], bw = L.lq[o + 3];
      L.lq[o] = qw * bx + qx * bw + qy * bz - qz * by;
      L.lq[o + 1] = qw * by - qx * bz + qy * bw + qz * bx;
      L.lq[o + 2] = qw * bz + qx * by - qy * bx + qz * bw;
      L.lq[o + 3] = qw * bw - qx * bx - qy * by - qz * bz;
    }
    for (let k = 0; k < 3; k++) L.lp[k] += this.offP[k] * w;
  }
}

/** the largest angle (deg) between two poses' local rotations, over every bone: how far apart a clip switch's two poses are */
export function maxLocalAngle(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < NB; i++) {
    const o = i * 4;
    const d = Math.abs(a[o] * b[o] + a[o + 1] * b[o + 1] + a[o + 2] * b[o + 2] + a[o + 3] * b[o + 3]);
    m = Math.max(m, (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI);
  }
  return m;
}
/** a crossfade between two poses this far apart (deg, some bone) can take the short way round mid-fade: inertialize instead */
export const FAR_APART = (globalThis as { __farApart?: number }).__farApart ?? 120;

/** the locomotion loops: a switch into or out of one is where a crossfade's shortest path flips sides (measured) */
const GAITS = new Set(['manager_walk', 'walk', 'trot', 'jog', 'run', 'run_sprint', 'run_turn', 'run_turn_sprint']);
/**
 * Which transition a clip switch gets. Measured over the 511 clip switches the game makes, each through the constraint layer
 * (tools/jank/run.ts fades --constrain [--crossfade | --inertia]): this offset inertialization removes the crossfade's 180 deg arm flips
 * (46 -> 2 frames) but adds more than it removes elsewhere (shoulder twist, ankle bend, forearm flips: severity 264 -> 304 for every switch,
 * 299 for gait switches only), because a fixed offset rides on a new clip that is itself moving. So the mixer's crossfade stays the default;
 * `?inertia` (or globalThis.__inertia) turns inertialization on for switches into / out of a gait, for comparison.
 */
const inertiaOn = () => (globalThis as { __inertia?: boolean }).__inertia ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).has('inertia'));
export const useInertia = (from: string, to: string) => inertiaOn() && (GAITS.has(from) || GAITS.has(to));
