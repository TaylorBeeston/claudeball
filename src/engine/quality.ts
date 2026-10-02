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
}

export const QUALITY: Record<QualityName, QualitySettings> = {
  low: { name: 'low', maxDpr: 1, msaa: 0, shadowCascades: 2, shadowMapSize: 1024, ao: false, aoHalfRes: true, bloom: false, dof: false, grain: false, crowdDensity: 0.25, crowdAnimate: false, detail: 0.3, puppetLod: [0.4, 0.2] },
  medium: { name: 'medium', maxDpr: 1.25, msaa: 0, shadowCascades: 3, shadowMapSize: 2048, ao: true, aoHalfRes: true, bloom: true, dof: false, grain: true, crowdDensity: 0.55, crowdAnimate: true, detail: 0.6, puppetLod: [0.3, 0.12] },
  high: { name: 'high', maxDpr: 1.5, msaa: 4, shadowCascades: 3, shadowMapSize: 2048, ao: true, aoHalfRes: true, bloom: true, dof: true, grain: true, crowdDensity: 0.85, crowdAnimate: true, detail: 0.85, puppetLod: [0.22, 0.09] },
  ultra: { name: 'ultra', maxDpr: 2, msaa: 4, shadowCascades: 4, shadowMapSize: 4096, ao: true, aoHalfRes: false, bloom: true, dof: true, grain: true, crowdDensity: 1, crowdAnimate: true, detail: 1, puppetLod: [0.14, 0.05] },
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

/**
 * Adaptive resolution: drops the internal render scale when frame time creeps
 * over budget, and creeps back up when there is headroom. Preset changes are
 * left to the user; scale is the cheap, flicker-free lever.
 */
export class AdaptiveScale {
  scale = 1;
  min = 0.55;
  private ema = 16.7;
  private cooldown = 0;
  enabled = true;

  /** Forget the history (e.g. after a long warm-up or compile stall, which says nothing about steady-state frame time). */
  reset() {
    this.scale = 1;
    this.ema = 16.7;
    this.cooldown = 2;
  }

  update(frameMs: number, dt: number): boolean {
    this.ema += (Math.min(frameMs, 100) - this.ema) * 0.05;
    this.cooldown -= dt;
    if (!this.enabled || this.cooldown > 0) return false;
    if (this.ema > 19.5 && this.scale > this.min) {
      this.scale = Math.max(this.min, this.scale - 0.08);
      this.cooldown = 1.2;
      return true;
    }
    if (this.ema < 13.5 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.04);
      this.cooldown = 3;
      return true;
    }
    return false;
  }
}
