/**
 * Head look-at: pure math (no three.js), shared by the glTF and the procedural players.
 *
 * The target is expressed as a yaw/pitch relative to the player's torso, clamped to human limits, ignored when it is behind the
 * player or too close (angles blow up near the head), and followed by a critically damped spring with a maximum angular speed so
 * a spiking ball position can never whip the head around. Neutral (0, 0) is where the head goes when there is nothing to look at.
 */
export const LOOK_LIMITS = {
  /** neck + head yaw offset from the clip pose, either side (rad) */
  yaw: (70 * Math.PI) / 180,
  /** extra yaw the upper spine may add either side (rad) */
  spineYaw: (20 * Math.PI) / 180,
  /** neck + head pitch offset from the clip pose, up or down (rad) */
  pitch: (35 * Math.PI) / 180,
  /** absolute limits of where the head may point relative to the torso: yaw either side, up, down (rad) */
  absYaw: (90 * Math.PI) / 180,
  absUp: (75 * Math.PI) / 180,
  absDown: (35 * Math.PI) / 180,
  /** targets closer than this (m, horizontal, from the head) are ignored */
  minDist: 1.0,
  /** targets more than this far off the torso axis (rad) are "behind" and ignored */
  behind: (120 * Math.PI) / 180,
  /** spring natural frequency (1/s) */
  omega: 11,
  /** angular speed cap (rad/s) */
  maxSpeed: 7,
} as const;

/** Per-frame bound (rad) for how far the look offset may move: what the spring cap allows at this dt. */
export const maxLookStep = (dt: number) => LOOK_LIMITS.maxSpeed * dt + 1e-6;

/** Yaw / pitch OFFSET (rad) to add on top of the animation's own head pose. */
export interface LookTarget {
  yaw: number;
  pitch: number;
  /** false when the target should be ignored (behind, too close, non-finite) */
  valid: boolean;
}

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The offset that turns a head, which the clip already points at (`clipYaw`, `clipPitch`, relative to the torso), toward a point
 * given in torso-local axes (+Z forward, +X the model's left, +Y up).
 */
export function lookTarget(dx: number, dy: number, dz: number, clipYaw = 0, clipPitch = 0, out: LookTarget = { yaw: 0, pitch: 0, valid: false }): LookTarget {
  out.yaw = out.pitch = 0;
  out.valid = false;
  const h = Math.hypot(dx, dz);
  if (!Number.isFinite(dx + dy + dz + clipYaw + clipPitch) || h < LOOK_LIMITS.minDist) return out;
  const yaw = wrap(Math.atan2(dx, dz));
  if (Math.abs(yaw) > LOOK_LIMITS.behind) return out;
  const pitch = Math.atan2(-dy, h);
  const ty = clamp(yaw, -LOOK_LIMITS.absYaw, LOOK_LIMITS.absYaw);
  const tp = clamp(pitch, -LOOK_LIMITS.absUp, LOOK_LIMITS.absDown);
  out.yaw = clamp(ty - clipYaw, -LOOK_LIMITS.yaw - LOOK_LIMITS.spineYaw, LOOK_LIMITS.yaw + LOOK_LIMITS.spineYaw);
  out.pitch = clamp(tp - clipPitch, -LOOK_LIMITS.pitch, LOOK_LIMITS.pitch);
  out.valid = true;
  return out;
}

export class HeadLook {
  /** current offset from the clip pose */
  yaw = 0;
  pitch = 0;
  private vy = 0;
  private vp = 0;
  /** angle moved in the last step (rad), for diagnostics / tests */
  lastStep = 0;

  reset() {
    this.yaw = this.pitch = this.vy = this.vp = 0;
    this.lastStep = 0;
  }

  /** Advance toward `t` (or back to the clip pose when it is invalid / null). */
  step(t: LookTarget | null, dt: number) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    const ty = t?.valid ? t.yaw : 0;
    const tp = t?.valid ? t.pitch : 0;
    const py = this.yaw, pp = this.pitch;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    const w = LOOK_LIMITS.omega;
    for (let i = 0; i < n; i++) {
      // critically damped spring: x'' = w^2 (target - x) - 2 w x'
      this.vy += (w * w * (ty - this.yaw) - 2 * w * this.vy) * h;
      this.vp += (w * w * (tp - this.pitch) - 2 * w * this.vp) * h;
      const sp = Math.hypot(this.vy, this.vp);
      if (sp > LOOK_LIMITS.maxSpeed) {
        this.vy *= LOOK_LIMITS.maxSpeed / sp;
        this.vp *= LOOK_LIMITS.maxSpeed / sp;
      }
      this.yaw += this.vy * h;
      this.pitch += this.vp * h;
    }
    const maxYaw = LOOK_LIMITS.yaw + LOOK_LIMITS.spineYaw;
    this.yaw = clamp(this.yaw, -maxYaw, maxYaw);
    this.pitch = clamp(this.pitch, -LOOK_LIMITS.pitch, LOOK_LIMITS.pitch);
    this.lastStep = Math.hypot(this.yaw - py, this.pitch - pp);
  }

  /** Split the yaw offset between the upper spine and the neck/head so the neck itself never exceeds its own limit. */
  split(): { spine: number; neckHeadYaw: number } {
    const spine = clamp(this.yaw * 0.25, -LOOK_LIMITS.spineYaw, LOOK_LIMITS.spineYaw);
    const rest = clamp(this.yaw - spine, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
    return { spine, neckHeadYaw: rest };
  }
}
