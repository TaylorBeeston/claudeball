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
}

export const QUALITY: Record<QualityName, QualitySettings> = {
  low: { name: 'low', maxDpr: 1, msaa: 0, shadowCascades: 2, shadowMapSize: 1024, ao: false, aoHalfRes: true, bloom: false, dof: false, grain: false, crowdDensity: 0.25, crowdAnimate: false, detail: 0.3 },
  medium: { name: 'medium', maxDpr: 1.25, msaa: 0, shadowCascades: 3, shadowMapSize: 2048, ao: true, aoHalfRes: true, bloom: true, dof: false, grain: true, crowdDensity: 0.55, crowdAnimate: true, detail: 0.6 },
  high: { name: 'high', maxDpr: 1.5, msaa: 4, shadowCascades: 3, shadowMapSize: 2048, ao: true, aoHalfRes: true, bloom: true, dof: true, grain: true, crowdDensity: 0.85, crowdAnimate: true, detail: 0.85 },
  ultra: { name: 'ultra', maxDpr: 2, msaa: 4, shadowCascades: 4, shadowMapSize: 4096, ao: true, aoHalfRes: false, bloom: true, dof: true, grain: true, crowdDensity: 1, crowdAnimate: true, detail: 1 },
};

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
