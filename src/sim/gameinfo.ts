/**
 * Who and where, for the broadcast and the HUD: the ballpark, the umpire crew, the managers and pitching coaches, the clubs' records coming in and
 * the date. All of it is generated data (fictional names, never real people), deterministic, and drawn from its OWN random streams, so it never
 * changes a game: the park and the managers belong to the home / each club (a club always plays in the same park under the same manager), the
 * umpires, the date and the records to the game's seed. Records are derived from the clubs' strength (the ratings of the lineup and the pitchers),
 * not from a simulated season, so they cost nothing at load.
 */
import { Rng } from './rng';
import type { FenceConfig } from './field';
import { DEFAULT_FENCE } from './field';
import type { Team, TeamSide } from './types';

export interface Venue {
  name: string;
  /** what people call it ("the Yards") */
  short: string;
  city: string;
  opened: number;
  capacity: number;
  /** fence distances down the lines and to centre (ft), from the sim's own fence */
  lf: number;
  cf: number;
  rf: number;
  /** a feature of the park the booth can mention */
  feature: string;
}

export interface Official {
  key: 'plate' | 'first' | 'second' | 'third';
  name: string;
  /** seasons in the big leagues */
  years: number;
  /** the crew chief */
  chief: boolean;
}

export interface Skipper {
  name: string;
  /** seasons managing this club (including this one) */
  season: number;
  /** what he did before */
  background: 'catcher' | 'infielder' | 'outfielder' | 'pitcher' | 'coach';
  pitchingCoach: string;
}

export interface TeamRecord {
  w: number;
  l: number;
  /** the last ten games, oldest first ('W' / 'L') */
  last10: ('W' | 'L')[];
  streak: { kind: 'W' | 'L'; n: number };
  /** the strength the record was derived from (rating points, ~50 = average) */
  strength: number;
}

export interface GameInfo {
  venue: Venue;
  umpires: Official[];
  managers: Record<TeamSide, Skipper>;
  records: Record<TeamSide, TeamRecord>;
  /** the home club's costumed mascot */
  mascot: string;
  date: { month: number; day: number; weekday: number; monthName: string; weekdayName: string };
  /** the configured wind (m/s, sim axes), or null when the game is calm: only a real wind may be said to carry the ball */
  wind: { x: number; z: number } | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PARK_A = ['Bluestem', 'Harborlight', 'Cobalt', 'Juniper', 'Foundry', 'Lantern', 'Copperline', 'Meridian', 'Northgate', 'Kestrel', 'Larkspur', 'Old Mill', 'Tidewater', 'Ironwood', 'Signal Hill', 'Granary', 'Riverbend', 'Cinder', 'Prairie Light', 'Heritage'];
const PARK_B = ['Field', 'Park', 'Ballpark', 'Field', 'Yards', 'Grounds'];
const FEATURES = [
  'the hand-operated scoreboard in left-center',
  'the old brick warehouse beyond the right-field wall',
  'the bullpens stacked one above the other in right-center',
  'the grass berm beyond the center-field fence, where families spread out blankets',
  'the train tracks that run past the left-field corner',
  'the tall scoreboard clock above the center-field bleachers',
  'the ivy-free brick backstop, the closest seats to home plate in the league',
  'the river walk behind the right-field seats',
];

// officials and skippers: names of their own (not the players' lists), and never a real umpire, manager or broadcaster (see DENY)
const OFF_FIRST = ['Walt', 'Gene', 'Lou', 'Russ', 'Phil', 'Dale', 'Marty', 'Ned', 'Stan', 'Earl', 'Hal', 'Vern', 'Doug', 'Larry', 'Terry', 'Glenn', 'Rich', 'Ted', 'Carl', 'Roy', 'Wes', 'Curt', 'Gil', 'Boyd', 'Dewey', 'Mort', 'Abe', 'Otis', 'Rudy', 'Lowell', 'Emmett', 'Floyd', 'Merle', 'Virgil', 'Ike', 'Rollie', 'Hector', 'Ramon', 'Tomas', 'Kenji', 'Dario', 'Anton'];
const OFF_LAST = ['Hollister', 'Brannigan', 'Okafor', 'Lindqvist', 'Marchetti', 'Pruitt', 'Szymanski', 'Whitlock', 'Fairbanks', 'Delacroix', 'Kowalczyk', 'Ambrose', 'Thibodeaux', 'Ostrander', 'Rourke', 'Vandermeer', 'Galloway', 'Ferrante', 'Haverford', 'Quimby', 'Stroud', 'Battaglia', 'Ellery', 'Mancuso', 'Pettigrew', 'Lockhart', 'Varga', 'Hruska', 'Ibarra', 'Tanaka', 'Moreau', 'Calloway', 'Underhill', 'Rasmussen', 'Okonjo', 'Pellegrino', 'Weatherby', 'Dunleavy', 'Abernathy', 'Kincaid'];
const MASCOT_NAMES = ['Rowdy', 'Scooter', 'Buster', 'Dash', 'Slugger', 'Pepper', 'Ziggy', 'Bingo', 'Sparky', 'Rascal', 'Murphy', 'Biscotti'];
const SINGULAR: Record<string, string> = { Ironmen: 'Ironman', Bison: 'Bison', Thunder: 'Thunderbolt', Storm: 'Stormcloud', Lynx: 'Lynx', 'Sea Dogs': 'Sea Dog', Foxes: 'Fox', Wolves: 'Wolf' };

/** Real people's names that must never be generated (umpires, managers, broadcasters): checked by a test across many seeds too. */
export const DENY = new Set(['joe west', 'angel hernandez', 'cb bucknor', 'ron kulpa', 'jim joyce', 'doug harvey', 'dave roberts', 'david roberts', 'aaron boone', 'kevin cash', 'bob melvin', 'bruce bochy', 'terry francona', 'tony la russa', 'joe torre', 'bobby cox', 'jim leyland', 'joe maddon', 'dusty baker', 'buck showalter', 'vin scully', 'jon miller', 'joe buck', 'harry caray', 'bob uecker', 'jim kaat', 'jim palmer', 'jim deshaies', 'ernie harwell', 'mel allen', 'red barber', 'jack buck', 'marty brennaman', 'bob costas', 'gary cohen', 'len kasper', 'dave sims', 'phil rizzuto', 'larry andersen', 'rich waltz', 'terry collins', 'gene lamont', 'phil garner', 'carl erskine', 'stan musial', 'ted williams', 'roy halladay', 'ted barrett', 'doug eddings', 'phil cuzzi', 'larry vanover', 'ted simmons']);

const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

function person(rng: Rng, used: Set<string>): string {
  for (let k = 0; k < 50; k++) {
    const n = `${rng.pick(OFF_FIRST)} ${rng.pick(OFF_LAST)}`;
    const last = n.split(' ')[1];
    if (DENY.has(n.toLowerCase()) || used.has(last)) continue;
    used.add(last);
    return n;
  }
  return `${rng.pick(OFF_FIRST)} ${rng.pick(OFF_LAST)}`;
}

/** The fence distance (ft) at a spray angle, from the fence polygon. */
function fenceFt(f: FenceConfig, deg: number): number {
  const p = f.points;
  for (let i = 1; i < p.length; i++) {
    if (deg <= p[i].angleDeg) {
      const a = p[i - 1];
      const b = p[i];
      const u = (deg - a.angleDeg) / Math.max(1e-6, b.angleDeg - a.angleDeg);
      return Math.round(((a.distance + (b.distance - a.distance) * u) / 0.3048) / 5) * 5;
    }
  }
  return 400;
}

/** The home club's park (stable per club: a club always plays in the same park). */
export function parkFor(team: Pick<Team, 'name' | 'abbrev'>, fence: FenceConfig = DEFAULT_FENCE): Venue {
  const rng = new Rng(`park:${team.abbrev}:${team.name}`);
  const a = rng.pick(PARK_A);
  const b = rng.pick(PARK_B);
  const city = team.name.split(' ')[0];
  const name = `${a} ${b}`;
  const short = b === 'Yards' ? 'the Yards' : b === 'Grounds' ? 'the Grounds' : a;
  return {
    name,
    short,
    city,
    opened: 1912 + Math.floor(rng.next() * 105),
    capacity: 1000 * (31 + Math.floor(rng.next() * 15)),
    lf: fenceFt(fence, -45),
    cf: fenceFt(fence, 0),
    rf: fenceFt(fence, 45),
    feature: rng.pick(FEATURES),
  };
}

/** A club's strength in rating points (~50 = league average): its lineup's bats and its pitching. */
export function teamStrength(t: Team): number {
  const by = new Map(t.roster.map((p) => [p.id, p]));
  const hitters = t.lineup.map((s) => by.get(s.playerId)).filter((p) => !!p);
  const bat = hitters.reduce((a, p) => a + (p!.ratings.contact + p!.ratings.power + p!.ratings.eye) / 3, 0) / Math.max(1, hitters.length);
  const arms = [t.startingPitcherId, ...(t.rotation ?? []), ...t.bullpen].map((id) => by.get(id)).filter((p) => !!p);
  const pit = arms.reduce((a, p) => a + (p!.ratings.control + p!.ratings.movement) / 2 + (p!.ratings.velocity - 93) * 1.5, 0) / Math.max(1, arms.length);
  return 0.55 * bat + 0.45 * pit;
}

function record(rng: Rng, strength: number, games: number): TeamRecord {
  const pct = Math.min(0.64, Math.max(0.36, 0.5 + (strength - 50) * 0.012 + rng.normal(0, 0.03)));
  const w = Math.round(games * pct);
  const l = games - w;
  // the last ten, consistent with the record: draw a sequence with the club's own win rate, then keep it if it fits (it nearly always does)
  const n = Math.min(10, games);
  let last10: ('W' | 'L')[] = [];
  for (let k = 0; k < 20; k++) {
    last10 = Array.from({ length: n }, () => (rng.next() < pct ? 'W' : 'L'));
    const wins = last10.filter((x) => x === 'W').length;
    if (wins <= w && n - wins <= l) break;
  }
  const kind = last10[last10.length - 1] ?? 'W';
  let s = 0;
  for (let i = last10.length - 1; i >= 0 && last10[i] === kind; i--) s++;
  return { w, l, last10, streak: { kind, n: s }, strength: Math.round(strength * 10) / 10 };
}

export function buildGameInfo(seed: number | string, teams: Record<TeamSide, Team>, opts: { fence?: FenceConfig; wind?: { x: number; z: number } } = {}): GameInfo {
  const rng = new Rng(`${seed}:gameinfo`);
  // the date: a day of the regular season (April to September); the weekday follows the calendar of a fixed year
  const month = 4 + Math.floor(rng.next() * 6);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = 1 + Math.floor(rng.next() * dim);
  const weekday = new Date(Date.UTC(2026, month - 1, day)).getUTCDay();
  const opening = Date.UTC(2026, 2, 26);
  const games = Math.max(4, Math.round(((Date.UTC(2026, month - 1, day) - opening) / 86400000) * 0.93));
  const used = new Set<string>();
  const crew = new Rng(`${seed}:umpires`);
  const keys: Official['key'][] = ['plate', 'first', 'second', 'third'];
  const chiefAt = Math.floor(crew.next() * 4);
  const umpires: Official[] = keys.map((key, i) => ({ key, name: person(crew, used), years: i === chiefAt ? 14 + Math.floor(crew.next() * 12) : 2 + Math.floor(crew.next() * 14), chief: i === chiefAt }));
  const skipper = (t: Team): Skipper => {
    const r = new Rng(`skipper:${t.abbrev}:${t.name}`);
    const bg = r.pick(['catcher', 'infielder', 'outfielder', 'pitcher', 'coach'] as const);
    const name = person(r, used);
    return { name, season: 1 + Math.floor(r.next() * 7), background: bg, pitchingCoach: person(r, used) };
  };
  const recs = new Rng(`${seed}:records`);
  const g2 = games + (recs.next() < 0.5 ? 0 : 1); // the two clubs have played about as many games
  const home = teams.home;
  const nick = home.name.split(' ').slice(1).join(' ');
  const m = new Rng(`mascot:${home.abbrev}`);
  return {
    venue: parkFor(home, opts.fence),
    umpires,
    managers: { home: skipper(teams.home), away: skipper(teams.away) },
    records: { home: record(recs, teamStrength(teams.home), games), away: record(recs, teamStrength(teams.away), g2) },
    mascot: `${m.pick(MASCOT_NAMES)} the ${SINGULAR[nick] ?? nick.replace(/s$/, '')}`,
    date: { month, day, weekday, monthName: MONTHS[month - 1], weekdayName: WEEKDAYS[weekday] },
    wind: opts.wind && Math.hypot(opts.wind.x, opts.wind.z) > 0.3 ? { ...opts.wind } : null,
  };
}

/** a stable small integer from a string (for flavour choices keyed by name) */
export const nameHash = hashStr;
