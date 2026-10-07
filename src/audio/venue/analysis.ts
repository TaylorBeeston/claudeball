/**
 * Offline audio measurements, pure maths on Float32Arrays (no Web Audio): loudness (ITU-R BS.1770-4 / EBU R128 integrated LUFS),
 * true peak (4x oversampled), reverberation time (Schroeder backward integration, broadband or per octave band), band energy,
 * RMS envelopes and cross-correlation lags. Used by the unit tests (`venue/__tests__`) and by the render tool (`tools/audio/render.ts`),
 * so the mix can be checked without ears.
 */

export type Channels = Float32Array[];

/** a direct-form biquad run over a signal (returns a new array) */
export function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = o;
    y[i] = o;
  }
  return y;
}

/** RBJ cookbook coefficients, normalised (a0 = 1) */
export function rbj(type: 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'highshelf' | 'lowshelf', f: number, sr: number, q = Math.SQRT1_2, gainDb = 0) {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 'lowpass':
      [b0, b1, b2, a0, a1, a2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'highpass':
      [b0, b1, b2, a0, a1, a2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'bandpass':
      [b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'peaking':
      [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A];
      break;
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2, a0, a1, a2] = [A * (A + 1 + (A - 1) * cw + s), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s), A + 1 - (A - 1) * cw + s, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s];
      break;
    }
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2, a0, a1, a2] = [A * (A + 1 - (A - 1) * cw + s), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s), A + 1 + (A - 1) * cw + s, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s];
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function filt(x: Float32Array, c: ReturnType<typeof rbj>): Float32Array {
  return biquad(x, c.b0, c.b1, c.b2, c.a1, c.a2);
}

// ---- loudness ----------------------------------------------------------------------------------------------------------------

/** the K-weighting pre-filter (BS.1770 shelf + RLB high-pass) for any sample rate (the libebur128 derivation) */
function kWeight(x: Float32Array, sr: number): Float32Array {
  // stage 1: high shelf, +4 dB above ~1.5 kHz
  {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sr);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    x = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  }
  // stage 2: RLB high-pass at ~38 Hz
  {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / sr);
    const a0 = 1 + K / Q + K * K;
    x = biquad(x, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  }
  return x;
}

/** mean-square of the K-weighted channels in 400 ms blocks with 75 % overlap (summed over channels, weight 1 for L/R) */
function blockPowers(chs: Channels, sr: number, blockSec = 0.4, hop = 0.1): number[] {
  const kw = chs.map((c) => kWeight(c, sr));
  const n = kw[0].length;
  const bl = Math.round(blockSec * sr);
  const hp = Math.round(hop * sr);
  const out: number[] = [];
  for (let s = 0; s + bl <= n; s += hp) {
    let p = 0;
    for (const c of kw) {
      let acc = 0;
      for (let i = s; i < s + bl; i++) acc += c[i] * c[i];
      p += acc / bl;
    }
    out.push(p);
  }
  return out;
}

const lk = (p: number) => -0.691 + 10 * Math.log10(Math.max(1e-12, p));

/** integrated loudness, LUFS (absolute gate -70 LUFS, relative gate -10 LU) */
export function lufsIntegrated(chs: Channels, sr: number): number {
  const ps = blockPowers(chs, sr).filter((p) => lk(p) > -70);
  if (!ps.length) return -Infinity;
  const rel = lk(ps.reduce((a, b) => a + b, 0) / ps.length) - 10;
  const g = ps.filter((p) => lk(p) > rel);
  return lk(g.reduce((a, b) => a + b, 0) / g.length);
}

/** loudness over time: momentary (400 ms) or short-term (3 s) values, one per 100 ms */
export function loudnessSeries(chs: Channels, sr: number, window: 'momentary' | 'short' = 'momentary'): number[] {
  return blockPowers(chs, sr, window === 'momentary' ? 0.4 : 3).map(lk);
}

/** loudness range (EBU Tech 3342): 10th to 95th percentile of the gated short-term loudness */
export function loudnessRange(chs: Channels, sr: number): number {
  const st = loudnessSeries(chs, sr, 'short').filter((v) => v > -70);
  if (!st.length) return 0;
  const lin = st.map((v) => Math.pow(10, (v + 0.691) / 10));
  const rel = lk(lin.reduce((a, b) => a + b, 0) / lin.length) - 20;
  const g = st.filter((v) => v > rel).sort((a, b) => a - b);
  if (!g.length) return 0;
  const q = (p: number) => g[Math.min(g.length - 1, Math.floor(p * (g.length - 1)))];
  return q(0.95) - q(0.1);
}

// ---- peaks ---------------------------------------------------------------------------------------------------------------------

export function samplePeak(chs: Channels): number {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

/** inter-sample (true) peak: 4x oversampling with a windowed-sinc interpolator (48 taps per phase), linear */
export function truePeak(chs: Channels): number {
  const taps = 48;
  const half = taps / 2;
  const phases: Float32Array[] = [];
  for (let ph = 1; ph < 4; ph++) {
    const h = new Float32Array(taps);
    const frac = ph / 4;
    for (let k = 0; k < taps; k++) {
      const t = k - half + 1 - frac;
      const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / taps) + 0.08 * Math.cos((4 * Math.PI * (k + 0.5)) / taps);
      h[k] = sinc * w;
    }
    phases.push(h);
  }
  let peak = samplePeak(chs);
  for (const c of chs) {
    for (let i = half; i < c.length - half; i++) {
      // only interpolate around loud samples (cheap and exact enough: an inter-sample peak needs a loud neighbour)
      if (Math.abs(c[i]) < peak * 0.5 && Math.abs(c[i + 1]) < peak * 0.5) continue;
      for (const h of phases) {
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += h[k] * c[i - half + 1 + k];
        const a = Math.abs(acc);
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}

export const db = (v: number) => 20 * Math.log10(Math.max(1e-12, v));

// ---- reverberation -------------------------------------------------------------------------------------------------------------

/** Schroeder energy decay curve in dB (0 dB at the start) */
export function decayCurve(x: Float32Array): Float32Array {
  const e = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) {
    acc += x[i] * x[i];
    e[i] = acc;
  }
  const out = new Float32Array(x.length);
  const e0 = e[0] || 1e-30;
  for (let i = 0; i < x.length; i++) out[i] = 10 * Math.log10(Math.max(1e-30, e[i] / e0));
  return out;
}

/**
 * RT60 from an impulse response: a least-squares line through the decay curve between -5 dB and `-5 - span` dB (T20 with span 20,
 * T30 with span 30), extrapolated to 60 dB.
 */
export function rt60(ir: Float32Array, sr: number, span = 20): number {
  const edc = decayCurve(ir);
  let i0 = -1, i1 = -1;
  for (let i = 0; i < edc.length; i++) {
    if (i0 < 0 && edc[i] <= -5) i0 = i;
    if (edc[i] <= -5 - span) {
      i1 = i;
      break;
    }
  }
  if (i0 < 0 || i1 <= i0) return NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const n = i1 - i0;
  for (let i = i0; i < i1; i++) {
    const t = i / sr;
    sx += t;
    sy += edc[i];
    sxx += t * t;
    sxy += t * edc[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // dB per second (negative)
  return slope < 0 ? -60 / slope : NaN;
}

/** RT60 in an octave band around `fc` (two cascaded band-passes) */
export function rt60Band(ir: Float32Array, sr: number, fc: number, span = 20): number {
  const c = rbj('bandpass', fc, sr, 1.41);
  return rt60(filt(filt(ir, c), c), sr, span);
}

// ---- spectra / envelopes -------------------------------------------------------------------------------------------------------

/** in-place radix-2 FFT (re, im of length 2^k) */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** averaged power spectrum (Welch, Hann, 50 % overlap): `psd[k]` for frequency k * sr / size */
export function powerSpectrum(x: Float32Array, size = 4096): Float64Array {
  const psd = new Float64Array(size / 2 + 1);
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  let n = 0;
  for (let s = 0; s + size <= x.length; s += size / 2) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    n++;
  }
  if (n) for (let k = 0; k < psd.length; k++) psd[k] /= n;
  return psd;
}

/** energy between `lo` and `hi` Hz from a power spectrum */
export function bandPower(psd: Float64Array, sr: number, lo: number, hi: number): number {
  const size = (psd.length - 1) * 2;
  let e = 0;
  for (let k = Math.max(0, Math.floor((lo * size) / sr)); k <= Math.min(psd.length - 1, Math.ceil((hi * size) / sr)); k++) e += psd[k];
  return e;
}

/** frequencies (Hz) where the spectrum (smoothed over 1/3 octave) is `dropDb` under its in-band maximum, below and above the peak region */
export function bandEdges(x: Float32Array, sr: number, dropDb = 10): { lo: number; hi: number } {
  const psd = powerSpectrum(x, 8192);
  const size = (psd.length - 1) * 2;
  const freqs = [] as number[];
  for (let f = 40; f < sr / 2 * 0.95; f *= Math.pow(2, 1 / 6)) freqs.push(f);
  const lvl = freqs.map((f) => 10 * Math.log10(bandPower(psd, sr, f / Math.pow(2, 1 / 6), f * Math.pow(2, 1 / 6)) / Math.max(1, (f * 0.23 * size) / sr) + 1e-30));
  const max = Math.max(...lvl);
  const iMax = lvl.indexOf(max);
  let lo = freqs[0], hi = freqs[freqs.length - 1];
  for (let i = iMax; i >= 0; i--) if (lvl[i] < max - dropDb) { lo = freqs[i]; break; }
  for (let i = iMax; i < lvl.length; i++) if (lvl[i] < max - dropDb) { hi = freqs[i]; break; }
  return { lo, hi };
}

/** RMS envelope in dBFS, one value per `hopMs` over a `winMs` window */
export function rmsEnvelope(x: Float32Array, sr: number, winMs = 50, hopMs = 10): Float32Array {
  const w = Math.max(1, Math.round((winMs / 1000) * sr));
  const h = Math.max(1, Math.round((hopMs / 1000) * sr));
  const out = new Float32Array(Math.max(0, Math.floor((x.length - w) / h) + 1));
  for (let k = 0; k < out.length; k++) {
    let acc = 0;
    for (let i = k * h; i < k * h + w; i++) acc += x[i] * x[i];
    out[k] = 10 * Math.log10(acc / w + 1e-20);
  }
  return out;
}

/** the mono sum of a pair of channels */
export function mono(chs: Channels): Float32Array {
  const out = new Float32Array(chs[0].length);
  for (const c of chs) for (let i = 0; i < c.length; i++) out[i] += c[i] / chs.length;
  return out;
}

/** time (s) of the first sample above `thresholdDb` dBFS (after `fromSec`), or NaN */
export function onset(x: Float32Array, sr: number, thresholdDb: number, fromSec = 0): number {
  const thr = Math.pow(10, thresholdDb / 20);
  for (let i = Math.floor(fromSec * sr); i < x.length; i++) if (Math.abs(x[i]) >= thr) return i / sr;
  return NaN;
}

/** lag (samples, b relative to a) that maximises the cross-correlation within +-maxLag */
export function xcorrLag(a: Float32Array, b: Float32Array, maxLag: number): number {
  let best = 0, bestV = -Infinity;
  const n = Math.min(a.length, b.length);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) acc += a[i] * b[i + lag];
    if (acc > bestV) {
      bestV = acc;
      best = lag;
    }
  }
  return best;
}
