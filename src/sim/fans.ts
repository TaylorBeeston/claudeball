/**
 * Who the home crowd cares about: a few crowd favourites on the home club and, now and then, a villain or two on the visitors. Flavour only
 * (the crowd's reaction when the PA announces them, a line from the booth), drawn from streams of its own, so it never changes a game:
 *   - favourites belong to the home club (`fans:<abbrev>:<name>`): a club's fans love the same players every time it is at home. Picked from the
 *     lineup, weighted toward the best bats and the veterans; one may be the hometown kid; the ace and the closer can be favourites too.
 *   - villains belong to the matchup (`foes:<home>:<away>`, the rivalry to the pair either way round): a former home player now with the
 *     visitors, or the rival's best power bat. Most visits have none. (A visitor who hurts them during the game is the audio's to notice.)
 * Seasons with the club are generated here (the rosters do not keep a history), bounded by age.
 */
import { Rng } from './rng';
import type { PlayerInfo, Team, TeamSide } from './types';

export type FanKind =
  /** favourites: the club's best bat, a long-serving veteran, the local kid, the number one starter (the ace), the closer */
  | 'star' | 'veteran' | 'hometown' | 'ace' | 'closer'
  /** villains: played for the home club before, the rival club's big bat */
  | 'former' | 'rival';

export interface FanPick {
  id: string;
  name: string;
  kind: FanKind;
  /** favourites: seasons with the home club; a former player: the seasons he played for it */
  years: number;
  pitcher: boolean;
}

export interface CrowdFans {
  favourites: FanPick[];
  villains: FanPick[];
  /** the two clubs are rivals */
  rivals: boolean;
}

/** the lineup score `generateTeam` orders the bats by */
const batScore = (p: PlayerInfo) => p.ratings.contact * 0.35 + p.ratings.power * 0.35 + p.ratings.eye * 0.2 + p.ratings.speed * 0.1;

const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

/** two clubs are rivals (either way round): about one pair in seven */
export const rivalsOf = (a: Pick<Team, 'abbrev'>, b: Pick<Team, 'abbrev'>) => hashStr([a.abbrev, b.abbrev].sort().join('|')) % 7 === 3;

const hitters = (t: Team): PlayerInfo[] => {
  const by = new Map(t.roster.map((p) => [p.id, p]));
  return t.lineup.map((s) => by.get(s.playerId)).filter((p): p is PlayerInfo => !!p);
};

/** seasons with a club: a veteran most of his career, anyone else a few; never before he was 21 */
const seasons = (rng: Rng, age: number, veteran: boolean) => {
  const most = Math.max(1, age - 21);
  return Math.min(most, veteran ? 6 + Math.floor(rng.next() * 8) : 2 + Math.floor(rng.next() * 5));
};

function favourites(home: Team): FanPick[] {
  const rng = new Rng(`fans:${home.abbrev}:${home.name}`);
  const bats = hitters(home);
  const out: FanPick[] = [];
  if (bats.length) {
    const n = Math.min(bats.length, 1 + (rng.next() < 0.6 ? 1 : 0) + (rng.next() < 0.25 ? 1 : 0));
    const mean = bats.reduce((a, p) => a + batScore(p), 0) / bats.length;
    const best = bats.reduce((a, p) => (batScore(p) > batScore(a) ? p : a));
    const pool = [...bats];
    const hometown = rng.next() < 0.35;
    for (let k = 0; k < n && pool.length; k++) {
      // weighted toward the best bats and the veterans (the fans have watched them longest)
      const w = pool.map((p) => Math.exp((batScore(p) - mean) / 5) * (p.age >= 30 ? 1.6 : 1));
      let r = rng.next() * w.reduce((a, x) => a + x, 0);
      let i = 0;
      while (i < pool.length - 1 && (r -= w[i]) > 0) i++;
      const p = pool.splice(i, 1)[0];
      const kind: FanKind = p === best ? 'star' : hometown && !out.some((f) => f.kind === 'hometown') ? 'hometown' : p.age >= 30 ? 'veteran' : 'star';
      out.push({ id: p.id, name: p.name, kind, years: seasons(rng, p.age, kind === 'veteran' || kind === 'hometown'), pitcher: false });
    }
  }
  const by = new Map(home.roster.map((p) => [p.id, p]));
  // the ace (the club's number one starter, a favourite when he starts) and the closer (the first man of the bullpen)
  const ace = by.get(home.rotation?.[0] ?? home.startingPitcherId);
  if (ace?.isPitcher && rng.next() < 0.5) out.push({ id: ace.id, name: ace.name, kind: 'ace', years: seasons(rng, ace.age, false), pitcher: true });
  const closer = by.get(home.bullpen[0]);
  if (closer && rng.next() < 0.45) out.push({ id: closer.id, name: closer.name, kind: 'closer', years: seasons(rng, closer.age, false), pitcher: true });
  return out;
}

function villains(home: Team, away: Team, rivals: boolean): FanPick[] {
  const rng = new Rng(`foes:${home.abbrev}:${away.abbrev}`);
  const bats = hitters(away);
  const out: FanPick[] = [];
  if (!bats.length) return out;
  // a former home player: one of the visitors' bats played here a while (about one visit in three)
  if (rng.next() < 0.3) {
    const p = rng.pick(bats);
    out.push({ id: p.id, name: p.name, kind: 'former', years: Math.min(Math.max(1, p.age - 21), 1 + Math.floor(rng.next() * 5)), pitcher: false });
  }
  // a rivalry: the visitors' biggest power bat hears it every time
  if (rivals && rng.next() < 0.85) {
    const p = bats.reduce((a, b) => (b.ratings.power > a.ratings.power ? b : a));
    if (!out.some((f) => f.id === p.id)) out.push({ id: p.id, name: p.name, kind: 'rival', years: 0, pitcher: false });
  }
  return out;
}

/** The home crowd's favourites and villains for a game between these clubs (the same clubs always give the same picks). */
export function crowdFans(teams: Record<TeamSide, Team>): CrowdFans {
  const rivals = rivalsOf(teams.home, teams.away);
  return { favourites: favourites(teams.home), villains: villains(teams.home, teams.away, rivals), rivals };
}
