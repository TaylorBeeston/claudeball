/**
 * The booth: a play-by-play voice and a colour analyst who talk about what is actually happening in the game.
 *
 * Pure module (no Web Audio, no DOM). `Chatter` keeps a small memory built from the sim's events (the pitch log of the current plate
 * appearance, each pitcher's pitch mix, each batter's results, runs per half inning) and turns it plus a snapshot (`ChatCtx`) into spoken lines.
 *  - `react(event, ctx)`: lines tied to an event (a pitch result, a new batter, a play, a half inning ending ...)
 *  - `pull(ctx, phase)`: one filler line or a play-by-play / colour exchange when the booth has been quiet for a while
 *
 * Rules the templates follow: every fact comes from the sim state or the events (nothing is invented), no pronouns for players
 * (they are named or called "the batter"), numbers are the real ones, and a template id never repeats within a window.
 * Priorities: filler 1, colour 1-2, pitch narration 2, banter 2; the event-driven calls in `cues.ts` outrank all of these.
 */
import type { RawEvent } from './types';

export type ChatterLevel = 'low' | 'normal' | 'high';
export type Phase = 'prePitch' | 'betweenBatters' | 'break';

export interface ChatPerson {
  id: string;
  name: string;
  number?: number;
  /** bats (batters) or throws (pitchers) */
  hand?: 'L' | 'R' | 'S';
  ratings?: Record<string, number>;
  /** batter line this game */
  bat?: { pa: number; ab: number; h: number; hr: number; bb: number; so: number; rbi: number; sb: number; doubles?: number; triples?: number };
  /** pitcher line this game */
  pit?: { outs: number; so: number; bb: number; h: number; er: number; r?: number; pitches: number; hr: number };
}

export interface ChatCtx {
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  balls: number;
  strikes: number;
  score: { home: number; away: number };
  runners: [boolean, boolean, boolean];
  /** names of the runners on first, second, third (when known) and their speed grade */
  runnerNames?: [string?, string?, string?];
  runnerSpeed?: [number?, number?, number?];
  teams: { home: string; away: string };
  batter?: ChatPerson;
  pitcher?: ChatPerson;
  /** crowd excitement 0..1 */
  crowd?: number;
  /** the sim's description of the last play, if any */
  lastPlay?: string;
}

export interface ChatLine {
  role: 'pbp' | 'color';
  text: string;
  pri: number;
  ttl: number;
  /** seconds after the line is queued (banter: the reply) */
  delay: number;
  /** lines of one exchange: if one is dropped the rest are too */
  group?: number;
  /** template id (debug / tests) */
  tag: string;
}

// ---- vocabulary --------------------------------------------------------------------------------------------------------

const PITCH_NAME: Record<string, string> = { FF: 'fastball', FT: 'two-seam fastball', SI: 'sinker', FC: 'cutter', SL: 'slider', CU: 'curveball', CH: 'changeup', SW: 'sweeper', FS: 'splitter' };
export const pitchName = (t: string) => PITCH_NAME[t] ?? 'pitch';
export const isFastball = (t: string) => t === 'FF' || t === 'FT' || t === 'SI' || t === 'FC';
export const isBreaking = (t: string) => t === 'SL' || t === 'CU' || t === 'SW';
export const isOffspeed = (t: string) => t === 'CH' || t === 'FS';

const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
export const ord = (n: number) => ORD[n] ?? `${n}th`;
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n: number) => NUM[n] ?? String(n);
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${num(n)} times`);

/** last name for casual mentions */
export const lastName = (full: string) => {
  const p = full.trim().split(/\s+/);
  return p.length > 1 ? p[p.length - 1] : full;
};

/**
 * Where a pitch crossed the plate, in a hitter's terms. The sim's +X is toward third base; a right-handed batter stands on +X
 * (so inside is +X for him) and a left-handed batter on -X. Heights are metres (zone ~0.5 .. 1.05).
 */
export function locationWords(x: number, y: number, bats: 'L' | 'R'): string {
  const side = (bats === 'R' ? x : -x) > 0 ? 'in' : 'away'; // toward the batter = inside
  const wide = Math.abs(x);
  const h = y < 0.15 ? 'dirt' : y < 0.55 ? 'low' : y > 0.98 ? 'up' : 'mid';
  if (h === 'dirt') return 'in the dirt';
  if (wide < 0.09 && h === 'mid') return 'right down the middle';
  if (wide < 0.09) return h === 'up' ? 'up in the zone' : 'down at the knees';
  if (h === 'mid') return side === 'in' ? 'inside' : 'away';
  return `${h} and ${side}`;
}

export function basesText(r: [boolean, boolean, boolean]): string {
  const n = r.filter(Boolean).length;
  if (n === 0) return 'nobody on';
  if (n === 3) return 'the bases loaded';
  if (n === 1) return r[0] ? 'a runner on first' : r[1] ? 'a runner on second' : 'a runner on third';
  if (r[0] && r[1]) return 'runners on first and second';
  if (r[0] && r[2]) return 'runners on the corners';
  return 'runners on second and third';
}

const countText = (b: number, s: number) => (b === 3 && s === 2 ? 'Full count.' : `${b} and ${s}.`);

// ---- memory ------------------------------------------------------------------------------------------------------------

interface PitchRec {
  type: string;
  mph: number;
  x?: number;
  y?: number;
  inZone?: boolean;
  call?: string;
}

interface PitcherMem {
  types: string[];
  maxMph: number;
  hardest: boolean;
}

export class Memory {
  pa: PitchRec[] = [];
  batterId = '';
  pitchers = new Map<string, PitcherMem>();
  results = new Map<string, string[]>();
  half = { runs: 0, hits: 0, walks: 0, ks: 0, ob: 0 };
  lastScore = { home: 0, away: 0 };
  lastExit = 0;
  lastLaunch = 0;
  lastMargin: number | null = null;
  lastClose = false;
  paCount = 0;
  pitchesThisPa = 0;
  /** the pitch whose location is waiting for its call */
  pending: PitchRec | null = null;
}

// ---- the chatter -------------------------------------------------------------------------------------------------------

export interface LevelCfg {
  /** seconds of silence in the booth before filler */
  quiet: number;
  /** chance a pitch result is narrated */
  react: number;
  /** chance an idle pull becomes a two-voice exchange */
  banter: number;
  /** chance of a break-time (between innings) exchange */
  brk: number;
}

export const LEVELS: Record<ChatterLevel, LevelCfg> = {
  low: { quiet: 15, react: 0.12, banter: 0.2, brk: 0.5 },
  normal: { quiet: 6.5, react: 0.38, banter: 0.45, brk: 0.9 },
  high: { quiet: 3.2, react: 0.7, banter: 0.7, brk: 1 },
};

type Facts = ReturnType<Chatter['facts']>;
interface Tpl {
  id: string;
  cat: string;
  /** null when the facts for this template are missing */
  say(f: Facts, c: ChatCtx, m: Memory): string | null;
}

let groupSeq = 1;

export class Chatter {
  readonly m = new Memory();
  private recent: string[] = [];
  /** fact cooldowns: key -> paCount at which it was last used */
  private used = new Map<string, number>();

  constructor(private rng: () => number = Math.random, private window = 28) {}

  // -- facts ----------------------------------------------------------------------------------------------------------

  facts(c: ChatCtx, extra: { result?: string } = {}) {
    const bat = c.batter;
    const pit = c.pitcher;
    const battingTeam = c.half === 'top' ? c.teams.away : c.teams.home;
    const fieldingTeam = c.half === 'top' ? c.teams.home : c.teams.away;
    const batScore = c.half === 'top' ? c.score.away : c.score.home;
    const fldScore = c.half === 'top' ? c.score.home : c.score.away;
    const diff = batScore - fldScore;
    const bl = bat?.bat;
    const hand: 'L' | 'R' = bat?.hand === 'L' ? 'L' : bat?.hand === 'R' ? 'R' : (pit?.hand === 'R' ? 'L' : 'R'); // a switch hitter bats opposite the pitcher
    const pm = pit ? this.m.pitchers.get(pit.id) : undefined;
    const types = pm?.types ?? [];
    let streak = 0;
    for (let i = types.length - 1; i >= 0 && types[i] === types[types.length - 1]; i--) streak++;
    let fbStreak = 0;
    for (let i = types.length - 1; i >= 0 && isFastball(types[i]); i--) fbStreak++;
    const results = bat ? (this.m.results.get(bat.id) ?? []) : [];
    return {
      c, bat, pit, bats: hand, battingTeam, fieldingTeam, diff, batScore, fldScore,
      bName: bat ? lastName(bat.name) : 'the batter',
      pName: pit ? lastName(pit.name) : 'the pitcher',
      bFull: bat?.name ?? 'the batter',
      ab: bl?.ab ?? 0, h: bl?.h ?? 0, hr: bl?.hr ?? 0, so: bl?.so ?? 0, bb: bl?.bb ?? 0, rbi: bl?.rbi ?? 0, pa: bl?.pa ?? 0,
      types, streak, fbStreak, fbCount: types.filter(isFastball).length, brkCount: types.filter(isBreaking).length, offCount: types.filter(isOffspeed).length,
      pitchCount: pit?.pit?.pitches ?? types.length,
      results, late: c.inning >= 7, rsp: c.runners[1] || c.runners[2], onBase: c.runners.filter(Boolean).length,
      inningText: `${c.half === 'top' ? 'top' : 'bottom'} of the ${ord(c.inning)}`,
      pa_: this.m.pa,
      hardest: !!pm?.hardest,
      result: extra.result,
    };
  }

  // -- bookkeeping ----------------------------------------------------------------------------------------------------

  private pick(list: Tpl[], f: Facts, c: ChatCtx): { tpl: Tpl; text: string } | null {
    const cand: { tpl: Tpl; text: string }[] = [];
    for (const t of list) {
      if (this.recent.includes(t.id)) continue;
      const text = t.say(f, c, this.m);
      if (text) cand.push({ tpl: t, text });
    }
    if (!cand.length) return null;
    const p = cand[Math.floor(this.rng() * cand.length)];
    this.remember(p.tpl.id);
    return p;
  }

  private remember(id: string) {
    this.recent.push(id);
    if (this.recent.length > this.window) this.recent.shift();
  }

  /** a fact (a stat about a person, say) is not repeated within `gap` plate appearances */
  private fresh(key: string, gap = 3): boolean {
    const last = this.used.get(key);
    if (last !== undefined && this.m.paCount - last < gap) return false;
    this.used.set(key, this.m.paCount);
    return true;
  }

  private line(role: 'pbp' | 'color', text: string, tag: string, o: { pri?: number; ttl?: number; delay?: number; group?: number } = {}): ChatLine {
    return { role, text, tag, pri: o.pri ?? (role === 'pbp' ? 2 : 1), ttl: o.ttl ?? 9, delay: o.delay ?? 0, group: o.group };
  }

  // -- memory from events ---------------------------------------------------------------------------------------------

  /** Feed every sim event (cheap). */
  observe(ev: RawEvent, c: ChatCtx) {
    const m = this.m;
    switch (ev.type) {
      case 'gameStart':
        this.m.pitchers.clear();
        this.m.results.clear();
        this.m.lastScore = { home: 0, away: 0 };
        break;
      case 'batterUp':
        m.pa = [];
        m.pending = null;
        m.batterId = String(ev.batterId ?? '');
        m.paCount++;
        break;
      case 'pitchReleased': {
        const type = String(ev.pitchType ?? '');
        const mph = Number(ev.mph) || 0;
        const rec: PitchRec = { type, mph: Math.round(mph) };
        m.pa.push(rec);
        m.pending = rec;
        const pid = String(ev.pitcherId ?? '');
        if (pid) {
          const pm = m.pitchers.get(pid) ?? { types: [], maxMph: 0, hardest: false };
          pm.hardest = pm.types.length >= 12 && mph > pm.maxMph + 0.4 && mph >= 95;
          pm.maxMph = Math.max(pm.maxMph, mph);
          pm.types.push(type);
          m.pitchers.set(pid, pm);
        }
        break;
      }
      case 'pitchCrossed':
        if (m.pending) {
          m.pending.x = Number(ev.x);
          m.pending.y = Number(ev.y);
          m.pending.inZone = !!ev.inZone;
        }
        break;
      case 'contact':
        m.lastExit = Number(ev.exitMph) || 0;
        m.lastLaunch = Number(ev.launchDeg) || 0;
        break;
      case 'plateAppearanceEnd': {
        const id = String(ev.batterId ?? m.batterId);
        const r = String(ev.result ?? '');
        m.results.set(id, [...(m.results.get(id) ?? []), r]);
        if (/single|double|triple|home run/.test(r)) m.half.hits++;
        if (/walk/.test(r)) m.half.walks++;
        if (/strikeout/.test(r)) m.half.ks++;
        break;
      }
      case 'runScored':
        m.half.runs++;
        break;
      case 'halfInningStart':
        m.half = { runs: 0, hits: 0, walks: 0, ks: 0, ob: 0 };
        break;
      case 'out':
        m.lastClose = ev.closePlay === true;
        m.lastMargin = typeof ev.margin === 'number' ? ev.margin : null;
        break;
      case 'safe':
        m.lastClose = ev.closePlay === true;
        m.lastMargin = typeof ev.margin === 'number' ? ev.margin : null;
        break;
      default:
        break;
    }
    void c;
  }

  // -- event-driven lines ---------------------------------------------------------------------------------------------

  /** Lines in response to an event. `observe` must have been called for it first. */
  react(ev: RawEvent, c: ChatCtx, level: ChatterLevel): ChatLine[] {
    const cfg = LEVELS[level];
    const f = this.facts(c);
    const out: ChatLine[] = [];
    switch (ev.type) {
      case 'batterUp': {
        // introduce the matchup (the PA announcer already read the name and number)
        if (!f.bat || !f.pit) break;
        if (this.rng() > 0.35 + 0.65 * cfg.react) break;
        const p = this.pick(INTRO, f, c);
        if (p) out.push(this.line('pbp', p.text, p.tpl.id, { ttl: 10, delay: 2.5 }));
        if (this.rng() < cfg.banter) {
          const q = this.pick(MATCHUP_COLOR, f, c);
          if (q) out.push(this.line('color', q.text, q.tpl.id, { ttl: 14, delay: 0, pri: 1 }));
        }
        break;
      }
      case 'call':
      case 'umpireCall': {
        if (!this.isPitchCall(ev)) break;
        const rec = this.m.pending;
        if (!rec || (rec as PitchRec & { told?: boolean }).told) break;
        (rec as PitchRec & { told?: boolean }).told = true;
        if (this.rng() > cfg.react) break;
        const text = this.pitchLine(rec, f, c, ev);
        if (!text) break;
        const g = groupSeq++;
        out.push(this.line('pbp', text, 'pitch', { ttl: 5, delay: 0.5, group: g }));
        // colour follow-up about the pitcher's pattern
        if (this.rng() < cfg.banter * 0.55) {
          const q = this.pick(PITCH_COLOR, f, c);
          if (q) out.push(this.line('color', q.text, q.tpl.id, { ttl: 8, delay: 0.3, group: g }));
        }
        break;
      }
      case 'plateAppearanceEnd': {
        const r = String(ev.result ?? '');
        if (this.rng() > 0.35 + 0.65 * cfg.react) break;
        const p = this.pick(AFTER_PA, this.facts(c, { result: r }), c);
        // the batter's line right after the PA is the freshest fact
        if (p) out.push(this.line('color', p.text, p.tpl.id, { ttl: 10, delay: 3, pri: 1 }));
        break;
      }
      case 'runScored': {
        const p = this.pick(RUN_SCORED, f, c);
        this.m.lastScore = { ...c.score };
        if (p) out.push(this.line('color', p.text, p.tpl.id, { ttl: 8, delay: 3.5 }));
        break;
      }
      case 'out':
      case 'safe': {
        if (ev.closePlay !== true) break;
        const p = this.pick(CLOSE_PLAY, f, c);
        if (p) out.push(this.line('color', p.text, p.tpl.id, { ttl: 9, delay: 2.2, pri: 2 }));
        break;
      }
      case 'steal': {
        const p = this.pick(STEAL, f, c);
        if (p) out.push(this.line('color', p.text, p.tpl.id, { ttl: 6, delay: 1, pri: 2 }));
        break;
      }
      case 'halfInningEnd': {
        if (this.rng() > cfg.brk) break;
        const g = groupSeq++;
        const a = this.pick(HALF_SUMMARY_PBP, f, c);
        if (a) out.push(this.line('pbp', a.text, a.tpl.id, { ttl: 14, delay: 2, group: g }));
        const b = this.pick(HALF_SUMMARY_COLOR, f, c);
        if (b) out.push(this.line('color', b.text, b.tpl.id, { ttl: 16, delay: 0, group: g }));
        break;
      }
      case 'pitchingChange': {
        const p = this.pick(PITCHING_CHANGE, f, c);
        if (p) out.push(this.line('color', p.text, p.tpl.id, { ttl: 12, delay: 4 }));
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** the booth reacts to the broadcast going to a replay */
  replay(c: ChatCtx): ChatLine[] {
    const f = this.facts(c);
    const g = groupSeq++;
    const a = this.pick(REPLAY_PBP, f, c);
    const out: ChatLine[] = [];
    if (a) out.push(this.line('pbp', a.text, a.tpl.id, { ttl: 6, delay: 0.3, pri: 2, group: g }));
    const b = this.pick(REPLAY_COLOR, f, c);
    if (b) out.push(this.line('color', b.text, b.tpl.id, { ttl: 9, delay: 0, pri: 2, group: g }));
    return out;
  }

  private isPitchCall(ev: RawEvent): boolean {
    if (ev.type === 'umpireCall') return ['ball', 'ball_four', 'strike_called', 'strike_swinging', 'strikeout', 'foul', 'foul_tip'].includes(String(ev.kind));
    const k = String((ev.call as { kind?: string } | undefined)?.kind ?? '');
    return ['ball', 'strikeLooking', 'strikeSwinging', 'foul', 'foulTip'].includes(k);
  }

  /** "Fastball, 94, low and away. Strike two." (the count after the pitch, from the `call` event's count before it) */
  private pitchLine(rec: PitchRec, f: Facts, c: ChatCtx, ev: RawEvent): string | null {
    if (!rec.type || !rec.mph) return null;
    const call = ev.type === 'call' ? (ev.call as { kind?: string; balls?: number; strikes?: number } | undefined) : undefined;
    const kind = ev.type === 'umpireCall' ? String(ev.kind) : String(call?.kind);
    if (kind === 'strikeout' || kind === 'ball_four') return null; // the mapper's play-by-play covers these
    const strikesBefore = call?.strikes ?? -1;
    if (strikesBefore >= 2 && (kind === 'strikeLooking' || kind === 'strikeSwinging')) return null; // strike three: the umpire and the play-by-play have it
    if ((call?.balls ?? -1) >= 3 && kind === 'ball') return null; // ball four
    const loc = rec.x !== undefined && rec.y !== undefined ? locationWords(rec.x, rec.y, f.bats) : '';
    const name = pitchName(rec.type);
    const head = `${name[0].toUpperCase()}${name.slice(1)}, ${rec.mph}${loc ? `, ${loc}` : ''}.`;
    const b = call?.balls ?? c.balls;
    const s = call?.strikes ?? c.strikes;
    const known = call !== undefined; // only the `call` event carries the count before the pitch
    const NUMW = ['zero', 'one', 'two', 'three'];
    let verdict = '';
    if (kind === 'strike_swinging' || kind === 'strikeSwinging') verdict = known && s < 2 ? `Swing and a miss, strike ${NUMW[s + 1]}.` : 'Swing and a miss.';
    else if (kind === 'foul' || kind === 'foulTip' || kind === 'foul_tip') verdict = known && s < 2 ? `Fouled off, strike ${NUMW[s + 1]}.` : 'Fouled off.';
    else if (kind === 'strike_called' || kind === 'strikeLooking') verdict = known && s < 2 ? `Called strike ${NUMW[s + 1]}.` : 'Called strike.';
    else if (kind === 'ball') verdict = known && b < 3 ? `Ball ${NUMW[b + 1]}.` : 'Ball.';
    return `${head} ${verdict}`.trim();
  }

  // -- idle chatter ---------------------------------------------------------------------------------------------------

  /**
   * One filler line or exchange for a quiet moment. Returns [] when there is nothing grounded to say.
   * `phase`: prePitch (batter set to hit), betweenBatters, break (between half innings).
   */
  pull(c: ChatCtx, phase: Phase, level: ChatterLevel): ChatLine[] {
    const cfg = LEVELS[level];
    const f = this.facts(c);
    const g = groupSeq++;
    const out: ChatLine[] = [];
    const ex = this.rng() < (phase === 'break' ? cfg.brk : cfg.banter);
    if (phase === 'break') {
      const a = this.pick(BREAK_PBP, f, c);
      if (a) out.push(this.line('pbp', a.text, a.tpl.id, { ttl: 22, group: g, pri: 1 }));
      if (ex) {
        const b = this.pick(BREAK_COLOR, f, c);
        if (b) out.push(this.line('color', b.text, b.tpl.id, { ttl: 24, group: g, pri: 1, delay: 0 }));
      }
      return out;
    }
    const setupPool = phase === 'prePitch' ? SETUP_PBP : BETWEEN_PBP;
    const a = this.pick(setupPool, f, c);
    if (a) out.push(this.line('pbp', a.text, a.tpl.id, { ttl: 8, group: g, pri: 1 }));
    if (ex || !a) {
      const b = this.pick(phase === 'prePitch' ? SETUP_COLOR : BETWEEN_COLOR, f, c);
      if (b) out.push(this.line('color', b.text, b.tpl.id, { ttl: 10, group: g, pri: 1, delay: 0 }));
    }
    return out;
  }

  /** used by tests / debugging */
  resetRecent() {
    this.recent = [];
    this.used.clear();
  }
}

// ---- template library --------------------------------------------------------------------------------------------------
// A template returns null unless every fact it mentions is present. No pronouns for people.

const t = (id: string, cat: string, say: Tpl['say']): Tpl => ({ id, cat, say });

const hits = (f: Facts) => (f.ab > 0 ? `${f.h}-for-${f.ab}` : null);
const grade = (v: number | undefined) => (v === undefined ? null : Math.round(v / 5) * 5);

const INTRO: Tpl[] = [
  t('intro.hand', 'intro', (f) => (f.bat && f.pit && f.bat.hand ? `${f.bFull}, batting ${f.bat.hand === 'L' ? 'left-handed' : f.bat.hand === 'R' ? 'right-handed' : 'from both sides'}, against ${f.pName}.` : null)),
  t('intro.line', 'intro', (f) => (hits(f) && f.ab >= 1 ? `${f.bName} comes up ${hits(f)} on the night.` : f.pa === 0 ? `${f.bName} steps in for a first look at ${f.pName} tonight.` : null)),
  t('intro.sit', 'intro', (f, c) => `${f.inningText[0].toUpperCase()}${f.inningText.slice(1)}, ${c.outs === 1 ? 'one out' : c.outs === 0 ? 'nobody out' : 'two outs'}, with ${basesText(c.runners)}.`),
  t('intro.pitches', 'intro', (f) => (f.pit?.pit && f.pit.pit.pitches >= 20 ? `${f.pName} is at ${f.pit.pit.pitches} pitches.` : null)),
  t('intro.matchup', 'intro', (f) => (f.bat?.hand && f.pit?.hand && f.bat.hand !== 'S' && f.pit.hand !== 'S' ? (f.bat.hand === f.pit.hand ? `${f.pit.hand === 'L' ? 'Lefty' : 'Righty'} against ${f.bat.hand === 'L' ? 'lefty' : 'righty'} here.` : `${f.pit.hand === 'L' ? 'Lefty' : 'Righty'} on the mound, ${f.bat.hand === 'L' ? 'a left-handed' : 'a right-handed'} bat in the box.`) : null)),
];

const MATCHUP_COLOR: Tpl[] = [
  t('mc.power', 'color', (f) => (f.bat?.ratings?.power && f.bat.ratings.power >= 65 ? `${f.bName} has ${grade(f.bat.ratings.power)}-grade power, so anything left over the plate is dangerous.` : null)),
  t('mc.contact', 'color', (f) => (f.bat?.ratings?.contact && f.bat.ratings.contact >= 65 ? `${f.bName} makes contact: a ${grade(f.bat.ratings.contact)} grade on the bat-to-ball skill.` : null)),
  t('mc.eye', 'color', (f) => (f.bat?.ratings?.eye && f.bat.ratings.eye >= 65 ? `A patient hitter, ${f.bName}. The eye grades out at ${grade(f.bat.ratings.eye)}.` : null)),
  t('mc.speed', 'color', (f) => (f.bat?.ratings?.speed && f.bat.ratings.speed >= 65 ? `${f.bName} can run, a ${grade(f.bat.ratings.speed)} on the speed grade, so any ball on the ground is a race.` : null)),
  t('mc.homer', 'color', (f) => (f.hr >= 1 ? `${f.bName} already has ${f.hr === 1 ? 'a homer' : `${f.hr} homers`} tonight.` : null)),
  t('mc.so', 'color', (f) => (f.so >= 2 ? `${f.bName} has struck out ${times(f.so)} tonight, so ${f.pName} will want to keep the ball moving.` : null)),
  t('mc.multi', 'color', (f) => (f.h >= 2 ? `${f.bName} has ${num(f.h)} hits tonight already.` : null)),
  t('mc.vel', 'color', (f) => (f.pit?.ratings?.velocity && f.pit.ratings.velocity >= 96 ? `${f.pName} can run it up to ${Math.round(f.pit.ratings.velocity)}.` : null)),
  t('mc.control', 'color', (f) => (f.pit?.ratings?.control && f.pit.ratings.control >= 65 ? `${f.pName} has command, ${grade(f.pit.ratings.control)} on the control grade, and will work the corners.` : f.pit?.ratings?.control && f.pit.ratings.control <= 35 ? `${f.pName} is still hunting the strike zone with a ${grade(f.pit.ratings.control)} command grade.` : null)),
  t('mc.walks', 'color', (f) => (f.pit?.pit && f.pit.pit.bb >= 2 ? `${f.pName} has issued ${num(f.pit.pit.bb)} walks tonight, so the zone has been a challenge.` : null)),
  t('mc.ks', 'color', (f) => (f.pit?.pit && f.pit.pit.so >= 3 ? `${f.pName} has ${f.pit.pit.so} strikeouts tonight.` : null)),
];

const PITCH_COLOR: Tpl[] = [
  t('pc.streak', 'color', (f) => (f.streak >= 3 ? `That is ${num(f.streak)} ${pitchName(f.types[f.types.length - 1])}s in a row from ${f.pName}.` : null)),
  t('pc.fbstreak', 'color', (f) => (f.fbStreak >= 4 && f.streak < 3 ? `${num(f.fbStreak)} straight fastballs, counting the variations, from ${f.pName}.` : null)),
  t('pc.first', 'color', (f) => {
    const last = f.types[f.types.length - 1];
    if (!last) return null;
    const n = f.types.filter((x) => x === last).length;
    return n === 1 && f.types.length >= 8 ? `The first ${pitchName(last)} of the night from ${f.pName}.` : null;
  }),
  t('pc.mix', 'color', (f) => (f.types.length >= 15 ? `${f.pName} has gone to the fastball ${f.fbCount} times out of ${f.types.length} tonight.` : null)),
  t('pc.break', 'color', (f) => (f.brkCount >= 5 ? `${num(f.brkCount)} breaking balls so far tonight from ${f.pName}.` : null)),
  t('pc.hard', 'color', (f) => (f.pit && f.hardest ? `That is as hard as ${f.pName} has thrown tonight.` : null)),
  t('pc.gap', 'color', (f) => {
    const a = f.pa_[f.pa_.length - 1], b = f.pa_[f.pa_.length - 2];
    return a && b && b.mph - a.mph >= 8 && isFastball(b.type) && isOffspeed(a.type) ? `That change of speed, ${b.mph} then ${a.mph}, is what you want to see.` : null;
  }),
  t('pc.seq', 'color', (f) => (f.pa_.length >= 4 ? `${num(f.pa_.length)} pitches in this at-bat.` : null)),
  t('pc.two', 'color', (f, c) => (c.strikes === 2 && c.balls < 3 ? `Two strikes on ${f.bName}, and the pitcher is ahead.` : c.balls === 3 && c.strikes < 2 ? `Ball three, and ${f.pName} needs to find the zone.` : null)),
];

const AFTER_PA: Tpl[] = [
  t('pa.hit', 'color', (f) => (f.result && /single|double|triple/.test(f.result) && hits(f) ? `${f.bName} is ${hits(f)} now.` : null)),
  t('pa.hr', 'color', (f) => (f.result === 'home run' ? (f.hr >= 2 ? `That is ${ord(f.hr)} home run of the night for ${f.bName}.` : `A home run for ${f.bName}, the first tonight.`) : null)),
  t('pa.k', 'color', (f) => (f.result && /strikeout/.test(f.result) && f.so >= 3 ? (f.so === 3 ? `That is three strikeouts tonight for ${f.bName}, a hat trick.` : f.so === 4 ? `Four strikeouts for ${f.bName}: the golden sombrero.` : `${num(f.so)} strikeouts tonight for ${f.bName}.`) : f.result && /strikeout/.test(f.result) && f.pit?.pit && f.pit.pit.so >= 2 ? `That is ${num(f.pit.pit.so)} strikeouts tonight for ${f.pName}.` : null)),
  t('pa.walk', 'color', (f) => (f.result && /walk/.test(f.result) && f.pit?.pit && f.pit.pit.bb >= 2 ? `${f.pName} has walked ${num(f.pit.pit.bb)} tonight.` : null)),
  t('pa.rbi', 'color', (f) => (f.rbi >= 2 && f.result && /single|double|triple|home run|sac/.test(f.result) ? `${f.bName} has driven in ${num(f.rbi)} tonight.` : null)),
  t('pa.exit', 'color', (f, c, m) => (m.lastExit >= 100 && f.result && /single|double|triple|out/.test(f.result) ? `That ball was hit ${Math.round(m.lastExit)} miles an hour.` : null)),
];

const RUN_SCORED: Tpl[] = [
  t('run.tie', 'color', (f, c, m) => (c.score.home === c.score.away && m.lastScore.home !== m.lastScore.away ? `And the game is tied at ${c.score.home}.` : null)),
  t('run.lead', 'color', (f, c, m) => {
    const lead = c.score.home === c.score.away ? null : c.score.home > c.score.away ? 'home' : 'away';
    const was = m.lastScore.home === m.lastScore.away ? null : m.lastScore.home > m.lastScore.away ? 'home' : 'away';
    return lead && lead !== was ? `${lead === 'home' ? c.teams.home : c.teams.away} take the lead, ${Math.max(c.score.home, c.score.away)} to ${Math.min(c.score.home, c.score.away)}.` : null;
  }),
  t('run.extend', 'color', (f, c) => (Math.abs(c.score.home - c.score.away) >= 3 ? `${c.score.home > c.score.away ? c.teams.home : c.teams.away} now lead by ${Math.abs(c.score.home - c.score.away)}.` : null)),
  t('run.board', 'color', (f, c) => (f.late && f.diff === 1 ? 'A one-run game now, and the tension is building.' : null)),
];

const CLOSE_PLAY: Tpl[] = [
  t('close.margin', 'color', (f, c, m) => (m.lastMargin !== null && Math.abs(m.lastMargin) < 0.1 ? `That was close: ${Math.abs(m.lastMargin) < 0.03 ? 'a few hundredths of a second' : `about ${Math.max(1, Math.round(Math.abs(m.lastMargin) * 100))} hundredths of a second`} separated them.` : 'That was a close play.')),
  t('close.look', 'color', () => 'Bang-bang play there.'),
  t('close.ump', 'color', () => 'Everyone is waiting on the umpire for that one.'),
];

const STEAL: Tpl[] = [
  t('steal.speed', 'color', (f, c) => {
    const i = c.runnerSpeed?.findIndex((s) => s !== undefined && s >= 65) ?? -1;
    return i >= 0 && c.runnerNames?.[i] ? `${lastName(c.runnerNames[i]!)} has ${grade(c.runnerSpeed![i])}-grade speed, so the jump makes sense.` : null;
  }),
  t('steal.going', 'color', () => 'The runner is going!'),
];

const HALF_SUMMARY_PBP: Tpl[] = [
  t('hs.score', 'break', (f, c) => `After ${c.half === 'top' ? `the top of the ${ord(c.inning)}` : `${ord(c.inning)} inning`}, it is ${c.teams.away} ${c.score.away}, ${c.teams.home} ${c.score.home}.`),
  t('hs.tied', 'break', (f, c) => (c.score.home === c.score.away ? `All tied at ${c.score.home} as we move on.` : null)),
  t('hs.lead', 'break', (f, c) => (c.score.home !== c.score.away ? `${c.score.home > c.score.away ? c.teams.home : c.teams.away} lead ${Math.max(c.score.home, c.score.away)} to ${Math.min(c.score.home, c.score.away)}.` : null)),
];

const HALF_SUMMARY_COLOR: Tpl[] = [
  t('hc.quiet', 'break', (f, c, m) => (m.half.hits === 0 && m.half.walks === 0 && m.half.runs === 0 ? 'A clean half inning: nobody reached.' : null)),
  t('hc.runs', 'break', (f, c, m) => (m.half.runs >= 1 ? `${m.half.runs === 1 ? 'One run' : `${num(m.half.runs)} runs`} came in that half inning.` : null)),
  t('hc.ks', 'break', (f, c, m) => (m.half.ks >= 2 ? `${num(m.half.ks)} strikeouts that half inning.` : null)),
  t('hc.hits', 'break', (f, c, m) => (m.half.hits >= 2 && m.half.runs === 0 ? `${num(m.half.hits)} hits and nothing to show for it.` : null)),
  t('hc.crowd', 'break', (f, c) => ((c.crowd ?? 0) > 0.6 ? 'The crowd is on its feet here.' : null)),
];

const REPLAY_PBP: Tpl[] = [
  t('rp.look', 'replay', () => "Let's take another look at that."),
  t('rp.again', 'replay', () => 'Here it is again from a different angle.'),
  t('rp.watch', 'replay', () => 'Watch this replay.'),
  t('rp.slow', 'replay', () => 'And in slow motion.'),
];

const REPLAY_COLOR: Tpl[] = [
  t('rc.last', 'replay', (f, c, m) => (c.lastPlay ? (m.lastClose ? `${c.lastPlay} A close one.` : c.lastPlay) : null)),
  t('rc.exit', 'replay', (f, c, m) => (m.lastExit >= 95 ? `Off the bat at ${Math.round(m.lastExit)} miles an hour.` : null)),
  t('rc.close', 'replay', (f, c, m) => (m.lastClose && m.lastMargin !== null ? `The call came down to about ${Math.max(1, Math.round(Math.abs(m.lastMargin) * 100))} hundredths of a second.` : null)),
];

const PITCHING_CHANGE: Tpl[] = [
  t('pch.line', 'change', (f) => (f.pit?.pit ? `${f.pName} takes over, in a game that is ${f.c.teams.away} ${f.c.score.away}, ${f.c.teams.home} ${f.c.score.home}.` : null)),
];

const SETUP_PBP: Tpl[] = [
  t('su.count', 'setup', (f, c) => (c.balls + c.strikes > 0 ? countText(c.balls, c.strikes) : null)),
  t('su.sit', 'setup', (f, c) => `${c.outs === 0 ? 'Nobody out' : c.outs === 1 ? 'One out' : 'Two outs'}, ${basesText(c.runners)}.`),
  t('su.score', 'setup', (f, c) => (c.score.home === c.score.away ? `Tied at ${c.score.home} in the ${f.inningText}.` : `${c.teams.away} ${c.score.away}, ${c.teams.home} ${c.score.home} in the ${f.inningText}.`)),
  t('su.rsp', 'setup', (f, c) => (f.rsp && c.outs < 2 ? `${f.bName} up with ${basesText(c.runners)} and ${c.outs === 0 ? 'nobody' : 'one'} out.` : null)),
  t('su.pitch', 'setup', (f) => (f.pit?.pit && f.pit.pit.pitches >= 30 ? `${f.pName} has thrown ${f.pit.pit.pitches} pitches.` : null)),
  t('su.late', 'setup', (f, c) => (f.late && Math.abs(f.diff) <= 2 ? `We are in the ${f.inningText} of a ${Math.abs(f.diff) === 0 ? 'tie game' : Math.abs(f.diff) === 1 ? 'one-run game' : 'two-run game'}.` : null)),
  t('su.full', 'setup', (f, c) => (c.balls === 3 && c.strikes === 2 ? 'Full count, and everyone is up.' : null)),
];

const SETUP_COLOR: Tpl[] = [
  t('sc.dp', 'setup', (f, c) => (c.runners[0] && c.outs < 2 ? `With a runner on first and fewer than two out, ${f.pName} would love a double-play ball.` : null)),
  t('sc.rsp2', 'setup', (f, c) => (f.rsp && c.outs === 2 ? `Two outs with a runner in scoring position: ${f.pName} is one pitch away from getting out of it, ${f.bName} one swing from changing the game.` : null)),
  t('sc.loaded', 'setup', (f, c) => (c.runners.every(Boolean) ? `The bases are loaded and ${f.bName} is at the plate.` : null)),
  t('sc.speedrun', 'setup', (f, c) => {
    const i = c.runnerSpeed?.findIndex((s) => s !== undefined && s >= 70) ?? -1;
    return i >= 0 && c.runnerNames?.[i] ? `${lastName(c.runnerNames[i]!)} on ${['first', 'second', 'third'][i]} is a ${grade(c.runnerSpeed![i])} runner, so keep an eye on that.` : null;
  }),
  t('sc.crowd', 'setup', (f, c) => ((c.crowd ?? 0) > 0.55 ? 'The crowd is into it.' : null)),
  t('sc.mix', 'setup', (f) => (f.types.length >= 20 ? `${f.pName} has used the fastball ${Math.round((f.fbCount / f.types.length) * 100)} percent of the time tonight.` : null)),
  t('sc.cnt', 'setup', (f, c) => (c.strikes === 2 && c.balls === 0 ? `${f.bName} is down 0 and 2, protecting the plate now.` : c.balls === 3 && c.strikes === 0 ? `${f.pName} is behind 3 and 0, and ${f.bName} may be taking.` : null)),
  t('sc.platoon', 'setup', (f) => (f.bat?.hand && f.pit?.hand && f.bat.hand !== 'S' && f.pit.hand !== 'S' && f.bat.hand === f.pit.hand ? `Same-handed matchup here, ${f.pit.hand === 'L' ? 'lefty' : 'righty'} against ${f.pit.hand === 'L' ? 'lefty' : 'righty'}.` : null)),
];

const BETWEEN_PBP: Tpl[] = [
  t('bt.sit', 'between', (f, c) => `${c.outs === 0 ? 'No outs' : c.outs === 1 ? 'One out' : 'Two outs'}, ${basesText(c.runners)}.`),
  t('bt.score', 'between', (f, c) => `It is ${c.teams.away} ${c.score.away}, ${c.teams.home} ${c.score.home}, ${f.inningText}.`),
  t('bt.pitch', 'between', (f) => (f.pit?.pit && f.pit.pit.pitches >= 15 ? `${f.pName} is at ${f.pit.pit.pitches} pitches, with ${f.pit.pit.so} strikeouts.` : null)),
];

const BETWEEN_COLOR: Tpl[] = [
  t('bc.line', 'between', (f) => (f.pit?.pit && f.pit.pit.outs >= 3 ? `${f.pName} is ${Math.floor(f.pit.pit.outs / 3)}${f.pit.pit.outs % 3 ? `.${f.pit.pit.outs % 3}` : ''} innings in with ${f.pit.pit.h} hits and ${f.pit.pit.er} earned runs allowed.` : null)),
  t('bc.crowd', 'between', (f, c) => ((c.crowd ?? 0) > 0.5 ? 'You can feel the energy in this ballpark.' : null)),
  t('bc.diff', 'between', (f) => (f.late && Math.abs(f.diff) <= 1 ? 'Every pitch matters now in a game this tight.' : null)),
  t('bc.bat', 'between', (f) => (f.bat && f.ab >= 2 ? `${f.bName} is ${hits(f)} tonight.` : null)),
];

const BREAK_PBP: Tpl[] = [
  t('bk.score', 'break', (f, c) => `We go to the ${c.half === 'top' ? `bottom of the ${ord(c.inning)}` : `${ord(c.inning + 1)}`}, with ${c.teams.away} ${c.score.away} and ${c.teams.home} ${c.score.home}.`),
  t('bk.pitcher', 'break', (f) => (f.pit?.pit && f.pit.pit.pitches >= 10 ? `${f.pName} is at ${f.pit.pit.pitches} pitches on the night.` : null)),
  t('bk.tied', 'break', (f, c) => (c.score.home === c.score.away ? `The score is tied at ${c.score.home}.` : null)),
];

const BREAK_COLOR: Tpl[] = [
  t('bkc.k', 'break', (f) => (f.pit?.pit && f.pit.pit.so >= 4 ? `${f.pName} has ${f.pit.pit.so} strikeouts so far.` : null)),
  t('bkc.hits', 'break', (f) => (f.pit?.pit && f.pit.pit.h === 0 && f.pit.pit.outs >= 6 ? `${f.pName} has not allowed a hit yet.` : null)),
  t('bkc.close', 'break', (f) => (f.late && Math.abs(f.diff) <= 2 ? 'This one is going to come down to the wire.' : null)),
  t('bkc.crowd', 'break', (f, c) => ((c.crowd ?? 0) > 0.55 ? 'The crowd is on its feet.' : null)),
  t('bkc.lead', 'break', (f, c) => (Math.abs(c.score.home - c.score.away) >= 4 ? `${c.score.home > c.score.away ? c.teams.home : c.teams.away} are in control by ${Math.abs(c.score.home - c.score.away)}.` : null)),
];

/** every template, for the library tests (pronoun scan, id uniqueness) */
export const ALL_TEMPLATES: Tpl[] = [
  ...INTRO, ...MATCHUP_COLOR, ...PITCH_COLOR, ...AFTER_PA, ...RUN_SCORED, ...CLOSE_PLAY, ...STEAL, ...HALF_SUMMARY_PBP, ...HALF_SUMMARY_COLOR,
  ...REPLAY_PBP, ...REPLAY_COLOR, ...PITCHING_CHANGE, ...SETUP_PBP, ...SETUP_COLOR, ...BETWEEN_PBP, ...BETWEEN_COLOR, ...BREAK_PBP, ...BREAK_COLOR,
];

export type { Tpl };
