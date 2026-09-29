/**
 * Tiny offline DSP toolkit used by `synth.ts` to render every sound into plain Float32Arrays (no Web Audio needed, so the
 * recipes run and are testable under node). Deterministic for a given seed.
 */
export type Rand = () => number;

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FilterType = 'lp' | 'hp' | 'bp';

/** RBJ biquad; `set` can be called every few samples to sweep the cutoff. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type?: FilterType, f?: number, q?: number, sr?: number) {
    if (type) this.set(type, f ?? 1000, q ?? 0.707, sr ?? 44100);
  }

  set(type: FilterType, f: number, q: number, sr: number): this {
    const w = (2 * Math.PI * Math.min(Math.max(f, 10), sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    if (type === 'lp') {
      this.b0 = (1 - cw) / 2 / a0;
      this.b1 = (1 - cw) / a0;
      this.b2 = this.b0;
    } else if (type === 'hp') {
      this.b0 = (1 + cw) / 2 / a0;
      this.b1 = -(1 + cw) / a0;
      this.b2 = this.b0;
    } else {
      this.b0 = al / a0;
      this.b1 = 0;
      this.b2 = -al / a0;
    }
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - al) / a0;
    return this;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export interface Rendered {
  sr: number;
  /** 1 or 2 channels */
  ch: Float32Array[];
}

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Scale so the loudest sample of all channels is `peak`; also removes a tiny DC offset and de-clicks the edges. */
export function finish(r: Rendered, peak = 0.9, fadeMs = 2): Rendered {
  let m = 1e-9;
  for (const c of r.ch) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  const g = peak / m;
  const fade = Math.max(1, Math.floor((fadeMs / 1000) * r.sr));
  for (const c of r.ch) {
    for (let i = 0; i < c.length; i++) c[i] *= g;
    for (let i = 0; i < fade && i < c.length; i++) {
      const k = i / fade;
      c[c.length - 1 - i] *= k;
      c[i] *= Math.min(1, k * 4);
    }
  }
  return r;
}

/** Make a loop seamless by cross-fading the last `xf` seconds into the first ones, then dropping the tail. */
export function makeLoop(r: Rendered, xf: number): Rendered {
  const n = Math.floor(xf * r.sr);
  const ch = r.ch.map((c) => {
    const len = c.length - n;
    const o = new Float32Array(len);
    o.set(c.subarray(0, len));
    for (let i = 0; i < n; i++) {
      const k = i / n; // head fades in, the tail that follows the loop end fades out
      o[i] = c[i] * k + c[len + i] * (1 - k);
    }
    return o;
  });
  return { sr: r.sr, ch };
}

export const expo = (t: number, tau: number) => Math.exp(-t / tau);

/** Sum of damped sinusoids ("modes") added into `out`. */
export function addModes(out: Float32Array, sr: number, modes: [f: number, amp: number, tau: number][], t0 = 0, phase = 0) {
  const s0 = Math.floor(t0 * sr);
  for (const [f, a, tau] of modes) {
    const n = Math.min(out.length - s0, Math.floor(tau * 8 * sr));
    const w = (TAU * f) / sr;
    const dec = Math.exp(-1 / (tau * sr));
    let env = a;
    for (let i = 0; i < n; i++) {
      out[s0 + i] += env * Math.sin(w * i + phase);
      env *= dec;
    }
  }
}

/** White noise burst through a filter chain with an exponential envelope, added into `out`. */
export function addNoise(out: Float32Array, sr: number, r: Rand, o: { t0?: number; tau: number; amp: number; hp?: number; lp?: number; bp?: number; q?: number }) {
  const s0 = Math.floor((o.t0 ?? 0) * sr);
  const n = Math.min(out.length - s0, Math.floor(o.tau * 8 * sr));
  const hp = o.hp ? new Biquad('hp', o.hp, 0.707, sr) : null;
  const lp = o.lp ? new Biquad('lp', o.lp, 0.707, sr) : null;
  const bp = o.bp ? new Biquad('bp', o.bp, o.q ?? 1, sr) : null;
  const dec = Math.exp(-1 / (o.tau * sr));
  let env = o.amp;
  for (let i = 0; i < n; i++) {
    let x = r() * 2 - 1;
    if (hp) x = hp.tick(x);
    if (bp) x = bp.tick(x);
    if (lp) x = lp.tick(x);
    out[s0 + i] += x * env;
    env *= dec;
  }
}

/** A sine with an exponentially falling pitch (kick / membrane / boom). */
export function addThump(out: Float32Array, sr: number, o: { t0?: number; f0: number; f1: number; pitchTau: number; tau: number; amp: number }) {
  const s0 = Math.floor((o.t0 ?? 0) * sr);
  const n = Math.min(out.length - s0, Math.floor(o.tau * 7 * sr));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.pitchTau);
    ph += (TAU * f) / sr;
    out[s0 + i] += o.amp * Math.sin(ph) * Math.exp(-t / o.tau);
  }
}

/** Band-passed noise whose centre frequency follows `fc(t)` under the amplitude envelope `env(t)` (whooshes, scuffs). */
export function sweepNoise(sr: number, dur: number, r: Rand, fc: (t: number) => number, env: (t: number) => number, q = 1.4, lpHz = 0): Float32Array {
  const n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const f = new Biquad();
  const lp = lpHz ? new Biquad('lp', lpHz, 0.707, sr) : null;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 15) === 0) f.set('bp', fc(t), q, sr);
    let y = f.tick(r() * 2 - 1) * env(t);
    if (lp) y = lp.tick(y);
    out[i] = y;
  }
  return out;
}

export const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440],
  o: [570, 840, 2410],
  u: [325, 700, 2530],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
};

export interface ChoirOpts {
  sr: number;
  dur: number;
  vowel: [number, number, number];
  voices: number;
  /** fundamental in Hz at time t (each voice detunes and drifts around it) */
  f0: (t: number) => number;
  env: (t: number) => number;
  breath?: number;
  /** vowel formants multiplied by this at time t (e.g. an opening mouth) */
  formantScale?: (t: number) => number;
  spread?: number;
  /** each voice starts at a random point in this window (s) so the crowd does not begin as one */
  stagger?: number;
}

/** A crowd of voices (glottal saw through three formants), spread over the stereo field. */
export function choir(o: ChoirOpts, r: Rand): Rendered {
  const n = Math.floor(o.dur * o.sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const spread = o.spread ?? 1;
  for (let v = 0; v < o.voices; v++) {
    const pan = (r() * 2 - 1) * spread;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const detune = 1 + (r() - 0.5) * 0.18;
    const shift = 0.9 + r() * 0.25; // vocal tract size
    const stagger = r() * (o.stagger ?? 0);
    const vibHz = 4 + r() * 3;
    const vibPh = r() * TAU;
    const amp = 0.5 + r() * 0.5;
    const f1 = new Biquad();
    const f2 = new Biquad();
    const f3 = new Biquad();
    const noiseLp = new Biquad('lp', 5000, 0.7, o.sr);
    let ph = r();
    let drift = 0;
    for (let i = 0; i < n; i++) {
      const t = i / o.sr;
      const e = o.env(t - stagger);
      if (e <= 1e-4) continue;
      if ((i & 31) === 0) {
        const sc = (o.formantScale ? o.formantScale(t) : 1) * shift;
        f1.set('bp', o.vowel[0] * sc, 5, o.sr);
        f2.set('bp', o.vowel[1] * sc, 6, o.sr);
        f3.set('bp', o.vowel[2] * sc, 7, o.sr);
        drift += (r() - 0.5) * 0.02;
        drift *= 0.97;
      }
      const f = o.f0(t) * detune * (1 + drift + 0.012 * Math.sin(TAU * vibHz * t + vibPh));
      ph += f / o.sr;
      if (ph >= 1) ph -= 1;
      const src = (2 * ph - 1) * (1 - (o.breath ?? 0.3)) + (o.breath ?? 0.3) * noiseLp.tick(r() * 2 - 1) * 2;
      const y = (f1.tick(src) * 1.0 + f2.tick(src) * 0.6 + f3.tick(src) * 0.3) * e * amp;
      L[i] += y * gl;
      R[i] += y * gr;
    }
  }
  return { sr: o.sr, ch: [L, R] };
}

/** Poisson hand claps: dense random short noise bursts; `rate(t)` is claps per second (thinned per millisecond). */
export function claps(out: Float32Array[], sr: number, r: Rand, dur: number, rate: (t: number) => number, amp: number) {
  const n = Math.floor(dur * sr);
  const step = Math.max(1, Math.floor(sr / 1000));
  for (let ch = 0; ch < out.length; ch++) {
    const o = out[ch];
    for (let s = 0; s < n; s += step) {
      const lam = rate(s / sr);
      if (lam <= 0 || r() >= lam * 0.001) continue;
      const len = Math.floor((0.004 + r() * 0.012) * sr);
      const f = new Biquad('bp', 1200 + r() * 2500, 0.8 + r(), sr);
      const a = amp * (0.3 + r() * 0.7);
      for (let i = 0; i < len && s + i < n; i++) o[s + i] += f.tick(r() * 2 - 1) * a * Math.exp((-i / len) * 4);
    }
  }
}

export function mono(sr: number, data: Float32Array): Rendered {
  return { sr, ch: [data] };
}
