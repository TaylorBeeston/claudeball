import { describe, expect, it } from 'vitest';
import { DUCK_DEFAULTS, PROCESSOR_NAME, duckStep, newDuckState, workletSource, type DuckParams } from '../duck';

const SR = 48000;
const BLOCK = 128 / SR;
/** run the follower over a key given as mean-square per block; returns the reduction per block */
function run(key: (t: number) => number, secs: number, p: DuckParams = DUCK_DEFAULTS): number[] {
  const s = newDuckState();
  const out: number[] = [];
  for (let i = 0; i < secs / BLOCK; i++) out.push(duckStep(s, key(i * BLOCK), BLOCK, p));
  return out;
}
const voice = Math.pow(10, -20 / 10); // a voice at -20 dBFS rms (well above the -50 dBFS threshold)
const firstAt = (r: number[], pred: (v: number) => boolean, from = 0) => {
  for (let i = Math.round(from / BLOCK); i < r.length; i++) if (pred(r[i])) return i * BLOCK;
  return NaN;
};

describe('sidechain duck follower', () => {
  it('reaches the full depth with a ~30-80 ms attack while the booth talks', () => {
    const r = run((t) => (t >= 0.5 && t < 2.5 ? voice : 0), 4);
    expect(Math.min(...r)).toBeCloseTo(-DUCK_DEFAULTS.depth, 1);
    const t90 = firstAt(r, (v) => v <= -0.9 * DUCK_DEFAULTS.depth) - 0.5;
    // 90 % of the way with a 50 ms time constant: ~115 ms (= 2.3 tau), plus a few ms of detector
    expect(t90).toBeGreaterThan(0.06);
    expect(t90).toBeLessThan(0.2);
    expect(r[Math.round(0.4 / BLOCK)]).toBe(0);
  });

  it('holds through the gaps between words, then releases over ~0.5 s', () => {
    // syllables: 150 ms on, 100 ms off
    const r = run((t) => (t >= 0.5 && t < 2.5 && (t * 1000) % 250 < 150 ? voice : 0), 5);
    const during = r.slice(Math.round(1 / BLOCK), Math.round(2.4 / BLOCK));
    expect(Math.max(...during)).toBeLessThan(-0.85 * DUCK_DEFAULTS.depth);
    // after the voice stops: the hold, then back to within 1 dB in ~1-1.6 s
    const back = firstAt(r, (v) => v > -1, 2.5) - 2.5;
    expect(back).toBeGreaterThan(0.6);
    expect(back).toBeLessThan(1.8);
    expect(r[Math.round(2.6 / BLOCK)]).toBeLessThan(-0.85 * DUCK_DEFAULTS.depth); // still held 100 ms after
  });

  it('ignores a key under the threshold, scales with the level above it, and follows the external key (browser speech)', () => {
    expect(Math.min(...run(() => Math.pow(10, -60 / 10), 2))).toBe(0);
    const half = Math.min(...run(() => Math.pow(10, (DUCK_DEFAULTS.threshold + DUCK_DEFAULTS.range / 2) / 10), 2));
    expect(half).toBeCloseTo(-DUCK_DEFAULTS.depth / 2, 0);
    const ext = Math.min(...run(() => 0, 2, { ...DUCK_DEFAULTS, ext: 1 }));
    expect(ext).toBeCloseTo(-DUCK_DEFAULTS.depth, 1);
    expect(Math.min(...run(() => voice, 2, { ...DUCK_DEFAULTS, depth: 10 }))).toBeCloseTo(-10, 1);
  });

  it('the worklet source runs the same algorithm and writes [linear gain, eq dB] control channels', () => {
    const src = workletSource();
    let Proc: any = null;
    class AudioWorkletProcessor {
      port = { onmessage: null as unknown, postMessage: () => {} };
    }
    // evaluate the processor source with the AudioWorkletGlobalScope bits stubbed
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(AudioWorkletProcessor, (name: string, c: unknown) => {
      expect(name).toBe(PROCESSOR_NAME);
      Proc = c;
    }, SR);
    const proc = new Proc();
    const params = Object.fromEntries(Proc.parameterDescriptors.map((d: { name: string; defaultValue: number }) => [d.name, new Float32Array([d.defaultValue])]));
    const ref = newDuckState();
    const amp = Math.sqrt(voice);
    let last = { g: 1, e: 0 };
    for (let b = 0; b < 300; b++) {
      const key = new Float32Array(128).fill(b > 20 ? amp : 0);
      const out = [new Float32Array(128), new Float32Array(128)];
      proc.process([[key]], [out], params);
      const red = duckStep(ref, b > 20 ? voice : 0, BLOCK, DUCK_DEFAULTS);
      expect(out[0][127]).toBeCloseTo(Math.pow(10, red / 20), 5);
      expect(out[1][127]).toBeCloseTo((red * DUCK_DEFAULTS.eqDepth) / DUCK_DEFAULTS.depth, 4);
      last = { g: out[0][127], e: out[1][127] };
    }
    expect(last.g).toBeCloseTo(Math.pow(10, -DUCK_DEFAULTS.depth / 20), 2);
    expect(last.e).toBeCloseTo(-DUCK_DEFAULTS.eqDepth, 1);
  });
});
