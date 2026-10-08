/**
 * Procedural sound design. Every recipe renders into Float32Arrays (`Rendered`) with `dsp.ts`; `mixer.ts` turns them into
 * AudioBuffers once and reuses them. Recipes are deterministic per (id, bucket, alt), so a hit of the same kind always comes
 * from a small pool of variants (no per-hit allocation, no per-hit synthesis).
 *
 * Nothing here is sampled: bat, glove, dirt, fence and crowd sounds are built from noise, damped resonances and
 * formant-filtered voices. That keeps the repo licence-clean (MIT, no third-party audio) and the game never silent.
 */
import type { CrowdId, SfxId } from './types';
import * as F from './foley';
import {
  Biquad,
  addModes,
  addNoise,
  addThump,
  choir,
  claps,
  clamp,
  finish,
  makeLoop,
  mono,
  mulberry32,
  sweepNoise,
  VOWELS,
  type Rand,
  type Rendered,
} from './dsp';

export interface SoundDef {
  /** number of intensity buckets (a cue picks one), and random alternatives per bucket */
  buckets: number;
  alts: number;
  make(bucket: number, alt: number, r: Rand): Rendered;
}

const SR = 44100;
const buf = (dur: number, sr = SR) => new Float32Array(Math.floor(dur * sr));
const jit = (r: Rand, amt: number) => 1 + (r() * 2 - 1) * amt;

function firework(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(2.4);
  addThump(o, SR, { f0: 110, f1: 32, pitchTau: 0.12, tau: 0.35, amp: 1 });
  addNoise(o, SR, r, { tau: 0.12, amp: 0.7, lp: 900 });
  addNoise(o, SR, r, { tau: 0.01, amp: 0.8, hp: 600 });
  for (let k = 0; k < 90; k++) {
    const t0 = 0.35 + r() * 1.7;
    addNoise(o, SR, r, { t0, tau: 0.004 + r() * 0.01, amp: 0.25 * Math.exp(-(t0 - 0.35) / 1.0), hp: 2500 + r() * 2500 });
  }
  return finish(mono(SR, o), 0.8, 60);
}

function replayWhoosh(_b: number, _a: number, r: Rand): Rendered {
  const dur = 0.6;
  const x = sweepNoise(SR, dur, r, (t) => 300 + 5000 * Math.pow(t / dur, 2), (t) => Math.pow(Math.sin(Math.PI * clamp(t / dur, 0, 1)), 1.5), 0.9, 9000);
  return finish(mono(SR, x), 0.7, 30);
}

function paClick(_b: number, _a: number, r: Rand): Rendered {
  // a PA microphone being keyed: a soft pop plus a breath of room tone, nothing melodic
  const o = buf(0.3);
  addNoise(o, SR, r, { tau: 0.003, amp: 0.8, bp: 1500, q: 1 });
  addThump(o, SR, { f0: 140, f1: 90, pitchTau: 0.01, tau: 0.02, amp: 0.5 });
  addNoise(o, SR, r, { t0: 0.02, tau: 0.09, amp: 0.1, lp: 3200, hp: 300 }); // room tone tail
  return finish(mono(SR, o), 0.5);
}

// ---- broadcast stings (tasteful: air, wood and a little tone, nothing cheesy) ------------------------------------------------

function bfxWhoosh(_b: number, _a: number, r: Rand): Rendered {
  const dur = 0.55;
  const x = sweepNoise(SR, dur, r, (t) => 650 + 1900 * Math.sin(Math.PI * clamp(t / dur, 0, 1)) , (t) => Math.pow(Math.sin(Math.PI * clamp(t / dur, 0, 1)), 2), 0.7, 5200);
  return finish(mono(SR, x), 0.55, 40);
}

function bfxThunk(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.16);
  addThump(o, SR, { f0: 130, f1: 62, pitchTau: 0.025, tau: 0.045, amp: 0.8 });
  addNoise(o, SR, r, { tau: 0.004, amp: 0.25, hp: 1800, lp: 6000 });
  return finish(mono(SR, o), 0.5, 6);
}

function bfxReplay(_b: number, _a: number, r: Rand): Rendered {
  const dur = 0.95;
  const o = buf(dur);
  const sw = sweepNoise(SR, 0.62, r, (t) => 280 + 5200 * Math.pow(t / 0.62, 2), (t) => Math.pow(Math.sin(Math.PI * clamp(t / 0.62, 0, 1)), 1.4), 0.9, 8000);
  for (let i = 0; i < sw.length; i++) o[i] += sw[i] * 0.8;
  // a short rising tone under the whoosh: two stacked sines (octave) with a swelling envelope
  let ph1 = 0;
  let ph2 = 0;
  for (let i = 0; i < Math.floor(0.62 * SR); i++) {
    const t = i / SR;
    const f = 330 * Math.pow(2.2, t / 0.62);
    ph1 += (2 * Math.PI * f) / SR;
    ph2 += (2 * Math.PI * f * 2) / SR;
    const e = Math.pow(Math.sin(Math.PI * clamp(t / 0.62, 0, 1) * 0.9), 2);
    o[i] += (Math.sin(ph1) * 0.22 + Math.sin(ph2) * 0.08) * e;
  }
  addModes(o, SR, [[784, 0.22, 0.09], [1568, 0.08, 0.06]], 0.6);
  return finish(mono(SR, o), 0.6, 30);
}

function bfxBlip(_b: number, _a: number, _r: Rand): Rendered {
  const o = buf(0.2);
  addModes(o, SR, [[1480, 0.55, 0.03], [2960, 0.12, 0.02], [4440, 0.04, 0.015]], 0);
  return finish(mono(SR, o), 0.4, 6);
}

function bfxThump(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.9);
  addThump(o, SR, { f0: 78, f1: 38, pitchTau: 0.12, tau: 0.22, amp: 0.9 });
  addNoise(o, SR, r, { tau: 0.25, amp: 0.25, lp: 420, hp: 40 });
  return finish(mono(SR, o), 0.6, 60);
}

/** Fallback shout ("HEY!" / "Aah!") for when the browser has no speech synthesis: one voice, open vowel, falling pitch. */
function umpYell(_b: number, _a: number, r: Rand): Rendered {
  const sr = 22050;
  const c = choir(
    { sr, dur: 0.42, vowel: VOWELS.a, voices: 1, f0: (t) => 165 - 55 * t, env: (t) => (t < 0 ? 0 : Math.min(1, t / 0.02) * Math.exp(-Math.max(0, t - 0.12) / 0.14)), breath: 0.15, spread: 0 },
    r,
  );
  return finish({ sr, ch: [c.ch[0]] }, 0.8, 12);
}

// ---- crowd ------------------------------------------------------------------------------------------------------------

const CSR = 16000;

/** trapezoid envelope: attack `a`, hold, then a linear release `d` */
const trap = (a: number, hold: number, d: number) => (t: number) => {
  if (t < 0) return 0;
  if (t < a) return Math.pow(t / a, 1.5);
  if (t < a + hold) return 1;
  return Math.max(0, 1 - (t - a - hold) / d);
};

/** Broadband "shhh" of thousands of voices / hands, shaped by `env`. */
function hiss(c: Rendered, r: Rand, env: (t: number) => number, amp: number) {
  for (const ch of c.ch) {
    const bp = new Biquad('bp', 2600, 0.5, c.sr);
    const lp = new Biquad('lp', 5200, 0.7, c.sr);
    for (let i = 0; i < ch.length; i++) {
      const e = env(i / c.sr);
      if (e <= 0) continue;
      ch[i] += lp.tick(bp.tick(r() * 2 - 1)) * e * amp * 0.6;
    }
  }
}

const TAU_ = Math.PI * 2;

/** a pocket of conversation: a few syllabic voices, formants wandering, shaped by `env` */
function babble(dur: number, voices: number, env: (t: number) => number, r: Rand): Rendered {
  const n = Math.floor(dur * CSR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let k = 0; k < voices; k++) {
    const pan = r() * 2 - 1;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const f = [new Biquad(), new Biquad(), new Biquad()];
    const V = VOWELS[['a', 'o', 'e', 'u', 'i'][Math.floor(r() * 5)]];
    const shift = 0.85 + r() * 0.4;
    const am = new Biquad('lp', 3 + r() * 3, 0.7, CSR);
    const src = new Biquad('lp', 3500, 0.7, CSR);
    let ph = r();
    for (let i = 0; i < n; i++) {
      const e = env(i / CSR);
      if (e <= 0) continue;
      if ((i & 63) === 0) {
        const wob = 1 + 0.18 * Math.sin((i / CSR) * (1.1 + k * 0.17) + k);
        for (let j = 0; j < 3; j++) f[j].set('bp', V[j] * shift * wob, 5 + j * 2, CSR);
      }
      ph += (115 + 25 * k + 20 * Math.sin(i / CSR * 3 + k)) / CSR;
      if (ph >= 1) ph -= 1;
      const x = (2 * ph - 1) * 0.6 + src.tick(r() * 2 - 1) * 0.5;
      const a = Math.max(0, am.tick(r() * 2 - 1) * 5);
      const y = (f[0].tick(x) + 0.6 * f[1].tick(x) + 0.3 * f[2].tick(x)) * a * a * e;
      L[i] += y * gl;
      R[i] += y * gr;
    }
  }
  return { sr: CSR, ch: [L, R] };
}

const empty = (dur: number): Rendered => ({ sr: CSR, ch: [new Float32Array(Math.floor(CSR * dur)), new Float32Array(Math.floor(CSR * dur))] });

function crowdBuf(id: CrowdId, r: Rand): Rendered {
  switch (id) {
    case 'roar_big': {
      const dur = 6.5;
      const env = trap(0.5, 2.4, 3.3);
      const c = choir({ sr: CSR, dur, vowel: VOWELS.a, voices: 12, f0: (t) => 150 + 30 * Math.min(1, t / 1.5), env, breath: 0.5, stagger: 0.4, formantScale: (t) => 1 + 0.08 * Math.min(1, t / 1) }, r);
      hiss(c, r, env, 0.5);
      claps(c.ch, CSR, r, dur, (t) => (t > 1.5 ? 60 * trap(0, 1.5, 3.5)(t - 1.5) : 0), 0.16);
      return finish(c, 0.95, 40);
    }
    case 'roar_med': {
      const dur = 4;
      const env = trap(0.35, 1.2, 2.0);
      const c = choir({ sr: CSR, dur, vowel: VOWELS.a, voices: 12, f0: () => 160, env, breath: 0.5, stagger: 0.3 }, r);
      hiss(c, r, env, 0.35);
      claps(c.ch, CSR, r, dur, (t) => 40 * trap(0, 1, 2.2)(t), 0.13);
      return finish(c, 0.9, 40);
    }
    case 'cheer_short': {
      const dur = 2.6;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.a, voices: 10, f0: (t) => 170 + 25 * t, env: trap(0.2, 0.5, 1.6), breath: 0.45, stagger: 0.2 }, r);
      claps(c.ch, CSR, r, dur, (t) => 30 * trap(0, 0.6, 1.7)(t), 0.12);
      return finish(c, 0.9, 40);
    }
    case 'applause': {
      const dur = 4.2;
      const c = empty(dur);
      claps(c.ch, CSR, r, dur, (t) => 140 * trap(0.3, 1.9, 1.9)(t), 0.3);
      hiss(c, r, trap(0.3, 1.9, 1.9), 0.18);
      return finish(c, 0.85, 50);
    }
    case 'applause_small': {
      const dur = 2.2;
      const c = empty(dur);
      claps(c.ch, CSR, r, dur, (t) => 60 * trap(0.15, 0.7, 1.2)(t), 0.3);
      hiss(c, r, trap(0.15, 0.7, 1.2), 0.1);
      return finish(c, 0.8, 40);
    }
    case 'groan': {
      const dur = 2.2;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.o, voices: 12, f0: (t) => 190 - 55 * Math.min(1, t / 1.6), env: trap(0.25, 0.5, 1.4), breath: 0.3, stagger: 0.2, formantScale: (t) => 1 - 0.12 * Math.min(1, t / 1.8) }, r);
      return finish(c, 0.85, 40);
    }
    case 'gasp': {
      const dur = 0.9;
      const env = trap(0.12, 0.15, 0.55);
      const c = choir({ sr: CSR, dur, vowel: VOWELS.o, voices: 10, f0: (t) => 210 + 60 * t, env, breath: 0.85, stagger: 0.08, formantScale: (t) => 1 + 0.25 * t }, r);
      hiss(c, r, env, 0.35);
      return finish(c, 0.85, 30);
    }
    case 'ooh': {
      const dur = 1.7;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.u, voices: 10, f0: (t) => 200 + 45 * Math.min(1, t / 0.8) - 30 * Math.max(0, t - 0.9), env: trap(0.3, 0.4, 0.9), breath: 0.3, stagger: 0.2 }, r);
      return finish(c, 0.8, 40);
    }
    case 'boo': {
      const dur = 2.6;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.u, voices: 14, f0: (t) => 125 - 10 * t, env: trap(0.3, 1.1, 1.2), breath: 0.2, stagger: 0.3 }, r);
      return finish(c, 0.85, 40);
    }
    case 'swell': {
      const dur = 3.4;
      const env = (t: number) => (t < 0 ? 0 : Math.pow(Math.min(1, t / 2.6), 2) * Math.max(0, 1 - Math.max(0, t - 2.6) / 0.8));
      const c = choir({ sr: CSR, dur, vowel: VOWELS.a, voices: 12, f0: (t) => 165 + 35 * (t / dur), env, breath: 0.5, stagger: 0.3, formantScale: (t) => 0.9 + 0.2 * (t / dur) }, r);
      hiss(c, r, env, 0.3);
      return finish(c, 0.7, 60);
    }
    case 'clap_single': {
      const c = empty(0.16);
      claps(c.ch, CSR, r, 0.16, (t) => (t < 0.014 ? 700 : 0), 0.45);
      return finish(c, 0.8, 8);
    }
    case 'clap_burst': {
      const c = empty(0.3);
      claps(c.ch, CSR, r, 0.3, (t) => (t < 0.1 ? 380 : t < 0.2 ? 60 * (1 - (t - 0.1) / 0.1) : 0), 0.35);
      hiss(c, r, (t) => (t < 0.12 ? 0.6 : Math.max(0, 0.6 - (t - 0.12) * 4)), 0.08);
      return finish(c, 0.85, 12);
    }
    case 'whistle': {
      // a two-finger / mouth whistle: a pure bent tone with a little breath
      const dur = 0.95;
      const n = Math.floor(dur * CSR);
      const x = new Float32Array(n);
      let ph = 0;
      const lp = new Biquad('lp', 5500, 0.7, CSR);
      for (let i = 0; i < n; i++) {
        const t = i / CSR;
        const bend = t < 0.22 ? Math.pow(t / 0.22, 1.4) : 1 - 0.18 * Math.min(1, (t - 0.22) / 0.5);
        const f = 2350 + 750 * bend + 25 * Math.sin(t * 38);
        ph += f / CSR;
        const env = Math.min(1, t / 0.03) * Math.exp(-Math.max(0, t - 0.55) / 0.13);
        x[i] = (Math.sin(TAU_ * ph) * 0.9 + lp.tick(r() * 2 - 1) * 0.1) * env;
      }
      return finish({ sr: CSR, ch: [x, Float32Array.from(x)] }, 0.4, 20);
    }
    case 'shout':
    case 'shout2': {
      const a = id === 'shout';
      const c = choir({ sr: CSR, dur: 0.6, vowel: a ? VOWELS.a : VOWELS.e, voices: 1, f0: (t) => (a ? 185 + 40 * t : 200 + 50 * Math.sin(t * 5)), env: (t) => (t < 0 ? 0 : Math.min(1, t / 0.04) * Math.exp(-Math.max(0, t - 0.25) / 0.12)), breath: 0.25, spread: 0.7, formantScale: (t) => 1 + 0.2 * Math.min(1, t / 0.2) }, r);
      return finish(c, 0.75, 20);
    }
    case 'kid': {
      const c = choir({ sr: CSR, dur: 0.7, vowel: VOWELS.a, voices: 1, f0: (t) => 470 + 160 * Math.min(1, t / 0.25) - 90 * Math.max(0, t - 0.35), env: (t) => (t < 0 ? 0 : Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.3) / 0.16)), breath: 0.3, spread: 0.8, formantScale: (t) => 1.25 + 0.1 * t }, r);
      return finish(c, 0.65, 20);
    }
    case 'vendor': {
      // a long two-syllable call from the aisles, far away: dull, with a slap of room
      const dur = 1.9;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.a, voices: 1, f0: (t) => 165 + 35 * Math.sin(Math.min(1, t / 0.7) * Math.PI) - 25 * Math.max(0, t - 1.0), env: (t) => (t < 0 ? 0 : t < 0.8 ? Math.min(1, t / 0.08) * (0.7 + 0.3 * Math.sin((t / 0.8) * Math.PI)) : 0.9 * Math.min(1, (t - 0.85) / 0.06) * Math.exp(-Math.max(0, t - 1.05) / 0.35)), breath: 0.3, spread: 0.3, formantScale: (t) => 0.95 + 0.15 * (t > 0.85 ? 1 : 0) }, r);
      for (const ch of c.ch) {
        const lp = new Biquad('lp', 1700, 0.7, CSR);
        for (let i = 0; i < ch.length; i++) {
          ch[i] = lp.tick(ch[i]);
          if (i > 3600) ch[i] += 0.22 * ch[i - 3600]; // an echo off the far stands
        }
      }
      return finish(c, 0.5, 40);
    }
    case 'chatter': {
      const dur = 3.4;
      const env = (t: number) => (t < 0 ? 0 : Math.min(1, t / 0.7)) * Math.min(1, Math.max(0, dur - t) / 1.1);
      const c = babble(dur, 5, env, r);
      return finish(c, 0.5, 60);
    }
    case 'chant': {
      // "LET'S GO!" (clap clap) three times, a few hundred people
      const dur = 5.4;
      const beat = (t: number, off: number, len: number) => (t < off || t > off + len ? 0 : Math.min(1, (t - off) / 0.04) * Math.min(1, (off + len - t) / 0.05));
      const rep = [0.1, 1.85, 3.6];
      const lets = (t: number) => rep.reduce((a, o) => a + beat(t, o, 0.28), 0);
      const go = (t: number) => rep.reduce((a, o) => a + beat(t, o + 0.34, 0.42), 0);
      const A = choir({ sr: CSR, dur, vowel: VOWELS.e, voices: 12, f0: () => 170, env: lets, breath: 0.4, stagger: 0.04 }, r);
      const B = choir({ sr: CSR, dur, vowel: VOWELS.o, voices: 12, f0: (t) => 150 - 12 * ((t - 0.34) % 1.75), env: go, breath: 0.4, stagger: 0.04 }, r);
      for (let k = 0; k < 2; k++) for (let i = 0; i < A.ch[k].length; i++) A.ch[k][i] += B.ch[k][i];
      for (const o of rep) {
        claps(A.ch, CSR, r, dur, (t) => (t > o + 0.95 && t < o + 1.02) || (t > o + 1.2 && t < o + 1.27) ? 900 : 0, 0.07);
      }
      return finish(A, 0.8, 50);
    }
    case 'aww': {
      const dur = 1.5;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.a, voices: 10, f0: (t) => 235 - 60 * Math.min(1, t / 1.2), env: trap(0.18, 0.3, 0.95), breath: 0.35, stagger: 0.15, formantScale: (t) => 1 - 0.1 * Math.min(1, t / 1.2) }, r);
      return finish(c, 0.7, 40);
    }
    case 'oh_relief': {
      const dur = 1.2;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.o, voices: 10, f0: (t) => 225 - 50 * Math.min(1, t / 0.9), env: trap(0.08, 0.2, 0.85), breath: 0.35, stagger: 0.1 }, r);
      return finish(c, 0.7, 30);
    }
    case 'boo_few': {
      const dur = 1.9;
      const c = choir({ sr: CSR, dur, vowel: VOWELS.u, voices: 4, f0: (t) => 122 - 8 * t, env: trap(0.25, 0.7, 0.9), breath: 0.2, stagger: 0.3 }, r);
      return finish(c, 0.6, 40);
    }
    case 'whoop': {
      const dur = 0.85;
      const c = choir(
        { sr: CSR, dur, vowel: VOWELS.o, voices: 1, f0: (t) => 260 + 260 * Math.pow(Math.min(t, 0.5) / 0.5, 1.2), env: (t) => (t < 0 ? 0 : Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.5) / 0.15)), breath: 0.2, spread: 0.6 },
        r,
      );
      return finish(c, 0.7, 30);
    }
  }
}

/** Seamless looping stadium bed: syllabic babble of many voices (murmur) or a sustained wash (roar bed). */
export function crowdLoop(kind: 'murmur' | 'roar' | 'claps', seed = 7): Rendered {
  const r = mulberry32(seed + (kind === 'roar' ? 100 : kind === 'claps' ? 200 : 0));
  const dur = 7;
  const n = Math.floor((dur + 0.6) * CSR);
  if (kind === 'claps') {
    // sustained applause: a few hundred hands, slow swirls in density so it breathes
    const c = empty(dur + 0.6);
    claps(c.ch, CSR, r, dur + 0.6, (t) => 150 + 55 * Math.sin(t * 1.3) + 30 * Math.sin(t * 3.1 + 1), 0.28);
    hiss(c, r, () => 1, 0.1);
    return finish(makeLoop(c, 0.6), 0.6, 1);
  }
  if (kind === 'roar') {
    const c = choir({ sr: CSR, dur: dur + 0.8, vowel: VOWELS.a, voices: 10, f0: (t) => 140 + 20 * Math.sin(t * 0.7), env: () => 1, breath: 0.6, formantScale: (t) => 1 + 0.06 * Math.sin(t * 1.1) }, r);
    hiss(c, r, () => 1, 0.45);
    return finish(makeLoop(c, 0.8), 0.6, 1);
  }
  // murmur: clusters of noise -> wandering formants -> slow syllabic amplitude
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let k = 0; k < 14; k++) {
    const pan = r() * 2 - 1;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const f = [new Biquad(), new Biquad(), new Biquad()];
    const V = VOWELS[['a', 'o', 'e', 'u', 'i'][Math.floor(r() * 5)]];
    const shift = 0.85 + r() * 0.4;
    const am = new Biquad('lp', 2 + r() * 3, 0.7, CSR);
    const src = new Biquad('lp', 3500, 0.7, CSR);
    for (let i = 0; i < n; i++) {
      if ((i & 63) === 0) {
        const wob = 1 + 0.15 * Math.sin((i / CSR) * (0.4 + k * 0.05) + k);
        for (let j = 0; j < 3; j++) f[j].set('bp', V[j] * shift * wob, 4 + j * 2, CSR);
      }
      const env = Math.max(0, am.tick(r() * 2 - 1) * 5);
      const x = src.tick(r() * 2 - 1) * 2;
      const y = (f[0].tick(x) + 0.6 * f[1].tick(x) + 0.3 * f[2].tick(x)) * env * env;
      L[i] += y * gl;
      R[i] += y * gr;
    }
  }
  for (const ch of [L, R]) {
    const lp = new Biquad('lp', 380, 0.7, CSR);
    for (let i = 0; i < ch.length; i++) ch[i] += lp.tick(r() * 2 - 1) * 0.5;
  }
  return finish(makeLoop({ sr: CSR, ch: [L, R] }, 0.6), 0.5, 1);
}

// ---- registry ---------------------------------------------------------------------------------------------------------

/** The bank: buckets are physical cases (pitch speed, catch type, surface ...), alts are variations (pitch, decay, noise seed). */
export const SFX_DEFS: Record<SfxId, SoundDef> = {
  // the bat
  bat_crack: { buckets: 3, alts: 3, make: F.batCrack },
  bat_thud: { buckets: 2, alts: 3, make: F.batThud },
  bat_tick: { buckets: 1, alts: 3, make: F.batTick },
  bunt_tap: { buckets: 1, alts: 2, make: F.buntTap },
  bat_drop: { buckets: 1, alts: 2, make: F.batDrop },
  bat_rack: { buckets: 1, alts: 2, make: F.batRack },
  bat_tap: { buckets: 1, alts: 2, make: F.batTap },
  swing_whoosh: { buckets: 1, alts: 3, make: F.swingWhoosh },
  pitch_whoosh: { buckets: 2, alts: 2, make: F.pitchWhip },
  // gloves and hands
  mitt_pop: { buckets: 4, alts: 3, make: F.mittPop },
  mitt_block: { buckets: 1, alts: 2, make: F.mittBlock },
  mitt_creak: { buckets: 1, alts: 2, make: F.mittCreak },
  glove_pop: { buckets: 6, alts: 2, make: F.glovePop },
  bare_smack: { buckets: 1, alts: 2, make: F.bareSmack },
  glove_transfer: { buckets: 1, alts: 3, make: F.gloveTransfer },
  thigh_slap: { buckets: 1, alts: 2, make: F.thighSlap },
  // the ball on things
  ground_bounce: { buckets: 2, alts: 2, make: F.grassBounce },
  dirt_thud: { buckets: 2, alts: 2, make: F.dirtBounce },
  plate_bounce: { buckets: 1, alts: 2, make: F.plateBounce },
  wall_thud: { buckets: 2, alts: 2, make: F.wallThud },
  fence_rattle: { buckets: 1, alts: 2, make: F.fenceRattle },
  backstop_bang: { buckets: 1, alts: 2, make: F.backstopBang },
  seat_thump: { buckets: 1, alts: 3, make: F.seatClack },
  seat_scramble: { buckets: 1, alts: 1, make: F.seatScramble },
  body_thump: { buckets: 1, alts: 2, make: F.bodyThump },
  // through the air
  throw_whip: { buckets: 3, alts: 2, make: F.throwZip },
  // tags, slides, feet, bases
  tag_slap: { buckets: 1, alts: 3, make: F.tagSlap },
  tag_miss: { buckets: 1, alts: 2, make: F.tagMiss },
  slide_scuff: { buckets: 2, alts: 2, make: F.slideScrape },
  footstep: { buckets: 3, alts: 3, make: F.footstep },
  base_thud: { buckets: 2, alts: 2, make: F.baseTap },
  // gear and rituals
  helmet_tap: { buckets: 1, alts: 2, make: F.helmetTap },
  velcro: { buckets: 1, alts: 1, make: F.velcro },
  rosin_poof: { buckets: 1, alts: 1, make: F.rosinPoof },
  rail_thump: { buckets: 1, alts: 1, make: F.railThump },
  ump_gear: { buckets: 1, alts: 2, make: F.umpGear },
  pouch: { buckets: 1, alts: 2, make: F.pouch },
  ball_rub: { buckets: 1, alts: 1, make: F.ballRub },
  // stadium and broadcast
  firework: { buckets: 1, alts: 1, make: firework },
  replay_whoosh: { buckets: 1, alts: 1, make: replayWhoosh },
  pa_click: { buckets: 1, alts: 1, make: paClick },
  ump_yell: { buckets: 1, alts: 2, make: umpYell },
  bfx_whoosh: { buckets: 1, alts: 2, make: bfxWhoosh },
  bfx_thunk: { buckets: 1, alts: 2, make: bfxThunk },
  bfx_replay: { buckets: 1, alts: 1, make: bfxReplay },
  bfx_blip: { buckets: 1, alts: 1, make: bfxBlip },
  bfx_thump: { buckets: 1, alts: 1, make: bfxThump },
};

export const CROWD_IDS: CrowdId[] = ['roar_big', 'roar_med', 'cheer_short', 'applause', 'applause_small', 'groan', 'gasp', 'ooh', 'boo', 'swell', 'whoop', 'clap_single', 'clap_burst', 'whistle', 'shout', 'shout2', 'kid', 'vendor', 'chatter', 'chant', 'aww', 'oh_relief', 'boo_few'];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Render one variant (deterministic per id/bucket/alt). */
export function renderSfx(id: SfxId, bucket: number, alt: number): Rendered {
  const d = SFX_DEFS[id];
  return d.make(bucket, alt, mulberry32(hash(`${id}:${bucket}:${alt}`)));
}

export function renderCrowd(id: CrowdId): Rendered {
  return crowdBuf(id, mulberry32(hash(id)));
}
