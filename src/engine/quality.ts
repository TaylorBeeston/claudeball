export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  name: QualityName;
  /** max device pixel ratio */
  maxDpr: number;
  msaa: number;
  shadowCascades: number;
  shadowMapSize: number;
  ao: boolean;
  aoHalfRes: boolean;
  bloom: boolean;
  dof: boolean;
  grain: boolean;
  crowdDensity: number;
  crowdAnimate: boolean;
  /** grass detail (procedural) 0..1 */
  detail: number;
  /** player level of detail: screen-height fractions below which a player loses his micro details (tier 1) and everything but the body shapes (tier 2) */
  puppetLod: readonly [number, number];
  /** azimuth sectors the stands' seats and spectators are drawn in (each is a draw call per mesh kind; fewer sectors = fewer calls, coarser culling) */
  crowdSectors: number;
}

export const QUALITY: Record<QualityName, QualitySettings> = {
  low: { name: 'low', maxDpr: 1, msaa: 0, shadowCascades: 2, shadowMapSize: 1024, ao: false, aoHalfRes: true, bloom: false, dof: false, grain: false, crowdDensity: 0.25, crowdAnimate: false, detail: 0.3, puppetLod: [0.4, 0.2], crowdSectors: 4 },
  medium: { name: 'medium', maxDpr: 1.25, msaa: 0, shadowCascades: 3, shadowMapSize: 2048, ao: true, aoHalfRes: true, bloom: true, dof: false, grain: true, crowdDensity: 0.55, crowdAnimate: true, detail: 0.6, puppetLod: [0.3, 0.12], crowdSectors: 8 },
  high: { name: 'high', maxDpr: 1.5, msaa: 4, shadowCascades: 3, shadowMapSize: 2048, ao: true, aoHalfRes: true, bloom: true, dof: true, grain: true, crowdDensity: 0.85, crowdAnimate: true, detail: 0.85, puppetLod: [0.22, 0.09], crowdSectors: 12 },
  ultra: { name: 'ultra', maxDpr: 2, msaa: 4, shadowCascades: 4, shadowMapSize: 4096, ao: true, aoHalfRes: false, bloom: true, dof: true, grain: true, crowdDensity: 1, crowdAnimate: true, detail: 1, puppetLod: [0.14, 0.05], crowdSectors: 24 },
};

/** Internal pixel budget (megapixels, before the adaptive scale) per preset: phones keep a sharp image at a small cost, big screens stay capped. */
const PIXEL_BUDGET_MP: Record<QualityName, number> = { low: 0.9, medium: 1.5, high: 2.8, ultra: 5.5 };

/**
 * Device pixel ratio to render at. Desktops: the preset's cap. Touch devices (phones' DPR is 3, tablets' 2): up to 1.5 even on Low,
 * but never above what the preset's pixel budget allows at this screen size, so a phone renders ~0.7 MP on Low instead of 0.33 MP
 * (blurry) or 3 MP (hot).
 */
export function pixelRatioFor(q: QualitySettings, deviceDpr: number, cssW: number, cssH: number, coarse: boolean): number {
  const cap = coarse ? Math.max(q.maxDpr, 1.5) : q.maxDpr;
  let dpr = Math.min(deviceDpr, cap);
  if (coarse) dpr = Math.min(dpr, Math.max(1, Math.sqrt((PIXEL_BUDGET_MP[q.name] * 1e6) / Math.max(1, cssW * cssH))));
  return Math.max(0.5, dpr);
}

export const QUALITY_ORDER: QualityName[] = ['low', 'medium', 'high', 'ultra'];

/** how many CPU-side load levels the adaptive controller can step through (see `loadEffects`) */
export const LOAD_LEVELS = 4;

/** What a load level changes (cumulative: level 3 includes levels 1 and 2). Every item removes CPU draw-call work, not only pixels. */
export interface LoadEffects {
  /** multiplies the puppet LOD thresholds (more puppets drop to the cheaper tiers) */
  lodScale: number;
  /** upper bound on the stands' sector count (fewer sectors = fewer draw calls) */
  crowdSectors: number;
  /** spectators stop moving (no per-frame uniform animation) */
  crowdAnimate: boolean;
  /** tower-spot shadows allowed (lower = fewer shadow passes at night) */
  towerShadows: number;
  /** the far shadow cascades are redrawn every n-th frame only (1 = every frame) */
  farShadowEvery: number;
  /** ambient occlusion (its depth/normal prepass is a full extra scene pass) and depth of field are dropped */
  noAo: boolean;
}

export function loadEffects(level: number): LoadEffects {
  return {
    lodScale: level >= 1 ? 1.5 : 1,
    crowdSectors: level >= 2 ? 4 : 99,
    crowdAnimate: level < 2,
    towerShadows: level >= 2 ? 1 : 99,
    farShadowEvery: level >= 3 ? 2 : 1,
    noAo: level >= 4,
  };
}

/**
 * Adaptive load: when frames run long it lowers the cost, and when there is headroom it gives it back, one step at a time.
 * Two levers: the render scale (pixels: helps when the GPU is the limit) and the CPU-side load level (draw calls: helps when the main thread is the limit).
 * Which one moves first depends on where the time goes (`jsMs` against the frame interval). The old controller only changed the resolution and, at 60 Hz
 * vsync, could never restore it (its average never fell below the restore threshold, which a vsync-capped frame time cannot do): headroom is now judged on
 * the JS time with the frame interval still on budget, and each degrade that follows a restore within 20 s doubles the calm time required for the next
 * restore (up to 2 minutes), so the controller settles instead of oscillating.
 */
export class AdaptiveScale {
  scale = 1;
  min = 0.6;
  level = 0;
  maxLevel = LOAD_LEVELS;
  enabled = true;
  /** frame budget in ms: 1000 / refresh rate */
  budget = 16.7;
  private ema = 16.7;
  private emaJs = 6;
  private cooldown = 2;
  private calm = 0;
  private backoff = 8;
  private clock = 0;
  private lastRestore = -1e9;

  /** Forget the history (e.g. after a long warm-up or compile stall, which says nothing about steady-state frame time). Keeps the level. */
  reset() {
    this.ema = this.budget;
    this.emaJs = 6;
    this.cooldown = 3;
    this.calm = 0;
  }

  /** Back to full quality (a new game, a preset change by the player). */
  full() {
    this.scale = 1;
    this.level = 0;
    this.backoff = 8;
    this.reset();
  }

  /** `jsMs` = the main-thread time of the tick, `frameMs` = the interval between frames, `dt` in seconds. true = something changed. */
  update(jsMs: number, frameMs: number, dt: number): boolean {
    this.clock += dt;
    this.ema += (Math.min(frameMs, 100) - this.ema) * 0.05;
    this.emaJs += (Math.min(jsMs, 100) - this.emaJs) * 0.05;
    this.cooldown -= dt;
    if (!this.enabled || this.cooldown > 0) return false;
    const slow = this.ema > this.budget * 1.14;
    if (slow) {
      this.calm = 0;
      const cpuBound = this.emaJs > this.budget * 0.6;
      let changed = false;
      if (cpuBound && this.level < this.maxLevel) {
        this.level++;
        changed = true;
      } else if (this.scale > this.min + 1e-6) {
        this.scale = Math.max(this.min, this.scale - 0.08);
        changed = true;
      } else if (this.level < this.maxLevel) {
        this.level++;
        changed = true;
      }
      if (changed) {
        if (this.clock - this.lastRestore < 20) this.backoff = Math.min(120, this.backoff * 2);
        this.cooldown = 1.5;
      }
      return changed;
    }
    // on budget: headroom means the main thread is well under it (a vsync-capped frame interval says nothing)
    if (this.ema < this.budget * 1.08 && this.emaJs < this.budget * 0.5 && (this.scale < 1 || this.level > 0)) {
      this.calm += dt;
      if (this.calm >= this.backoff) {
        this.calm = 0;
        if (this.scale < 1 - 1e-6) this.scale = Math.min(1, this.scale + 0.05);
        else this.level--;
        this.lastRestore = this.clock;
        this.cooldown = 3;
        this.backoff = Math.max(8, this.backoff * 0.9);
        return true;
      }
    } else this.calm = Math.max(0, this.calm - dt);
    return false;
  }
}
