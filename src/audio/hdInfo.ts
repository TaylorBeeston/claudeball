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
  // `?hdmode=cpu|gpu` forces a mode (testing)
  try {
    const f = new URLSearchParams(location.search).get('hdmode');
    if (f === 'cpu' || f === 'gpu') return f;
  } catch {
    /* no location (node) */
  }
  return typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu ? 'gpu' : 'cpu';
}

/**
 * HD voices are offered only with WebGPU: measured in headless Chrome, the CPU (WASM) model runs 3x slower than real time on an idle
 * machine and 5-7x while the game renders (see the audio README), so live commentary cannot keep up. `?hdmode=cpu` forces it for testing.
 */
export function hdSupported(): boolean {
  if (pickMode() === 'gpu') return true;
  try {
    return new URLSearchParams(location.search).get('hdmode') === 'cpu';
  } catch {
    return false;
  }
}
