/**
 * The rolling game log: what happened pitch by pitch, plate appearance by plate appearance, built only from the sim's events.
 * Everything the booth says about "tonight" (tendencies, streaks, who has done what against whom) is derived from here or from the
 * state snapshot, never made up.
 */
import type { RawEvent } from '../types';
import { lastNameOf, type BoothCtx } from './ctx';

export type PitchResult = 'ball' | 'called' | 'swinging' | 'foul' | 'inplay' | 'hbp';

export interface PitchRec {
  n: number;
  pa: number;
  pitcherId: string;
  batterId: string;
  inning: number;
  half: 'top' | 'bottom';
  /** the count before the pitch */
  balls: number;
  strikes: number;
  type: string;
  mph: number;
  x?: number;
  y?: number;
  inZone?: boolean;
  result?: PitchResult;
}

export interface PaRec {
  n: number;
  batterId: string;
  pitcherId: string;
  inning: number;
  half: 'top' | 'bottom';
  pitches: number;
  result?: string;
  /** bases the batter reached (0 for outs) */
  reached: boolean;
  /** runs that scored during the plate appearance */
  runs?: number;
}

/** A moment worth recalling later (callbacks, the break recap, the closing): what happened, to whom, when. */
export interface Moment {
  kind: 'hr' | 'rbiHit' | 'robbed' | 'doublePlay' | 'strikeoutRisp' | 'stolenBase';
  inning: number;
  half: 'top' | 'bottom';
  batterId: string;
  pitcherId?: string;
  fielderId?: string;
  /** the PA result ('double', 'home run' ...) */
  result?: string;
  runs: number;
  /** the score after it (home, away) */
  score: { home: number; away: number };
  /** the batting side was behind, tied or ahead before it */
  before: 'behind' | 'tied' | 'ahead';
}

export const isFastball = (t: string) => t === 'FF' || t === 'FT' || t === 'SI' || t === 'FC';
export const isBreaking = (t: string) => t === 'SL' || t === 'CU' || t === 'SW';
export const isOffspeed = (t: string) => t === 'CH' || t === 'FS';
export const isHit = (r?: string) => !!r && /^(single|double|triple|home run)(?! play)/.test(r); // ("double play" is an out)
export const isK = (r?: string) => !!r && r.startsWith('strikeout');
export const isWalk = (r?: string) => !!r && /walk|hit by pitch/.test(r);
export const isOut = (r?: string) => !!r && !isHit(r) && !isWalk(r) && r !== 'reached on error' && r !== "fielder's choice";

export class GameLog {
  pitches: PitchRec[] = [];
  pas: PaRec[] = [];
  /** the current plate appearance */
  cur: PaRec | null = null;
  private pitchN = 0;
  private paN = 0;
  private pending: PitchRec | null = null;
  /** runs scored per half inning key `${inning}${t|b}` */
  runsByHalf = new Map<string, number>();
  /** steals this game per runner id: [attempts, successes] */
  steals = new Map<string, [number, number]>();
  scoreLine: { home: number; away: number }[] = [];
  /** home/away lead history for comebacks */
  maxDeficit = { home: 0, away: 0 };
  leadChanges = 0;
  private lastLeader: 'home' | 'away' | null = null;
  /** last batted ball */
  lastContact: { exitMph: number; launchDeg: number; sprayDeg: number; time: number; runnersOn: number } | null = null;
  /** outs recorded in the last play window (for double / triple plays) */
  recentOuts: number[] = [];
  /** time (sim seconds) of the last thing the booth narrated about the play */
  lastCallTime = -99;
  half = { hits: 0, walks: 0, ks: 0, runs: 0, batters: 0 };
  /** outs in the current half inning (counted from `out` events) */
  outs = 0;
  /** where the ball first met a glove this play (`fielded` / `catch`), metres from the plate */
  landing: { x: number; z: number; air: boolean; time: number; fielderId: string } | null = null;
  /** the ball hit the wall this play */
  lastWall = -99;
  /** a steal is in progress (until a safe / out) */
  stealing: { id: string; base: number; time: number } | null = null;
  /** pitcher id -> batters faced this game */
  private bf = new Map<string, number>();
  /** notable plays, in order (at most 60) */
  moments: Moment[] = [];
  private scoreBeforePa: { home: number; away: number } | null = null;
  private rispAtPa = false;

  private moment(m: Omit<Moment, 'before'>, before: { home: number; away: number }) {
    const bat = m.half === 'top' ? before.away - before.home : before.home - before.away;
    this.moments.push({ ...m, before: bat < 0 ? 'behind' : bat === 0 ? 'tied' : 'ahead' });
    if (this.moments.length > 60) this.moments.shift();
  }

  // -- feeding --------------------------------------------------------------------------------------------------------

  observe(ev: RawEvent, c: BoothCtx) {
    const time = Number(ev.time ?? c.time ?? 0);
    switch (ev.type) {
      case 'gameStart':
        this.reset();
        break;
      case 'halfInningStart':
      case 'halfInningEnd':
        this.half = ev.type === 'halfInningStart' ? { hits: 0, walks: 0, ks: 0, runs: 0, batters: 0 } : this.half;
        this.outs = 0;
        this.stealing = null;
        break;
      case 'batterUp': {
        this.paN++;
        const pa: PaRec = { n: this.paN, batterId: String(ev.batterId ?? ''), pitcherId: String(ev.pitcherId ?? ''), inning: c.inning, half: c.half, pitches: 0, reached: false };
        this.pas.push(pa);
        if (this.pas.length > 200) this.pas.shift();
        this.cur = pa;
        this.pending = null;
        this.scoreBeforePa = { ...c.score };
        this.rispAtPa = !!(c.runners[1] || c.runners[2]);
        this.bf.set(pa.pitcherId, (this.bf.get(pa.pitcherId) ?? 0) + 1);
        this.half.batters++;
        break;
      }
      case 'pitchReleased': {
        const pa = this.cur;
        const rec: PitchRec = {
          n: ++this.pitchN, pa: pa?.n ?? 0, pitcherId: String(ev.pitcherId ?? pa?.pitcherId ?? ''), batterId: pa?.batterId ?? '', inning: c.inning, half: c.half,
          balls: c.balls, strikes: c.strikes, type: String(ev.pitchType ?? ''), mph: Math.round(Number(ev.mph) || 0),
        };
        if (pa) pa.pitches++;
        this.pitches.push(rec);
        if (this.pitches.length > 600) this.pitches.shift();
        this.pending = rec;
        break;
      }
      case 'pitchCrossed':
        if (this.pending) {
          this.pending.x = Number(ev.x);
          this.pending.y = Number(ev.y);
          this.pending.inZone = !!ev.inZone;
        }
        break;
      case 'call': {
        const k = String((ev.call as { kind?: string } | undefined)?.kind ?? '');
        const p = this.pending;
        if (!p || p.result) break;
        const cl = ev.call as { balls?: number; strikes?: number };
        if (typeof cl.balls === 'number') {
          p.balls = cl.balls;
          p.strikes = cl.strikes ?? p.strikes;
        }
        if (k === 'ball') p.result = 'ball';
        else if (k === 'strikeLooking') p.result = 'called';
        else if (k === 'strikeSwinging') p.result = 'swinging';
        else if (k === 'foul' || k === 'foulTip') p.result = 'foul';
        else if (k === 'hitByPitch') p.result = 'hbp';
        break;
      }
      case 'contact':
        if (this.pending && !this.pending.result) this.pending.result = 'inplay';
        this.lastContact = { exitMph: Number(ev.exitMph) || 0, launchDeg: Number(ev.launchDeg) || 0, sprayDeg: Number(ev.sprayDeg) || 0, time, runnersOn: c.runners.filter(Boolean).length };
        this.recentOuts = [];
        break;
      case 'out':
        this.outs++;
        this.recentOuts.push(time);
        this.recentOuts = this.recentOuts.filter((t) => time - t < 6);
        break;
      case 'plateAppearanceEnd': {
        const pa = this.cur;
        const r = String(ev.result ?? '');
        if (pa) {
          pa.result = r;
          pa.reached = !isOut(r);
          const before = this.scoreBeforePa ?? c.score;
          const runs = pa.runs ?? 0;
          const base = { inning: pa.inning, half: pa.half, batterId: pa.batterId, pitcherId: pa.pitcherId, result: r, runs, score: { ...c.score } };
          if (/^home run/.test(r)) this.moment({ kind: 'hr', ...base }, before);
          else if (isHit(r) && runs > 0) this.moment({ kind: 'rbiHit', ...base }, before);
          else if (isK(r) && this.rispAtPa && this.outs >= 3) this.moment({ kind: 'strikeoutRisp', ...base }, before);
          else if (r === 'double play') this.moment({ kind: 'doublePlay', ...base }, before);
        }
        if (isHit(r)) this.half.hits++;
        if (isWalk(r)) this.half.walks++;
        if (isK(r)) this.half.ks++;
        break;
      }
      case 'runScored': {
        const k = `${c.inning}${c.half === 'top' ? 't' : 'b'}`;
        this.runsByHalf.set(k, (this.runsByHalf.get(k) ?? 0) + 1);
        this.half.runs++;
        if (this.cur) this.cur.runs = (this.cur.runs ?? 0) + 1;
        this.trackScore(c);
        break;
      }
      case 'fielded':
      case 'catch': {
        const p = ev.pos as { x?: number; z?: number } | undefined;
        if (p && typeof p.x === 'number' && typeof p.z === 'number' && (!this.landing || time - this.landing.time > 6)) this.landing = { x: p.x, z: p.z, air: ev.type === 'catch' && !!ev.fly, time, fielderId: String(ev.fielderId ?? '') };
        break;
      }
      case 'robbedHomeRun':
        this.moment({ kind: 'robbed', inning: c.inning, half: c.half, batterId: String(ev.batterId ?? this.cur?.batterId ?? ''), fielderId: String(ev.fielderId ?? ''), runs: 0, score: { ...c.score } }, c.score);
        break;
      case 'wallContact':
        this.lastWall = time;
        break;
      case 'steal': {
        const id = String(ev.runnerId ?? '');
        this.stealing = { id, base: Number(ev.toBase) || 0, time };
        const s = this.steals.get(id) ?? [0, 0];
        s[0]++;
        this.steals.set(id, s);
        break;
      }
      case 'safe':
        if (this.stealing && time - this.stealing.time < 8) this.noteSteal(this.stealing.id, true);
        break;
      default:
        break;
    }
  }

  /** score changed: remember leads for comeback detection */
  trackScore(c: BoothCtx) {
    const { home, away } = c.score;
    this.scoreLine.push({ home, away });
    this.maxDeficit.home = Math.max(this.maxDeficit.home, away - home);
    this.maxDeficit.away = Math.max(this.maxDeficit.away, home - away);
    const leader = home === away ? null : home > away ? 'home' : 'away';
    if (leader && this.lastLeader && leader !== this.lastLeader) this.leadChanges++;
    if (leader) this.lastLeader = leader;
  }

  noteSteal(id: string, success: boolean) {
    const s = this.steals.get(id) ?? [0, 0];
    if (success) s[1]++;
    this.steals.set(id, s);
  }

  reset() {
    this.pitches = [];
    this.pas = [];
    this.cur = null;
    this.pitchN = 0;
    this.paN = 0;
    this.pending = null;
    this.runsByHalf.clear();
    this.steals.clear();
    this.scoreLine = [];
    this.maxDeficit = { home: 0, away: 0 };
    this.leadChanges = 0;
    this.lastLeader = null;
    this.lastContact = null;
    this.recentOuts = [];
    this.outs = 0;
    this.landing = null;
    this.stealing = null;
    this.bf.clear();
    this.half = { hits: 0, walks: 0, ks: 0, runs: 0, batters: 0 };
    this.moments = [];
  }

  // -- queries --------------------------------------------------------------------------------------------------------

  pitchesInPa(): PitchRec[] {
    const pa = this.cur?.n;
    return pa ? this.pitches.filter((p) => p.pa === pa) : [];
  }

  pitcherPitches(pid: string): PitchRec[] {
    return this.pitches.filter((p) => p.pitcherId === pid);
  }

  /** pitch-type shares for a pitcher */
  mix(pid: string) {
    const ps = this.pitcherPitches(pid);
    const total = ps.length;
    const by: Record<string, number> = {};
    for (const p of ps) by[p.type] = (by[p.type] ?? 0) + 1;
    return { total, by, fb: ps.filter((p) => isFastball(p.type)).length, brk: ps.filter((p) => isBreaking(p.type)).length, off: ps.filter((p) => isOffspeed(p.type)).length };
  }

  /** what a pitcher has thrown on a count (balls, strikes) tonight */
  onCount(pid: string, balls: number, strikes: number): PitchRec[] {
    return this.pitches.filter((p) => p.pitcherId === pid && p.balls === balls && p.strikes === strikes && p.type);
  }

  /** consecutive same-type pitches at the end of this pitcher's log */
  streak(pid: string): { type: string; n: number } | null {
    const ps = this.pitcherPitches(pid);
    if (!ps.length) return null;
    const type = ps[ps.length - 1].type;
    let n = 0;
    for (let i = ps.length - 1; i >= 0 && ps[i].type === type; i--) n++;
    return { type, n };
  }

  /** consecutive fastballs (any fastball family) at the end of this pitcher's log */
  fastballStreak(pid: string): number {
    const ps = this.pitcherPitches(pid);
    let n = 0;
    for (let i = ps.length - 1; i >= 0 && isFastball(ps[i].type); i--) n++;
    return n;
  }

  batterPas(bid: string): PaRec[] {
    return this.pas.filter((p) => p.batterId === bid && p.result);
  }

  /** this plate appearance is the nth of this batter against this pitcher */
  timesThrough(bid: string, pid: string): number {
    return this.pas.filter((p) => p.batterId === bid && p.pitcherId === pid).length;
  }

  /** batters retired in a row by the pitcher (since the last baserunner) */
  retiredStreak(pid: string): number {
    const done = this.pas.filter((p) => p.pitcherId === pid && p.result);
    let n = 0;
    for (let i = done.length - 1; i >= 0 && !done[i].reached; i--) n++;
    return n;
  }

  /** baserunners the pitcher allowed in his last `k` batters faced */
  recentTrouble(pid: string, k = 4): number {
    const done = this.pas.filter((p) => p.pitcherId === pid && p.result).slice(-k);
    return done.filter((p) => p.reached).length;
  }

  batterVsPitcher(bid: string, pid: string): { pa: number; hits: number; ks: number; walks: number } {
    const ps = this.pas.filter((p) => p.batterId === bid && p.pitcherId === pid && p.result);
    return { pa: ps.length, hits: ps.filter((p) => isHit(p.result)).length, ks: ps.filter((p) => isK(p.result)).length, walks: ps.filter((p) => isWalk(p.result)).length };
  }

  runsInHalf(c: BoothCtx): number {
    return this.runsByHalf.get(`${c.inning}${c.half === 'top' ? 't' : 'b'}`) ?? 0;
  }

  /** consecutive completed half innings, most recent first, in which the team's pitchers allowed nothing */
  scorelessStreak(team: 'home' | 'away', c: BoothCtx): number {
    const pitchingHalf = team === 'home' ? 't' : 'b'; // the home team pitches while the visitors bat (top halves)
    let n = 0;
    for (let i = c.inning; i >= 1; i--) {
      const completed = pitchingHalf === 't' ? i < c.inning || c.half === 'bottom' : i < c.inning;
      if (!completed) continue;
      if ((this.runsByHalf.get(`${i}${pitchingHalf}`) ?? 0) > 0) break;
      n++;
    }
    return n;
  }

  batterName(bid: string, c: BoothCtx): string | undefined {
    const n = c.person?.(bid)?.name ?? (c.batter?.id === bid ? c.batter.name : undefined);
    return n ? lastNameOf(n) : undefined;
  }
}
