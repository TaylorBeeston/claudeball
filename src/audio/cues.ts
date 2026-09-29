/**
 * Sim/engine event -> audio cues. Pure: no Web Audio, no DOM, no three.js (so it is unit-tested under node).
 *
 * Events arrive in the shape of the sim's own `GameEvent` (`RawEvent`). When only the engine's reduced `GameEvent`
 * stream is available (the `?mock` game) `engineToRaw` converts it first. Unknown events and missing fields are ignored.
 */
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
export function classifyContact(exitMph: number, launchDeg: number, sprayDeg: number): ContactClass {
  const power = clamp((exitMph - 40) / 65, 0, 1);
  if (exitMph <= 32) return { sound: 'bunt_tap', bucket: 0, gain: 0.55, power };
  if (exitMph < 58 && (launchDeg > 55 || Math.abs(sprayDeg) > 65)) return { sound: 'bat_tick', bucket: 0, gain: 0.6, power };
  if (launchDeg < -8 || exitMph < 62) return { sound: 'bat_thud', bucket: exitMph < 50 ? 0 : 1, gain: 0.55 + 0.25 * power, power };
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

const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const ordinal = (n: number) => ORD[n] ?? `${n}th`;

function trimName(n: string) {
  return n.replace(/\s+/g, ' ').trim();
}

/** Team name as spoken: drop a trailing abbreviation-looking token, keep it short. */
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

export class CueMapper {
  private lastPitcherId = '';
  private lastExit = 0;
  private lastLaunch = 0;
  private lastPitchMph = 0;
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
      return this.mapInner(ev, c);
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
        out.push(cue.crowd('roar_med', 2, 0.8), cue.speak('pa', `Ladies and gentlemen, welcome to Claudeball. Tonight, the ${teamSay(c.teams.away)} visit the ${teamSay(c.teams.home)}.`, PRI.pa, 20, 0.5, 1));
        out.push({ kind: 'organ', id: 'ditty', imp: 1, delay: 0.2 });
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
          out.push({ kind: 'sfx', id: 'pa_chime', imp: 1, delay: 0, gain: 0.5 });
          out.push(cue.speak('pa', `Now batting, number ${b.number ?? ''}, ${trimName(b.name)}.`.replace('number , ', ''), PRI.pa, 15, 0.1, 1));
          const line = c.batterLine?.(ev.batterId);
          if (line && line.ab >= 2 && this.plays % 3 === 1) out.push(cue.speak('color', `${trimName(b.name)} is ${line.h} for ${line.ab} today.`, PRI.color, 6, 4, 1));
        }
        if (c.runners[1] || c.runners[2]) out.push(cue.excite(0.15, 6, 1));
        break;
      }
      case 'pitchReleased': {
        const mph = num(ev.mph);
        this.lastPitchMph = mph;
        out.push(cue.sfx('pitch_whoosh', 0, { pos: vec(ev.release) ?? { x: 0, y: 1.8, z: 16.5 }, gain: 0.22 + 0.1 * clamp((mph - 70) / 30, 0, 1), delay: 0.03 }));
        break;
      }
      case 'pitchCrossed': {
        const mph = num(ev.mph, this.lastPitchMph);
        const bucket = mph < 82 ? 0 : mph < 92 ? 1 : 2;
        const m = c.catcher ?? { x: 0, y: 0.8, z: -1.1 };
        out.push(cue.sfx('mitt_pop', 1, { pos: m, bucket, gain: 0.62 + 0.14 * bucket, delay: 0.03 }));
        if (mph >= 99 && this.plays % 2 === 0) out.push(cue.speak('color', `${Math.round(mph)} miles an hour.`, PRI.color, 3, 0.6, 1));
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
        const k = classifyContact(mph, launch, num(ev.sprayDeg));
        out.push(cue.sfx(k.sound, 2, { pos: vec(ev.pos) ?? HOME, bucket: k.bucket, gain: k.gain }));
        if (k.sound === 'bat_crack' || k.sound === 'bat_thud') {
          // a ball in the air with some carry: the crowd rises with it before it comes down
          const hang = launch > 15 && mph > 70;
          out.push(cue.excite(hang ? 0.25 + 0.5 * k.power : 0.1 + 0.2 * k.power, hang ? 4 : 1.5, 1));
          if (hang && mph >= 88) out.push(cue.crowd('swell', 1, 0.5 + 0.5 * k.power, 0.25));
        }
        if (mph >= 100) out.push(cue.speak('pbp', 'Hit hard!', PRI.pbp, 2, 0.3, 1));
        break;
      }
      case 'call': {
        const cl = (ev.call ?? {}) as Record<string, unknown>;
        const kind = str(cl.kind);
        this.lastCall = { kind, t: num(ev.time) };
        const text = umpireText(kind, num(cl.balls, c.balls), num(cl.strikes, c.strikes));
        if (text) out.push(cue.speak('ump', text, PRI.ump, 1.5, 0.05, 2));
        if (kind === 'foul' || kind === 'foulTip') out.push(cue.crowd('ooh', 1, 0.35, 0.15));
        if ((kind === 'strikeLooking' || kind === 'strikeSwinging') && num(cl.strikes) >= 2) out.push(cue.excite(0.3, 2, 1));
        break;
      }
      case 'fielded': {
        const p = vec(ev.pos) ?? c.pos(ev.fielderId);
        out.push(cue.sfx('glove_pop', 1, { pos: p, bucket: 0, gain: 0.65 }));
        if (ev.clean === false) out.push(cue.crowd('ooh', 1, 0.4, 0.1));
        break;
      }
      case 'catch': {
        const p = vec(ev.pos) ?? c.pos(ev.fielderId);
        out.push(cue.sfx('glove_pop', 1, { pos: p, bucket: ev.fly ? 1 : 0, gain: ev.fly ? 0.7 : 0.5 }));
        if (ev.fly) out.push(cue.crowd('applause_small', 1, 0.6 * this.favour(c, !hb), 0.2));
        break;
      }
      case 'error': {
        out.push(cue.crowd('groan', 2, hb ? 0.5 : 1, 0.1), cue.excite(0.15, 2, 1));
        const f = c.person(ev.fielderId);
        const how = ev.kind === 'throw' ? 'throws it away' : ev.kind === 'drop' ? 'drops it' : 'bobbles it';
        if (f) out.push(cue.speak('pbp', `${trimName(f.name)} ${how}!`, PRI.pbp, 3, 0.3, 2));
        break;
      }
      case 'throw':
      case 'ballReturn': {
        const from = c.pos(ev.fromId);
        const to = vec(ev.target) ?? (ev.toId != null ? c.pos(ev.toId) : undefined) ?? (typeof ev.toBase === 'number' ? BASE_POS[ev.toBase as number] : undefined);
        const mph = num(ev.mph, 60);
        const casual = t === 'ballReturn';
        out.push(cue.sfx('throw_whip', casual ? 0 : 1, { pos: from, gain: casual ? 0.25 : 0.4 + 0.3 * clamp((mph - 50) / 45, 0, 1), delay: 0.02 }));
        if (from && to) {
          const d = Math.hypot(to.x - from.x, to.z - from.z);
          const flight = clamp(d / Math.max(12, mph * MPH * 0.92), 0.08, 2.5);
          out.push(cue.sfx('glove_pop', casual ? 0 : 1, { pos: to, bucket: casual ? 0 : 1, gain: casual ? 0.4 : 0.75, delay: flight }));
        }
        break;
      }
      case 'tag':
      case 'tagAttempt': {
        out.push(cue.sfx('tag_slap', 2, { pos: vec(ev.pos) ?? c.pos(ev.fielderId ?? ev.playerId), gain: 0.7 }));
        break;
      }
      case 'out': {
        const ot = str(ev.outType);
        const base = typeof ev.base === 'number' ? ev.base : null;
        const bp = base ? BASE_POS[base] : undefined;
        if (ot === 'tag' || ot === 'caughtStealing' || ot === 'pickoff') out.push(cue.sfx('tag_slap', 2, { pos: bp ?? c.pos(ev.playerId), gain: 0.7, delay: 0.05 }));
        const routine = ot === 'fly' || ot === 'line' || ot === 'pop' || ot === 'foulFly' || ot === 'infieldFly';
        if (ot !== 'strikeout' && !routine && base) out.push(cue.speak('ump', 'Out!', PRI.ump, 1.5, 0.15, 2));
        const fieldingHome = !hb;
        if (ot === 'strikeout') out.push(cue.crowd(fieldingHome ? 'cheer_short' : 'ooh', 2, fieldingHome ? 1 : 0.5, 0.2), cue.excite(0.4, 3, 1, 0.2));
        else out.push(cue.crowd(fieldingHome ? 'applause_small' : 'groan', 1, fieldingHome ? 0.7 : 0.35, 0.25));
        if (c.outs >= 2) out.push({ kind: 'organ', id: 'sting', imp: 1, delay: 1.2, gain: 0.6 });
        break;
      }
      case 'safe': {
        const p = vec(ev.pos) ?? (typeof ev.base === 'number' ? BASE_POS[ev.base as number] : undefined) ?? c.pos(ev.playerId);
        out.push(cue.speak('ump', 'Safe!', PRI.ump, 1.5, 0.12, 2), cue.sfx('slide_scuff', 1, { pos: p, gain: 0.5 }));
        out.push(cue.crowd(hb ? 'cheer_short' : 'ooh', 1, hb ? 0.7 : 0.4, 0.2));
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
        out.push(cue.sfx('body_thump', 2, { pos: c.pos(ev.batterId) ?? HOME, gain: 0.7 }), cue.crowd('ooh', 1, 0.6, 0.15));
        break;
      }
      case 'wildPitch':
      case 'passedBall':
        out.push(cue.crowd('ooh', 1, 0.5, 0.2), cue.excite(0.2, 3, 1));
        break;
      case 'wallContact': {
        const speed = num(ev.speed, 10);
        const p = vec(ev.pos);
        if (ev.who === 'fielder') out.push(cue.sfx('wall_thud', 1, { pos: p, gain: 0.35 + 0.25 * clamp(speed / 8, 0, 1) }));
        else {
          out.push(cue.sfx('wall_thud', 2, { pos: p, gain: 0.55 + 0.45 * clamp(speed / 30, 0, 1) }));
          if (speed > 14) out.push(cue.sfx('fence_rattle', 1, { pos: p, gain: 0.4 + 0.4 * clamp(speed / 35, 0, 1), delay: 0.03 }));
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
        out.push(cue.sfx('wall_thud', 2, { pos: p, gain: 0.5 }), cue.sfx('glove_pop', 2, { pos: p, bucket: 1, gain: 0.7, delay: 0.05 }));
        out.push(cue.crowd('gasp', 3, 1, 0.05), cue.crowd(fieldingHome ? 'roar_big' : 'groan', 3, fieldingHome ? 0.9 : 0.8, 0.9), cue.excite(0.9, 6, 3, 0.9));
        const f = c.person(ev.fielderId), b = c.person(ev.batterId);
        this.spokenPlay = true;
        if (f) out.push(cue.speak('pbp', `Robbed! ${trimName(f.name)} takes a home run away${b ? ` from ${trimName(b.name)}` : ''}!`, PRI.big, 5, 0.6, 3));
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
        out.push(cue.sfx('seat_thump', 2, { pos: seat, gain: 0.7, delay: 0.7 + clamp(dist / 120, 0, 1) * 0.5 }));
        if (hb) {
          out.push({ kind: 'organ', id: 'hr_fanfare', imp: 3, delay: 1.2 });
          out.push(cue.sfx('firework', 3, { pos: { x: 0, y: 60, z: 130 }, gain: 0.6, delay: 1.6 }));
        } else out.push(cue.crowd('boo', 2, 0.35, 0.6));
        this.spokenPlay = true;
        const who = b ? trimName(b.name) : 'The batter';
        out.push(cue.speak('pbp', `${who} swings, and it's outta here! ${ft} feet!`, PRI.big, 6, 0.25, 3));
        if (this.lastExit > 0) out.push(cue.speak('color', `That one left the bat at ${Math.round(this.lastExit)} miles an hour.`, PRI.color + 1, 12, 3.2, 2));
        break;
      }
      case 'baseTouch': {
        const base = num(ev.base);
        const p = vec(ev.pos) ?? BASE_POS[base];
        out.push(cue.sfx('base_thud', 0, { pos: p, gain: 0.3 }));
        if (base === 4 && ev.trot) out.push(cue.crowd('applause', 2, hb ? 0.7 : 0.25, 0.3));
        break;
      }
      case 'runScored': {
        const homeScored = ev.team === 'home' || (ev.team == null && hb);
        out.push(cue.crowd(homeScored ? 'cheer_short' : 'ooh', 2, homeScored ? 0.9 : 0.4, 0.2), cue.excite(0.5, 5, 2, 0.2));
        if (homeScored) out.push({ kind: 'organ', id: 'charge', imp: 2, delay: 1.0, gain: 0.8 });
        break;
      }
      case 'plateAppearanceEnd': {
        const r = str(ev.result);
        if (r === 'single' || r === 'double' || r === 'triple') {
          out.push(cue.crowd(r === 'single' ? 'applause_small' : 'cheer_short', 2, this.favour(c, hb) * (r === 'single' ? 0.8 : 1), 0.4), cue.excite(r === 'single' ? 0.35 : 0.6, 4, 2, 0.4));
          if (hb) out.push({ kind: 'organ', id: r === 'single' ? 'charge' : 'ditty', imp: 1, delay: 1.5, gain: 0.7 });
        } else if (r.startsWith('strikeout') && !hb) {
          out.push({ kind: 'organ', id: 'sting', imp: 1, delay: 1.0, gain: 0.7 });
        } else if (r === 'walk' || r === 'intentional walk') {
          if (hb) out.push({ kind: 'organ', id: 'walk_up', imp: 1, delay: 1.0, gain: 0.7 });
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
        out.push(cue.speak('pbp', desc + score, scored ? PRI.pbp + 1 : PRI.pbp - 1, scored ? 8 : 5, 0.4, 1));
        if (/strikes out/.test(desc)) {
          const p = c.pitcherLine?.(this.lastPitcherId);
          if (p && p.so > 0) out.push(cue.speak('color', `That's strikeout number ${p.so} on the night.`, PRI.color, 6, 2.5, 1));
        }
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
        if (inn === 7 && ev.half === 'top') out.push({ kind: 'organ', id: 'stretch', imp: 2, delay: 1.5, gain: 0.9 });
        else out.push({ kind: 'organ', id: 'ditty', imp: 1, delay: 1.5, gain: 0.7 });
        if (ev.half === 'bottom' && inn >= 2)
          out.push(cue.speak('color', `After ${inn}, it's ${teamSay(c.teams.away)} ${c.score.away}, ${teamSay(c.teams.home)} ${c.score.home}.`, PRI.color, 10, 3, 1));
        break;
      }
      case 'gameEnd': {
        const w = str(ev.winner);
        const hw = num(ev.home, c.score.home), aw = num(ev.away, c.score.away);
        out.push(cue.crowd(w === 'home' ? 'roar_big' : 'groan', 3, w === 'home' ? 1 : 0.6, 0.2), { kind: 'organ', id: w === 'home' ? 'hr_fanfare' : 'dirge', imp: 3, delay: 1, gain: 0.8 });
        const nm = w === 'home' ? c.teams.home : w === 'away' ? c.teams.away : '';
        out.push(cue.speak('pbp', w === 'tie' ? "And that's the ballgame." : `And that's the ballgame. ${teamSay(nm)} win, ${Math.max(hw, aw)} to ${Math.min(hw, aw)}.`, PRI.big, 20, 0.5, 3));
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
