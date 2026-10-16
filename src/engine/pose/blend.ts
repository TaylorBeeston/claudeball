/**
 * A crossfade that keeps its path. three's mixer blends two clips by slerping every bone along the SHORTEST arc, re-chosen each frame: when the
 * two clips hold a bone nearly half a turn apart and keep moving, the shortest arc switches sides mid-fade and the bone turns the other way
 * round in one frame (the stance -> swing, swing -> stance and gait switches' arm / hand flips, B1 / B2 sweeps). Here the arc is chosen once,
 * when the fade starts, and each clip's rotation is then followed continuously (q or -q, whichever is nearer last frame's), so the blend can
 * only move continuously; it may go past half a turn rather than jump back.
 */
import { NB } from './skeleton';

export class ContinuousBlend {
  /** each side's rotations as last blended (sign-continuous) */
  private a = new Float64Array(NB * 4);
  private b = new Float64Array(NB * 4);
  private started = false;

  reset() {
    this.started = false;
  }

  /**
   * Blend bone i's rotations `qa` (outgoing) and `qb` (incoming) with weight w into out (all x, y, z, w at offset o / i * 4). Call for the bones of
   * one fade every frame from its start; `reset()` when a new fade begins.
   */
  blend(qa: ArrayLike<number>, ao: number, qb: ArrayLike<number>, bo: number, w: number, i: number, out: Float64Array | number[], oo: number, first: boolean) {
    const o = i * 4;
    let ax = qa[ao], ay = qa[ao + 1], az = qa[ao + 2], aw = qa[ao + 3];
    let bx = qb[bo], by = qb[bo + 1], bz = qb[bo + 2], bw = qb[bo + 3];
    if (first) {
      // the fade starts on the shorter arc
      if (ax * bx + ay * by + az * bz + aw * bw < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
      }
    } else {
      // each side continues from where it was (no sign jump of its own)
      const pa = this.a, pb = this.b;
      if (ax * pa[o] + ay * pa[o + 1] + az * pa[o + 2] + aw * pa[o + 3] < 0) {
        ax = -ax;
        ay = -ay;
        az = -az;
        aw = -aw;
      }
      if (bx * pb[o] + by * pb[o + 1] + bz * pb[o + 2] + bw * pb[o + 3] < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
      }
    }
    this.a[o] = ax;
    this.a[o + 1] = ay;
    this.a[o + 2] = az;
    this.a[o + 3] = aw;
    this.b[o] = bx;
    this.b[o + 1] = by;
    this.b[o + 2] = bz;
    this.b[o + 3] = bw;
    // slerp along the arc these representations span (no re-choice of the shorter one)
    const cos = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz + aw * bw));
    const th = Math.acos(cos), sn = Math.sin(th);
    let s0 = 1 - w, s1 = w;
    if (sn > 1e-6) {
      s0 = Math.sin((1 - w) * th) / sn;
      s1 = Math.sin(w * th) / sn;
    }
    let x = ax * s0 + bx * s1, y = ay * s0 + by * s1, z = az * s0 + bz * s1, ww = aw * s0 + bw * s1;
    const l = Math.hypot(x, y, z, ww) || 1;
    x /= l;
    y /= l;
    z /= l;
    ww /= l;
    out[oo] = x;
    out[oo + 1] = y;
    out[oo + 2] = z;
    out[oo + 3] = ww;
    this.started = true;
  }

  get active() {
    return this.started;
  }
}
