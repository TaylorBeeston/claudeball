/**
 * When the home crowd reacts to who the PA announces (pure: no Web Audio, no clock; its own seeded stream, so a game's reactions are the same on
 * every run). The picks come from the sim's game info (`src/sim/fans.ts`): the home club's favourites and the visitors it loves to boo. This
 * decides, per plate appearance, whether the crowd makes something of it and how much:
 *   - a favourite's first time up: always, full size; later: now and then, smaller, more likely late in a close game or with runners on
 *   - a villain's first time up: always; later: now and then
 *   - a visitor who hurt them earlier (a home run, or two runs or more driven in) gets booed his next time up
 *   - a favourite pitcher: the ace's first batter (the PA's "Now pitching"), the closer coming in
 * Capped per game so it stays an occasion and not every batter. `force` (debug, `?fans=all`): every batter is a favourite or a villain, no caps.
 */
import type { CrowdFans, FanKind } from '../sim/fans';
import { mulberry32 } from './dsp';
import type { RawEvent } from './types';

export type FanSide = 'favourite' | 'villain';

export interface FanMoment {
  id: string;
  name: string;
  side: FanSide;
  /** why: the pick's kind, or 'burned' (a visitor who hurt them earlier this game) */
  kind: FanKind | 'burned';
  /** 0..1 how big the reaction is */
  size: number;
  /** his plate appearance this game (1: the first time up); pitchers: 1 */
  pa: number;
  pitcher: boolean;
  years: number;
  /** a 'burned' visitor: what he did */
  burnedBy?: 'hr' | 'rbi';
}

export interface FanSituation {
  inning: number;
  half: 'top' | 'bottom';
  score: { home: number; away: number };
  runners: [boolean, boolean, boolean];
}

/** how many reactions a game gets at most */
export const FAN_CAPS = { favourite: 5, villain: 4, pitcher: 2, perPlayer: 3 };

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

export class FanBook {
  readonly fans: CrowdFans;
  /** every reaction the book called this game (debug / evidence) */
  readonly log: (FanMoment & { inning: number; half: 'top' | 'bottom' })[] = [];
  private rng: () => number;
  private force: boolean;
  private pas = new Map<string, number>();
  private reacted = new Map<string, number>();
  private count = { favourite: 0, villain: 0, pitcher: 0 };
  private introduced = new Set<string>();
  private burned = new Map<string, 'hr' | 'rbi'>();
  /** the plate appearance in progress: the batter and the visitors' runs when it began */
  private cur: { id: string; away: boolean; runs: number } | null = null;
  private awayRuns = 0;

  constructor(fans: CrowdFans | null | undefined, o: { seed: string; force?: boolean }) {
    this.fans = fans ?? { favourites: [], villains: [], rivals: false };
    this.rng = mulberry32(hash(`${o.seed}|fans`));
    this.force = !!o.force;
  }

  private pick(id: string, side: FanSide) {
    return (side === 'favourite' ? this.fans.favourites : this.fans.villains).find((f) => f.id === id);
  }

  private moment(m: Omit<FanMoment, 'size'>, size: number, s: FanSituation): FanMoment {
    const out = { ...m, size: Math.round(size * 100) / 100 };
    this.reacted.set(m.id, (this.reacted.get(m.id) ?? 0) + 1);
    this.log.push({ ...out, inning: s.inning, half: s.half });
    return out;
  }

  /** a new batter (and the pitcher he faces): the reaction to his introduction, if any */
  batterUp(batterId: string, name: string, pitcherId: string, pitcherName: string, s: FanSituation): { batter: FanMoment | null; pitcher: FanMoment | null } {
    const home = s.half === 'bottom';
    const pa = (this.pas.get(batterId) ?? 0) + 1;
    this.pas.set(batterId, pa);
    this.cur = { id: batterId, away: !home, runs: this.awayRuns };
    // the pitcher: only his introduction (the first batter he faces), only the home club's own
    let pitcher: FanMoment | null = null;
    if (pitcherId && !this.introduced.has(pitcherId)) {
      this.introduced.add(pitcherId);
      const f = !home ? this.pick(pitcherId, 'favourite') : undefined;
      if ((f || (this.force && !home)) && (this.force || this.count.pitcher < FAN_CAPS.pitcher)) {
        this.count.pitcher++;
        pitcher = this.moment({ id: pitcherId, name: pitcherName, side: 'favourite', kind: f?.kind ?? 'ace', pa: 1, pitcher: true, years: f?.years ?? 0 }, 0.9, s);
      }
    }
    return { batter: this.batter(batterId, name, pa, s), pitcher };
  }

  private batter(id: string, name: string, pa: number, s: FanSituation): FanMoment | null {
    const side: FanSide = s.half === 'bottom' ? 'favourite' : 'villain';
    const f = this.pick(id, side);
    const burned = side === 'villain' ? this.burned.get(id) : undefined;
    const r = this.rng();
    if (this.force) return this.moment({ id, name, side, kind: f?.kind ?? (side === 'favourite' ? 'star' : 'rival'), pa, pitcher: false, years: f?.years ?? 0 }, pa === 1 ? 1 : 0.6, s);
    if (!f && !burned) return null;
    if (this.count[side] >= FAN_CAPS[side] || (this.reacted.get(id) ?? 0) >= FAN_CAPS.perPlayer) return null;
    const late = s.inning >= 7 && Math.abs(s.score.home - s.score.away) <= 2;
    const big = late || s.runners[1] || s.runners[2];
    let size = 0;
    if (side === 'favourite') {
      if (pa === 1) size = 1;
      else if (r < (big ? 0.6 : 0.2)) size = big ? 0.85 : 0.6;
    } else if (burned) size = 0.8;
    else if (pa === 1) size = 0.9;
    else if (r < 0.3) size = 0.5;
    if (!size) return null;
    this.count[side]++;
    // (a villain who also hurt them today: the booth has the fresher reason)
    const kind = burned ? 'burned' : f!.kind;
    if (burned) this.burned.delete(id);
    return this.moment({ id, name, side, kind, pa, pitcher: false, years: f?.years ?? 0, burnedBy: burned }, size, s);
  }

  /** the game's events: a visitor who hurt the home club is remembered for his next time up */
  observe(ev: RawEvent) {
    switch (ev.type) {
      case 'runScored':
        if (ev.team === 'away') this.awayRuns++;
        break;
      case 'homeRun':
        if (this.cur?.away && ev.batterId === this.cur.id) this.burned.set(this.cur.id, 'hr');
        break;
      case 'plateAppearanceEnd': {
        const c = this.cur;
        // two runs or more in on his plate appearance (runs that scored while he batted: near enough his RBIs)
        if (c?.away && ev.batterId === c.id && !this.burned.has(c.id) && this.awayRuns - c.runs >= 2) this.burned.set(c.id, 'rbi');
        this.cur = null;
        break;
      }
      default:
        break;
    }
  }

  /** what the debug panel and the harness show */
  get state() {
    return { favourites: this.fans.favourites.map((f) => `${f.name} (${f.kind})`), villains: this.fans.villains.map((f) => `${f.name} (${f.kind})`), rivals: this.fans.rivals, count: { ...this.count }, log: this.log.slice(-12) };
  }
}
