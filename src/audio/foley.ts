/**
 * Foley: the sounds of the ball, the bats, the gloves and the players, synthesised (pure, deterministic per seed; `synth.ts` lists them
 * in `SFX_DEFS`, the mixer renders a bank of variants once at load and plays them through the mic array).
 *
 * Physical-modelling-inspired building blocks:
 *   modal()   struck objects: a few damped resonances (a two-pole recursion per mode: no sin() per sample). Wood is damped hard (every
 *             mode dies in < 40 ms: no metallic ring); leather pockets are low and dead; plastic and metal ring a little longer.
 *   burst()   an impact's broadband transient or a puff: filtered noise with a short attack and an exponential decay.
 *   grains()  friction and granular textures (dirt skitter, cleat crunch, velcro, cloth rustle, chain-link jingle): a random impulse
 *             train (density and level following envelopes) through a grain-decay and a filter.
 *   zip()     things moving through air (a throw, a pitch, a swing): band noise whose centre sweeps (Doppler) with a seam flutter.
 * Each recipe takes (bucket, alt, rng): the bucket is the physical case (pitch speed, catch type, surface ...), the alt a variation
 * (pitch +-0.5-1 semitone, decay +-15 %, a new noise seed), so repeats never sound identical. Every result is levelled to a target
 * loudness (`level`: the loudest 25 ms RMS, in dBFS) so the types sit right against each other before the mapping's gains and the mics'
 * distances; trailing silence is trimmed (memory).
 */
import { Biquad, addThump, type Rand, type Rendered } from './dsp';

export const FSR = 44100;
/** every target sits this much under its nominal level so even the sharpest transients keep under the peak cap (the mixer's trim
 * brings the field back up) */
const HEADROOM = 6;
const buf = (dur: number) => new Float32Array(Math.ceil(dur * FSR));
/** a random factor of +-`semis` semitones */
const sem = (r: Rand, semis: number) => Math.pow(2, ((r() * 2 - 1) * semis) / 12);
/** a random factor of 1 +- `amt` */
const vary = (r: Rand, amt: number) => 1 + (r() * 2 - 1) * amt;

type Mode = [f: number, amp: number, tau: number];

/** damped resonances (two-pole recursion), scaled in pitch and decay */
export function modal(out: Float32Array, modes: Mode[], o: { t0?: number; pitch?: number; decay?: number; amp?: number } = {}) {
  const s0 = Math.floor((o.t0 ?? 0) * FSR);
  for (const [f0, a, tau0] of modes) {
    const f = f0 * (o.pitch ?? 1);
    if (f >= FSR * 0.45) continue;
    const tau = tau0 * (o.decay ?? 1);
    const w = (2 * Math.PI * f) / FSR;
    const rr = Math.exp(-1 / (tau * FSR));
    const c1 = 2 * rr * Math.cos(w);
    const c2 = -rr * rr;
    const n = Math.min(out.length - s0, Math.floor(tau * 7 * FSR));
    // y[n] = A r^n sin(w (n + 1)): starts at A sin(w) (no click), then the recursion
    let y2 = 0;
    let y1 = a * (o.amp ?? 1) * Math.sin(w);
    for (let i = 0; i < n; i++) {
      out[s0 + i] += y1;
      const y = c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
    }
  }
}

export interface BurstOpts {
  t0?: number;
  /** linear attack, s (0: instant) */
  attack?: number;
  tau: number;
  amp: number;
  hp?: number;
  lp?: number;
  bp?: number;
  q?: number;
}

/** filtered noise with an attack and an exponential decay */
export function burst(out: Float32Array, r: Rand, o: BurstOpts) {
  const s0 = Math.floor((o.t0 ?? 0) * FSR);
  const na = Math.floor((o.attack ?? 0) * FSR);
  const n = Math.min(out.length - s0, na + Math.floor(o.tau * 7 * FSR));
  const hp = o.hp ? new Biquad('hp', o.hp, 0.707, FSR) : null;
  const hp2 = o.hp ? new Biquad('hp', o.hp, 0.707, FSR) : null;
  const lp = o.lp ? new Biquad('lp', o.lp, 0.707, FSR) : null;
  const bp = o.bp ? new Biquad('bp', o.bp, o.q ?? 1, FSR) : null;
  const dec = Math.exp(-1 / (o.tau * FSR));
  let env = o.amp;
  for (let i = 0; i < n; i++) {
    let x = r() * 2 - 1;
    if (hp) x = hp2!.tick(hp.tick(x));
    if (bp) x = bp.tick(x);
    if (lp) x = lp.tick(x);
    if (i < na) out[s0 + i] += x * o.amp * (i / na);
    else {
      out[s0 + i] += x * env;
      env *= dec;
    }
  }
}

export interface GrainOpts {
  t0?: number;
  dur: number;
  /** grains per second at x = 0..1 of the duration */
  rate: (x: number) => number;
  /** level at x */
  amp: (x: number) => number;
  /** each grain's decay, s */
  tau: number;
  hp?: number;
  lp?: number;
  bp?: number;
  q?: number;
}

/** a granular texture: random impulses (density and level by envelope) -> grain decay -> filters */
export function grains(out: Float32Array, r: Rand, o: GrainOpts) {
  const s0 = Math.floor((o.t0 ?? 0) * FSR);
  const n = Math.min(out.length - s0, Math.floor((o.dur + o.tau * 6) * FSR));
  if (n <= 0) return;
  const imp = new Float32Array(n);
  let t = 0;
  for (;;) {
    const x = t / o.dur;
    if (x >= 1) break;
    const rate = Math.max(1, o.rate(x));
    t += -Math.log(1 - r() * 0.999) / rate;
    const i = Math.floor(t * FSR);
    if (i >= n || t >= o.dur) break;
    imp[i] += (r() < 0.5 ? -1 : 1) * o.amp(t / o.dur) * (0.4 + 0.6 * r());
  }
  const d = Math.exp(-1 / (o.tau * FSR));
  const hp = o.hp ? new Biquad('hp', o.hp, 0.707, FSR) : null;
  const lp = o.lp ? new Biquad('lp', o.lp, 0.707, FSR) : null;
  const bp = o.bp ? new Biquad('bp', o.bp, o.q ?? 1, FSR) : null;
  let y = 0;
  for (let i = 0; i < n; i++) {
    // each impulse rings as a short noisy grain: an exponential envelope on noise
    y = y * d + Math.abs(imp[i]);
    let x = (r() * 2 - 1) * y * (imp[i] < 0 ? -1 : 1);
    if (hp) x = hp.tick(x);
    if (bp) x = bp.tick(x);
    if (lp) x = lp.tick(x);
    out[s0 + i] += x;
  }
}

/** an object passing through air: band noise sweeping fc(x) (x = 0..1), a bell envelope peaking at `peak`, a seam flutter (Hz) */
export function zip(out: Float32Array, r: Rand, o: { t0?: number; dur: number; fc: (x: number) => number; q: number; amp: number; peak: number; flutter?: number; lp?: number }) {
  const s0 = Math.floor((o.t0 ?? 0) * FSR);
  const n = Math.min(out.length - s0, Math.floor(o.dur * FSR));
  const f = new Biquad();
  const lp = o.lp ? new Biquad('lp', o.lp, 0.707, FSR) : null;
  const ph0 = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    if ((i & 15) === 0) f.set('bp', o.fc(x), o.q, FSR);
    const e = x < o.peak ? Math.pow(x / o.peak, 2) : Math.pow(1 - (x - o.peak) / (1 - o.peak), 1.6);
    const fl = o.flutter ? 1 + 0.45 * Math.sin(ph0 + (2 * Math.PI * o.flutter * i) / FSR) : 1;
    let y = f.tick(r() * 2 - 1) * e * fl * o.amp;
    if (lp) y = lp.tick(y);
    out[s0 + i] += y;
  }
}

const thump = (out: Float32Array, o: Parameters<typeof addThump>[2]) => addThump(out, FSR, o);

/**
 * Level a sound: its loudest 25 ms RMS to `db` dBFS (peaks capped at -0.3 dBFS), trailing silence (< -60 dB under the peak) trimmed,
 * short fades at both ends.
 */
export function level(x: Float32Array, db: number): Rendered {
  let pk = 1e-9;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  let end = x.length;
  const floor = pk * Math.pow(10, -60 / 20);
  while (end > 64 && Math.abs(x[end - 1]) < floor) end--;
  const y = x.slice(0, Math.min(x.length, end + Math.floor(0.003 * FSR)));
  const w = Math.floor(0.025 * FSR);
  let best = 1e-12;
  let acc = 0;
  for (let i = 0; i < y.length; i++) {
    acc += y[i] * y[i];
    if (i >= w) acc -= y[i - w] * y[i - w];
    best = Math.max(best, acc / w); // a fixed 25 ms window (shorter sounds count as quieter, as they are)
  }
  let g = Math.pow(10, db / 20) / Math.sqrt(best);
  if (pk * g > 0.966) g = 0.966 / pk;
  const fade = Math.floor(0.003 * FSR);
  for (let i = 0; i < y.length; i++) y[i] *= g;
  for (let i = 0; i < fade && i < y.length; i++) y[y.length - 1 - i] *= i / fade;
  for (let i = 0; i < 8 && i < y.length; i++) y[i] *= i / 8;
  return { sr: FSR, ch: [y] };
}

// ---- the bat (wood: hard-damped bending modes, no metallic ring) --------------------------------------------------------------

/** a wooden bat's bending / shell modes (Hz) and how long each rings */
const WOOD: Mode[] = [
  [175, 1, 0.02],
  [615, 1, 0.018],
  [1240, 1, 0.011],
  [2060, 1, 0.005],
  [3100, 1, 0.003],
];

/** bat on ball, solid contact; bucket 0 ordinary (< 78 mph exit), 1 solid (78-96), 2 the sweet spot (96+): sharper, brighter, less sting */
export function batCrack(b: number, _a: number, r: Rand): Rendered {
  const p = [0.25, 0.6, 1][b] ?? 0.6;
  const o = buf(0.3);
  const pitch = sem(r, 0.7);
  burst(o, r, { tau: 0.00035 + 0.00025 * (1 - p), amp: 1.4, hp: 1800 });
  // the crack: the wood's broadband snap, longer and brighter the better the contact
  burst(o, r, { tau: 0.0025 + 0.002 * p, amp: 0.9 + 0.6 * p, hp: 1200, lp: 7000 });
  burst(o, r, { tau: 0.0035 + 0.002 * p, amp: 0.9, bp: (2500 + 1500 * p) * pitch, q: 0.7 });
  if (p > 0.9) burst(o, r, { t0: 0.0005, tau: 0.0004, amp: 0.7, hp: 3500 }); // the ball leaving the barrel
  // the sweet spot barely excites the first bending mode (no sting, no "thunk"); the rest of the barrel rings briefly
  const amps = [0.4 - 0.3 * p, 0.55 - 0.15 * p, 0.5 + 0.1 * p, 0.4 + 0.15 * p, 0.3 + 0.15 * p];
  modal(o, WOOD.map(([f, , t], i) => [f, amps[i], t] as Mode), { pitch, decay: vary(r, 0.15) });
  thump(o, { f0: 320, f1: 170, pitchTau: 0.006, tau: 0.01, amp: 0.2 }); // the ball's compression
  burst(o, r, { t0: 0.002, attack: 0.003, tau: 0.03, amp: 0.35, bp: 1100, q: 0.6 }); // the crack's body in the air
  return level(o, ([-12.5, -10, -8][b] ?? -10) - HEADROOM);
}

/** bat on ball, poor contact; bucket 0 jammed (near the hands: the first bending mode "thunks"), 1 off the end (a hollow "tock") */
export function batThud(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.3);
  const pitch = sem(r, 0.8);
  if (b === 0) {
    burst(o, r, { tau: 0.0015, amp: 1, hp: 900, lp: 4500 });
    modal(o, [[170, 1.1, 0.035], [600, 0.6, 0.016], [1150, 0.3, 0.008]], { pitch, decay: vary(r, 0.15) });
    thump(o, { f0: 230, f1: 120, pitchTau: 0.012, tau: 0.035, amp: 0.9 });
    burst(o, r, { t0: 0.003, tau: 0.03, amp: 0.25, lp: 600 }); // the buzz in the handle
  } else {
    burst(o, r, { tau: 0.0007, amp: 0.8, bp: 2200, q: 0.8 });
    modal(o, [[230, 0.4, 0.02], [880, 1, 0.022], [1520, 0.55, 0.011], [2400, 0.25, 0.006]], { pitch, decay: vary(r, 0.15) });
    thump(o, { f0: 260, f1: 150, pitchTau: 0.008, tau: 0.015, amp: 0.45 });
  }
  return level(o, (b === 0 ? -13 : -13.5) - HEADROOM);
}

/** a foul tip: the ball just grazes the bat */
export function batTick(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.07);
  const pitch = sem(r, 1);
  burst(o, r, { tau: 0.0003, amp: 1, hp: 3000 });
  modal(o, [[2400, 0.45, 0.003], [4100, 0.3, 0.002], [1250, 0.25, 0.004]], { pitch });
  burst(o, r, { t0: 0.0006, tau: 0.002, amp: 0.3, bp: 5200, q: 1 }); // the seams scuffing the wood
  return level(o, (-17) - HEADROOM);
}

/** a bunt: the bat gives, the ball is deadened */
export function buntTap(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.12);
  const pitch = sem(r, 0.8);
  burst(o, r, { tau: 0.0008, amp: 0.6, bp: 1800, q: 0.8 });
  modal(o, [[600, 0.6, 0.008], [1200, 0.3, 0.005], [175, 0.3, 0.012]], { pitch, decay: vary(r, 0.15) });
  thump(o, { f0: 260, f1: 170, pitchTau: 0.006, tau: 0.012, amp: 0.7 });
  return level(o, (-16) - HEADROOM);
}

/** the bat dropped / tossed on the dirt: two or three wooden knocks, a puff, a short roll */
export function batDrop(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.62);
  const hits = [0, 0.15 + 0.04 * r(), 0.26 + 0.05 * r()];
  hits.forEach((t0, k) => {
    const a = [1, 0.55, 0.3][k];
    const pitch = sem(r, 1.5);
    burst(o, r, { t0, tau: 0.0005, amp: 0.8 * a, hp: 2000 });
    modal(o, [[410, 0.6, 0.03], [1160, 0.5, 0.02], [2320, 0.25, 0.01]], { t0, pitch, amp: a });
    burst(o, r, { t0, tau: 0.012, amp: 0.35 * a, lp: 2500, hp: 150 }); // dirt
  });
  grains(o, r, { t0: 0.32, dur: 0.18, rate: () => 120, amp: (x) => 0.12 * (1 - x), tau: 0.002, bp: 1500, q: 0.8 });
  return level(o, (-18) - HEADROOM);
}

/** a bat set into the rack against the others */
export function batRack(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.32);
  burst(o, r, { tau: 0.0005, amp: 0.7, hp: 1800 });
  modal(o, [[520, 0.6, 0.04], [1400, 0.5, 0.02], [2600, 0.3, 0.01]], { pitch: sem(r, 1.5) });
  modal(o, [[480, 0.35, 0.035], [1310, 0.3, 0.018]], { t0: 0.045 + 0.02 * r(), pitch: sem(r, 2) });
  return level(o, (-22) - HEADROOM);
}

/** the batter knocking the dirt from his spikes with the bat: two taps */
export function batTap(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.36);
  for (const t0 of [0, 0.16 + 0.03 * r()]) {
    burst(o, r, { t0, tau: 0.0007, amp: 0.6, hp: 4000 }); // the metal spikes
    modal(o, [[900, 0.5, 0.012], [2200, 0.35, 0.006]], { t0, pitch: sem(r, 1) });
    burst(o, r, { t0: t0 + 0.002, tau: 0.01, amp: 0.15, lp: 2000 }); // dirt falling
  }
  return level(o, (-25) - HEADROOM);
}

// ---- gloves and hands --------------------------------------------------------------------------------------------------------------

/**
 * The catcher's mitt, the iconic pop. Bucket by pitch speed (< 80, 80-88, 88-95, 95+ mph). Layers: a leather transient, a tiny
 * paper-like snap of the laces, the pocket's air slap, the mitt's dead body resonances (300-700 Hz, fast), a low thump that grows with
 * the speed; the room tail comes from the venue (the plate mic's reverb send).
 */
export function mittPop(b: number, _a: number, r: Rand): Rendered {
  const p = [0.25, 0.5, 0.75, 1][b] ?? 0.5;
  const o = buf(0.3);
  const pitch = sem(r, 0.6);
  const decay = vary(r, 0.15);
  burst(o, r, { tau: 0.0009, amp: 1.3 + 0.5 * p, hp: 2200 }); // the leather crack
  burst(o, r, { t0: 0.0012 + 0.001 * r(), tau: 0.0005, amp: 0.6 + 0.2 * p, bp: 7000 * pitch, q: 1.5 }); // the laces' paper snap
  burst(o, r, { tau: 0.007 + 0.002 * (1 - p), amp: 1.5, hp: 700, lp: 6000 }); // the pocket slapping shut on the ball
  burst(o, r, { tau: 0.004, amp: 1, bp: 2600 * pitch, q: 0.9 });
  modal(o, [[340, 0.55, 0.012], [520, 0.45, 0.009], [690, 0.35, 0.007], [1050, 0.25, 0.005]], { pitch, decay });
  thump(o, { f0: 150 + 20 * p, f1: 82, pitchTau: 0.01, tau: 0.02 + 0.015 * p, amp: 0.14 + 0.36 * p });
  burst(o, r, { t0: 0.002, tau: 0.04, amp: 0.1, lp: 900 }); // air pushed out of the pocket
  return level(o, ([-14, -12.5, -11, -9.5][b] ?? -12) - HEADROOM);
}

/** a pitch in the dirt: the catcher blocks it (chest protector thump, a dull mitt, a puff of dirt) */
export function mittBlock(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.36);
  thump(o, { f0: 140, f1: 70, pitchTau: 0.015, tau: 0.05, amp: 1 });
  burst(o, r, { tau: 0.003, amp: 0.6, bp: 1100, q: 0.8, lp: 2500 });
  modal(o, [[330, 0.5, 0.01], [500, 0.35, 0.008]], { pitch: sem(r, 0.8) });
  burst(o, r, { t0: 0.004, attack: 0.004, tau: 0.04, amp: 0.45, lp: 2200, hp: 200 }); // dirt
  grains(o, r, { t0: 0.01, dur: 0.15, rate: (x) => 900 * (1 - x), amp: (x) => 0.25 * (1 - x), tau: 0.0007, bp: 3800, q: 0.7 });
  return level(o, (-14) - HEADROOM);
}

/** the catcher framing a pitch: the mitt's leather creaks as he holds it */
export function mittCreak(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.32);
  const base = 45 + 25 * r();
  grains(o, r, { dur: 0.28, rate: (x) => base * (1 + x), amp: (x) => Math.sin(Math.PI * x), tau: 0.0015, bp: 1700 * sem(r, 2), q: 3 });
  return level(o, (-30) - HEADROOM);
}

/**
 * A fielder's glove. Buckets: 0 soft (a casual return, the pitcher taking the ball back), 1 firm (a throw), 2 hard (a line drive, a
 * pickoff), 3 a fly ball out there (a soft, low "thwup" in the big pocket), 4 a grounder scooped (the glove brushing the dirt first),
 * 5 in the webbing / off the edge (thin, a slap).
 */
export function glovePop(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.26);
  const pitch = sem(r, 0.8);
  const decay = vary(r, 0.15);
  let t0 = 0;
  if (b === 4) {
    // the scoop: leather over dirt, then the ball arrives
    grains(o, r, { dur: 0.03, rate: () => 2500, amp: (x) => 0.35 * x, tau: 0.0006, bp: 3000, q: 0.6 });
    t0 = 0.03;
  }
  const P = [
    { tr: 0.4, trHp: 2000, slap: 1100, slapTau: 0.004, modes: [[420, 0.7, 0.008], [650, 0.45, 0.006]] as Mode[], th: [175, 110, 0.02, 0.45], db: -21 },
    { tr: 0.85, trHp: 2200, slap: 1300, slapTau: 0.005, modes: [[380, 0.8, 0.01], [600, 0.6, 0.008], [860, 0.35, 0.006]] as Mode[], th: [165, 95, 0.028, 0.75], db: -14 },
    { tr: 1.1, trHp: 2600, slap: 1450, slapTau: 0.0045, modes: [[400, 0.8, 0.01], [630, 0.6, 0.008], [900, 0.4, 0.006]] as Mode[], th: [175, 95, 0.032, 0.95], db: -12 },
    { tr: 0.25, trHp: 1500, slap: 700, slapTau: 0.01, modes: [[300, 0.8, 0.014], [470, 0.5, 0.01]] as Mode[], th: [130, 78, 0.04, 0.9], db: -17 },
    { tr: 0.35, trHp: 1800, slap: 1000, slapTau: 0.005, modes: [[380, 0.6, 0.009], [580, 0.4, 0.007]] as Mode[], th: [160, 100, 0.022, 0.5], db: -19 },
    { tr: 0.7, trHp: 3000, slap: 2400, slapTau: 0.003, modes: [[900, 0.6, 0.006], [1400, 0.4, 0.005]] as Mode[], th: [220, 150, 0.012, 0.3], db: -17 },
  ][Math.min(5, Math.max(0, b))];
  const fly = b === 3;
  burst(o, r, { t0, attack: fly ? 0.0015 : 0, tau: 0.0008, amp: P.tr * 1.5, hp: P.trHp, lp: fly ? 5000 : undefined });
  // the pocket's slap: broadband for a firm catch, low and soft for the big outfield pocket ("thwup")
  burst(o, r, { t0, attack: fly ? 0.002 : 0, tau: P.slapTau, amp: 1.3, hp: fly ? 250 : 600, lp: fly ? 2200 : 5500 });
  burst(o, r, { t0, attack: fly ? 0.002 : 0, tau: P.slapTau, amp: 0.7, bp: P.slap * pitch, q: fly ? 0.7 : 0.9 });
  modal(o, P.modes.map(([f, a, t]) => [f, a * 0.7, t] as Mode), { t0, pitch, decay });
  thump(o, { t0, f0: P.th[0], f1: P.th[1], pitchTau: 0.01, tau: P.th[2] * 0.7, amp: P.th[3] * (fly ? 0.4 : 0.22) });
  return level(o, (P.db) - HEADROOM);
}

/** a ball caught (or a tag made) with the bare hand: skin smack */
export function bareSmack(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.14);
  burst(o, r, { tau: 0.002, amp: 1.2, hp: 1500, lp: 6000 });
  burst(o, r, { tau: 0.006, amp: 1.4, bp: 2200 * sem(r, 1), q: 0.6 });
  thump(o, { f0: 230, f1: 140, pitchTau: 0.006, tau: 0.012, amp: 0.2 });
  return level(o, (-16) - HEADROOM);
}

/** the ball moved from the glove to the throwing hand: a leather rustle and the ball into the palm */
export function gloveTransfer(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.2);
  grains(o, r, { dur: 0.11, rate: (x) => 250 + 300 * Math.sin(Math.PI * x), amp: (x) => 0.4 * Math.sin(Math.PI * x), tau: 0.001, bp: 2800 * sem(r, 2), q: 0.8 });
  const t0 = 0.09 + 0.03 * r();
  burst(o, r, { t0, tau: 0.003, amp: 0.5, bp: 1500, q: 0.9 });
  thump(o, { t0, f0: 210, f1: 140, pitchTau: 0.005, tau: 0.01, amp: 0.25 });
  return level(o, (-26) - HEADROOM);
}

/** a glove slapped against the thigh (jogging off the field, a fielder's habit) */
export function thighSlap(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.18);
  burst(o, r, { tau: 0.012, amp: 0.9, lp: 1600 });
  burst(o, r, { tau: 0.005, amp: 0.5, bp: 800, q: 0.8 });
  thump(o, { f0: 150, f1: 90, pitchTau: 0.008, tau: 0.02, amp: 0.6 });
  burst(o, r, { tau: 0.001, amp: 0.25, hp: 2500 });
  return level(o, (-25) - HEADROOM);
}

// ---- the ball on the ground and against things ---------------------------------------------------------------------------------

/** a bounce on the grass: bucket 0 soft, 1 hard */
export function grassBounce(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.2);
  const s = b ? 1 : 0.55;
  thump(o, { f0: 165 * sem(r, 1), f1: 78, pitchTau: 0.008, tau: 0.022, amp: 0.9 });
  burst(o, r, { tau: 0.02, amp: 0.45 * s, lp: 1200, hp: 100 }); // turf
  grains(o, r, { dur: 0.035, rate: () => 500, amp: () => 0.15 * s, tau: 0.0008, bp: 3600, q: 0.8 }); // blades
  return level(o, (b ? -19 : -24) - HEADROOM);
}

/** a bounce on dirt: bucket 0 the infield (a puff, then the skitter of grit), 1 the warning track (crunchy, gravelly) */
export function dirtBounce(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.32);
  const track = b === 1;
  thump(o, { f0: (track ? 170 : 195) * sem(r, 1), f1: 88, pitchTau: 0.008, tau: 0.02, amp: track ? 0.6 : 0.8 });
  burst(o, r, { attack: 0.002, tau: 0.035, amp: 0.65, lp: track ? 3200 : 2500, hp: 200 }); // the puff
  grains(o, r, {
    t0: 0.004,
    dur: track ? 0.13 : 0.2,
    rate: (x) => (track ? 1600 : 900) * Math.pow(1 - x, 1.5),
    amp: (x) => (track ? 0.55 : 0.32) * (1 - x),
    tau: track ? 0.0009 : 0.0007,
    bp: track ? 2600 : 4000,
    q: 0.7,
  });
  return level(o, (track ? -20 : -21) - HEADROOM);
}

/** off the plate (hard rubber) or the mound's packed clay */
export function plateBounce(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.16);
  burst(o, r, { tau: 0.0007, amp: 0.6, hp: 1800 });
  thump(o, { f0: 240, f1: 130, pitchTau: 0.006, tau: 0.018, amp: 0.8 });
  modal(o, [[480, 0.5, 0.01], [760, 0.3, 0.007]], { pitch: sem(r, 1.5) });
  return level(o, (-18) - HEADROOM);
}

/** the outfield wall's padding: bucket 0 a fielder crashing into it (body, cloth), 1 the ball (a padded boom from the panel behind) */
export function wallThud(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.4);
  thump(o, { f0: b ? 125 : 110, f1: 55, pitchTau: 0.03, tau: b ? 0.06 : 0.07, amp: 1 });
  burst(o, r, { attack: 0.002, tau: 0.03, amp: 0.6, lp: 800 }); // the pad's air
  modal(o, [[85, 0.4, 0.1], [210, 0.25, 0.06]], { pitch: sem(r, 1) }); // the wall panel
  if (b) burst(o, r, { tau: 0.0008, amp: 0.4, lp: 3000, hp: 600 });
  else {
    burst(o, r, { t0: 0.004, tau: 0.02, amp: 0.4, bp: 600, q: 0.7 }); // cloth
    grains(o, r, { t0: 0.02, dur: 0.12, rate: () => 300, amp: (x) => 0.15 * (1 - x), tau: 0.001, bp: 2500, q: 0.8 });
  }
  return level(o, (b ? -11 : -14) - HEADROOM);
}

/** a chain-link fence (the top of the wall, the bullpen): the mesh jingles and the links rattle for a while */
export function fenceRattle(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.9);
  const modes: Mode[] = [];
  for (let k = 0; k < 10; k++) modes.push([(900 + r() * 5200) * (k < 3 ? 0.6 : 1), 0.12 + r() * 0.2, 0.02 + r() * 0.1]);
  modal(o, modes);
  burst(o, r, { tau: 0.0012, amp: 0.8, hp: 1500 });
  thump(o, { f0: 120, f1: 70, pitchTau: 0.02, tau: 0.04, amp: 0.4 }); // the post
  grains(o, r, { t0: 0.01, dur: 0.7, rate: (x) => 600 * Math.pow(1 - x, 2) + 20, amp: (x) => 0.45 * Math.pow(1 - x, 1.5), tau: 0.0015, bp: 4200, q: 0.9 });
  return level(o, (-16) - HEADROOM);
}

/** a wild pitch / passed ball into the backstop: padded wall, the netting above rattles */
export function backstopBang(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.6);
  thump(o, { f0: 130, f1: 60, pitchTau: 0.025, tau: 0.06, amp: 1 });
  burst(o, r, { attack: 0.002, tau: 0.025, amp: 0.55, lp: 900 });
  burst(o, r, { tau: 0.0008, amp: 0.35, hp: 900, lp: 4000 });
  grains(o, r, { t0: 0.01, dur: 0.45, rate: (x) => 400 * (1 - x) + 10, amp: (x) => 0.25 * (1 - x), tau: 0.0012, hp: 2200 });
  modal(o, [[1900, 0.08, 0.04], [3300, 0.06, 0.03]], { t0: 0.01, pitch: sem(r, 2) });
  return level(o, (-13) - HEADROOM);
}

/** a ball landing in the seats: a hollow plastic clack, bouncing once or twice */
export function seatClack(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.5);
  const hits = [0, 0.08 + 0.03 * r(), 0.14 + 0.05 * r()];
  hits.forEach((t0, k) => {
    const a = [1, 0.45, 0.2][k];
    burst(o, r, { t0, tau: 0.0006, amp: 0.8 * a, hp: 2000 });
    modal(o, [[700, 0.6, 0.02], [1350, 0.5, 0.015], [2200, 0.35, 0.01], [3100, 0.2, 0.006]], { t0, pitch: sem(r, 2), amp: a });
  });
  thump(o, { f0: 160, f1: 90, pitchTau: 0.01, tau: 0.03, amp: 0.4 }); // the seat's frame
  return level(o, (-16) - HEADROOM);
}

/** fans scrambling for a ball in the stands: seats knocked, feet, cloth */
export function seatScramble(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.95);
  const n = 6 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const t0 = 0.04 + r() * 0.75;
    const a = 0.3 + 0.5 * r();
    modal(o, [[650, 0.5, 0.015], [1300, 0.35, 0.01], [2400, 0.2, 0.006]], { t0, pitch: sem(r, 3), amp: a });
    burst(o, r, { t0, tau: 0.0006, amp: 0.5 * a, hp: 2000 });
    if (r() < 0.5) thump(o, { t0, f0: 120, f1: 80, pitchTau: 0.01, tau: 0.02, amp: 0.3 * a }); // a foot on concrete
  }
  grains(o, r, { dur: 0.9, rate: () => 160, amp: (x) => 0.12 * Math.sin(Math.PI * x), tau: 0.003, lp: 2200, hp: 300 }); // cloth, shuffling
  return level(o, (-20) - HEADROOM);
}

/** a ball off a body (hit by pitch): a dull thud and cloth */
export function bodyThump(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.25);
  thump(o, { f0: 150 * sem(r, 1), f1: 80, pitchTau: 0.012, tau: 0.04, amp: 1 });
  burst(o, r, { tau: 0.02, amp: 0.55, lp: 900 });
  burst(o, r, { tau: 0.003, amp: 0.35, bp: 1500, q: 0.8 });
  return level(o, (-15) - HEADROOM);
}

/** the plate umpire's ball pouch: he digs out a new ball (cloth, two balls clicking) */
export function pouch(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.32);
  grains(o, r, { dur: 0.22, rate: () => 300, amp: (x) => 0.4 * Math.sin(Math.PI * x), tau: 0.002, bp: 2000, q: 0.7 });
  const t0 = 0.12 + 0.05 * r();
  modal(o, [[2600, 0.25, 0.005], [4100, 0.15, 0.003]], { t0, pitch: sem(r, 2) });
  burst(o, r, { t0, tau: 0.0006, amp: 0.3, hp: 2500 });
  return level(o, (-28) - HEADROOM);
}

/** hands rubbing up a new ball: three strokes of leather friction */
export function ballRub(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.62);
  for (const t0 of [0, 0.2, 0.4]) grains(o, r, { t0: t0 + 0.02 * r(), dur: 0.15, rate: () => 600, amp: (x) => 0.5 * Math.sin(Math.PI * x), tau: 0.0008, bp: 2500 * sem(r, 2), q: 0.6, lp: 6000 });
  return level(o, (-32) - HEADROOM);
}

// ---- through the air ------------------------------------------------------------------------------------------------------------

/** a throw going by: a zip that rises as it comes and falls as it goes (Doppler), the seams fluttering; bucket 0 a lob, 1 a throw, 2 a hard throw */
export function throwZip(b: number, _a: number, r: Rand): Rendered {
  const dur = [0.22, 0.16, 0.12][b] ?? 0.16;
  const o = buf(dur + 0.05);
  const top = [2200, 3200, 4200][b] ?? 3200;
  zip(o, r, { dur, fc: (x) => (x < 0.6 ? top * (0.45 + 0.55 * (x / 0.6)) : top * (1 - 0.5 * ((x - 0.6) / 0.4))), q: 1.8, amp: 1, peak: 0.6, flutter: 22 + 14 * r() + 8 * b, lp: 8000 });
  burst(o, r, { attack: 0.01, tau: 0.03, amp: 0.25, lp: 700 }); // the arm
  return level(o, ([-30, -25, -21][b] ?? -25) - HEADROOM);
}

/** a pitch past the plate (only the dish hears it): a short whip; bucket 0 off-speed, 1 a fastball */
export function pitchWhip(b: number, _a: number, r: Rand): Rendered {
  const dur = b ? 0.08 : 0.11;
  const o = buf(dur + 0.02);
  zip(o, r, { dur, fc: (x) => (b ? 4600 : 3600) * (1 - 0.55 * x), q: 1.5, amp: 1, peak: 0.45, flutter: 30 + 20 * r(), lp: 9000 });
  return level(o, (b ? -26 : -30) - HEADROOM);
}

/** a bat swung through the air */
export function swingWhoosh(_b: number, _a: number, r: Rand): Rendered {
  const dur = 0.26 * vary(r, 0.1);
  const o = buf(dur + 0.02);
  zip(o, r, { dur, fc: (x) => (x < 0.6 ? 300 + 900 * (x / 0.6) : 1200 - 600 * ((x - 0.6) / 0.4)) * sem(r, 1), q: 1.1, amp: 1, peak: 0.62, lp: 4000 });
  return level(o, (-22) - HEADROOM);
}

// ---- tags, slides, feet, bases ---------------------------------------------------------------------------------------------------------

/** a tag: the glove swiped across the jersey, then the dull impact on the body */
export function tagSlap(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.2);
  zip(o, r, { dur: 0.03, fc: (x) => 2600 - 1300 * x, q: 0.8, amp: 0.5, peak: 0.7, lp: 6000 });
  const t0 = 0.025;
  thump(o, { t0, f0: 170, f1: 100, pitchTau: 0.008, tau: 0.02, amp: 0.8 });
  burst(o, r, { t0, tau: 0.01, amp: 0.7, lp: 2500 }); // cloth
  burst(o, r, { t0, tau: 0.004, amp: 0.4, bp: 1200, q: 0.9 }); // leather
  return level(o, (-16) - HEADROOM);
}

/** a tag that misses: the glove through the air and a brush of cloth */
export function tagMiss(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.22);
  zip(o, r, { dur: 0.2, fc: (x) => 2800 - 1800 * x, q: 1.2, amp: 1, peak: 0.45, lp: 6500 });
  burst(o, r, { t0: 0.02, tau: 0.02, amp: 0.15, bp: 900, q: 0.7 });
  return level(o, (-22) - HEADROOM);
}

/** a slide: bucket 0 feet first (a long scrape, cloth, a puff of dust), 1 head first (the body lands, a shorter scrape) */
export function slideScrape(b: number, _a: number, r: Rand): Rendered {
  const head = b === 1;
  const dur = (head ? 0.45 : 0.62) * vary(r, 0.1);
  const o = buf(dur + 0.12);
  if (head) thump(o, { f0: 130, f1: 70, pitchTau: 0.015, tau: 0.05, amp: 0.9 });
  grains(o, r, { t0: head ? 0.02 : 0, dur, rate: (x) => 1800 * (1 - x) + 150, amp: (x) => Math.min(1, x * 15) * Math.pow(1 - x, 1.2) * 0.7, tau: 0.0008, bp: 2200, q: 0.5 });
  burst(o, r, { attack: 0.03, tau: dur * 0.18, amp: 0.4, lp: 320 }); // the body's rumble
  zip(o, r, { dur: dur * 0.8, fc: () => 1400, q: 0.5, amp: 0.25, peak: 0.2, lp: 3500 }); // cloth
  burst(o, r, { t0: dur * 0.6, attack: 0.03, tau: 0.06, amp: 0.3, lp: 1500, hp: 200 }); // the dust settling
  return level(o, (-17) - HEADROOM);
}

/** a cleat in the ground: bucket 0 grass, 1 infield dirt (a crunch), 2 the warning track (gravel) */
export function footstep(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.1);
  if (b === 0) {
    thump(o, { f0: 120, f1: 70, pitchTau: 0.006, tau: 0.012, amp: 0.6 });
    burst(o, r, { tau: 0.01, amp: 0.4, lp: 1500 });
    grains(o, r, { dur: 0.02, rate: () => 400, amp: () => 0.1, tau: 0.0007, bp: 3500 });
  } else {
    thump(o, { f0: 150, f1: 85, pitchTau: 0.006, tau: 0.012, amp: 0.4 });
    grains(o, r, { dur: b === 2 ? 0.045 : 0.03, rate: () => (b === 2 ? 3000 : 4000), amp: (x) => (b === 2 ? 0.8 : 0.6) * (1 - x), tau: 0.0007, bp: b === 2 ? 2000 : 3000, q: 0.7 });
  }
  return level(o, (b === 0 ? -34 : -30) - HEADROOM);
}

/** a foot on a base: bucket 0 the bag (rubber and canvas, a spike tick), 1 home plate (hard rubber) */
export function baseTap(b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.14);
  if (b === 0) {
    thump(o, { f0: 140, f1: 90, pitchTau: 0.008, tau: 0.02, amp: 0.8 });
    burst(o, r, { tau: 0.008, amp: 0.4, lp: 1500 });
    burst(o, r, { tau: 0.0006, amp: 0.3, hp: 3500 });
  } else {
    thump(o, { f0: 200, f1: 120, pitchTau: 0.006, tau: 0.012, amp: 0.6 });
    modal(o, [[600, 0.5, 0.008], [1100, 0.3, 0.005]], { pitch: sem(r, 1) });
    burst(o, r, { tau: 0.0006, amp: 0.35, hp: 3000 });
  }
  return level(o, (b === 0 ? -24 : -21) - HEADROOM);
}

// ---- gear and rituals --------------------------------------------------------------------------------------------------------------

/** a knock on a batting helmet (the batter's hand, the bat): plastic shell, two taps */
export function helmetTap(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.24);
  for (const [t0, a] of [[0, 1], [0.11 + 0.03 * r(), 0.6]] as [number, number][]) {
    burst(o, r, { t0, tau: 0.0005, amp: 0.6 * a, hp: 2500 });
    modal(o, [[950, 0.6, 0.015], [1750, 0.45, 0.01], [2600, 0.3, 0.006]], { t0, pitch: sem(r, 1.5), amp: a });
  }
  return level(o, (-26) - HEADROOM);
}

/** batting gloves: the Velcro strap ripped open and pressed back */
export function velcro(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.62);
  const len = 0.32 * vary(r, 0.15);
  grains(o, r, { dur: len, rate: (x) => 3200 * Math.min(1, x * 6) * (1 - 0.5 * x), amp: (x) => Math.min(1, x * 8) * (1 - 0.6 * x), tau: 0.0004, bp: 3500, q: 0.6 });
  // pressed back: a few soft pats
  for (let k = 0; k < 3; k++) burst(o, r, { t0: len + 0.1 + k * 0.05, tau: 0.006, amp: 0.25, lp: 1800 });
  return level(o, (-28) - HEADROOM);
}

/** the pitcher's rosin bag: patted twice, a puff of powder */
export function rosinPoof(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.62);
  for (const t0 of [0, 0.3 + 0.08 * r()]) {
    thump(o, { t0, f0: 130, f1: 85, pitchTau: 0.006, tau: 0.015, amp: 0.5 });
    burst(o, r, { t0, tau: 0.008, amp: 0.4, lp: 1500 });
    burst(o, r, { t0: t0 + 0.005, attack: 0.012, tau: 0.08, amp: 0.45, lp: 1800, hp: 300 }); // the powder
  }
  return level(o, (-30) - HEADROOM);
}

/** the dugout rail: a padded steel pipe, leaned on or slapped (a big moment on the bench) */
export function railThump(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.5);
  thump(o, { f0: 110, f1: 65, pitchTau: 0.012, tau: 0.05, amp: 1 });
  modal(o, [[310, 0.25, 0.12], [870, 0.2, 0.08], [1650, 0.12, 0.05]], { pitch: sem(r, 1) });
  burst(o, r, { tau: 0.012, amp: 0.4, lp: 1600 });
  return level(o, (-20) - HEADROOM);
}

/** the plate umpire's gear: the mask off and on, a buckle and a plate knocking */
export function umpGear(_b: number, _a: number, r: Rand): Rendered {
  const o = buf(0.32);
  const n = 4 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const t0 = r() * 0.24;
    burst(o, r, { t0, tau: 0.0012, amp: 0.4 + 0.3 * r(), hp: 2500 });
    modal(o, [[1900, 0.25, 0.01], [3200, 0.15, 0.006]], { t0, pitch: sem(r, 3), amp: 0.5 + 0.5 * r() });
  }
  modal(o, [[800, 0.4, 0.012]], { t0: 0.05, pitch: sem(r, 2) });
  return level(o, (-28) - HEADROOM);
}
