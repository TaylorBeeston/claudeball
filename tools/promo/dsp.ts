/**
 * Small offline DSP kit for the promo's music bed and produced effects (Node, plain Float32Arrays, deterministic): oscillators with
 * PolyBLEP, RBJ biquads, envelopes, a seeded noise source, a Freeverb-style reverb, a look-ahead true-peak limiter and WAV I/O.
 */
import fs from 'node:fs';

export const SR = 48000;
export type Stereo = [Float32Array, Float32Array];

export function stereo(seconds: number, sr = SR): Stereo {
  const n = Math.ceil(seconds * sr);
  return [new Float32Array(n), new Float32Array(n)];
}

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const dbGain = (db: number) => Math.pow(10, db / 20);

/** PolyBLEP saw / square at a (possibly moving) frequency */
export function polyblep(t: number, dt: number) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export class Osc {
  phase = 0;
  constructor(private kind: 'saw' | 'square' | 'sine' | 'tri', phase = 0) {
    this.phase = phase;
  }
  next(hz: number, sr = SR): number {
    const dt = hz / sr;
    const p = this.phase;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    switch (this.kind) {
      case 'sine':
        return Math.sin(2 * Math.PI * p);
      case 'tri':
        return 1 - 4 * Math.abs(p - 0.5);
      case 'square': {
        let v = p < 0.5 ? 1 : -1;
        v += polyblep(p, dt);
        v -= polyblep((p + 0.5) % 1, dt);
        return v;
      }
      default:
        return 2 * p - 1 - polyblep(p, dt);
    }
  }
}

/** RBJ biquad, coefficients settable per sample */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(public type: 'lp' | 'hp' | 'bp' | 'peak' | 'lshelf' | 'hshelf', f = 1000, q = 0.707, gainDb = 0, sr = SR) {
    this.set(f, q, gainDb, sr);
  }
  set(f: number, q = 0.707, gainDb = 0, sr = SR) {
    f = Math.min(Math.max(f, 10), sr * 0.45);
    const w = (2 * Math.PI * f) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'peak': b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
      case 'lshelf': {
        const r = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 - (A - 1) * c + r); b1 = 2 * A * (A - 1 - (A + 1) * c); b2 = A * (A + 1 - (A - 1) * c - r);
        a0 = A + 1 + (A - 1) * c + r; a1 = -2 * (A - 1 + (A + 1) * c); a2 = A + 1 + (A - 1) * c - r; break;
      }
      case 'hshelf': {
        const r = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 + (A - 1) * c + r); b1 = -2 * A * (A - 1 + (A + 1) * c); b2 = A * (A + 1 + (A - 1) * c - r);
        a0 = A + 1 - (A - 1) * c + r; a1 = 2 * (A - 1 - (A + 1) * c); a2 = A + 1 - (A - 1) * c - r; break;
      }
      default: b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** attack-decay(-sustain-release) envelope value at time t for a note of length `len` */
export function adsr(t: number, len: number, a: number, d: number, s: number, r: number) {
  if (t < 0) return 0;
  let v: number;
  if (t < a) v = t / a;
  else if (t < a + d) v = 1 - (1 - s) * ((t - a) / d);
  else v = s;
  if (t > len) v *= Math.max(0, 1 - (t - len) / r);
  return v;
}

/** add a mono signal into a stereo buffer at `t0` seconds with gain and pan (-1..1, equal power) */
export function mixIn(dst: Stereo, src: Float32Array, t0: number, gain = 1, pan = 0, sr = SR) {
  const o = Math.round(t0 * sr);
  const a = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * gain * Math.SQRT2, gr = Math.sin(a) * gain * Math.SQRT2;
  for (let i = 0; i < src.length; i++) {
    const k = o + i;
    if (k < 0 || k >= dst[0].length) continue;
    dst[0][k] += src[i] * gl;
    dst[1][k] += src[i] * gr;
  }
}

/** Freeverb-style stereo reverb (8 combs + 4 allpasses per side) */
export function reverb(input: Stereo, { room = 0.82, damp = 0.35, wet = 0.3, dry = 1, preDelay = 0.02 } = {}): Stereo {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round((n * SR) / 44100));
  const alls = [556, 441, 341, 225].map((n) => Math.round((n * SR) / 44100));
  const out: Stereo = [new Float32Array(input[0].length), new Float32Array(input[0].length)];
  const pd = Math.round(preDelay * SR);
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch ? 23 : 0;
    const cb = combs.map((n) => ({ buf: new Float32Array(n + spread), i: 0, store: 0 }));
    const ab = alls.map((n) => ({ buf: new Float32Array(n + spread), i: 0 }));
    const x = input[ch], y = out[ch];
    for (let s = 0; s < x.length; s++) {
      const inp = (s >= pd ? (input[0][s - pd] + input[1][s - pd]) * 0.5 : 0) * 0.015;
      let acc = 0;
      for (const c of cb) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = inp + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        acc += o;
      }
      for (const a of ab) {
        const o = a.buf[a.i];
        a.buf[a.i] = acc + o * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        acc = o - acc;
      }
      y[s] = x[s] * dry + acc * wet;
    }
  }
  return out;
}

/** gentle tanh saturation */
export const sat = (x: number, drive = 1.5) => Math.tanh(x * drive) / Math.tanh(drive);

/** per-sample true peak (4x oversampling, the same 48-tap windowed sinc as `src/audio/venue/analysis.ts` truePeak) */
const TP_TAPS = 48;
const TP_PHASES: Float32Array[] = [1, 2, 3].map((ph) => {
  const h = new Float32Array(TP_TAPS);
  for (let k = 0; k < TP_TAPS; k++) {
    const t = k - TP_TAPS / 2 + 1 - ph / 4;
    const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[k] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / TP_TAPS) + 0.08 * Math.cos((4 * Math.PI * (k + 0.5)) / TP_TAPS));
  }
  return h;
});
function interpPeak(x: Float32Array, i: number) {
  let m = Math.abs(x[i]);
  const half = TP_TAPS / 2;
  if (i < half || i + half >= x.length) return m;
  for (const h of TP_PHASES) {
    let acc = 0;
    for (let k = 0; k < TP_TAPS; k++) acc += h[k] * x[i - half + 1 + k];
    m = Math.max(m, Math.abs(acc));
  }
  return m;
}

/** look-ahead true-peak limiter: gain never lets the (4x interpolated) peak exceed `ceilingDb`; release in seconds */
export function limit(x: Stereo, ceilingDb = -1, lookahead = 0.005, release = 0.12): Stereo {
  const c = dbGain(ceilingDb);
  const n = x[0].length, la = Math.round(lookahead * SR);
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(interpPeak(x[0], i), interpPeak(x[1], i));
    need[i] = p > c ? c / p : 1;
  }
  // the gain at i is the minimum need over [i, i + la] (look-ahead), smoothed on the way up
  const g = new Float32Array(n);
  const rel = Math.exp(-1 / (release * SR));
  let cur = 1;
  const dq: number[] = [];
  for (let i = n - 1 + la; i >= 0; i--) {
    // sliding minimum via a monotone deque (indices into need), window [i, i+la]
    const j = i;
    if (j < n) {
      while (dq.length && need[dq[dq.length - 1]] >= need[j]) dq.pop();
      dq.push(j);
    }
    while (dq.length && dq[0] > i + la) dq.shift();
    if (i < n) g[i] = dq.length ? need[dq[0]] : 1;
  }
  // a box average of the window minimum over the look-ahead: a smooth attack that still reaches the needed gain at every peak
  const sm = new Float32Array(n);
  let acc = la; // the window starts full of unity gain
  for (let i = 0; i < n; i++) {
    acc += g[i] - (i >= la ? g[i - la] : 1);
    sm[i] = acc / la;
  }
  const out: Stereo = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const target = sm[i];
    cur = target < cur ? target : target + (cur - target) * rel;
    out[0][i] = x[0][i] * cur;
    out[1][i] = x[1][i] * cur;
  }
  return out;
}

export function readWav(file: string): { sr: number; ch: Float32Array[] } {
  const b = fs.readFileSync(file);
  let o = 12;
  let fmt = { ch: 2, sr: 48000, bits: 24, format: 1 };
  let data: Buffer | null = null;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4);
    const len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  if (!data) throw new Error(`no data in ${file}`);
  const bps = fmt.bits / 8;
  const n = Math.floor(data.length / (bps * fmt.ch));
  const ch = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++)
    for (let c = 0; c < fmt.ch; c++) {
      const p = (i * fmt.ch + c) * bps;
      ch[c][i] = fmt.format === 3 ? data.readFloatLE(p) : bps === 3 ? data.readIntLE(p, 3) / 8388608 : data.readInt16LE(p) / 32768;
    }
  return { sr: fmt.sr, ch };
}

/**
 * Where a speech track cut at `from + len` should end so that no word is cut: the window's end if it falls in a pause; else the start
 * of the first pause after it, if that comes within `slack` seconds; else the start of the last pause inside the window (each take
 * times its words differently, so a fixed length can land mid-word). A pause: at least `minPause` seconds of 20 ms blocks under
 * `floorDb` (shorter gaps fall between the words of a phrase); returns a length.
 */
export function speechEnd(x: Float32Array, from: number, len: number, { sr = SR, slack = 0.6, floorDb = -50, tail = 0.08, minPause = 0.15 } = {}): number {
  const blk = Math.round(0.02 * sr), floor = 10 ** (floorDb / 10), need = Math.ceil((minPause * sr) / blk);
  const end = from + len, n = Math.ceil((len + slack * sr) / blk) + need;
  // quiet[b]: block b (from `from`) is under the floor; past the end of the track counts as quiet
  const quiet = Array.from({ length: n }, (_, b) => {
    const i = from + b * blk;
    if (i >= x.length) return true;
    let s = 0;
    for (let k = i; k < i + blk; k++) s += k >= 0 && k < x.length ? x[k] * x[k] : 0;
    return s / blk < floor;
  });
  // the pauses: runs of quiet blocks at least `need` long, as [first block, last block]
  const pauses: [number, number][] = [];
  for (let b = 0; b < n; ) {
    if (!quiet[b]) { b++; continue; }
    let e = b;
    while (e + 1 < n && quiet[e + 1]) e++;
    if (e - b + 1 >= need || e === n - 1) pauses.push([b, e]);
    b = e + 1;
  }
  const at = (b: number) => Math.min(from + b * blk + Math.round(tail * sr), x.length) - from;
  const eb = Math.floor(len / blk);
  if (pauses.some(([b, e]) => b <= eb - 1 && e >= eb - 1)) return len;
  const after = pauses.find(([b]) => b >= eb && (b - eb) * blk <= slack * sr);
  if (after) return at(after[0]);
  const before = pauses.filter(([b, e]) => b > 0 && e < eb).pop();
  return before ? Math.min(at(before[0]), len) : len;
}
