/** Small, always-loaded facts about the optional HD voices (the heavy code is in the lazily imported `neural.ts`). */
export type HdMode = 'gpu' | 'cpu';

/**
 * WebGPU runs the fp32 model (~326 MB; measured real-time factor 0.1-0.2 on a desktop GPU); everything else the 8-bit quantised one
 * (~92 MB; measured real-time factor ~3 on one CPU thread, i.e. slower than real time).
 */
export const HD_MODES: Record<HdMode, { device: string; dtype: string; mb: number }> = {
  gpu: { device: 'webgpu', dtype: 'fp32', mb: 326 },
  cpu: { device: 'wasm', dtype: 'q8', mb: 92 },
};

export function pickMode(): HdMode {
  return typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu ? 'gpu' : 'cpu';
}
