/**
 * The promo's music bed, written as code (no samples, no existing songs): a driving 120 BPM ballpark-rock cue in A minor, i-VI-III-VII,
 * with a stadium-organ lead, brass-like stabs, kick / snare / claps / hats, bass, a riser into the drop, and a separate stem of produced
 * effects (impacts, booms, whooshes, reverse crashes) placed on the edit's cuts. Rendered offline here (pure DSP, deterministic), so the
 * user can swap in another track: the music is its own stem.
 *
 * The plan comes from the edit (`edit.ts`): sections by bar, the hits, and the places the band drops out (the slow-motion contact).
 */
import { Biquad, Osc, SR, adsr, dbGain, midiHz, mixIn, reverb, rng, sat, stereo, type Stereo } from './dsp';

export type Section = 'intro' | 'title' | 'build' | 'lift' | 'drop' | 'break' | 'climax' | 'outro';
export interface MusicPlan {
  bpm: number;
  seconds: number;
  /** consecutive sections, in bars of 4 beats */
  sections: { kind: Section; bars: number }[];
  /** produced effects on the timeline (seconds) */
  hits: { t: number; kind: 'impact' | 'boom' | 'whoosh' | 'revcrash' | 'riser' | 'tick'; gain?: number; len?: number }[];
  /** the band stops (seconds): everything but the pad tail and the effects */
  stops: { t0: number; t1: number }[];
}

const CHORDS: number[][] = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 52, 55], // C (low voicing 48 = C3)
  [55, 59, 62], // G
];
const ROOTS = [33, 29, 36, 31]; // A1 F1 C2 G1 (bass)

// ---- instruments: each renders one event into a mono buffer --------------------------------------------------------------------
function kick(gain = 1): Float32Array {
  const n = Math.round(0.5 * SR), o = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t * 28);
    ph += f / SR;
    const env = Math.exp(-t * 7.5);
    o[i] = (Math.sin(2 * Math.PI * ph) * env + (t < 0.004 ? (1 - t / 0.004) * 0.6 : 0)) * gain;
  }
  return o;
}
function snare(r: () => number, gain = 1): Float32Array {
  const n = Math.round(0.35 * SR), o = new Float32Array(n);
  const bp = new Biquad('bp', 2200, 0.7), hp = new Biquad('hp', 900);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (185 - 40 * t) / SR;
    o[i] = (hp.run(bp.run(r())) * 2.4 * Math.exp(-t * 16) + Math.sin(2 * Math.PI * ph) * 0.55 * Math.exp(-t * 26)) * gain;
  }
  return o;
}
function clap(r: () => number, gain = 1): Float32Array {
  const n = Math.round(0.3 * SR), o = new Float32Array(n);
  const bp = new Biquad('bp', 1300, 1.2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = Math.exp(-t * 22);
    for (const d of [0, 0.011, 0.023]) if (t >= d && t < d + 0.008) e = Math.max(e, 1 - (t - d) / 0.008);
    o[i] = bp.run(r()) * e * 3 * gain;
  }
  return o;
}
function hat(r: () => number, open: boolean, gain = 1): Float32Array {
  const n = Math.round((open ? 0.35 : 0.06) * SR), o = new Float32Array(n);
  const hp = new Biquad('hp', 7500, 0.8), pk = new Biquad('peak', 10500, 2, 6);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    o[i] = pk.run(hp.run(r())) * Math.exp(-t * (open ? 9 : 70)) * 0.6 * gain;
  }
  return o;
}
function crash(r: () => number, len = 2.6, gain = 1, reverse = false): Float32Array {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const hp = new Biquad('hp', 4200, 0.6);
  const ring = [3150, 4373, 5911, 7342].map((f) => ({ f, ph: 0 }));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let m = 0;
    for (const q of ring) {
      q.ph += q.f / SR;
      m += (q.ph % 1) < 0.5 ? 1 : -1;
    }
    o[i] = hp.run(r() * 0.8 + m * 0.07) * Math.exp(-t * (3.2 / len) * 1.6) * gain * 0.5;
  }
  if (reverse) o.reverse();
  return o;
}
/** bass: saw + sub through an enveloped low-pass */
function bass(note: number, len: number, gain = 1): Float32Array {
  const n = Math.round((len + 0.08) * SR), o = new Float32Array(n);
  const s1 = new Osc('saw'), s2 = new Osc('saw', 0.3), sub = new Osc('sine');
  const lp = new Biquad('lp', 400, 1.1);
  const f = midiHz(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 32 === 0) lp.set(180 + 1100 * Math.exp(-t * 14), 1.1);
    const env = adsr(t, len, 0.004, 0.08, 0.75, 0.06);
    o[i] = (sat(lp.run(s1.next(f) * 0.5 + s2.next(f * 1.004) * 0.5), 1.8) * 0.7 + sub.next(f) * 0.6) * env * gain;
  }
  return o;
}
/** stadium organ: drawbars (16' 8' 5 1/3' 4' 2 2/3' 2') with a Leslie (amplitude + pitch wobble) and a little overdrive */
function organ(notes: number[], len: number, gain = 1, leslieHz = 6.4, perc = true): Float32Array {
  const n = Math.round((len + 0.15) * SR), o = new Float32Array(n);
  const bars: [number, number][] = [[0.5, 0.6], [1, 1], [1.5, 0.55], [2, 0.65], [3, 0.35], [4, 0.4], [6, 0.12]];
  const ph = notes.map(() => bars.map(() => Math.random() * 0));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = adsr(t, len, 0.006, 0.05, 0.92, 0.09);
    const wob = 1 + 0.0025 * Math.sin(2 * Math.PI * leslieHz * t);
    let v = 0;
    notes.forEach((m, k) => {
      const f = midiHz(m) * wob;
      bars.forEach(([h, a], j) => {
        ph[k][j] += (f * h) / SR;
        v += Math.sin(2 * Math.PI * ph[k][j]) * a;
      });
      // key-click percussion on the 2 2/3' harmonic
      if (perc) v += Math.sin(2 * Math.PI * ph[k][4] * 1.0) * 0.5 * Math.exp(-t * 14);
    });
    const am = 0.82 + 0.18 * Math.sin(2 * Math.PI * leslieHz * t + 1.3);
    o[i] = sat(v * 0.16, 1.6) * env * am * gain;
  }
  return o;
}
/** brass-like stab: stacked detuned saws through a fast-opening low-pass */
function brass(notes: number[], len: number, gain = 1): Float32Array {
  const n = Math.round((len + 0.2) * SR), o = new Float32Array(n);
  const voices = notes.flatMap((m) => [-0.08, 0, 0.07].map((d) => ({ f: midiHz(m + d), osc: new Osc('saw', Math.abs(d) * 3) })));
  const lp = new Biquad('lp', 600, 1.4);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 32 === 0) lp.set(500 + 3800 * Math.min(1, t / 0.05) * Math.exp(-t * 3.2), 1.4);
    let v = 0;
    for (const q of voices) v += q.osc.next(q.f);
    o[i] = sat(lp.run(v / voices.length) * 2.2, 1.4) * adsr(t, len, 0.02, 0.12, 0.6, 0.12) * gain;
  }
  return o;
}
/** pad: wide detuned saws, slow attack, dark */
function pad(notes: number[], len: number, gain = 1): Float32Array {
  const n = Math.round((len + 1.2) * SR), o = new Float32Array(n);
  const voices = notes.flatMap((m) => [-0.12, 0.05, 0.13].map((d, k) => ({ f: midiHz(m + d), osc: new Osc('saw', k * 0.31) })));
  const lp = new Biquad('lp', 900, 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const q of voices) v += q.osc.next(q.f);
    o[i] = lp.run(v / voices.length) * adsr(t, len, 0.9, 0.5, 0.85, 1.1) * gain;
  }
  return o;
}
function riser(r: () => number, len: number, gain = 1): Float32Array {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const bp = new Biquad('bp', 300, 2);
  const s = new Osc('saw');
  for (let i = 0; i < n; i++) {
    const t = i / SR, u = t / len;
    if (i % 32 === 0) bp.set(250 * Math.pow(40, u), 2.5);
    o[i] = (bp.run(r()) * 1.8 + s.next(110 * Math.pow(8, u)) * 0.12 * u) * Math.pow(u, 1.6) * gain;
  }
  return o;
}
function impact(r: () => number, gain = 1, boomy = false): Float32Array {
  const n = Math.round((boomy ? 3.2 : 1.6) * SR), o = new Float32Array(n);
  const lp = new Biquad('lp', 2400, 0.7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = (boomy ? 34 : 48) + 90 * Math.exp(-t * 12);
    ph += f / SR;
    o[i] = (Math.sin(2 * Math.PI * ph) * Math.exp(-t * (boomy ? 1.3 : 3.2)) * 1.1 + lp.run(r()) * Math.exp(-t * 18) * 0.8) * gain;
  }
  return o;
}
function whoosh(r: () => number, len = 0.7, gain = 1): Float32Array {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const bp = new Biquad('bp', 400, 1.2);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if (i % 32 === 0) bp.set(300 + 5200 * Math.sin(Math.PI * u) ** 2, 1.4);
    o[i] = bp.run(r()) * Math.sin(Math.PI * u) ** 1.6 * 2.2 * gain;
  }
  return o;
}

// ---- the arrangement --------------------------------------------------------------------------------------------------------------
export function renderMusic(plan: MusicPlan): { music: Stereo; drums: Stereo; fx: Stereo } {
  const beat = 60 / plan.bpm, bar = beat * 4;
  const music = stereo(plan.seconds + 4), drums = stereo(plan.seconds + 4), fx = stereo(plan.seconds + 4);
  const r = rng(20261014);
  const stopped = (t: number) => plan.stops.some((s) => t >= s.t0 - 0.02 && t < s.t1);
  // the organ lead (original): a call-and-answer stadium figure over the four chords, A minor pentatonic + the chord tones
  const LEAD: [number, number, number][][] = [
    [[0, 0.5, 69], [0.5, 0.5, 72], [1, 0.5, 74], [1.5, 1, 76], [3, 0.5, 74], [3.5, 0.5, 72]],
    [[0, 1, 72], [1, 0.5, 69], [1.5, 0.5, 72], [2, 1.5, 77], [3.5, 0.5, 76]],
    [[0, 0.5, 76], [0.5, 0.5, 79], [1, 1, 76], [2, 0.5, 74], [2.5, 0.5, 72], [3, 1, 74]],
    [[0, 0.5, 74], [0.5, 0.5, 76], [1, 0.5, 79], [1.5, 0.5, 81], [2, 2, 83]],
  ];
  let t0 = 0;
  let barIndex = 0;
  for (const sec of plan.sections) {
    for (let b = 0; b < sec.bars; b++, barIndex++) {
      const tb = t0 + b * bar;
      const ci = barIndex % 4;
      const chord = CHORDS[ci];
      const last = b === sec.bars - 1;
      const k = sec.kind;
      // pads under everything but the drop's busiest bars
      if (k === 'intro' || k === 'title' || k === 'break' || k === 'outro') mixIn(music, pad(k === 'intro' || k === 'title' ? [45, 52, 57, 60] : chord.map((m) => m - 12), bar, 0.22), tb, 1, 0);
      if (k === 'build' || k === 'lift' || k === 'climax') mixIn(music, pad(chord.map((m) => m - 12), bar, 0.12), tb, 1, 0);
      // a soft heartbeat in the intro's second half
      if (k === 'intro' && b >= sec.bars / 2) for (const off of [0, beat * 0.35]) mixIn(drums, kick(0.35), tb + off, 1, 0);
      if (k === 'intro' && b === 1) mixIn(music, organ([57, 60, 64, 69], bar * 2, 0.18, 0.8, false), tb, 1, 0.1);
      // drums
      if (k === 'build' || k === 'lift' || k === 'drop' || k === 'climax') {
        for (let q = 0; q < 4; q++) {
          const tq = tb + q * beat;
          if (stopped(tq)) continue;
          const four = k === 'drop' || k === 'climax' || (k === 'lift' && b >= 1);
          if (four || q === 0 || q === 2) mixIn(drums, kick(1), tq, 0.9, 0);
          if (q === 1 || q === 3) {
            mixIn(drums, snare(r, k === 'build' ? 0.6 : 0.85), tq, 0.8, 0.05);
            mixIn(drums, clap(r, 0.6), tq + 0.004, 0.7, -0.1);
          }
          const sub = k === 'drop' || k === 'climax' ? 4 : 2;
          for (let h = 0; h < sub; h++) mixIn(drums, hat(r, h === sub / 2 && (k === 'drop' || k === 'climax'), h % 2 ? 0.45 : 0.8), tq + (h * beat) / sub, 0.6, 0.35);
        }
        if (b === 0) mixIn(drums, crash(r, 2.4, k === 'drop' || k === 'climax' ? 1 : 0.6), tb, 0.7, -0.25);
        // a snare roll into the next section
        if (last && (k === 'build' || k === 'lift')) for (let s = 0; s < 8; s++) mixIn(drums, snare(r, 0.25 + s * 0.07), tb + bar / 2 + (s * bar) / 16, 0.7, 0.05);
      }
      // bass: eighths in build / lift / climax, driving octaves in the drop
      if (k === 'build' || k === 'lift' || k === 'drop' || k === 'climax') {
        for (let e = 0; e < 8; e++) {
          const te = tb + (e * beat) / 2;
          if (stopped(te)) continue;
          const note = ROOTS[ci] + (k === 'drop' && e % 2 ? 12 : 0);
          mixIn(music, bass(note, beat / 2 - 0.03, k === 'build' ? 0.45 : 0.55), te, 1, 0);
        }
      }
      // brass stabs on the chord changes (and the "and" of 2 in the drop)
      if (k === 'lift' || k === 'drop' || k === 'climax') {
        const voicing = chord.map((m) => m + 12);
        if (!stopped(tb)) mixIn(music, brass(voicing, beat * 0.45, 0.32), tb, 1, -0.2);
        if (k !== 'lift' && !stopped(tb + beat * 1.5)) mixIn(music, brass(voicing, beat * 0.3, 0.26), tb + beat * 1.5, 1, 0.2);
      }
      // the organ lead in the drop and the climax; offbeat organ chops in the build
      if (k === 'drop' || k === 'climax') {
        for (const [st, ln, m] of LEAD[ci]) if (!stopped(tb + st * beat)) mixIn(music, organ([m, m + 12], ln * beat * 0.92, 0.3), tb + st * beat, 1, 0.15);
      }
      if (k === 'build') for (let q = 0; q < 4; q++) if (!stopped(tb + (q + 0.5) * beat)) mixIn(music, organ(chord.map((m) => m + 12), beat * 0.22, 0.18), tb + (q + 0.5) * beat, 1, 0.25);
      if (k === 'outro' && b === 0) mixIn(music, organ([57, 64, 69, 72, 76], bar * 2.5, 0.3, 5.5), tb, 1, 0);
    }
    t0 += sec.bars * bar;
  }
  // produced effects
  for (const h of plan.hits) {
    const g = h.gain ?? 1;
    if (h.kind === 'impact') mixIn(fx, impact(r, g), h.t, 1, 0);
    if (h.kind === 'boom') mixIn(fx, impact(r, g, true), h.t, 1, 0);
    if (h.kind === 'whoosh') mixIn(fx, whoosh(r, h.len ?? 0.6, g), h.t - (h.len ?? 0.6) * 0.6, 1, 0);
    if (h.kind === 'revcrash') {
      const len = h.len ?? 1.6;
      mixIn(fx, crash(r, len, g, true), h.t - len, 1, 0);
    }
    if (h.kind === 'riser') {
      const len = h.len ?? 4;
      mixIn(fx, riser(r, len, g), h.t - len, 1, 0);
    }
    if (h.kind === 'tick') mixIn(fx, hat(r, false, g * 1.4), h.t, 1, 0);
  }
  // space: the band in a hall, the drums drier, the effects big
  const wetMusic = reverb(music, { room: 0.8, damp: 0.4, wet: 0.22 });
  const wetDrums = reverb(drums, { room: 0.7, damp: 0.5, wet: 0.12 });
  const wetFx = reverb(fx, { room: 0.88, damp: 0.3, wet: 0.35 });
  // a little glue: duck the music under the kick (sidechain feel)
  const kickEnv = new Float32Array(wetMusic[0].length);
  {
    let e = 0;
    const att = Math.exp(-1 / (0.002 * SR)), rel = Math.exp(-1 / (0.12 * SR));
    for (let i = 0; i < kickEnv.length; i++) {
      const x = Math.abs(drums[0][i]) + Math.abs(drums[1][i]);
      e = x > e ? x + (e - x) * att : x + (e - x) * rel;
      kickEnv[i] = e;
    }
  }
  for (let i = 0; i < wetMusic[0].length; i++) {
    const g = 1 / (1 + 0.35 * Math.min(3, kickEnv[i]));
    wetMusic[0][i] *= g;
    wetMusic[1][i] *= g;
  }
  void dbGain;
  return { music: wetMusic, drums: wetDrums, fx: wetFx };
}
