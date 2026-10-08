/**
 * The sidechain duck: the park (crowd, effects, organ, PA, music) sits back while the booth talks, like a broadcast mixer's ducker.
 * Web Audio has no sidechain input on its compressor, so an AudioWorklet follows the booth bus's envelope and writes two CONTROL
 * signals: a broadband gain (into the park bus's GainNode.gain) and a dB value for a dynamic presence cut (into a peaking filter's gain
 * at ~2.2 kHz, so the 1-4 kHz band of the ambience goes down further than the lows: the crowd stays big, the voice stays clear).
 * No park audio passes through JavaScript: the worklet reads only the booth key and outputs two slow control channels.
 *
 * `duckStep` is the whole algorithm, pure and self-contained: the worklet source embeds it verbatim (`duckStep.toString()`) and the
 * unit tests run the same function.
 *
 *   detector  mean square of the key per 128-sample block -> dB, peak-ish ballistics (5 ms up, 120 ms down) so syllables don't chatter
 *   gain      amount = clamp((level - threshold) / range, 0, 1); target = -depth * amount (dB)
 *             gain ballistics: `attack` going down (30-80 ms), a `hold` (bridges the gaps between words), then `release` (300-700 ms)
 *   external  `ext` (0..1) is a key level for voices outside Web Audio (browser speech): treated as a voice at threshold + ext * range
 */

export interface DuckParams {
  /** broadband duck depth, dB (positive) */
  depth: number;
  /** extra cut of the 1-4 kHz band at full duck, dB (positive) */
  eqDepth: number;
  /** key level where ducking starts, dBFS, and the range over which it reaches full depth */
  threshold: number;
  range: number;
  attack: number;
  release: number;
  hold: number;
  /** external key 0..1 */
  ext: number;
}

export interface DuckState {
  /** detector level, dB */
  det: number;
  /** current gain reduction, dB (<= 0) */
  red: number;
  /** seconds left of the hold */
  hold: number;
}

export const DUCK_DEFAULTS: DuckParams = { depth: 7, eqDepth: 4, threshold: -50, range: 14, attack: 0.05, release: 0.5, hold: 0.25, ext: 0 };

export const newDuckState = (): DuckState => ({ det: -120, red: 0, hold: 0 });

/** advance one block: `ms` = mean square of the key over the block, `dt` = block duration (s). Returns the new reduction (dB, <= 0). */
export function duckStep(s: DuckState, ms: number, dt: number, p: DuckParams): number {
  const lvl = 10 * Math.log10(ms + 1e-12);
  const up = 1 - Math.exp(-dt / 0.005);
  const down = 1 - Math.exp(-dt / 0.12);
  s.det += (lvl - s.det) * (lvl > s.det ? up : down);
  const ext = p.ext > 0 ? p.threshold + p.ext * p.range : -120;
  const key = Math.max(s.det, ext);
  const amount = Math.min(1, Math.max(0, (key - p.threshold) / Math.max(1, p.range)));
  const target = -p.depth * amount;
  if (target < s.red - 0.01) {
    s.red += (target - s.red) * (1 - Math.exp(-dt / Math.max(0.001, p.attack)));
    s.hold = p.hold;
  } else if (s.hold > 0) {
    s.hold -= dt;
    if (target < s.red) s.red = target;
  } else s.red += (target - s.red) * (1 - Math.exp(-dt / Math.max(0.001, p.release)));
  return s.red;
}

export const PROCESSOR_NAME = 'cb-duck';

/** the AudioWorkletProcessor source (registered from a Blob URL): input = booth key, output 2 channels = [gain (linear), eq (dB)] */
export function workletSource(): string {
  return `
const duckStep = (${duckStep.toString()});
class CbDuck extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'depth', defaultValue: ${DUCK_DEFAULTS.depth}, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
      { name: 'eqDepth', defaultValue: ${DUCK_DEFAULTS.eqDepth}, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: ${DUCK_DEFAULTS.threshold}, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: ${DUCK_DEFAULTS.range}, minValue: 1, maxValue: 60, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: ${DUCK_DEFAULTS.attack}, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
      { name: 'release', defaultValue: ${DUCK_DEFAULTS.release}, minValue: 0.01, maxValue: 5, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: ${DUCK_DEFAULTS.hold}, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'ext', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.s = { det: -120, red: 0, hold: 0 };
    this.prev = 0;
    this.n = 0;
    this.port.onmessage = () => this.port.postMessage({ red: this.s.red, det: this.s.det });
  }
  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    const len = out[0].length;
    let ms = 0;
    if (inp && inp.length) {
      for (let c = 0; c < inp.length; c++) {
        const x = inp[c];
        for (let i = 0; i < x.length; i++) ms += x[i] * x[i];
      }
      ms /= inp.length * len;
    }
    const p = { depth: params.depth[0], eqDepth: params.eqDepth[0], threshold: params.threshold[0], range: params.range[0], attack: params.attack[0], release: params.release[0], hold: params.hold[0], ext: params.ext[0] };
    const red = duckStep(this.s, ms, len / sampleRate, p);
    const g0 = Math.pow(10, this.prev / 20), g1 = Math.pow(10, red / 20);
    const eqScale = p.depth > 0 ? p.eqDepth / p.depth : 0;
    const gc = out[0], ec = out[1] || out[0];
    for (let i = 0; i < len; i++) {
      const f = (i + 1) / len;
      gc[i] = g0 + (g1 - g0) * f;
      if (out[1]) ec[i] = (this.prev + (red - this.prev) * f) * eqScale;
    }
    this.prev = red;
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', CbDuck);
`;
}
