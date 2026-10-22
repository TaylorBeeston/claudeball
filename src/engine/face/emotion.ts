/**
 * The face's emotion model (docs/faces.md section 5): pure, no three.js. One `FaceState` per person turns three layers into the 20 face keys of
 * the player files (assets/src/face_style.py):
 *   - mood: valence (-1..1) and arousal (0..1), eased toward event-driven goals and back to the person's baseline (tau 20-90 s); sets the resting face
 *     and the blink rate;
 *   - reactions: preset expressions with an attack / hold / release envelope and a priority (a stronger one pre-empts, a weaker one waits; one at a
 *     time, the next cross-fading in), held through a close-up of that person;
 *   - life: blinks (now and then a double blink or one lid a few ms behind the other), saccades (small fixation offsets for the eyes, which lead the
 *     head), brow flickers, gum chewing, the jaw while talking.
 * Every key then follows its target with a critically damped spring (fast for lids, medium for brows and mouth); blinks are written directly.
 * Weights are in key units (1 = the full stylized expression); `_L` is the model's left (a mirrored left-hander shows it on the other side, which
 * does not matter for a person's own asymmetries; eye look is solved in rig space and needs no swap).
 */

export const FACE_KEYS = [
  'blink_L', 'blink_R', 'squint_L', 'squint_R', 'wide_L', 'wide_R', 'brow_up_L', 'brow_up_R', 'brow_down_L', 'brow_down_R', 'brow_inner_up_L', 'brow_inner_up_R',
  'smile_L', 'smile_R', 'jaw_open', 'frown', 'lip_press', 'sneer', 'pucker', 'cheek_puff',
] as const;
export type FaceKey = (typeof FACE_KEYS)[number];
export type Weights = Partial<Record<FaceKey, number>>;
const KEY_INDEX = new Map<FaceKey, number>(FACE_KEYS.map((k, i) => [k, i]));

/** both sides of a sided key */
const both = (k: 'blink' | 'squint' | 'wide' | 'brow_up' | 'brow_down' | 'brow_inner_up' | 'smile', v: number): Weights => ({ [`${k}_L`]: v, [`${k}_R`]: v }) as Weights;

export type ReactionName =
  | 'joy' | 'grin' | 'shout' | 'yell' | 'frustration' | 'dejection' | 'anger' | 'glare' | 'argue' | 'wince' | 'flinch' | 'shock' | 'concentration'
  | 'relief' | 'smirk' | 'delight' | 'concern' | 'grimace' | 'nod';

export interface Preset {
  w: Weights;
  /** seconds: rise, hold at full, fall */
  attack: number;
  hold: number;
  release: number;
  /** a reaction pre-empts the running one when its priority is at least as high */
  priority: number;
  /** the jaw talks / shouts while it runs (a syllable-rate envelope on top of `w.jaw_open`) */
  talk?: number;
  /** the mood it leaves behind: valence and arousal shifts */
  mood?: [number, number];
  /** scaled by the person's temper (fiery people show it more) */
  temper?: boolean;
}

/**
 * The presets, calibrated on the built heads (tools/faces/facelab.py CAND=BUILD renders: joy, shout, anger, dejected, shock, wince read at the
 * director's pitcherFace size).
 */
export const PRESETS: Record<ReactionName, Preset> = {
  joy: { w: { ...both('brow_up', 0.35), ...both('squint', 0.45), ...both('smile', 1), jaw_open: 0.42 }, attack: 0.2, hold: 1.8, release: 1.2, priority: 3, mood: [0.35, 0.3] },
  grin: { w: { ...both('smile', 0.8), ...both('squint', 0.3), ...both('brow_up', 0.15) }, attack: 0.25, hold: 1.6, release: 1.0, priority: 2, mood: [0.2, 0.1] },
  shout: { w: { ...both('brow_down', 0.8), ...both('squint', 0.5), jaw_open: 1, sneer: 0.6, ...both('smile', 0.3) }, attack: 0.12, hold: 1.2, release: 0.8, priority: 4, talk: 0.25, mood: [0.4, 0.5] },
  yell: { w: { ...both('brow_down', 0.6), ...both('squint', 0.6), jaw_open: 0.9, ...both('smile', 0.4), sneer: 0.4 }, attack: 0.1, hold: 0.9, release: 0.7, priority: 4, mood: [0.3, 0.5], temper: true },
  frustration: { w: { lip_press: 0.9, ...both('brow_down', 0.7), frown: 0.4, ...both('squint', 0.2) }, attack: 0.25, hold: 2.2, release: 1.4, priority: 3, mood: [-0.3, 0.25] },
  dejection: { w: { ...both('brow_inner_up', 1), ...both('blink', 0.4), frown: 1, lip_press: 0.3 }, attack: 0.5, hold: 2.5, release: 2.0, priority: 3, mood: [-0.4, -0.1] },
  anger: { w: { ...both('brow_down', 1), ...both('squint', 0.35), lip_press: 0.8, sneer: 0.35, frown: 0.3 }, attack: 0.2, hold: 2.0, release: 1.4, priority: 4, mood: [-0.35, 0.4], temper: true },
  glare: { w: { ...both('brow_down', 0.8), ...both('squint', 0.6), lip_press: 0.4 }, attack: 0.3, hold: 1.8, release: 1.0, priority: 3, mood: [-0.2, 0.3], temper: true },
  argue: { w: { ...both('brow_down', 0.9), sneer: 0.4, jaw_open: 0.3, ...both('squint', 0.3) }, attack: 0.2, hold: 3.5, release: 1.0, priority: 4, talk: 0.35, mood: [-0.3, 0.5], temper: true },
  wince: { w: { ...both('brow_down', 0.6), ...both('brow_inner_up', 0.5), ...both('blink', 0.9), ...both('squint', 0.3), sneer: 0.3, jaw_open: 0.24 }, attack: 0.08, hold: 0.8, release: 0.7, priority: 5, mood: [-0.2, 0.4] },
  flinch: { w: { ...both('blink', 1), ...both('squint', 0.6), ...both('brow_down', 0.4), ...both('brow_inner_up', 0.3), jaw_open: 0.15 }, attack: 0.05, hold: 0.35, release: 0.4, priority: 5, mood: [-0.1, 0.5] },
  shock: { w: { ...both('brow_up', 1), ...both('wide', 1), jaw_open: 0.84 }, attack: 0.1, hold: 1.0, release: 0.9, priority: 4, mood: [-0.2, 0.5] },
  concentration: { w: { ...both('brow_down', 0.3), ...both('squint', 0.25), lip_press: 0.3 }, attack: 0.4, hold: 2.0, release: 0.8, priority: 1 },
  relief: { w: { ...both('brow_inner_up', 0.3), ...both('smile', 0.35), jaw_open: 0.1, ...both('blink', 0.25) }, attack: 0.3, hold: 1.4, release: 1.0, priority: 2, mood: [0.2, -0.1] },
  smirk: { w: { smile_L: 0.6, smile_R: 0.1, squint_L: 0.2 }, attack: 0.3, hold: 1.4, release: 0.9, priority: 2, mood: [0.15, 0] },
  delight: { w: { ...both('smile', 1), ...both('brow_up', 0.6), jaw_open: 0.5, ...both('wide', 0.3) }, attack: 0.2, hold: 1.6, release: 1.0, priority: 3, mood: [0.4, 0.3] },
  concern: { w: { ...both('brow_inner_up', 0.7), frown: 0.3, lip_press: 0.2 }, attack: 0.3, hold: 1.6, release: 1.0, priority: 2, mood: [-0.15, 0.2] },
  grimace: { w: { frown: 0.6, lip_press: 0.4, ...both('squint', 0.4), ...both('brow_down', 0.5), sneer: 0.3 }, attack: 0.15, hold: 1.4, release: 1.0, priority: 3, mood: [-0.25, 0.25] },
  nod: { w: { ...both('smile', 0.2), lip_press: 0.2 }, attack: 0.3, hold: 1.0, release: 0.8, priority: 1, mood: [0.05, 0] },
};

export interface Personality {
  /** scales every reaction (0.5-1.3) */
  expressiveness: number;
  /** 0..1: raises the mood's inertia, softens reactions a little */
  calm: number;
  /** 0..1: anger, glares and yells bigger */
  fiery: number;
  chews: boolean;
  /** blink-rate factor (0.8-1.25) */
  blinkRate: number;
  /** resting smile / brow height of this face */
  smile: number;
  brow: number;
  /** one corner of the mouth higher (-1..1: left / right), and the lid lag of an occasional uneven blink */
  asym: number;
  /** resting valence */
  valence: number;
}

/** a stable hash of a string (FNV-1a) */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** deterministic 0..1 numbers from a seed (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A person's temperament from the player id (stable across games) and, when the sim gives them, the 20-80 ratings: a high `clutch` (composure in
 * high-leverage spots) makes him calmer; managers and umpires are calm and less expressive, ball kids lively.
 */
export function personalityFor(id: string, ratings?: Record<string, number>, role?: string): Personality {
  const r = rng(hashString(id + ':temper'));
  const u = () => r();
  const clutch = ratings?.clutch !== undefined ? (ratings.clutch - 20) / 60 : 0.5;
  let calm = Math.min(1, Math.max(0, 0.25 + 0.5 * clutch + 0.3 * (u() - 0.5)));
  let expressiveness = 0.6 + 0.65 * u();
  const fiery = Math.max(0, Math.min(1, u() * 1.2 - 0.4 * calm));
  if (role === 'umpire') {
    calm = Math.max(calm, 0.8);
    expressiveness *= 0.6;
  }
  if (role === 'manager' || role === 'pitchcoach') calm = Math.max(calm, 0.6);
  if (role === 'ballkid' || role === 'batboy') expressiveness = Math.max(expressiveness, 1.1);
  return {
    expressiveness,
    calm,
    fiery: role === 'umpire' ? 0 : fiery,
    chews: role !== 'umpire' && u() < 0.3,
    blinkRate: 0.8 + 0.45 * u(),
    smile: 0.02 + 0.12 * u(),
    brow: 0.04 + 0.1 * u(),
    asym: (u() - 0.5) * 2,
    valence: (u() - 0.5) * 0.3,
  };
}

/** a critically damped spring toward `target` (no overshoot), exact for a constant target over the step */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const e = Math.exp(-omega * dt);
  const d = x - target;
  const c = v + omega * d;
  return [target + (d + c * dt) * e, (v - c * omega * dt) * e];
}

/** natural frequency (rad/s) per key: lids fast, brows and mouth medium (docs/faces.md: ~30 / ~12) */
const OMEGA: number[] = FACE_KEYS.map((k) => (/^(squint|wide)/.test(k) ? 30 : k === 'jaw_open' ? 18 : 12));

/** what the person is doing, from the animation (the engine's glue) */
export interface Activity {
  /** reading the pitch / the signs: focused brows */
  focus?: boolean;
  /** swinging, throwing, sliding: an effort face */
  effort?: boolean;
  /** talking (mound visit, argument, coach): the jaw moves at syllable rate */
  talking?: boolean;
  /** celebrating (a clip that cheers) */
  cheering?: boolean;
  /** 0..1 pressure of the moment (bases loaded, a late close game, two strikes) */
  tension?: number;
}

interface Running {
  name: ReactionName;
  p: Preset;
  amp: number;
  t: number;
  /** seconds the hold lasts (a close-up can stretch it) */
  hold: number;
}

/** keep this many non-zero keys at most (three's morph cost is per active target); the smallest are dropped */
export const MAX_ACTIVE = 10;

export class FaceState {
  readonly pers: Personality;
  /** mood now and its goal (valence -1..1, arousal 0..1) */
  valence: number;
  arousal = 0.2;
  private goalV: number;
  private goalA = 0.2;
  private cur: Running | null = null;
  private next: Running | null = null;
  private delayed: { at: number; name: ReactionName; amp: number }[] = [];
  private x = new Float64Array(FACE_KEYS.length);
  private v = new Float64Array(FACE_KEYS.length);
  private target = new Float64Array(FACE_KEYS.length);
  private out = new Float64Array(FACE_KEYS.length);
  private r: () => number;
  private clock = 0;
  private blinkAt: number;
  private blinkT = -1;
  private blinkLag = 0;
  private sacAt = 0;
  private flickAt: number;
  private flickT = -1;
  private chewHz: number;
  private talkPhase = 0;
  private talkAmp = 0;
  /** the eyes' fixation offset (rad) on top of the look target: small saccades */
  sacYaw = 0;
  sacPitch = 0;

  constructor(readonly id: string, pers?: Personality) {
    this.pers = pers ?? personalityFor(id);
    this.r = rng(hashString(id + ':face'));
    this.valence = this.goalV = this.pers.valence;
    this.blinkAt = 0.5 + 3 * this.r();
    this.flickAt = 3 + 6 * this.r();
    this.chewHz = 1.6 + 0.4 * this.r();
  }

  /** the reaction running now (null: none), for tests and probes */
  get reaction(): ReactionName | null {
    return this.cur?.name ?? null;
  }

  /**
   * Show a reaction (intensity 0..1.5, scaled by the person's expressiveness and, for temper presets, by how fiery he is), now or after `delay`
   * seconds (a reaction chain: grin, then shout). A stronger or equal one pre-empts the running one; a weaker one waits behind it.
   */
  react(name: ReactionName, intensity = 1, delay = 0) {
    if (delay > 0) {
      this.delayed.push({ at: this.clock + delay, name, amp: intensity });
      return;
    }
    const p = PRESETS[name];
    const P = this.pers;
    let amp = intensity * P.expressiveness * (1 - 0.25 * P.calm);
    if (p.temper) amp *= 0.6 + 0.8 * P.fiery;
    const run: Running = { name, p, amp: Math.min(1.4, amp), t: 0, hold: p.hold };
    const c = this.cur;
    if (!c || p.priority >= c.p.priority || c.t > c.p.attack + c.hold) {
      this.cur = run;
      if (p.mood) this.moodShift(p.mood[0] * Math.min(1, intensity), p.mood[1] * Math.min(1, intensity));
    } else if (!this.next || p.priority >= this.next.p.priority) this.next = run;
  }

  /** Keep the running reaction at full for at least `sec` more (a close-up of this person): it started within `within` s, or is still rising / held. */
  holdFor(sec: number, within = 0.5) {
    const c = this.cur;
    if (!c) return false;
    const inHold = c.t <= c.p.attack + c.hold;
    if (!inHold && c.t - (c.p.attack + c.hold) > within) return false;
    c.hold = Math.max(c.hold, c.t - c.p.attack + sec);
    return true;
  }

  /** Nudge the mood goal (valence, arousal); it decays back to the person's baseline. */
  moodShift(dv: number, da: number) {
    this.goalV = Math.max(-1, Math.min(1, this.goalV + dv));
    this.goalA = Math.max(0, Math.min(1, this.goalA + da));
  }

  /**
   * Advance by `dt` seconds and return the 20 weights (indexed like FACE_KEYS; the same array every call). `act` is what the person is doing now.
   */
  step(dt: number, act: Activity = {}): Float64Array {
    dt = Math.max(0, Math.min(0.1, dt));
    const tension = Math.max(0, Math.min(1, act.tension ?? 0));
    // a face coming back into the picture (only its clocks ran) shows its expression at once: a camera cut must not ramp up from a stale face
    const snap = this.stale;
    this.tick(dt, tension);
    this.stale = false;
    return this.compose(dt, act, tension, snap);
  }
  /** set by `tick` alone (the face was not drawn): the next `step` snaps the springs to their targets */
  private stale = false;

  /**
   * The clocks only (no weights): delayed reactions start, the running one moves through its envelope, the mood eases. A face too small or off the
   * picture gets just this (cheap), so a reaction is where it should be when the camera cuts to it.
   */
  tick(dt: number, tension = 0) {
    dt = Math.max(0, Math.min(0.1, dt));
    this.clock += dt;
    this.stale = true;
    const P = this.pers;
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      if (this.clock >= d.at) {
        this.delayed.splice(i, 1);
        this.react(d.name, d.amp);
      }
    }
    // mood: the goal decays to the baseline (tau 20-90 s by calm), the mood follows the goal more slowly
    const tauGoal = 20 + 70 * P.calm, tauMood = 2 + 4 * P.calm;
    this.goalV += (P.valence - this.goalV) * (1 - Math.exp(-dt / tauGoal));
    this.goalA += (0.2 + 0.35 * tension - this.goalA) * (1 - Math.exp(-dt / tauGoal));
    const km = 1 - Math.exp(-dt / tauMood);
    this.valence += (this.goalV - this.valence) * km;
    this.arousal += (this.goalA - this.arousal) * km;
    // the reaction's envelope clock; the next one takes over as this one releases
    const c = this.cur;
    if (c) {
      c.t += dt;
      const end = c.p.attack + c.hold;
      if (c.t >= end && this.next) {
        this.cur = this.next;
        this.next = null;
        if (this.cur.p.mood) this.moodShift(this.cur.p.mood[0], this.cur.p.mood[1]);
      } else if (c.t >= end + c.p.release) this.cur = null;
    } else if (this.next) {
      this.cur = this.next;
      this.next = null;
    }
  }

  private compose(dt: number, act: Activity, tension: number, snap = false): Float64Array {
    const P = this.pers, T = this.target;
    const val = this.valence, aro = this.arousal;
    // the resting face: the person's own, then the mood (contentment smiles a little, unhappiness lifts the inner brows), then the moment's pressure
    T.fill(0);
    const add = (k: FaceKey, w: number) => (T[KEY_INDEX.get(k)!] += w);
    const sm = P.smile + 0.35 * Math.max(0, val);
    add('smile_L', sm * (1 + 0.25 * P.asym));
    add('smile_R', sm * (1 - 0.25 * P.asym));
    add('brow_up_L', P.brow);
    add('brow_up_R', P.brow);
    const sad = Math.max(0, -val);
    add('frown', 0.3 * sad);
    add('brow_inner_up_L', 0.25 * sad);
    add('brow_inner_up_R', 0.25 * sad);
    add('brow_down_L', 0.25 * tension);
    add('brow_down_R', 0.25 * tension);
    add('lip_press', 0.2 * tension);
    add('wide_L', 0.1 * Math.max(0, aro - 0.5));
    add('wide_R', 0.1 * Math.max(0, aro - 0.5));
    // what he is doing
    if (act.focus) {
      add('brow_down_L', 0.15);
      add('brow_down_R', 0.15);
      add('squint_L', 0.12);
      add('squint_R', 0.12);
    }
    if (act.effort) {
      add('brow_down_L', 0.35);
      add('brow_down_R', 0.35);
      add('squint_L', 0.3);
      add('squint_R', 0.3);
      add('jaw_open', 0.25);
      add('lip_press', 0.2);
    }
    if (act.cheering) {
      add('smile_L', 0.7);
      add('smile_R', 0.7);
      add('jaw_open', 0.35);
      add('brow_up_L', 0.3);
      add('brow_up_R', 0.3);
    }
    // the reaction, with its envelope
    let talk = act.talking ? 0.22 : 0;
    const c = this.cur;
    if (c) {
      const { attack, release } = c.p;
      const e = c.t < attack ? smooth(c.t / attack) : c.t < attack + c.hold ? 1 : 1 - smooth((c.t - attack - c.hold) / release);
      const k = e * c.amp;
      for (const kk in c.p.w) add(kk as FaceKey, (c.p.w as Record<string, number>)[kk] * k);
      if (c.p.talk) talk = Math.max(talk, c.p.talk * e);
    }
    // talking: a syllable-rate jaw (4-6 syllables a second, uneven)
    if (talk > 0) {
      this.talkPhase += dt * (9 + 4 * this.r()) * Math.PI;
      if (Math.sin(this.talkPhase) > 0.95) this.talkAmp = 0.5 + 0.5 * this.r();
      add('jaw_open', talk * this.talkAmp * (0.5 + 0.5 * Math.sin(this.talkPhase)));
    } else if (P.chews && !c) {
      // gum: a slow rhythmic jaw and a little pucker
      add('jaw_open', 0.06 + 0.06 * (0.5 + 0.5 * Math.sin(this.clock * this.chewHz * 2 * Math.PI)));
      add('pucker', 0.06);
    }
    // brow flickers: a brief lift now and then (more when aroused)
    if (this.flickT < 0 && this.clock >= this.flickAt) this.flickT = 0;
    if (this.flickT >= 0) {
      this.flickT += dt;
      const f = this.flickT < 0.15 ? this.flickT / 0.15 : Math.max(0, 1 - (this.flickT - 0.15) / 0.35);
      add('brow_up_L', 0.18 * f);
      add('brow_up_R', 0.18 * f);
      if (this.flickT > 0.5) {
        this.flickT = -1;
        this.flickAt = this.clock + (4 + 6 * this.r()) / (0.7 + aro);
      }
    }
    // saccades: a new small fixation every 0.3-1.5 s
    if (this.clock >= this.sacAt) {
      this.sacYaw = (this.r() - 0.5) * 0.09;
      this.sacPitch = (this.r() - 0.5) * 0.06;
      this.sacAt = this.clock + 0.3 + 1.2 * this.r();
    }
    // springs
    for (let i = 0; i < FACE_KEYS.length; i++) {
      const [x, v] = snap ? [Math.min(1.4, T[i]), 0] : springStep(this.x[i], this.v[i], Math.min(1.4, T[i]), OMEGA[i], dt);
      this.x[i] = x;
      this.v[i] = v;
      this.out[i] = Math.max(0, x);
    }
    // blinks (direct: crisp): 2.5-6 s at rest, faster when aroused, sometimes a double blink, sometimes one lid 10-20 ms behind
    if (this.blinkT < 0 && this.clock >= this.blinkAt) {
      this.blinkT = 0;
      this.blinkLag = this.r() < 0.2 ? (0.01 + 0.01 * this.r()) * Math.sign(P.asym || 1) : 0;
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const lid = (t: number) => (t < 0 ? 0 : t < 0.05 ? t / 0.05 : t < 0.08 ? 1 : Math.max(0, 1 - (t - 0.08) / 0.1));   // close, shut a moment, open
      const bl = lid(this.blinkT - Math.max(0, this.blinkLag)), br = lid(this.blinkT - Math.max(0, -this.blinkLag));
      const iL = KEY_INDEX.get('blink_L')!, iR = KEY_INDEX.get('blink_R')!;
      this.out[iL] = Math.max(this.out[iL], bl);
      this.out[iR] = Math.max(this.out[iR], br);
      if (this.blinkT > 0.2) {
        this.blinkT = -1;
        const dbl = this.r() < 0.12;
        this.blinkAt = this.clock + (dbl ? 0.25 : (2.5 + 3.5 * this.r()) / (P.blinkRate * (0.8 + 0.8 * aro)));
      }
    }
    // the budget: only the strongest MAX_ACTIVE keys stay non-zero
    capActive(this.out, MAX_ACTIVE);
    return this.out;
  }

  /** the weights as a name -> value record (probes, tests) */
  weights(): Weights {
    const w: Weights = {};
    FACE_KEYS.forEach((k, i) => {
      if (this.out[i] > 0) w[k] = this.out[i];
    });
    return w;
  }
}

function smooth(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

/** zero all but the `n` largest entries (and anything below 0.005) */
export function capActive(w: Float64Array, n: number) {
  let count = 0;
  for (let i = 0; i < w.length; i++) {
    if (w[i] < 0.005) w[i] = 0;
    else count++;
  }
  while (count > n) {
    let mi = -1;
    for (let i = 0; i < w.length; i++) if (w[i] > 0 && (mi < 0 || w[i] < w[mi])) mi = i;
    w[mi] = 0;
    count--;
  }
}
