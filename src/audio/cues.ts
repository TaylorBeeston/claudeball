/**
 * Sim/engine event -> audio cues. Pure: no Web Audio, no DOM, no three.js (so it is unit-tested under node).
 *
 * Events arrive in the shape of the sim's own `GameEvent` (`RawEvent`). When only the engine's reduced `GameEvent`
 * stream is available (the `?mock` game) `engineToRaw` converts it first. Unknown events and missing fields are ignored.
 */
import { foulLanding } from './field';
import { PLACES } from './venue/mics';
import type { Cue, Importance, MapCtx, RawEvent, SpeakRole, Vec3 } from './types';

const MPH = 0.44704;
const FT = 3.28084;
const HOME: Vec3 = { x: 0, y: 0.9, z: 0 };
const BAG = 90 * 0.3048 / Math.SQRT2;
const BASE_POS: Record<number, Vec3> = {
  1: { x: -BAG, y: 0.5, z: BAG },
  2: { x: 0, y: 0.5, z: 2 * BAG },
  3: { x: BAG, y: 0.5, z: BAG },
  4: HOME,
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const vec = (v: unknown): Vec3 | undefined => {
  const o = v as Partial<Vec3> | null | undefined;
  return o && typeof o.x === 'number' && typeof o.z === 'number' ? { x: o.x, y: num(o.y, 0.5), z: o.z } : undefined;
};

/** Convert the engine's reduced GameEvent into the sim's event shape, for games that have no raw sim behind them. */
export function engineToRaw(e: { type: string } & Record<string, unknown>): RawEvent | null {
  switch (e.type) {
    case 'pitch': return { type: 'pitchReleased', mph: num(e.speed) / MPH, pitchType: e.pitchType, pitcherId: e.pitcherId };
    case 'contact': return { type: 'contact', exitMph: num(e.exitVelo) / MPH, launchDeg: num(e.launchAngle), sprayDeg: num(e.sprayAngle), batterId: e.batterId };
    case 'catch': return { type: 'catch', fielderId: e.playerId, fly: !!e.inAir };
    case 'throw': return { type: 'throw', fromId: e.playerId, toId: e.targetId ?? null, toBase: null, mph: 70, target: e.target };
    case 'out': return { type: 'out', playerId: e.playerId, outType: 'force', base: 1 };
    case 'homerun': return { type: 'homeRun', batterId: e.batterId, distance: e.distance, pos: e.pos };
    case 'base_touch': return { type: 'baseTouch', playerId: e.playerId, base: e.base, trot: e.trot, pos: e.pos };
    case 'wall_leap': return { type: 'wallLeap', fielderId: e.playerId, pos: e.pos };
    case 'ball': return { type: 'call', call: { kind: 'ball', balls: 0, strikes: 0 } };
    case 'strike': return { type: 'call', call: { kind: 'strikeLooking', balls: 0, strikes: 0 } };
    case 'foul': return { type: 'call', call: { kind: 'foul', balls: 0, strikes: 0 } };
    case 'play': return { type: 'playEnd', description: e.text };
    case 'half_inning': return { type: 'halfInningStart', inning: e.inning, half: e.half };
    case 'game_end': return { type: 'gameEnd', winner: e.winner };
    default: return null;
  }
}

export interface ContactClass {
  sound: 'bat_crack' | 'bat_thud' | 'bat_tick' | 'bunt_tap';
  /** 0..2 */
  bucket: number;
  gain: number;
  /** 0..1 */
  power: number;
}

/** Sound of the bat meeting the ball from the exit velocity and launch angle the physics produced. */
/** the catcher's mitt bucket by pitch speed: < 80, 80-88, 88-95, 95+ mph */
export const mittBucket = (mph: number) => (mph < 80 ? 0 : mph < 88 ? 1 : mph < 95 ? 2 : 3);

export function classifyContact(exitMph: number, launchDeg: number, sprayDeg: number): ContactClass {
  const power = clamp((exitMph - 40) / 65, 0, 1);
  if (exitMph <= 32) return { sound: 'bunt_tap', bucket: 0, gain: 0.55, power };
  if (exitMph < 58 && (launchDeg > 55 || Math.abs(sprayDeg) > 65)) return { sound: 'bat_tick', bucket: 0, gain: 0.6, power };
  // poor contact: a flare / pop off the end of the bat ("tock"), or jammed near the hands (a dull "thunk", usually beaten into the ground)
  if (launchDeg < -8 || exitMph < 62) return { sound: 'bat_thud', bucket: launchDeg > 20 ? 1 : 0, gain: 0.55 + 0.25 * power, power };
  return { sound: 'bat_crack', bucket: exitMph < 78 ? 0 : exitMph < 96 ? 1 : 2, gain: 0.6 + 0.4 * power, power };
}

/** What the umpire says. `strikes`/`balls` are the count *before* the call (as the sim reports them). */
export function umpireText(kind: string, balls: number, strikes: number): string | null {
  switch (kind) {
    case 'ball': return balls >= 3 ? 'Ball four!' : 'Ball!';
    case 'strikeLooking':
    case 'strikeSwinging': return strikes >= 2 ? 'Strike three!' : 'Strike!';
    case 'foul': return 'Foul ball!';
    case 'foulTip': return strikes >= 2 ? 'Strike three!' : 'Foul tip!';
    case 'hitByPitch': return 'Take your base!';
    case 'infieldFly': return 'Infield fly!';
    case 'balk': return 'Balk!';
    case 'safe': return 'Safe!';
    case 'out': return 'Out!';
    default: return null;
  }
}

/** What the umpire says for the sim's `umpireCall` kinds (fair ball and home run are signalled, not shouted). */
export function umpireCallText(kind: string): string | null {
  switch (kind) {
    case 'ball': return 'Ball!';
    case 'ball_four': return 'Ball four!';
    case 'strike_called':
    case 'strike_swinging': return 'Strike!';
    case 'strikeout': return 'Strike three!';
    case 'foul': return 'Foul ball!';
    case 'foul_tip': return 'Foul tip!';
    case 'safe': return 'Safe!';
    case 'out': return 'Out!';
    case 'time': return 'Time!';
    case 'play_ball': return 'Play ball!';
    default: return null;
  }
}

const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const ordinal = (n: number) => ORD[n] ?? `${n}th`;

function trimName(n: string) {
  return n.replace(/\s+/g, ' ').trim();
}

/** Team name as spoken: drop a trailing abbreviation-looking token, keep it short. */
/** the PA announcer's welcome at the start of the pregame (the booth's opening waits for it) */
export function paWelcome(c: Pick<MapCtx, 'teams' | 'venue' | 'tod'>): string {
  const hi = c.tod === 'day' ? 'Good afternoon' : c.tod ? 'Good evening' : null;
  return `${hi ? `${hi}, ladies` : 'Ladies'} and gentlemen, welcome to ${c.venue ?? 'Claudeball'}! ${c.tod === 'day' ? 'Today' : 'Tonight'}, the ${teamSay(c.teams.away)} visit your ${teamSay(c.teams.home)}.`;
}

function teamSay(s: string) {
  return trimName(s) || 'the visitors';
}

const cue = {
  sfx(id: Extract<Cue, { kind: 'sfx' }>['id'], imp: Importance, o: Partial<Extract<Cue, { kind: 'sfx' }>> = {}): Cue {
    return { kind: 'sfx', id, imp, ...o };
  },
  crowd(id: Extract<Cue, { kind: 'crowd' }>['id'], imp: Importance, gain = 1, delay = 0): Cue {
    return { kind: 'crowd', id, imp, gain, delay };
  },
  excite(amount: number, hold: number, imp: Importance = 1, delay = 0): Cue {
    return { kind: 'excite', amount, hold, imp, delay };
  },
  speak(role: SpeakRole, text: string, pri: number, ttl: number, delay = 0, imp: Importance = 2): Cue {
    return { kind: 'speak', role, text, pri, ttl, delay, imp };
  },
};

/** Speech priorities: higher wins the queue and may interrupt a lower line that is already being spoken. */
export const PRI = { color: 1, pbp: 3, pa: 4, ump: 5, big: 6 } as const;

export interface MapperOptions {
  /**
   * The sim's detailed events are available (`umpireCall`, `catch`/`fielded` with kind/firm, `tag`, `closePlay`): umpire voices come from
   * `umpireCall` (not from `call`, `out` or `safe`), pops from `catch` events (not from `pitchCrossed` or the throw's flight time).
   * Also switched on by the first `umpireCall` seen.
   */
  detailed?: boolean;
  /**
   * Keep the crowd cues (`crowd`, `excite`). The running game turns them off: the crowd reaction model (`crowd.ts`) makes every crowd
   * sound itself from the same events. On by default so the mapping stays testable on its own.
   */
  crowdCues?: boolean;
}

export class CueMapper {
  detailed: boolean;
  crowdCues: boolean;
  private lastTagT = -9;
  private close: { t: number } | null = null;

  constructor(opts: MapperOptions = {}) {
    this.detailed = !!opts.detailed;
    this.crowdCues = opts.crowdCues !== false;
  }

  private lastPitcherId = '';
  private lastExit = 0;
  private lastLaunch = 0;
  private lastPitchMph = 0;
  /** where the last pitch crossed the plate (m: x across, y height) */
  private lastPitchAt = { x: 0, y: 0.8 };
  private lastSpray = 0;
  private lastContactT = -9;
  /** a fielder sweeping with the bare hand (`tagAttempt` hand: 'hand'): his tag is a smack, not a glove */
  private tagHand = new Map<string, 'glove' | 'hand'>();
  private batters = 0;
  private lastPouchT = -9;
  private spokenPlay = false;
  private scoreAtPlayEnd = { home: 0, away: 0 };
  private plays = 0;
  private lastCall = { kind: '', t: -9 };

  reset() {
    this.lastPitcherId = '';
    this.spokenPlay = false;
    this.scoreAtPlayEnd = { home: 0, away: 0 };
    this.plays = 0;
  }

  map(ev: RawEvent, c: MapCtx): Cue[] {
    try {
      const cues = this.mapInner(ev, c);
      return this.crowdCues ? cues : cues.filter((k) => k.kind !== 'crowd' && k.kind !== 'excite');
    } catch {
      return []; // audio never breaks the game
    }
  }

  private homeBatting(c: MapCtx) {
    return c.half === 'bottom';
  }

  /** How much the home crowd cares: 1 for its own team, ~0.45 for the visitors. */
  private favour(c: MapCtx, homeSide: boolean) {
    return homeSide ? 1 : 0.45;
  }

  private lateClose(c: MapCtx) {
    return c.inning >= 7 && Math.abs(c.score.home - c.score.away) <= 2;
  }

  private mapInner(ev: RawEvent, c: MapCtx): Cue[] {
    const out: Cue[] = [];
    const hb = this.homeBatting(c);
    const t = ev.type;
    switch (t) {
      case 'gameStart': {
        this.reset();
        out.push(cue.crowd('roar_med', 2, 0.8), cue.speak('pa', paWelcome(c), PRI.pa, 20, 0.5, 1));
        out.push({ kind: 'organ', id: 'ditty', imp: 2, delay: 0.2 });
        break;
      }
      case 'batterUp': {
        const b = c.person(ev.batterId);
        const pid = str(ev.pitcherId);
        this.spokenPlay = false;
        if (pid && pid !== this.lastPitcherId) {
          const p = c.person(pid);
          if (p) out.push(cue.speak('pa', `Now pitching, number ${p.number ?? ''}, ${trimName(p.name)}.`.replace('number , ', ''), PRI.pa, 15, 0, 1));
          this.lastPitcherId = pid;
        }
        if (b) {
          out.push({ kind: 'sfx', id: 'pa_click', imp: 1, delay: 0, gain: 0.22 }); // a tiny PA mic click, not melodic
          out.push(cue.speak('pa', `Now batting, number ${b.number ?? ''}, ${trimName(b.name)}.`.replace('number , ', ''), PRI.pa, 15, 0.1, 1));
        }
        if (c.runners[1] || c.runners[2]) out.push(cue.excite(0.15, 6, 1));
        // the walk-up rituals, heard only by the dish behind home: batting gloves, a knock on the helmet, the bat against the spikes;
        // now and then the pitcher pats the rosin bag (a different one each batter, so it never becomes a pattern)
        {
          const n = this.batters++;
          const box = { x: 0.9, y: 1.2, z: 0.3 };
          if (n % 2 === 0) out.push(cue.sfx('velcro', 0, { pos: box, gain: 0.7, delay: 2.2 }));
          if (n % 3 !== 1) out.push(cue.sfx('bat_tap', 0, { pos: { ...box, y: 0.2 }, gain: 0.7, delay: 3.4 }));
          if (n % 3 === 1) out.push(cue.sfx('helmet_tap', 0, { pos: { ...box, y: 1.75 }, gain: 0.6, delay: 3.0 }));
          if (n % 4 === 2) out.push(cue.sfx('rosin_poof', 0, { pos: { x: 0.6, y: 0.3, z: 17.5 }, gain: 0.8, delay: 4.5 }));
        }
        if (hb) out.push({ kind: 'organ', id: 'walk_up', imp: 2, delay: 0.4, gain: 0.8 }); // the home batter's walk-up riff, under the PA
        break;
      }
      case 'pitchReleased': {
        const mph = num(ev.mph);
        this.lastPitchMph = mph;
        // the ball whipping past the plate: only the dish behind home hears it, as it arrives
        const rel = vec(ev.release) ?? { x: 0, y: 1.8, z: 16.5 };
        const flight = clamp(rel.z / Math.max(25, mph * MPH), 0.3, 0.65);
        out.push(cue.sfx('pitch_whoosh', 0, { pos: { x: num(ev.targetX, 0), y: 1, z: 1.2 }, bucket: mph >= 88 ? 1 : 0, gain: 0.35 + 0.3 * clamp((mph - 75) / 25, 0, 1), delay: flight - 0.06 }));
        break;
      }
      case 'pitchCrossed': {
        const mph = num(ev.mph, this.lastPitchMph);
        this.lastPitchAt = { x: num(ev.x), y: num(ev.y, 0.8) };
        const m = c.catcher ?? { x: 0, y: 0.8, z: -1.1 };
        if (!this.detailed) out.push(cue.sfx('mitt_pop', 1, { pos: m, bucket: mittBucket(mph), gain: 0.7 + 0.1 * mittBucket(mph), delay: 0.03 }));
        if (c.strikes >= 2) out.push(cue.excite(0.12, 2, 1));
        break;
      }
      case 'swing':
        out.push(cue.sfx('swing_whoosh', 1, { pos: c.pos(ev.batterId) ?? HOME, gain: 0.5, delay: 0.09 }));
        break;
      case 'contact': {
        const mph = num(ev.exitMph);
        const launch = num(ev.launchDeg);
        this.lastExit = mph;
        this.lastLaunch = launch;
        const spray = num(ev.sprayDeg);
        this.lastSpray = spray;
        this.lastContactT = num(ev.time);
        const k = classifyContact(mph, launch, spray);
        out.push(cue.sfx(k.sound, 2, { pos: vec(ev.pos) ?? HOME, bucket: k.bucket, gain: k.gain }));
        // a ball put in play: the batter drops the bat on the dirt as he takes off (a foul he keeps)
        if (k.sound !== 'bunt_tap' && Math.abs(spray) < 45 && launch < 70) {
          const b = c.pos(ev.batterId) ?? HOME;
          out.push(cue.sfx('bat_drop', 0, { pos: { x: b.x - 0.6, y: 0.1, z: b.z + 0.3 }, gain: 0.55, delay: 0.55 + 0.15 * clamp(launch / 40, 0, 1) }));
        }
        if (k.sound === 'bat_crack' || k.sound === 'bat_thud') {
          // a ball in the air with some carry: the crowd rises with it before it comes down
          const hang = launch > 15 && mph > 70;
          out.push(cue.excite(hang ? 0.25 + 0.5 * k.power : 0.1 + 0.2 * k.power, hang ? 4 : 1.5, 1));
          if (hang && mph >= 88) out.push(cue.crowd('swell', 1, 0.5 + 0.5 * k.power, 0.25));
        }
        break;
      }
      case 'call': {
        const cl = (ev.call ?? {}) as Record<string, unknown>;
        const kind = str(cl.kind);
        this.lastCall = { kind, t: num(ev.time) };
        const text = umpireText(kind, num(cl.balls, c.balls), num(cl.strikes, c.strikes));
        if (text && !this.detailed) out.push(cue.speak('ump', text, PRI.ump, 1.5, 0.05, 2));
        if (kind === 'foul' || kind === 'foulTip') out.push(cue.crowd('ooh', 1, 0.35, 0.15));
        if (kind === 'foul') {
          // the sim stops a foul when it is called: if it was going into the stands (or the net), it lands there a moment later
          const since = Math.max(0, num(ev.time) - this.lastContactT);
          const land = foulLanding(this.lastExit, this.lastLaunch, this.lastSpray);
          const left = clamp(land.t - since, 0.05, 6);
          if (land.where === 'seats') {
            out.push(cue.sfx('seat_thump', 1, { pos: land.pos, gain: 0.6, delay: left }));
            if (this.lastExit > 75) out.push(cue.sfx('seat_scramble', 0, { pos: land.pos, gain: 0.5, delay: left + 0.15 }));
          } else if (land.where === 'net') out.push(cue.sfx('fence_rattle', 1, { pos: land.pos, gain: 0.45, delay: left }));
          // the plate umpire digs a new ball out of his pouch
          if (num(ev.time) - this.lastPouchT > 8) {
            this.lastPouchT = num(ev.time);
            out.push(cue.sfx('pouch', 0, { pos: { ...PLACES.umpire, y: 1 }, gain: 0.6, delay: 1.6 }));
          }
        }
        if ((kind === 'strikeLooking' || kind === 'strikeSwinging') && num(cl.strikes) >= 2) out.push(cue.excite(0.3, 2, 1));
        break;
      }
      case 'fielded':
      case 'catch': {
        const p = vec(ev.pos) ?? c.pos(ev.fielderId);
        const fly = t === 'catch' && !!ev.fly;
        const kind = str(ev.kind);
        const firm = ev.firm !== false; // an edge-of-the-glove catch (firm: false) is duller and softer
        const arm = ev.side === 'arm';
        const height = str(ev.height);
        if (kind === 'pitch') {
          // the catcher's mitt: the pop by pitch speed, deader off the edge; a pitch in the dirt is blocked (a thud, a puff of dirt)
          const mph = this.lastPitchMph;
          const b0 = mittBucket(mph);
          const at = p ?? c.catcher;
          if (this.lastPitchAt.y < 0.25 && height === 'low') out.push(cue.sfx('mitt_block', 1, { pos: at, gain: 0.8 }));
          else {
            out.push(cue.sfx('mitt_pop', 1, { pos: at, bucket: Math.max(0, b0 - (firm ? 0 : 1)), gain: (0.7 + 0.1 * b0) * (firm ? 1 : 0.75) * (ev.side === 'backhand' ? 0.9 : 1), rate: firm ? 1 : 0.93 }));
            // a borderline pitch: he holds it still (framing) and the leather creaks
            const edge = Math.abs(this.lastPitchAt.x) > 0.17 && Math.abs(this.lastPitchAt.x) < 0.32;
            if (firm && edge) out.push(cue.sfx('mitt_creak', 0, { pos: at, gain: 0.5, delay: 0.12 }));
          }
        } else {
          // a fielder's glove: by what was caught and how
          const far = p ? Math.hypot(p.x, p.z) > 50 : false;
          const bucket = !firm ? 5 : kind === 'ground' || (t === 'fielded' && !fly) ? 4 : fly ? (far ? 3 : 1) : kind === 'line' || kind === 'pickoff' ? 2 : kind === 'throw' ? 1 : 0;
          const gain = [0.5, 0.75, 0.85, 0.8, 0.6, 0.6][bucket] * (arm ? 0.85 : 1);
          const rate = (ev.side === 'backhand' ? 1.06 : 1) * (height === 'high' ? 1.03 : height === 'low' ? 0.97 : 1);
          out.push(cue.sfx('glove_pop', 1, { pos: p, bucket, gain, rate }));
          // juggled: a second, softer grab
          if (t === 'fielded' && ev.clean === false) out.push(cue.sfx('glove_pop', 1, { pos: p, bucket: 5, gain: 0.45, delay: 0.22 }));
        }
        if (t === 'fielded' && ev.clean === false) out.push(cue.crowd('ooh', 1, 0.4, 0.1));
        if (fly) out.push(cue.crowd('applause_small', 1, 0.6 * this.favour(c, !hb), 0.2));
        break;
      }
      case 'error': {
        out.push(cue.crowd('groan', 2, hb ? 0.5 : 1, 0.1), cue.excite(0.15, 2, 1));
        const f = c.person(ev.fielderId);
        const how = ev.kind === 'throw' ? 'throws it away' : ev.kind === 'drop' ? 'drops it' : 'bobbles it';
        break;
      }
      case 'throw':
      case 'ballReturn': {
        const from = c.pos(ev.fromId);
        const to = vec(ev.target) ?? (ev.toId != null ? c.pos(ev.toId) : undefined) ?? (typeof ev.toBase === 'number' ? BASE_POS[ev.toBase as number] : undefined);
        const mph = num(ev.mph, 60);
        const casual = t === 'ballReturn';
        out.push(cue.sfx('throw_whip', casual ? 0 : 1, { pos: from, bucket: casual || mph < 55 ? 0 : mph < 80 ? 1 : 2, gain: casual ? 0.4 : 0.6 + 0.3 * clamp((mph - 50) / 45, 0, 1), delay: 0.02 }));
        if (from && to && !(this.detailed && !casual)) {
          const d = Math.hypot(to.x - from.x, to.z - from.z);
          const flight = clamp(d / Math.max(12, mph * MPH * 0.92), 0.08, 2.5);
          out.push(cue.sfx('glove_pop', casual ? 0 : 1, { pos: to, bucket: casual ? 0 : mph > 80 ? 2 : 1, gain: casual ? 0.5 : 0.75, delay: flight }));
        }
        break;
      }
      case 'tag': {
        this.lastTagT = num(ev.time);
        const at = vec(ev.pos) ?? c.pos(ev.fielderId);
        // with the ball in the bare hand: a smack on the body; with the glove: the swipe across the jersey and the dull impact
        if (this.tagHand.get(str(ev.fielderId)) === 'hand') out.push(cue.sfx('bare_smack', 2, { pos: at, gain: 0.7 }), cue.sfx('body_thump', 1, { pos: at, gain: 0.35, delay: 0.01 }));
        else out.push(cue.sfx('tag_slap', 2, { pos: at, gain: 0.85 }));
        break;
      }
      case 'tagAttempt':
        // the sweep itself is quiet; the slap (tag) or the miss (tagAvoided) is what you hear
        this.tagHand.set(str(ev.fielderId), ev.hand === 'hand' ? 'hand' : 'glove');
        break;
      case 'tagAvoided': {
        // the glove swishes through air: the runner slid or dodged out of the way
        out.push(cue.sfx('tag_miss', 2, { pos: c.pos(ev.fielderId) ?? c.pos(ev.runnerId), gain: 0.7 }), cue.crowd('ooh', 2, 0.8, 0.12), cue.excite(0.3, 2.5, 2, 0.1));
        break;
      }
      case 'umpireCall': {
        this.detailed = true;
        const kind = str(ev.kind);
        const text = umpireCallText(kind);
        const at = vec(ev.pos);
        // "Play ball!" waits behind the PA's pitcher / batter announcements (it must be heard: the booth's handoff answers it); live calls go stale fast
        if (text) out.push({ ...cue.speak('ump', text, PRI.ump, kind === 'play_ball' ? 10 : 1.5, 0.05, 2), pos: at } as Cue);
        // the close play resolves: relief for one side, groans for the other
        if ((kind === 'safe' || kind === 'out') && this.close && num(ev.time) - this.close.t < 4 && num(ev.time) >= this.close.t) {
          const homeWins = kind === 'out' ? !hb : hb; // out: the fielding side wins the play; safe: the batting side
          out.push(cue.crowd(homeWins ? 'roar_med' : 'groan', 2, homeWins ? 0.85 : 0.8, 0.15), cue.excite(homeWins ? 0.5 : 0.25, 4, 2, 0.15));
          this.close = null;
        }
        break;
      }
      case 'out': {
        const ot = str(ev.outType);
        const base = typeof ev.base === 'number' ? ev.base : null;
        const bp = base ? BASE_POS[base] : undefined;
        const tagged = num(ev.time) - this.lastTagT < 1.5; // a `tag` event already made the slap
        if ((ot === 'tag' || ot === 'caughtStealing' || ot === 'pickoff') && !tagged) out.push(cue.sfx('tag_slap', 2, { pos: bp ?? c.pos(ev.playerId), gain: 0.7, delay: 0.05 }));
        const routine = ot === 'fly' || ot === 'line' || ot === 'pop' || ot === 'foulFly' || ot === 'infieldFly';
        if (ot !== 'strikeout' && !routine && base && !this.detailed) out.push(cue.speak('ump', 'Out!', PRI.ump, 1.5, 0.15, 2));
        const fieldingHome = !hb;
        if (ev.closePlay === true) {
          // tension until the umpire rules (see umpireCall)
          this.close = { t: num(ev.time) };
          out.push(cue.crowd('ooh', 2, 0.75, 0.05), cue.excite(0.4, 3, 2));
        } else if (ot === 'strikeout') out.push(cue.crowd(fieldingHome ? 'cheer_short' : 'ooh', 2, fieldingHome ? 1 : 0.5, 0.2), cue.excite(0.4, 3, 1, 0.2));
        else out.push(cue.crowd(fieldingHome ? 'applause_small' : 'groan', 1, fieldingHome ? 0.7 : 0.35, 0.25));
        if (ot === 'strikeout' && fieldingHome) out.push({ kind: 'organ', id: 'sting', imp: 2, delay: 1.3, gain: 0.9 });
        break;
      }
      case 'safe': {
        const p = vec(ev.pos) ?? (typeof ev.base === 'number' ? BASE_POS[ev.base as number] : undefined) ?? c.pos(ev.playerId);
        if (!this.detailed) out.push(cue.speak('ump', 'Safe!', PRI.ump, 1.5, 0.12, 2));
        void p; // the slide itself comes from the runner's animation (index.ts): a force at first has none
        if (ev.closePlay === true) {
          this.close = { t: num(ev.time) };
          out.push(cue.crowd('ooh', 2, 0.75, 0.05), cue.excite(0.4, 3, 2));
        } else out.push(cue.crowd(hb ? 'cheer_short' : 'ooh', 1, hb ? 0.7 : 0.4, 0.2));
        break;
      }
      case 'steal':
        out.push(cue.excite(0.25, 3, 1));
        break;
      case 'walk': {
        out.push(cue.crowd(hb ? 'applause_small' : 'boo', 1, 0.4, 0.3));
        break;
      }
      case 'hitByPitch': {
        const bp = c.pos(ev.batterId) ?? HOME;
        out.push(cue.sfx('body_thump', 2, { pos: { x: bp.x, y: 1.1, z: bp.z }, gain: 0.85 }), cue.crowd('ooh', 1, 0.6, 0.15));
        break;
      }
      case 'wildPitch':
      case 'passedBall':
        out.push(cue.crowd('ooh', 1, 0.5, 0.2), cue.excite(0.2, 3, 1));
        break;
      case 'wallContact': {
        const speed = num(ev.speed, 10);
        const p = vec(ev.pos);
        if (ev.who === 'fielder') out.push(cue.sfx('wall_thud', 1, { pos: p, bucket: 0, gain: 0.45 + 0.35 * clamp(speed / 8, 0, 1) }));
        else {
          // the padding (2.4 m); off the top rail it rings a little too
          out.push(cue.sfx('wall_thud', 2, { pos: p, bucket: 1, gain: 0.55 + 0.45 * clamp(speed / 30, 0, 1) }));
          if (p && p.y > 2.15) out.push(cue.sfx('fence_rattle', 1, { pos: p, gain: 0.35 + 0.3 * clamp(speed / 35, 0, 1), delay: 0.01 }));
          out.push(cue.crowd('ooh', 1, 0.6, 0.1));
        }
        break;
      }
      case 'wallLeap':
        out.push(cue.crowd('gasp', 2, 0.8, 0), cue.excite(0.5, 3, 2));
        break;
      case 'robbedHomeRun': {
        const p = vec(ev.pos);
        const fieldingHome = !hb;
        out.push(cue.sfx('wall_thud', 2, { pos: p, bucket: 0, gain: 0.6 }));
        out.push(cue.crowd('gasp', 3, 1, 0.05), cue.crowd(fieldingHome ? 'roar_big' : 'groan', 3, fieldingHome ? 0.9 : 0.8, 0.9), cue.excite(0.9, 6, 3, 0.9));
        const f = c.person(ev.fielderId), b = c.person(ev.batterId);
        this.spokenPlay = true;
        break;
      }
      case 'homeRun': {
        const pos = vec(ev.pos) ?? c.pos(ev.batterId);
        const dist = num(ev.distance);
        const ft = Math.round(dist * FT);
        const b = c.person(ev.batterId);
        // the crack was heard at contact; this is the ball clearing the fence: the seats answer
        const dir = pos ? Math.hypot(pos.x, pos.z) || 1 : 1;
        const seat = pos ? { x: pos.x + (pos.x / dir) * 14, y: 6, z: pos.z + (pos.z / dir) * 14 } : undefined;
        out.push(cue.crowd('roar_big', 3, this.favour(c, hb), 0.1), cue.excite(1, 9, 3, 0.1));
        const landT = 0.7 + clamp(dist / 120, 0, 1) * 0.5;
        out.push(cue.sfx('seat_thump', 2, { pos: seat, gain: 0.8, delay: landT }), cue.sfx('seat_scramble', 1, { pos: seat, gain: 0.7, delay: landT + 0.2 }));
        // the batting team's bench: over the rail
        out.push(cue.sfx('rail_thump', 1, { pos: hb ? PLACES.dugoutHome : PLACES.dugoutAway, gain: 0.7, delay: 0.4 }));
        if (hb) {
          out.push({ kind: 'organ', id: 'hr_fanfare', imp: 3, delay: 1.2, gain: 1 });
          out.push(cue.sfx('firework', 3, { pos: { x: 0, y: 60, z: 130 }, gain: 0.6, delay: 1.6 }));
        } else out.push(cue.crowd('boo', 2, 0.35, 0.6));
        this.spokenPlay = true;
        const who = b ? trimName(b.name) : 'The batter';
        break;
      }
      case 'baseTouch': {
        const base = num(ev.base);
        const p = vec(ev.pos) ?? BASE_POS[base];
        out.push(cue.sfx('base_thud', 0, { pos: p, bucket: base === 4 ? 1 : 0, gain: ev.trot ? 0.3 : 0.55 }));
        if (base === 4 && ev.trot) out.push(cue.crowd('applause', 2, hb ? 0.7 : 0.25, 0.3));
        break;
      }
      case 'runScored': {
        const homeScored = ev.team === 'home' || (ev.team == null && hb);
        out.push(cue.crowd(homeScored ? 'cheer_short' : 'ooh', 2, homeScored ? 0.9 : 0.4, 0.2), cue.excite(0.5, 5, 2, 0.2));
        if (homeScored) out.push({ kind: 'organ', id: 'charge', imp: 2, delay: 1.0, gain: 1 });
        out.push(cue.sfx('rail_thump', 0, { pos: homeScored ? PLACES.dugoutHome : PLACES.dugoutAway, gain: 0.5, delay: 0.6 }));
        break;
      }
      case 'plateAppearanceEnd': {
        const r = str(ev.result);
        if (r === 'single' || r === 'double' || r === 'triple') {
          out.push(cue.crowd(r === 'single' ? 'applause_small' : 'cheer_short', 2, this.favour(c, hb) * (r === 'single' ? 0.8 : 1), 0.4), cue.excite(r === 'single' ? 0.35 : 0.6, 4, 2, 0.4));
          // a hit with runners on, or extra bases: the long rally build; otherwise the plain charge
          if (hb) out.push({ kind: 'organ', id: c.runners.some(Boolean) || r !== 'single' ? 'rally' : 'charge', imp: 2, delay: 1.2, gain: 1 });
        } else if (r === 'walk' || r === 'intentional walk') {
          if (hb) out.push({ kind: 'organ', id: 'charge', imp: 2, delay: 1.2, gain: 0.9 });
        } else if (r === 'double play') {
          out.push(cue.crowd(hb ? 'groan' : 'cheer_short', 2, 0.8, 0.3));
        }
        break;
      }
      case 'playEnd': {
        this.plays++;
        const desc = str(ev.description);
        const sc = c.score;
        const scored = sc.home !== this.scoreAtPlayEnd.home || sc.away !== this.scoreAtPlayEnd.away;
        this.scoreAtPlayEnd = { home: sc.home, away: sc.away };
        if (this.spokenPlay) {
          this.spokenPlay = false;
          break;
        }
        if (!desc) break;
        const score = scored ? ` ${teamSay(c.teams.away)} ${sc.away}, ${teamSay(c.teams.home)} ${sc.home}.` : '';
        // with umpire events the ruling ('Strike three!', 'Out!') comes 0.2-0.6 s after the play: let the umpire go first
        const lag = this.detailed ? 1.3 : 0.4;
        break;
      }
      case 'pitchingChange': {
        const p = c.person(ev.inId);
        this.lastPitcherId = str(ev.inId);
        if (p) out.push(cue.speak('pa', `Now pitching, number ${p.number ?? ''}, ${trimName(p.name)}.`.replace('number , ', ''), PRI.pa, 20, 1, 1));
        break;
      }
      case 'halfInningEnd': {
        const inn = num(ev.inning, c.inning);
        out.push(cue.crowd('applause_small', 1, 0.5, 0.5), cue.excite(-0.3, 4, 1));
        // the fielders jog off, gloves slapping their thighs (the infielders pass the base mics)
        out.push(cue.sfx('thigh_slap', 0, { pos: { x: 15, y: 0.9, z: 14 }, gain: 0.6, delay: 1.2 }), cue.sfx('thigh_slap', 0, { pos: { x: -14, y: 0.9, z: 15 }, gain: 0.5, delay: 2.1 }));
        if (inn === 7 && ev.half === 'top') out.push({ kind: 'organ', id: 'stretch', imp: 3, delay: 1.5, gain: 1 });
        else out.push({ kind: 'organ', id: 'ditty', imp: 2, delay: 1.5, gain: 0.9 });
        break;
      }
      case 'gameEnd': {
        const w = str(ev.winner);
        const hw = num(ev.home, c.score.home), aw = num(ev.away, c.score.away);
        out.push(cue.crowd(w === 'home' ? 'roar_big' : 'groan', 3, w === 'home' ? 1 : 0.6, 0.2), { kind: 'organ', id: w === 'home' ? 'hr_fanfare' : 'dirge', imp: 3, delay: 1, gain: 1 });
        const nm = w === 'home' ? c.teams.home : w === 'away' ? c.teams.away : '';
        break;
      }
      case 'timeCalled': {
        // time out: the plate umpire steps out and takes his mask off
        out.push(cue.sfx('ump_gear', 0, { pos: { ...PLACES.umpire, y: 1.5 }, gain: 0.7, delay: 0.4 }));
        break;
      }
      case 'ballKidRetrieve': {
        const p = vec(ev.pos);
        if (p) out.push(cue.sfx('bare_smack', 0, { pos: { ...p, y: 0.3 }, gain: 0.25, delay: 0.1 }));
        break;
      }
      case 'ballTossedToFan': {
        const p = vec(ev.pos);
        if (p) out.push(cue.sfx('throw_whip', 0, { pos: p, bucket: 0, gain: 0.35 }));
        break;
      }
      case 'batBoyRetrieve': {
        // the bat back in the rack, in the batting team's dugout
        out.push(cue.sfx('bat_rack', 0, { pos: hb ? PLACES.dugoutHome : PLACES.dugoutAway, gain: 0.7, delay: 4 }));
        break;
      }
      default:
        break;
    }
    void this.lastLaunch;
    return out;
  }
}

/** Speed gating: which cues survive at a given sim speed. Everything is dropped while fast-forwarding. */
export function allowedAtSpeed(imp: Importance, speed: number, skipping: boolean): boolean {
  if (skipping) return false;
  if (speed <= 1.01) return true;
  if (speed <= 2.01) return imp >= 1;
  return imp >= 2;
}

export { HOME, BASE_POS };
