/**
 * The ballpark's impulse response, synthesised (pure, deterministic: same preset + sample rate = same samples).
 *
 * An open-air bowl does not ring like a hall: what you hear is a pre-delay (nothing comes back for 50-100 ms), a handful of distinct
 * reflections off the lower bowl, the backstop / press box and the upper deck and scoreboard (20-250 ms), then a diffuse, fairly long
 * tail from the stands (RT60 ~1.8-2.6 s at mid frequencies) whose highs die much faster than its lows (air absorption over long paths,
 * seats and people). The tail is built in four bands (< 250 Hz, 250 Hz-1 kHz, 1-4 kHz, > 4 kHz), each decaying at its own RT60, with
 * independent noise per channel (a decorrelated stereo tail) and a short build-up so it blooms rather than starts with a click.
 *
 * The IR has unit energy, so the send level into the convolver sets the reverb's loudness directly.
 */
import { mulberry32 } from '../dsp';
import { filt, rbj } from './analysis';

export type VenuePreset = 'dry' | 'normal' | 'big';
export const VENUE_PRESETS: VenuePreset[] = ['dry', 'normal', 'big'];

export interface VenueParams {
  /** seconds before the first reflection */
  preDelay: number;
  /** RT60 (s) per band: low (< 250 Hz), low-mid, high-mid (1-4 kHz), high (> 4 kHz) */
  rt60: [number, number, number, number];
  /** early reflections: delay (s, after the direct sound), gain (relative), left/right balance (-1..1), low-pass (Hz) */
  early: { t: number; g: number; pan: number; lp: number }[];
  /** level of the diffuse tail against the early reflections */
  tail: number;
  /** the build-up of the diffuse tail, s */
  bloom: number;
  /** total length, s */
  length: number;
  /** wet level of the shared reverb return for this preset (the mixer's convolver output) */
  wet: number;
}

/** the reflections that make a ballpark: lower bowl, backstop / press box, the dugout roofs, the upper deck, the scoreboard */
const EARLY: VenueParams['early'] = [
  { t: 0.022, g: 0.55, pan: -0.4, lp: 9000 }, // lower-bowl facade, near side
  { t: 0.037, g: 0.5, pan: 0.45, lp: 8000 },
  { t: 0.058, g: 0.42, pan: 0.1, lp: 7000 }, // backstop / screen
  { t: 0.085, g: 0.38, pan: -0.6, lp: 6000 }, // dugout roofs / camera wells
  { t: 0.118, g: 0.34, pan: 0.7, lp: 5000 }, // press box glass
  { t: 0.163, g: 0.3, pan: -0.2, lp: 4200 }, // upper deck facade
  { t: 0.205, g: 0.26, pan: 0.55, lp: 3500 }, // upper deck, far side
  { t: 0.248, g: 0.22, pan: -0.7, lp: 3000 }, // scoreboard / outfield stands
];

export const VENUES: Record<VenuePreset, VenueParams> = {
  // a small, open park: short tail, little slap
  dry: { preDelay: 0.035, rt60: [1.3, 1.1, 0.8, 0.5], early: EARLY.slice(0, 5).map((e) => ({ ...e, g: e.g * 0.7 })), tail: 0.6, bloom: 0.06, length: 1.3, wet: 0.16 },
  // a big-league bowl: the default
  normal: { preDelay: 0.07, rt60: [2.6, 2.2, 1.6, 0.95], early: EARLY, tail: 1, bloom: 0.09, length: 2.3, wet: 0.3 },
  // a domed / enclosed giant: long and lush
  big: { preDelay: 0.095, rt60: [3.2, 2.7, 2.0, 1.2], early: EARLY.map((e) => ({ ...e, t: e.t * 1.25, g: e.g * 1.1 })), tail: 1.2, bloom: 0.12, length: 2.8, wet: 0.38 },
};

export interface IR {
  sr: number;
  ch: [Float32Array, Float32Array];
}

/** the stadium impulse response for a preset at a sample rate */
export function stadiumIR(sr: number, preset: VenuePreset | string = 'normal'): IR {
  const p = VENUES[(preset in VENUES ? preset : 'normal') as VenuePreset];
  const n = Math.floor(p.length * sr);
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  const pre = Math.floor(p.preDelay * sr);

  // the diffuse tail: per band, independent noise per channel, exponential decay at that band's RT60
  const edges = [250, 1000, 4000];
  for (let c = 0; c < 2; c++) {
    const rng = mulberry32(9001 + c * 7919);
    const noise = new Float32Array(n);
    for (let i = pre; i < n; i++) noise[i] = rng() * 2 - 1;
    const tail = new Float32Array(n);
    for (let b = 0; b < 4; b++) {
      let band: Float32Array = noise;
      if (b > 0) band = filt(filt(band, rbj('highpass', edges[b - 1], sr)), rbj('highpass', edges[b - 1], sr));
      if (b < 3) band = filt(filt(band, rbj('lowpass', edges[b], sr)), rbj('lowpass', edges[b], sr));
      // amplitude falls 60 dB over RT60: 10^(-3 t / RT60), as a per-sample factor
      const r = Math.pow(10, -3 / p.rt60[b] / sr);
      let env = 1;
      for (let i = pre; i < n; i++) {
        tail[i] += band[i] * env;
        env *= r;
      }
    }
    // build-up: the reflections get denser over the first ~100 ms; the end is faded so nothing is cut
    const bloom = Math.max(1, Math.floor(p.bloom * sr));
    const fade = Math.floor(0.25 * sr);
    for (let i = pre; i < n; i++) {
      const x = i - pre;
      const up = x < bloom ? Math.pow(x / bloom, 1.5) : 1;
      const down = i > n - fade ? (n - i) / fade : 1;
      out[c][i] = tail[i] * up * down * p.tail * 0.25;
    }
  }

  // early reflections: a short band-limited click each, panned, on top of the tail
  for (const e of p.early) {
    const at = Math.floor((p.preDelay * 0.4 + e.t) * sr);
    if (at >= n - 64) continue;
    const click = new Float32Array(48);
    const r = mulberry32(Math.floor(e.t * 1e5));
    for (let i = 0; i < click.length; i++) click[i] = (r() * 2 - 1) * Math.exp(-i / 6);
    const lp = filt(click, rbj('lowpass', Math.min(e.lp, sr * 0.45), sr));
    const gl = e.g * Math.sqrt(0.5 * (1 - e.pan));
    const gr = e.g * Math.sqrt(0.5 * (1 + e.pan));
    for (let i = 0; i < lp.length && at + i < n; i++) {
      out[0][at + i] += lp[i] * gl;
      out[1][at + i] += lp[i] * gr;
    }
  }

  // unit energy (summed over both channels / 2)
  let e = 0;
  for (const c of out) for (let i = 0; i < n; i++) e += c[i] * c[i];
  const g = 1 / Math.sqrt(Math.max(1e-12, e / 2));
  for (const c of out) for (let i = 0; i < n; i++) c[i] *= g;
  return { sr, ch: out };
}

/** correlation coefficient of the two channels over a window (the stereo decorrelation of the tail) */
export function channelCorrelation(ir: IR, from = 0.15, to = 1.2): number {
  const a = Math.floor(from * ir.sr), b = Math.min(ir.ch[0].length, Math.floor(to * ir.sr));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = a; i < b; i++) {
    const x = ir.ch[0][i], y = ir.ch[1][i];
    sxy += x * y;
    sxx += x * x;
    syy += y * y;
  }
  return sxy / Math.sqrt(Math.max(1e-30, sxx * syy));
}
