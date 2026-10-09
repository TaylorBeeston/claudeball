/**
 * The crowd reaction model (pure: no Web Audio, no clock, no Math.random; the rng and the time step are injected, so it is
 * deterministic and tested under node).
 *
 * What it does: the stadium bed (a murmur loop, a roar wash and a clapping loop, `ambience.ts`) is driven by an *energy envelope*:
 * every game event adds an envelope with its own attack / hold / decay shape, they are summed (a soft maximum, never above 1) on top of
 * the leverage of the situation (late innings, a close score, runners in scoring position). On top of that the model schedules
 * one-shot sounds (a pop, an "ooh", a groan, a clap pattern, a chant) and a trickle of incidental life (a lone clap, a whistle, a kid, a
 * vendor, a creaking seat, a pocket of conversation, a wave of cheer going round the stands).
 *
 *   contact          an immediate pop sized by exit velocity (soft "ooh" for weak contact, a sharper rise for hard hits); a fly ball with
 *                    carry makes an anticipation swell that rises while the ball is in the air (1-6 s) and the crowd holds its breath
 *   then, by outcome foul: the pop dies fast ("aww"); caught: relief "ohh" + applause; hit: a cheer scaled by impact and by whose side
 *                    it is (home team: loud; visitors: muted, a few groans and boos); home run: a crescendo that keeps building for
 *                    4-8 s with a long roar, clapping, whistles and a second wave; robbed: gasp, then groan or cheer by side
 *   others           strikeouts, two-strike clap-claps for the home pitcher, walks, steals, close plays, double plays, runs, walk-offs,
 *                    pitching changes, mound visits, between-innings chants, a ball tossed to a fan ...
 *   tension          on two strikes / full counts the murmur leans in (hush), more so right before the pitch in tense moments
 *
 * `observe(ev, ctx)` feeds events; `update(dt)` advances time and returns the bed; `take()` drains the one-shots that are due.
 */
import type { CrowdId, RawEvent } from './types';
import { baseline } from './excitement';
import { ZONES, type ZoneId } from './venue/mics';

export type ShotId = CrowdId | 'seat_thump';

export interface CrowdShot {
  id: ShotId;
  gain: number;
  /** seconds from now (the moment of `take()`) */
  delay: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** playback rate (also stretches a sound to the time that is available) */
  rate?: number;
  /** a pan that moves across the stands over `dur` seconds (the wave) */
  sweep?: { from: number; to: number; dur: number };
  /** the section of the stands it comes from (else `pan` picks one) */
  zone?: ZoneId;
  /** the whole bowl at once (a big roar): no single section */
  diffuse?: boolean;
}

/** what the bed loops should do right now */
export interface CrowdBed {
  /** 0..1 overall crowd level (also for the speech delivery) */
  level: number;
  murmur: number;
  roar: number;
  clap: number;
  /** low-pass cut-off of the bed, Hz */
  cutoff: number;
  /** 0..1 how quiet the crowd is holding its breath */
  hush: number;
  /**
   * per section of the stands, 0..1: its own level (home fans and visiting fans react to different things: a visitor's home run lifts
   * the first-base side and the right-field bleachers while the home sections groan)
   */
  zones: Record<ZoneId, number>;
}

export interface CrowdCtx {
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  balls: number;
  strikes: number;
  score: { home: number; away: number };
  runners: [boolean, boolean, boolean];
}

export interface CrowdOptions {
  rng: () => number;
  /** phones: fewer incidental sounds, fewer voices (the controller also caps the voices) */
  lowPower?: boolean;
  /** how much of the stands is the home team's (default 0.7) */
  homeFans?: number;
}

type Channel = 'energy' | 'clap' | 'hush' | 'convo';
/** whose fans an energy envelope belongs to (none: everybody) */
type Side = 'home' | 'away';

interface Env {
  ch: Channel;
  side?: Side;
  tag: string;
  peak: number;
  t0: number;
  a: number;
  h: number;
  d: number;
  /** cut short at time `kt`, fading over `kf`, from the value `kv` it had then */
  kt?: number;
  kf?: number;
  kv?: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function envValue(e: Env, t: number): number {
  const x = t - e.t0;
  if (x < 0) return 0;
  let v: number;
  if (x < e.a) v = Math.pow(x / Math.max(1e-6, e.a), 1.5);
  else if (x < e.a + e.h) v = 1;
  else v = Math.pow(Math.max(0, 1 - (x - e.a - e.h) / Math.max(1e-6, e.d)), 1.4);
  v *= e.peak;
  if (e.kt !== undefined && t >= e.kt) {
    const f = Math.max(0, 1 - (t - e.kt) / Math.max(1e-6, e.kf ?? 0.5));
    return (e.kv ?? 0) * f;
  }
  return v;
}
const envEnd = (e: Env) => e.t0 + e.a + e.h + e.d;

/** rough carry in metres of a batted ball (vacuum range with a drag allowance), and its time in the air */
export function carryOf(exitMph: number, launchDeg: number): number {
  const v = exitMph * 0.44704;
  return ((v * v * Math.sin((2 * launchDeg * Math.PI) / 180)) / 9.81) * 0.62;
}
export function hangTime(exitMph: number, launchDeg: number): number {
  const v = exitMph * 0.44704;
  return clamp(((2 * v * Math.sin((launchDeg * Math.PI) / 180)) / 9.81) * 0.85, 0.6, 7);
}

export class CrowdModel {
  /** model time, s */
  t = 0;
  /** smoothed 0..1 crowd level */
  level = 0.2;
  private rng: () => number;
  private lowPower: boolean;
  private homeFans: number;
  private envs: Env[] = [];
  private shots: (CrowdShot & { at: number })[] = [];
  private base = 0.2;
  private lev = 1;
  private tension = 0;
  private hush = 0;
  private prePitch = false;
  private ctxNow: CrowdCtx = { inning: 1, half: 'top', outs: 0, balls: 0, strikes: 0, score: { home: 0, away: 0 }, runners: [false, false, false] };
  /** a ball in the air with some carry */
  private air: { k: number; T: number; t0: number } | null = null;
  private stealing = false;
  private outsRecent: number[] = [];
  private halfRuns = 0;
  private zoneLevel = Object.fromEntries(ZONES.map((z) => [z.id, 0.2])) as Record<ZoneId, number>;
  private life = { clap: 5, shout: 9, whistle: 30, kid: 60, vendor: 28, seat: 18, chatter: 7, chant: 80, wave: 140 };
  private clapUntil = 0;
  /** what the last reactions were (debug / tests) */
  readonly log: { t: number; what: string }[] = [];

  constructor(o: CrowdOptions) {
    this.rng = o.rng;
    this.lowPower = !!o.lowPower;
    this.homeFans = o.homeFans ?? 0.7;
    for (const k of Object.keys(this.life) as (keyof typeof this.life)[]) this.life[k] *= 0.5 + this.rng();
  }

  // ---- inputs ----------------------------------------------------------------------------------------------------------

  /** the situation, every tick (cheap): leverage and tension follow it */
  setContext(c: CrowdCtx) {
    this.ctxNow = c;
    this.base = baseline({ inning: c.inning, outs: c.outs, balls: c.balls, strikes: c.strikes, score: c.score, runners: c.runners });
    this.lev = clamp(0.8 + 0.9 * (this.base - 0.2), 0.75, 1.3);
    const rsp = c.runners[1] || c.runners[2];
    const late = c.inning >= 7 && Math.abs(c.score.home - c.score.away) <= 2;
    let tn = 0;
    if (c.strikes >= 2) tn += 0.4;
    if (c.balls >= 3) tn += 0.15;
    if (c.balls >= 3 && c.strikes >= 2) tn += 0.15;
    if (rsp) tn += 0.15;
    if (late) tn += 0.2;
    this.tension = clamp(tn, 0, 1);
  }

  /** is the next batter / pitcher of the home team? */
  private get homeBatting() {
    return this.ctxNow.half === 'bottom';
  }
  private get homePitching() {
    return this.ctxNow.half === 'top';
  }

  // ---- building blocks ---------------------------------------------------------------------------------------------------

  private add(ch: Channel, tag: string, peak: number, a: number, h: number, d: number, delay = 0, side?: Side) {
    if (peak <= 0.002) return;
    if (this.envs.length > 24) this.envs.shift();
    this.envs.push({ ch, tag, peak: Math.min(1, peak), t0: this.t + delay, a, h, d, side });
  }

  /** a section where the visiting team's fans sit (near their dugout on the first-base side, and out in right field) */
  private awayZone(): ZoneId {
    return this.rng() < 0.6 ? 'line_1b' : 'rf_bleachers';
  }

  /** end the envelopes of a tag early (the foul ball that ends the anticipation) */
  private cut(tag: string, fade: number) {
    for (const e of this.envs) {
      if (e.tag !== tag || (e.kt !== undefined && e.kt <= this.t)) continue;
      e.kv = envValue(e, this.t);
      e.kt = this.t;
      e.kf = fade;
    }
  }

  private shot(id: ShotId, gain: number, delay = 0, o: Partial<CrowdShot> = {}) {
    const g = clamp(gain, 0, 1.4);
    if (g < 0.03) return;
    if (this.shots.length > 40) this.shots.shift();
    this.shots.push({ id, gain: g, delay: 0, at: this.t + delay, ...o });
  }

  private note(what: string) {
    this.log.push({ t: +this.t.toFixed(2), what });
    if (this.log.length > 120) this.log.shift();
  }

  /** a reaction to something good for `home` (true: the home team) of size 0..1.3 */
  private joy(forHome: boolean, size: number, o: { cheer?: CrowdId; delay?: number } = {}) {
    const L = this.lev;
    const dl = o.delay ?? 0;
    if (forHome) {
      this.shot(o.cheer ?? 'cheer_short', size * L, dl);
      this.add('energy', 'joy', 0.55 * size * L, 0.25, 0.5 + size, 1.4 + 1.6 * size, dl, 'home');
    } else {
      // visitors' fans are a minority: a small cheer from their corner, the home stands groan, a few boo
      this.shot(o.cheer ?? 'cheer_short', size * 0.3 * L, dl, { zone: this.awayZone() });
      this.shot('aww', size * 0.55 * L, dl + 0.1);
      if (size > 0.55 && this.rng() < 0.6) this.shot('boo_few', size * 0.4, dl + 0.6, { zone: this.rng() < 0.5 ? 'home_side' : 'backstop' });
      this.add('energy', 'joy', 0.14 * size * L, 0.3, 0.4, 1.3, dl);
      this.add('energy', 'joy-away', 0.5 * size * L, 0.25, 0.4 + size * 0.5, 1.4 + size, dl, 'away');
    }
  }

  /** the clap-clap, clap-clap-clap rhythm of the home crowd on two strikes */
  private clapPattern(strength: number) {
    if (this.t < this.clapUntil) return;
    const beat = 0.27;
    const pat = [0, 1, 3, 4, 5, 7, 8, 10, 11, 12];
    const g = (0.3 + 0.35 * strength) * (this.lowPower ? 0.9 : 1);
    // the whole home crowd claps together: the bowl, not one section
    pat.forEach((b) => this.shot('clap_burst', g * (0.85 + 0.15 * this.rng()), 0.1 + b * beat, { rate: 0.97 + this.rng() * 0.06, diffuse: true }));
    this.add('clap', 'rhythm', 0.35 * strength, 0.4, 2.2, 1.2, 0.1);
    this.clapUntil = this.t + 12 * beat + 0.6;
    this.note('clap pattern');
  }

  private dp(c: CrowdCtx, fielding: 'home' | 'visitor') {
    void c;
    this.joy(fielding === 'home', 1.0, { cheer: 'roar_med' });
    this.note('double play');
  }

  // ---- events ----------------------------------------------------------------------------------------------------------------

  observe(ev: RawEvent, c: CrowdCtx) {
    this.setContext(c);
    const L = this.lev;
    const hb = c.half === 'bottom'; // the home team bats
    const homeFielding = !hb;
    switch (ev.type) {
      case 'gameStart':
        this.shot('roar_med', 0.7, 0.1);
        this.add('energy', 'start', 0.3, 0.6, 1.5, 3);
        break;
      case 'batterUp':
        this.air = null;
        this.stealing = false;
        if (hb) {
          this.shot('applause_small', 0.25 + 0.2 * L, 0.6);
          if (this.rng() < 0.18) this.shot('chant', 0.3, 1.2);
        }
        break;
      case 'windup':
        this.prePitch = true;
        break;
      case 'pitchReleased':
      case 'pitchCrossed':
        this.prePitch = false;
        break;
      case 'swing':
        break;
      case 'contact':
        this.prePitch = false;
        this.onContact(ev, c);
        break;
      case 'call':
        this.onCall(ev, c);
        break;
      case 'catch': {
        if (ev.kind === 'pitch') break;
        if (ev.fly && String(ev.height) === 'low') {
          this.shot('applause_small', 0.55 * L, 0.2);
          this.shot('ooh', 0.4, 0);
          this.note('great catch');
        }
        break;
      }
      case 'wallContact':
        if (ev.who === 'ball') this.shot('gasp', 0.3, 0);
        break;
      case 'wallLeap':
        this.shot('gasp', 0.5, 0);
        this.add('energy', 'wall', 0.25 * L, 0.2, 0.5, 1.2);
        break;
      case 'robbedHomeRun': {
        this.cut('air', 0.3);
        this.air = null;
        this.shot('gasp', 0.9, 0);
        this.add('energy', 'robbed', 0.55 * L, 0.2, 0.6, 2.2);
        if (homeFielding) {
          this.shot('roar_med', 0.9 * L, 0.7);
          this.shot('applause', 0.7, 1.1);
          this.add('energy', 'robbed', 0.6 * L, 0.5, 1.5, 3, 0.7);
        } else {
          this.shot('groan', 0.85, 0.6);
          this.shot('boo_few', 0.4, 1.4);
          this.shot('cheer_short', 0.25, 0.9, { pan: 0.8 });
        }
        this.note('robbed home run');
        break;
      }
      case 'homeRun':
        this.onHomeRun(ev, c);
        break;
      case 'out':
        this.onOut(ev, c);
        break;
      case 'safe':
        this.onSafe(ev, c);
        break;
      case 'steal':
        this.stealing = true;
        this.shot('swell', 0.35 + 0.15 * L, 0.1, { rate: 1.25 });
        this.add('hush', 'steal', 0.3, 0.3, 1.2, 0.8);
        this.add('energy', 'steal', 0.12 * L, 0.5, 0.8, 1.5);
        break;
      case 'tagAttempt':
        this.shot('gasp', 0.3, 0);
        this.add('hush', 'tag', 0.3, 0.1, 0.8, 0.6);
        break;
      case 'tagAvoided':
        this.shot('ooh', 0.55, 0.1);
        break;
      case 'walk':
        if (ev.intentional) {
          this.shot('boo', 0.45, 0.2);
        } else if (hb) {
          this.shot('applause_small', 0.4 * L, 0.2);
          this.add('energy', 'walk', 0.15 * L, 0.3, 0.6, 1.5);
        } else {
          this.shot('aww', 0.32, 0.15);
          this.shot('boo_few', 0.25, 0.6);
        }
        break;
      case 'hitByPitch':
        this.shot('ooh', 0.5, 0.05);
        if (hb) this.shot('boo', 0.4, 0.5);
        else this.shot('cheer_short', 0.3, 0.4);
        break;
      case 'wildPitch':
      case 'passedBall':
        this.shot('ooh', 0.3, 0.1);
        break;
      case 'pitchClockViolation': {
        // the home crowd likes a violation against the visitors (a little cheer) and boos one against its own man (at the umpire, really)
        const againstHome = ev.team === 'home';
        this.shot('ooh', 0.3, 0.05);
        if (againstHome) {
          this.shot('boo', 0.4, 0.4);
          this.shot('groan', 0.3, 0.3);
        } else this.shot('cheer_short', 0.35 * L, 0.35);
        this.note('clock violation');
        break;
      }
      case 'balk':
        this.shot('ooh', 0.35, 0.1);
        this.shot('boo_few', 0.25, 0.5);
        break;
      case 'error':
        if (homeFielding) {
          this.shot('groan', 0.6, 0.2);
          this.shot('boo_few', 0.3, 0.9);
        } else this.shot('cheer_short', 0.45 * L, 0.3);
        this.add('energy', 'err', 0.18 * L, 0.2, 0.5, 1.4);
        break;
      case 'runScored':
        this.onRun(ev, c);
        break;
      case 'plateAppearanceEnd':
        this.onPaEnd(ev, c);
        break;
      case 'pitchingChange': {
        // polite applause for the home reliever, a mix for a visitor's
        const home = homeFielding;
        this.shot('applause_small', (home ? 0.55 : 0.4) * L, 0.8);
        if (!home && this.rng() < 0.6) this.shot('boo_few', 0.3, 1.0);
        this.note('pitching change');
        break;
      }
      case 'substitution':
        if (hb) this.shot('applause_small', 0.25, 0.5);
        break;
      case 'moundVisit':
        this.add('convo', 'visit', 0.7, 1, 7, 2);
        this.shot('chatter', 0.3, 0.5, { pan: -0.4 });
        this.shot('applause_small', 0.12, 1.8);
        this.shot('chatter', 0.25, 3.5, { pan: 0.5 });
        this.note('mound visit');
        break;
      case 'ballTossedToFan':
        this.shot('cheer_short', 0.35, 0.2, { pan: (this.rng() - 0.5) * 1.4 });
        this.shot('whoop', 0.25, 0.4);
        break;
      case 'halfInningEnd':
        this.air = null;
        this.halfRuns = 0;
        this.outsRecent.length = 0;
        break;
      case 'breakStart':
      case 'halfInningStart':
        this.halfRuns = 0;
        // the home crowd keeps itself busy between innings: a chant, a ripple of applause
        if (ev.type === 'breakStart' && this.rng() < 0.5) this.shot('chant', 0.35, 3 + this.rng() * 4);
        break;
      case 'gameEnd': {
        const w = String(ev.winner);
        if (w === 'home') {
          this.shot('roar_big', 1.0, 0.2);
          this.shot('applause', 0.9, 1.5);
          this.add('energy', 'end', 0.9, 0.8, 3, 6);
          this.add('clap', 'end', 0.7, 1, 5, 5);
        } else if (w === 'tie') this.shot('applause_small', 0.4, 0.3);
        else {
          this.shot('aww', 0.6, 0.2);
          this.shot('applause_small', 0.35, 1.0, { pan: 0.7 });
        }
        break;
      }
      default:
        break;
    }
  }

  private onContact(ev: RawEvent, c: CrowdCtx) {
    const exit = num(ev.exitMph);
    const launch = num(ev.launchDeg);
    const spray = num(ev.sprayDeg);
    const L = this.lev;
    if (exit <= 32) return; // a bunt
    const foulish = Math.abs(spray) > 45;
    const q = clamp((exit - 55) / 50, 0, 1);
    // the immediate pop: "ooh" for weak contact, a sharper rise for hard hits
    const gain = (0.12 + 0.5 * q) * L * (foulish ? 0.7 : 1);
    this.shot(q > 0.6 ? 'gasp' : 'ooh', gain, 0.04);
    if (q > 0.75) this.shot('ooh', gain * 0.8, 0.12);
    this.add('energy', 'pop', (0.05 + 0.27 * q) * L * (foulish ? 0.55 : 1), 0.32 - 0.22 * q, 0.1 + 0.5 * q, foulish ? 0.8 : 1.9);
    // a fly ball with carry: the crowd rises with it (anticipation) and holds its breath
    if (!foulish && launch >= 14 && exit >= 70) {
      const k = clamp((carryOf(exit, launch) - 45) / 65, 0, 1);
      if (k > 0.12) {
        const T = hangTime(exit, launch);
        this.air = { k, T, t0: this.t };
        this.add('energy', 'air', (0.12 + 0.5 * k) * L, T * 0.85, T * 0.35, 1.4);
        this.add('hush', 'air', 0.3 * k, 0.4, T, 0.6);
        this.shot('swell', 0.25 + 0.55 * k, 0.15, { rate: clamp(3.4 / (T + 0.9), 0.65, 1.5) });
        this.note(`anticipation k=${k.toFixed(2)} T=${T.toFixed(1)}`);
      }
    }
    void c;
  }

  private onCall(ev: RawEvent, c: CrowdCtx) {
    const cl = (ev.call ?? {}) as { kind?: string; balls?: number; strikes?: number };
    const kind = String(cl.kind ?? '');
    const L = this.lev;
    const strikes = num(cl.strikes, c.strikes);
    const balls = num(cl.balls, c.balls);
    this.prePitch = false;
    if (kind === 'foul' || kind === 'foulTip') {
      // the ball that was going to be something is not: the anticipation dies at once
      const k = this.air?.k ?? 0.15;
      this.cut('air', 0.35);
      this.cut('pop', 0.4);
      this.air = null;
      this.shot('aww', 0.2 + 0.3 * k, 0.12);
      this.note('foul');
      return;
    }
    const strike = kind === 'strikeLooking' || kind === 'strikeSwinging';
    if (kind === 'strikeSwinging') {
      this.shot('ooh', 0.22 * L, 0.05);
      if (this.homePitching) this.add('energy', 'swing', 0.08 * L, 0.1, 0.2, 0.9);
    }
    if (strike && strikes + 1 === 2 && this.homePitching) this.clapPattern(clamp(0.5 + this.tension * 0.5, 0, 1));
    if (kind === 'ball' && balls + 1 === 3 && strikes === 2) this.shot('swell', 0.25, 0.2, { rate: 1.3 });
  }

  private onHomeRun(ev: RawEvent, c: CrowdCtx) {
    void ev;
    const hb = c.half === 'bottom';
    const L = this.lev;
    this.cut('air', 2);
    const was = this.air;
    this.air = null;
    if (hb) {
      // first wave as it clears the wall; the roar keeps building for several seconds, with clapping, whistles and a second wave
      this.shot('roar_big', 1.0 * L, 0.05);
      this.add('energy', 'hr', 0.62, 0.5, 0.6, 2.2, 0, 'home');
      this.add('energy', 'hr-build', 1.0, 3.6, 2.4, 5.5, 0.3, 'home');
      this.add('clap', 'hr', 0.8, 2.5, 3.5, 4.5, 0.6);
      this.shot('cheer_short', 0.8 * L, 1.4, { rate: 0.92 });
      this.shot('whistle', 0.35, 1.6, { pan: this.rng() < 0.5 ? -0.6 : 0.6 });
      this.shot('roar_big', 0.85 * L, 2.6, { rate: 0.96 });
      this.shot('whoop', 0.35, 2.2);
      this.shot('whistle', 0.3, 3.4, { pan: this.rng() < 0.5 ? -0.5 : 0.5 });
      this.shot('applause', 0.9, 3.4);
      this.shot('cheer_short', 0.45, 5.2, { pan: 0.6, sweep: { from: -0.8, to: 0.8, dur: 3 } });
      this.note(`home run (home) was=${was ? was.k.toFixed(2) : 'no'}`);
    } else {
      // a visitor's home run: a groan, a few boos, a pocket of fans cheering, then quiet
      this.shot('groan', 0.8, 0.1);
      this.shot('boo_few', 0.45, 0.8);
      const z = this.awayZone();
      this.shot('cheer_short', 0.4 * L, 0.3, { zone: z });
      this.shot('applause_small', 0.3, 1.2, { zone: z });
      this.add('energy', 'hr', 0.25, 0.3, 0.5, 2.5);
      this.add('energy', 'hr-away', 0.75, 0.3, 1.2, 3, 0, 'away');
      this.note('home run (visitor)');
    }
  }

  private onOut(ev: RawEvent, c: CrowdCtx) {
    const L = this.lev;
    const ot = String(ev.outType);
    const hb = c.half === 'bottom';
    const homeFielding = !hb;
    // double and triple plays: outs within a few seconds of each other
    this.outsRecent = this.outsRecent.filter((x) => this.t - x < 6);
    this.outsRecent.push(this.t);
    const n = this.outsRecent.length;
    if (this.stealing) this.stealing = false;
    if (ot === 'strikeout') {
      this.cut('pop', 0.3);
      if (homeFielding) {
        this.shot('cheer_short', 0.8 * L, 0.2);
        this.add('energy', 'k', 0.3 * L, 0.2, 0.6, 1.8, 0.1);
      } else {
        this.shot('aww', 0.45 * L, 0.2);
        this.shot('groan', 0.2, 0.4);
      }
      this.note('strikeout');
      return;
    }
    if (n >= 2) {
      this.dp(c, homeFielding ? 'home' : 'visitor');
      if (n >= 3) this.shot('roar_big', homeFielding ? 0.9 : 0.4, 0.3);
      return;
    }
    const air = this.air;
    this.cut('air', 0.6);
    this.air = null;
    if (ot === 'fly' || ot === 'line' || ot === 'pop' || ot === 'foulFly') {
      const k = air?.k ?? 0.1;
      // the ball comes down in a glove: relief, then applause when it is the home team's out
      this.shot('oh_relief', 0.25 + 0.5 * k, 0.05);
      if (homeFielding) {
        this.shot('applause_small', (0.3 + 0.5 * k) * L, 0.3);
        this.add('energy', 'catch', 0.12 + 0.2 * k, 0.15, 0.4, 1.5);
      } else this.shot('aww', 0.2 + 0.25 * k, 0.4);
      this.note(`caught k=${k.toFixed(2)}`);
      return;
    }
    if (ot === 'caughtStealing' || ot === 'pickoff') {
      if (homeFielding) this.shot('cheer_short', 0.7 * L, 0.2);
      else this.shot('groan', 0.5, 0.2);
      return;
    }
    // ground outs, force plays, tags: routine, a little applause for the home defence, a sigh for the home batter
    if (ev.closePlay === true) {
      if (homeFielding) this.shot('roar_med', 0.8 * L, 0.1);
      else this.shot('groan', 0.65, 0.1);
      this.note('close out');
      return;
    }
    if (homeFielding) this.shot('applause_small', 0.2 * L, 0.3);
    else this.shot('aww', 0.18, 0.3);
  }

  private onSafe(ev: RawEvent, c: CrowdCtx) {
    const L = this.lev;
    const hb = c.half === 'bottom';
    const close = ev.closePlay === true;
    if (this.stealing) {
      this.stealing = false;
      if (hb) this.joy(true, 0.75, { cheer: 'cheer_short', delay: 0.1 });
      else {
        this.shot('ooh', 0.35, 0.1);
        this.shot('groan', 0.3, 0.3);
      }
      this.note('steal');
      return;
    }
    if (close) {
      // tension released: relief for the side it favours, a groan for the other
      if (hb) this.joy(true, 0.8, { cheer: 'roar_med', delay: 0.05 });
      else {
        this.shot('groan', 0.6, 0.1);
        this.add('energy', 'close', 0.15, 0.2, 0.4, 1.2);
      }
      this.note('close safe');
    }
    void L;
  }

  private onRun(ev: RawEvent, c: CrowdCtx) {
    const L = this.lev;
    const forHome = ev.team === 'home' || (ev.team === undefined && c.half === 'bottom');
    this.halfRuns++;
    const home = num(ev.runsHome, c.score.home);
    const away = num(ev.runsAway, c.score.away);
    const walkoff = forHome && c.half === 'bottom' && c.inning >= 9 && home > away && home - away <= 1;
    const big = this.halfRuns >= 3 ? 0.25 : 0;
    if (forHome) {
      if (walkoff) {
        this.shot('roar_big', 1.2, 0.1);
        this.shot('roar_big', 1.0, 1.6);
        this.shot('applause', 1.0, 2.6);
        this.shot('whistle', 0.4, 1.0);
        this.add('energy', 'walkoff', 1.0, 0.8, 4, 8);
        this.add('clap', 'walkoff', 0.9, 1.5, 5, 5);
        this.note('walk-off');
      } else {
        this.shot('roar_big', (0.6 + big) * L, 0.1);
        this.shot('applause', 0.5 + big, 1.5);
        this.add('energy', 'run', (0.5 + big) * L, 0.4, 1.2, 3.2, 0, 'home');
        this.add('clap', 'run', 0.55, 1, 2, 3.5, 0.5);
        this.note(`run (home) big=${big}`);
      }
    } else {
      this.shot('groan', 0.5, 0.15);
      this.shot('cheer_short', 0.3 * L, 0.2, { zone: this.awayZone() });
      this.add('energy', 'run', 0.1, 0.3, 0.4, 1.6);
      this.add('energy', 'run-away', 0.5 * L, 0.3, 0.8, 2.2, 0, 'away');
      this.note('run (visitor)');
    }
  }

  private onPaEnd(ev: RawEvent, c: CrowdCtx) {
    const L = this.lev;
    const hb = c.half === 'bottom';
    const r = String(ev.result ?? '');
    this.cut('air', 0.4);
    this.air = null;
    // in-play hits: a cheer scaled by impact and by whose side it is (the home runs have their own reaction)
    const size = r === 'single' ? 0.55 : r === 'double' ? 0.85 : r === 'triple' ? 1.05 : 0;
    if (size > 0) {
      this.joy(hb, size, { cheer: size > 0.9 ? 'roar_med' : size > 0.6 ? 'cheer_short' : 'applause_small', delay: 0.15 });
      this.note(`hit ${r} ${hb ? 'home' : 'visitor'}`);
    } else if (r === 'reached on error') {
      if (hb) this.shot('cheer_short', 0.3 * L, 0.2);
    } else if (r === 'sac fly' || r === 'sac bunt') {
      if (hb) this.shot('applause_small', 0.3, 0.2);
    }
  }

  // ---- time ------------------------------------------------------------------------------------------------------------------------

  /** advance by `dt` seconds (call ~10 times a second); `life`: also make the incidental sounds (off while paused / muted) */
  update(dt: number, life = true): CrowdBed {
    this.t += dt;
    let keep: Env[] = [];
    const sums: Record<Channel, number> = { energy: 0, clap: 0, hush: 0, convo: 0 };
    const prod: Record<Channel, number> = { energy: 1, clap: 1, hush: 1, convo: 1 };
    const zprod = ZONES.map(() => 1);
    for (const e of this.envs) {
      if (this.t > (e.kt !== undefined ? e.kt + (e.kf ?? 0.5) : envEnd(e))) continue;
      keep.push(e);
      const v = clamp(envValue(e, this.t), 0, 0.98);
      if (e.ch === 'energy') {
        // per section: home envelopes weigh by its home share, the visitors' by theirs; the visitors' own envelopes are not the bowl's
        ZONES.forEach((z, i) => {
          const w = e.side === 'home' ? clamp(z.home * 1.15, 0, 1) : e.side === 'away' ? clamp((1 - z.home) * 2, 0, 1) : 1;
          zprod[i] *= 1 - v * w;
        });
        if (e.side === 'away') continue;
      }
      prod[e.ch] *= 1 - v;
      sums[e.ch] += v;
    }
    this.envs = keep;
    keep = [];
    const energy = 1 - prod.energy;
    const target = clamp(this.base + (1 - this.base) * energy, 0.05, 1);
    // the crowd rises quickly and settles more slowly
    const rate = target > this.level ? 6 : 1.4;
    this.level += (target - this.level) * Math.min(1, rate * dt);
    // hush: leaning in on a tense count, more so right before the pitch
    const hTarget = clamp(Math.max(this.tension * (this.prePitch ? 0.9 : 0.4), 1 - prod.hush), 0, 1);
    this.hush += (hTarget - this.hush) * Math.min(1, (hTarget > this.hush ? 2.5 : 3.5) * dt);
    if (life) this.makeLife(dt, energy);
    const lv = this.level;
    const zones = {} as Record<ZoneId, number>;
    ZONES.forEach((z, i) => {
      const zt = clamp(this.base + (1 - this.base) * (1 - zprod[i]), 0.05, 1);
      const cur = this.zoneLevel[z.id];
      zones[z.id] = this.zoneLevel[z.id] = cur + (zt - cur) * Math.min(1, (zt > cur ? 6 : 1.4) * dt);
    });
    return {
      level: lv,
      murmur: (0.55 + 0.35 * lv) * (1 - 0.5 * this.hush) * (1 + 0.25 * (1 - prod.convo)),
      roar: Math.pow(lv, 1.6) * 1.25,
      clap: (1 - prod.clap) * 0.9,
      cutoff: (1600 + 4400 * lv) * (1 - 0.3 * this.hush),
      hush: this.hush,
      zones,
    };
  }

  private makeLife(dt: number, energy: number) {
    const f = this.lowPower ? 1.8 : 1; // phones: half as many incidental sounds
    const L = this.life;
    const r = this.rng;
    const pan = () => (r() * 2 - 1) * 0.9;
    const lv = this.level;
    L.clap -= dt;
    L.shout -= dt;
    L.whistle -= dt;
    L.kid -= dt;
    L.vendor -= dt;
    L.seat -= dt;
    L.chatter -= dt;
    L.chant -= dt;
    L.wave -= dt;
    if (L.clap <= 0) {
      L.clap = (5 + r() * 9 - lv * 3) * f;
      const n = r() < 0.3 ? 2 : 1;
      for (let i = 0; i < n; i++) this.shot('clap_single', 0.18 + 0.2 * r(), i * (0.35 + r() * 0.3), { pan: pan() });
    }
    if (L.shout <= 0) {
      L.shout = (10 + r() * 16) * f;
      this.shot(r() < 0.5 ? 'shout' : 'shout2', 0.14 + 0.18 * r() + 0.12 * lv, 0, { pan: pan(), rate: 0.9 + r() * 0.25 });
      if (r() < 0.3) this.shot('whoop', 0.15 + 0.15 * lv, 0.6, { pan: pan() });
    }
    if (L.whistle <= 0) {
      L.whistle = (28 + r() * 40 - lv * 15) * f;
      if (lv > 0.3 || r() < 0.4) this.shot('whistle', 0.16 + 0.14 * lv, 0, { pan: pan(), rate: 0.92 + r() * 0.2 });
    }
    if (L.kid <= 0) {
      L.kid = (70 + r() * 80) * f;
      this.shot('kid', 0.15 + 0.1 * r(), 0, { pan: pan(), rate: 0.9 + r() * 0.3 });
    }
    if (L.vendor <= 0) {
      L.vendor = (26 + r() * 30) * f;
      if (lv < 0.6) this.shot('vendor', 0.16 + 0.1 * r(), 0, { pan: pan(), rate: 0.92 + r() * 0.2 });
    }
    if (L.seat <= 0) {
      L.seat = (16 + r() * 28) * f;
      this.shot('seat_thump', 0.1 + 0.15 * r(), 0, { pan: pan() });
    }
    if (L.chatter <= 0) {
      L.chatter = (8 + r() * 14) * f;
      if (lv < 0.45) this.shot('chatter', 0.2 + 0.15 * r(), 0, { pan: pan(), rate: 0.95 + r() * 0.1 });
    }
    if (L.chant <= 0) {
      L.chant = (80 + r() * 90) * f;
      if (energy > 0.25 && this.homeBatting && this.tension > 0.3) this.shot('chant', 0.4 + 0.2 * lv, 0);
    }
    if (L.wave <= 0) {
      L.wave = (140 + r() * 140) * f;
      if (lv > 0.4) {
        const left = r() < 0.5;
        // the wave goes round the bowl section after section (the mixer plays it zone by zone)
        this.shot('cheer_short', 0.35 + 0.2 * lv, 0, { sweep: { from: left ? -0.9 : 0.9, to: left ? 0.9 : -0.9, dur: 6 }, rate: 0.85 });
        this.note('wave');
      }
    }
  }

  /** the one-shots that are due within `lookahead` seconds (their `delay` is relative to now) */
  take(lookahead = 0.12): CrowdShot[] {
    const out: CrowdShot[] = [];
    const rest: typeof this.shots = [];
    for (const s of this.shots) {
      if (s.at <= this.t + lookahead) {
        const { at, ...shot } = s;
        out.push({ ...shot, delay: Math.max(0, at - this.t) });
      } else rest.push(s);
    }
    this.shots = rest;
    return out;
  }

  /** current energy of the envelopes alone, 0..1, of the bowl (the visitors' own sections are in `zones`) (tests and debug) */
  get energy(): number {
    let p = 1;
    for (const e of this.envs) if (e.ch === 'energy' && e.side !== 'away') p *= 1 - clamp(envValue(e, this.t), 0, 0.98);
    return 1 - p;
  }

  reset() {
    this.envs = [];
    this.shots = [];
    this.air = null;
    this.level = this.base;
    for (const z of ZONES) this.zoneLevel[z.id] = this.base;
    this.hush = 0;
    this.stealing = false;
    this.outsRecent = [];
    this.halfRuns = 0;
    this.clapUntil = 0;
  }
}
