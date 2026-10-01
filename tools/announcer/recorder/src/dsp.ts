/**
 * Pure audio maths for the recorder: levels, silence trimming, quality checks, voice-activity detection and WAV encode/decode.
 * No DOM, no Web Audio: runs in the browser, in vitest and in the e2e checks.
 */

export const dbfs = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

export interface Levels {
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
}

export function levels(buf: ArrayLike<number>, from = 0, to = buf.length): Levels {
  let peak = 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = buf[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = to > from ? Math.sqrt(sum / (to - from)) : 0;
  return { peak, peakDb: dbfs(peak), rms, rmsDb: dbfs(rms) };
}

/** RMS in dBFS per hop-sized frame (window = 2.5 hops would smear; we use non-overlapping `hopMs` frames). */
export function frameDb(samples: Float32Array, rate: number, hopMs = 10): Float64Array {
  const hop = Math.max(1, Math.round((rate * hopMs) / 1000));
  const n = Math.floor(samples.length / hop);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) out[f] = levels(samples, f * hop, (f + 1) * hop).rmsDb;
  return out;
}

const percentile = (a: Float64Array, p: number): number => {
  if (!a.length) return -120;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export interface Analysis {
  rate: number;
  durationS: number;
  peakDb: number;
  /** average level of the speech frames */
  speechRmsDb: number;
  /** level of the quiet frames (or of the room tone, when one is given) */
  noiseDb: number;
  snrDb: number;
  /** samples at/near full scale, and the longest run of them */
  clippedSamples: number;
  clipRun: number;
  /** first/last speech sample index (inclusive start, exclusive end); -1 when no speech was found */
  speechStart: number;
  speechEnd: number;
  speechS: number;
  /** speech is already going at the very first / still going at the very last 40 ms of the buffer */
  startsCut: boolean;
  endsCut: boolean;
}

export interface AnalyzeOptions {
  /** noise floor from a room tone capture, dBFS (RMS) */
  roomToneDb?: number;
  hopMs?: number;
}

/**
 * Finds the speech. Threshold = the larger of "noise + 10 dB" and "loudest speech - 45 dB"; a speech run needs at least 40 ms,
 * and runs separated by less than 400 ms of quiet count as one utterance (breaths and stop consonants are not gaps).
 */
export function analyze(samples: Float32Array, rate: number, opts: AnalyzeOptions = {}): Analysis {
  const hopMs = opts.hopMs ?? 10;
  const hop = Math.max(1, Math.round((rate * hopMs) / 1000));
  const db = frameDb(samples, rate, hopMs);
  const lv = levels(samples);
  // noise: the room tone if we have it, otherwise the 10th percentile of the take's own frames (there is always some quiet in a take)
  const noiseDb = opts.roomToneDb ?? percentile(db, 0.1);
  const maxFrame = db.length ? Math.max(...db) : -120;
  const thr = Math.max(noiseDb + 10, maxFrame - 45, -70);
  const minRun = Math.ceil(40 / hopMs);
  const bridge = Math.ceil(400 / hopMs);
  // runs of active frames
  const runs: [number, number][] = [];
  let s = -1;
  for (let f = 0; f <= db.length; f++) {
    const on = f < db.length && db[f] >= thr;
    if (on && s < 0) s = f;
    else if (!on && s >= 0) {
      if (f - s >= minRun) runs.push([s, f]);
      s = -1;
    }
  }
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= bridge) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  let start = -1;
  let end = -1;
  if (merged.length) {
    start = merged[0][0] * hop;
    end = merged[merged.length - 1][1] * hop;
  }
  let sum = 0;
  let cnt = 0;
  for (const [a, b] of merged) for (let f = a; f < b; f++) {
    sum += 10 ** (db[f] / 10);
    cnt++;
  }
  const speechRmsDb = cnt ? 10 * Math.log10(sum / cnt) : -120;
  // clipping: samples at (or within ~0.1 dB of) full scale, in runs
  const limit = 0.989;
  let clipped = 0;
  let run = 0;
  let longest = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= limit) {
      clipped++;
      run++;
      if (run > longest) longest = run;
    } else run = 0;
  }
  const guard = Math.ceil(40 / hopMs);
  const startsCut = merged.length > 0 && merged[0][0] < 1 && db.length > guard && db.slice(0, guard).every((d) => d >= thr);
  const endsCut = merged.length > 0 && db.length > guard && db.slice(db.length - guard).every((d) => d >= thr);
  return {
    rate,
    durationS: samples.length / rate,
    peakDb: lv.peakDb,
    speechRmsDb,
    noiseDb,
    snrDb: speechRmsDb - noiseDb,
    clippedSamples: clipped,
    clipRun: longest,
    speechStart: start,
    speechEnd: end,
    speechS: start >= 0 ? (end - start) / rate : 0,
    startsCut,
    endsCut,
  };
}

export interface TrimResult {
  samples: Float32Array;
  /** where the kept region sits in the input */
  from: number;
  to: number;
  padHeadS: number;
  padTailS: number;
}

/** Cuts the take to the speech plus `padMs` of room at each end (clamped to what was recorded), with a 5 ms fade at both cut edges. */
export function trim(samples: Float32Array, rate: number, a: Analysis, padMs = 200): TrimResult {
  if (a.speechStart < 0) return { samples, from: 0, to: samples.length, padHeadS: 0, padTailS: 0 };
  const pad = Math.round((rate * padMs) / 1000);
  const from = Math.max(0, a.speechStart - pad);
  const to = Math.min(samples.length, a.speechEnd + pad);
  const out = samples.slice(from, to);
  const fade = Math.min(Math.round(rate * 0.005), out.length >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  return { samples: out, from, to, padHeadS: (a.speechStart - from) / rate, padTailS: (to - a.speechEnd) / rate };
}

export type Status = 'ok' | 'warn' | 'fail';
export interface Check {
  id: 'clipping' | 'level' | 'noise' | 'length' | 'start' | 'end' | 'speech';
  status: Status;
  label: string;
  detail: string;
}
export interface Qc {
  status: Status;
  checks: Check[];
}

export const QC_LIMITS = {
  /** peak above this = clipped (dBFS) */
  clipPeakDb: -0.3,
  clipRun: 3,
  /** speech peak: warn below, fail below */
  quietWarnDb: -18,
  quietFailDb: -30,
  /** noise floor above this (dBFS RMS) = noisy room */
  noiseWarnDb: -55,
  noiseFailDb: -45,
  snrWarnDb: 35,
  snrFailDb: 25,
  /** take length compared to the script's estimate */
  lengthRatioLo: 0.4,
  lengthRatioHi: 2.8,
  minSpeechS: 0.25,
};

/** Quality checks on one take. `expectedS` is the script's estimated spoken length (including its padding). */
export function qc(a: Analysis, expectedS: number): Qc {
  const L = QC_LIMITS;
  const checks: Check[] = [];
  const add = (id: Check['id'], status: Status, label: string, detail: string) => checks.push({ id, status, label, detail });

  if (a.speechStart < 0 || a.speechS < L.minSpeechS) {
    add('speech', 'fail', 'No speech', 'Nothing loud enough was heard. Check the mic, the level meter and that you spoke after the countdown.');
  } else add('speech', 'ok', 'Speech found', `${a.speechS.toFixed(1)} s of speech`);

  if (a.peakDb >= L.clipPeakDb || a.clipRun >= L.clipRun) add('clipping', 'fail', 'Clipping', `Peak ${a.peakDb.toFixed(1)} dBFS, ${a.clippedSamples} samples at full scale. Turn the mic gain down or speak further away.`);
  else add('clipping', 'ok', 'No clipping', `Peak ${a.peakDb.toFixed(1)} dBFS`);

  if (a.speechStart >= 0) {
    if (a.peakDb < L.quietFailDb) add('level', 'fail', 'Too quiet', `Peak ${a.peakDb.toFixed(1)} dBFS. Raise the mic gain or move closer.`);
    else if (a.peakDb < L.quietWarnDb) add('level', 'warn', 'A bit quiet', `Peak ${a.peakDb.toFixed(1)} dBFS (aim for -12 to -3).`);
    else add('level', 'ok', 'Level good', `Peak ${a.peakDb.toFixed(1)} dBFS`);

    if (a.noiseDb > L.noiseFailDb || a.snrDb < L.snrFailDb) add('noise', 'fail', 'Too noisy', `Noise floor ${a.noiseDb.toFixed(0)} dBFS, ${a.snrDb.toFixed(0)} dB above it. Find a quieter spot.`);
    else if (a.noiseDb > L.noiseWarnDb || a.snrDb < L.snrWarnDb) add('noise', 'warn', 'Some noise', `Noise floor ${a.noiseDb.toFixed(0)} dBFS, speech ${a.snrDb.toFixed(0)} dB above it.`);
    else add('noise', 'ok', 'Quiet room', `Noise floor ${a.noiseDb.toFixed(0)} dBFS (${a.snrDb.toFixed(0)} dB SNR)`);

    const ratio = a.speechS / Math.max(0.5, expectedS - 0.9);
    if (ratio < L.lengthRatioLo) add('length', 'warn', 'Short', `${a.speechS.toFixed(1)} s, the script expected about ${Math.max(0.5, expectedS - 0.9).toFixed(1)} s. Did you say the whole line?`);
    else if (ratio > L.lengthRatioHi) add('length', 'warn', 'Long', `${a.speechS.toFixed(1)} s, the script expected about ${Math.max(0.5, expectedS - 0.9).toFixed(1)} s. Stumble or long pause?`);
    else add('length', 'ok', 'Length fine', `${a.speechS.toFixed(1)} s`);

    if (a.startsCut) add('start', 'fail', 'Start cut off', 'Speech was already going when the take began. Wait for the countdown.');
    else add('start', 'ok', 'Clean start', 'Room before the first word');
    if (a.endsCut) add('end', 'fail', 'End cut off', 'The take stopped while you were still speaking. Let the last word finish and the sound die away before stopping.');
    else add('end', 'ok', 'Clean end', 'Room after the last word');
  }
  const status: Status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { status, checks };
}

/** Voice activity for hands-free recording: speech starts after `onsetMs` above the threshold, ends after `silenceMs` below it. */
export class Vad {
  state: 'idle' | 'speech' = 'idle';
  private above = 0;
  private below = 0;
  constructor(private thresholdDb: number, private onsetMs = 120, private silenceMs = 1100) {}
  setThreshold(db: number) {
    this.thresholdDb = db;
  }
  /** Feed one level reading covering `ms` of audio. Returns 'start' / 'end' on a transition. */
  push(levelDb: number, ms: number): 'start' | 'end' | null {
    if (levelDb >= this.thresholdDb) {
      this.above += ms;
      this.below = 0;
    } else {
      this.below += ms;
      if (this.state === 'idle') this.above = 0;
    }
    if (this.state === 'idle' && this.above >= this.onsetMs) {
      this.state = 'speech';
      return 'start';
    }
    if (this.state === 'speech' && this.below >= this.silenceMs) {
      this.state = 'idle';
      this.above = 0;
      return 'end';
    }
    return null;
  }
  reset() {
    this.state = 'idle';
    this.above = 0;
    this.below = 0;
  }
}

/** Mono WAV (PCM) as bytes. 16-bit gets TPDF dither; 24-bit does not need it. */
export function encodeWav(samples: Float32Array, rate: number, bits: 16 | 24 = 16): ArrayBuffer {
  const bytes = bits / 8;
  const dataLen = samples.length * bytes;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * bytes, true);
  v.setUint16(32, bytes, true);
  v.setUint16(34, bits, true);
  w(36, 'data');
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    let x = Math.max(-1, Math.min(1, samples[i]));
    if (bits === 16) {
      x = x * 32767 + (Math.random() - Math.random());
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x))), true);
    } else {
      const n = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
      v.setUint8(o, n & 0xff);
      v.setUint8(o + 1, (n >> 8) & 0xff);
      v.setUint8(o + 2, (n >> 16) & 0xff);
    }
    o += bytes;
  }
  return buf;
}

export interface Decoded {
  samples: Float32Array;
  rate: number;
  channels: number;
  bits: number;
}

/** PCM 16/24/32 and float32 WAV, any channel count (mixed down to mono). Throws on anything else. */
export function decodeWav(buf: ArrayBuffer): Decoded {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = 1, channels = 1, rate = 0, bits = 16;
  let data = -1, dataLen = 0;
  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = v.getUint16(o + 8, true);
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
      if (fmt === 0xfffe) fmt = v.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE: sub-format code
    } else if (id === 'data') {
      data = o + 8;
      dataLen = Math.min(len, buf.byteLength - data);
      break;
    }
    o += 8 + len + (len & 1);
  }
  if (data < 0 || !rate) throw new Error('WAV has no audio data');
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = data + (i * channels + c) * bps;
      let x: number;
      if (fmt === 3 && bits === 32) x = v.getFloat32(o, true);
      else if (fmt === 1 && bits === 16) x = v.getInt16(o, true) / 32768;
      else if (fmt === 1 && bits === 24) x = (((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) >> 8) / 8388608;
      else if (fmt === 1 && bits === 32) x = v.getInt32(o, true) / 2147483648;
      else throw new Error(`unsupported WAV format ${fmt}/${bits}-bit`);
      acc += x;
    }
    out[i] = acc / channels;
  }
  return { samples: out, rate, channels, bits };
}

/** Linear-interpolation resampler for the import path when decodeAudioData is not available (tests); the browser uses OfflineAudioContext. */
export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * k;
    const i0 = Math.floor(p);
    const f = p - i0;
    out[i] = x[i0] * (1 - f) + (x[Math.min(i0 + 1, x.length - 1)] ?? 0) * f;
  }
  return out;
}

export const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
