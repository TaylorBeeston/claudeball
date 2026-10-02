/**
 * Autofocus for the broadcast cameras. The depth-of-field pass blurs by `circle = aperture * 0.012 * |1 - focus / z|` (screen fraction), so the
 * zone that stays sharp (circle below `SHARP`) around a focus distance `f` is about `f * SHARP / (aperture * 0.012)` metres to either side.
 * The director therefore picks, for every shot, a subject (what the camera operator would focus on) and the half-depth of the slab that must
 * stay sharp around it; the aperture follows from those two, and the focus distance is racked to the subject smoothly instead of jumping.
 */

/** circle of confusion (screen fraction, ~0.4 px at 1080p) below which a pixel counts as sharp */
export const SHARP = 0.0004;
export const COC_SCALE = 0.012;

/** aperture value (the DoF pass's `aperture`) that keeps `halfSlab` metres either side of `focus` sharp */
export function apertureFor(focus: number, halfSlab: number, max = 1.2): number {
  if (!(halfSlab > 0) || !Number.isFinite(focus) || focus <= 0) return 0;
  return Math.max(0, Math.min(max, (SHARP * focus) / (COC_SCALE * halfSlab)));
}

/** the sharp half-depth (m) produced by an aperture at a focus distance (the inverse of `apertureFor`, before clamping) */
export function sharpHalfDepth(focus: number, aperture: number): number {
  return aperture > 0 ? (SHARP * focus) / (COC_SCALE * aperture) : Infinity;
}

/** blur circle (screen fraction) of something at distance `z` for a given focus and aperture; foreground is softened less than background */
export function circleOfConfusion(z: number, focus: number, aperture: number, maxBlur = 0.012, foregroundFactor = 0.45): number {
  const c = aperture * COC_SCALE * Math.abs(1 - focus / Math.max(z, 0.05));
  return Math.min(maxBlur, z < focus ? c * foregroundFactor : c);
}

/**
 * Rack focus: the focus distance follows the subject distance with a critically damped response (about `time` seconds to settle) and a maximum
 * rate (a fraction of the distance per second), so a change of subject reads as a quick focus pull and never overshoots. `snap()` on a cut.
 */
export class RackFocus {
  distance = 0;
  private velocity = 0;
  private ready = false;

  constructor(private time = 0.2, private maxRatePerSecond = 5) {}

  snap(d: number) {
    this.distance = d;
    this.velocity = 0;
    this.ready = true;
  }

  step(target: number, dt: number): number {
    if (!this.ready || !Number.isFinite(this.distance)) {
      this.snap(target);
      return this.distance;
    }
    dt = Math.min(Math.max(dt, 0), 0.1);
    const w = 4.6 / this.time; // critical damping: settles in about `time`
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    const cap = this.maxRatePerSecond * Math.max(this.distance, 5);
    for (let i = 0; i < n; i++) {
      this.velocity += (w * w * (target - this.distance) - 2 * w * this.velocity) * h;
      this.velocity = Math.max(-cap, Math.min(cap, this.velocity));
      this.distance += this.velocity * h;
    }
    return this.distance;
  }
}

/** Half-depth of the slab that must stay sharp (m) for each kind of shot; 0 means "deep focus, no blur". */
export function slabFor(shot: string, ctx: { ballHeight?: number; cutaway?: string } = {}): number {
  switch (shot) {
    case 'pitch': return 5; // batter, plate umpire and catcher sharp, the pitcher in front only slightly soft
    case 'follow': return Math.max(14, (ctx.ballHeight ?? 0) * 0.9 + 8); // a high fly: the ground under it stays sharp too
    case 'fielder': return 4.5;
    case 'base': return 6;
    case 'action': return 40;
    case 'replay': return 10;
    case 'hrwall': return 22;
    case 'trot': return 6;
    case 'homeplate': return 4.5;
    case 'umpire': return 2.8;
    case 'cutaway': return ctx.cutaway === 'wide' ? 0 : ctx.cutaway === 'ondeck' ? 4 : 7;
    case 'coach': return 5;
    case 'broll': return 4; // the planner's own rig sets the real slab
    case 'toss': return 9;
    case 'wide': return 0;
    default: return 12;
  }
}
