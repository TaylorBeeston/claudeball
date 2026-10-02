/**
 * The park-music director (pure: time and randomness are passed in). It turns game events into decisions: play this trigger (with this
 * track, or null when there is no file and the organ stinger should play instead), or stop. It owns the rules:
 *   - priority: finals > home run > rally > run scored > game start > pitching change > walk-up > the break; a lower one never cuts a
 *     higher one, and nothing overlaps (a higher one fades the current track out first)
 *   - cooldowns per trigger; only the home team's good news gets music (a visitor's run or home run is silent)
 *   - the break plays low until the next batter is called or the break ends; walk-ups and pitching-change music stop at the windup
 */
import { TRIGGERS, pickTrack, type Trigger, type TrackInfo } from './manifest';

export type MusicDecision =
  | {
      kind: 'play';
      trigger: Trigger;
      /** the file to play, or null: no file for this trigger, the caller plays the organ stinger */
      track: TrackInfo | null;
      /** wait this long before starting (the crowd's first reaction, or the previous track's fade-out) */
      delayMs: number;
      fadeInMs: number;
      /** stop at this many ms after the start (0: when the file ends) */
      maxMs: number;
      /** level relative to the trigger's usual (a visitor's pitching change is quieter) */
      level: number;
    }
  | { kind: 'stop'; fadeMs: number; reason: string };

export interface MusicCtx {
  inning: number;
  half: 'top' | 'bottom';
  score: { home: number; away: number };
}

export interface MusicRaw {
  type: string;
  [k: string]: unknown;
}

interface Current {
  trigger: Trigger;
  pri: number;
  start: number;
  /** when it ends by itself (s), Infinity for an open-ended loop */
  until: number;
}

/** these keep playing through the next pitch */
const THROUGH_PITCH = new Set<Trigger>(['finalWin', 'finalLoss', 'gameStart']);

export class MusicDirector {
  private cur: Current | null = null;
  private lastAt = new Map<Trigger, number>();
  private recent = new Map<Trigger, string[]>();
  private halfRuns = 0;
  private halfKey = '';
  private seenBreakStart = false;
  private rallyHalf = '';
  /** the variant chosen ahead for a trigger (so the player can fetch it before it is needed) */
  private planned = new Map<Trigger, TrackInfo | null>();
  /** what was decided (debug / tests) */
  readonly log: { t: number; what: string }[] = [];

  constructor(private o: { rng: () => number; tracks: () => TrackInfo[] }) {}

  get playing(): Trigger | null {
    return this.cur?.trigger ?? null;
  }

  /** the player says the track ended by itself */
  ended(t: number) {
    if (this.cur) this.note(t, `ended ${this.cur.trigger}`);
    this.cur = null;
  }

  private note(t: number, what: string) {
    this.log.push({ t: +t.toFixed(1), what });
    if (this.log.length > 120) this.log.shift();
  }

  private play(trigger: Trigger, t: number, o: { delayMs?: number; maxMs?: number; level?: number; force?: boolean } = {}): MusicDecision[] {
    const info = TRIGGERS[trigger];
    const out: MusicDecision[] = [];
    const last = this.lastAt.get(trigger) ?? -1e9;
    if (!o.force && t - last < info.cooldown) return out;
    let fade = 0;
    if (this.cur) {
      if (!o.force && this.cur.pri >= info.pri && t < this.cur.until) return out; // the higher (or equal) one plays on
      fade = trigger === 'walkUp' || trigger === 'inningBreak' ? 900 : 450;
      out.push({ kind: 'stop', fadeMs: fade, reason: `${trigger} takes over` });
    }
    const recent = this.recent.get(trigger) ?? [];
    const track = this.planned.has(trigger) ? this.planned.get(trigger)! : pickTrack(this.o.tracks(), trigger, this.o.rng, recent);
    this.planned.delete(trigger);
    if (track) {
      recent.push(track.id);
      if (recent.length > 2) recent.shift();
      this.recent.set(trigger, recent);
    }
    const dur = track?.durationMs ? track.durationMs / 1000 : (info.dur[0] + info.dur[1]) / 2;
    const maxMs = o.maxMs ?? (info.loop ? 90000 : 0);
    const delayMs = (o.delayMs ?? 0) + (fade ? fade + 100 : 0);
    this.cur = { trigger, pri: info.pri, start: t + delayMs / 1000, until: info.loop ? t + (maxMs ? maxMs / 1000 : 90) : t + delayMs / 1000 + dur };
    this.lastAt.set(trigger, t);
    this.note(t, `play ${trigger}${track ? ' ' + track.id : ' (organ)'}`);
    out.push({ kind: 'play', trigger, track, delayMs, fadeInMs: info.loop ? 1500 : 150, maxMs, level: o.level ?? 1 });
    return out;
  }

  private stop(t: number, fadeMs: number, reason: string): MusicDecision[] {
    if (!this.cur) return [];
    this.note(t, `stop ${this.cur.trigger}: ${reason}`);
    this.cur = null;
    return [{ kind: 'stop', fadeMs, reason }];
  }

  /** an event of the game; `t` is seconds on any steady clock */
  observe(ev: MusicRaw, c: MusicCtx, t: number): MusicDecision[] {
    // a track that should have ended by now
    if (this.cur && t > this.cur.until + 1) this.cur = null;
    const key = `${c.inning}${c.half}`;
    if (key !== this.halfKey) {
      this.halfKey = key;
      this.halfRuns = 0;
    }
    const homeBat = c.half === 'bottom';
    switch (ev.type) {
      case 'gameStart':
        return this.play('gameStart', t, { delayMs: 400 });
      case 'batterUp': {
        const out: MusicDecision[] = [];
        if (this.cur && (this.cur.trigger === 'inningBreak' || this.cur.trigger === 'pitchingChange')) out.push(...this.stop(t, 1500, 'the next batter is called'));
        if (homeBat) out.push(...this.play('walkUp', t, { delayMs: out.length ? 1600 : 500 }));
        return out;
      }
      case 'windup':
      case 'pitchReleased':
        if (this.cur && !THROUGH_PITCH.has(this.cur.trigger)) return this.stop(t, 900, 'the pitch');
        return [];
      case 'halfInningEnd': {
        if (this.seenBreakStart) return []; // the break event carries its length
        if (c.inning === 7 && ev.half !== 'bottom') return []; // the seventh-inning stretch belongs to the organ
        return this.play('inningBreak', t, { delayMs: 1500 });
      }
      case 'breakStart': {
        this.seenBreakStart = true;
        const sec = typeof ev.sec === 'number' ? ev.sec : 0;
        const inn = typeof ev.inning === 'number' ? ev.inning : c.inning;
        if (inn === 7 && ev.half === 'top') return []; // the stretch
        if (this.cur?.trigger === 'inningBreak') {
          this.cur.until = Math.min(this.cur.until, t + Math.max(4, sec - 1));
          return [];
        }
        if (sec > 0 && sec < 14) return [];
        return this.play('inningBreak', t, { delayMs: 800, maxMs: sec > 0 ? Math.round(Math.min(90, sec - 1.5) * 1000) : 0 });
      }
      case 'runScored': {
        const forHome = ev.team === 'home' || (ev.team === undefined && homeBat);
        if (!forHome) return [];
        this.halfRuns++;
        const home = typeof ev.runsHome === 'number' ? ev.runsHome : c.score.home;
        const away = typeof ev.runsAway === 'number' ? ev.runsAway : c.score.away;
        if (homeBat && c.inning >= 9 && home > away && home - away <= 1) return []; // a walk-off: the final music follows
        if (this.halfRuns >= 2 && this.rallyHalf !== key) {
          this.rallyHalf = key;
          const r = this.play('rally', t, { delayMs: 600 });
          if (r.length) return r;
        }
        return this.play('runScored', t, { delayMs: 700 });
      }
      case 'homeRun':
        return homeBat ? this.play('homeRun', t, { delayMs: 1200 }) : [];
      case 'plateAppearanceEnd': {
        const r = String(ev.result ?? '');
        if (homeBat && (r === 'double' || r === 'triple') && this.rallyHalf !== key) {
          this.rallyHalf = key;
          return this.play('rally', t, { delayMs: 900 });
        }
        return [];
      }
      case 'pitchingChangeStart':
      case 'pitchingChange': {
        const home = c.half === 'top'; // the home team is in the field
        return this.play('pitchingChange', t, { delayMs: 600, level: home ? 1 : 0.7 });
      }
      case 'gameEnd': {
        const w = String(ev.winner);
        if (w === 'home') return this.play('finalWin', t, { delayMs: 1500 });
        if (w === 'away') return this.play('finalLoss', t, { delayMs: 1500 });
        return this.stop(t, 1500, 'a tie');
      }
      default:
        return [];
    }
  }

  /** steady-time housekeeping (call a few times a second): a break that has run its course fades out */
  tick(t: number): MusicDecision[] {
    if (this.cur && this.cur.until !== Infinity && t > this.cur.until) {
      if (TRIGGERS[this.cur.trigger].loop) return this.stop(t, 1500, 'the break is over');
      this.cur = null;
    }
    return [];
  }

  /** the player or the game is silenced (pause, skip, mute, fast-forward, music off) */
  silence(t: number, reason: string, fadeMs = 700): MusicDecision[] {
    return this.stop(t, fadeMs, reason);
  }

  /** debug (`?musictest`): play a trigger now, whatever is going on */
  force(trigger: Trigger, t: number): MusicDecision[] {
    return this.play(trigger, t, { force: true });
  }

  /** has a file started or been decided for one of these triggers lately (the organ then stays quiet)? */
  covered(triggers: Trigger[], t: number, within = 4): boolean {
    for (const k of triggers) {
      const at = this.lastAt.get(k);
      if (at !== undefined && t - at <= within && this.hasTrack(k)) return true;
    }
    return false;
  }

  /** the variant that will play next for a trigger (chosen now, so it can be fetched ahead); null when there is no file */
  peek(trigger: Trigger): TrackInfo | null {
    if (!this.planned.has(trigger)) this.planned.set(trigger, pickTrack(this.o.tracks(), trigger, this.o.rng, this.recent.get(trigger) ?? []));
    return this.planned.get(trigger) ?? null;
  }

  /** the manifest changed: forget the plans */
  resetPlans() {
    this.planned.clear();
  }

  hasTrack(trigger: Trigger): boolean {
    return this.o.tracks().some((x) => x.trigger === trigger);
  }
}
