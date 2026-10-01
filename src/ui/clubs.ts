/**
 * The league the menu offers: 30 clubs built from the sim's own city and nickname lists, plus the pair of teams a seed produces by
 * itself. A club is only a name and abbreviation until a game starts; `buildTeam` then asks the sim to generate the roster, so a
 * given club is always the same team (its players come from the club's own seed).
 */
import { CITIES, MASCOTS, generateTeam, type Team, type TeamSide } from '../sim';
import { teamInfo } from '../engine/realSimAdapter';
import { CLUB_COUNT, type MatchSetup } from './settings';

export interface Club {
  index: number;
  city: string;
  abbr: string;
  name: string;
}

export const CLUBS: Club[] = Array.from({ length: CLUB_COUNT }, (_, i) => {
  const [city, abbr] = CITIES[i % CITIES.length];
  return { index: i, city, abbr, name: `${city} ${MASCOTS[(i * 7 + 4) % MASCOTS.length]}` };
});

export const CLUB_ABBRS = CLUBS.map((c) => c.abbr);

/** Jersey and trim colours of a club on a side (the engine derives them from the abbreviation and the side). */
export function clubColors(c: { name: string; abbr: string }, side: 'home' | 'away') {
  const t = teamInfo({ name: c.name, abbrev: c.abbr }, side === 'home' ? 1 : 0);
  return { color: t.color, trim: t.trim };
}

/** What the sim does when no team is given (the seed's own pair); only the names are needed for the menu. */
export function seedTeams(seed: number): { away: Club; home: Club } {
  const make = (side: TeamSide, index: number): Club => {
    const t = generateTeam(`${seed}:${side}`, { side });
    return { index, city: t.name.split(' ')[0], abbr: t.abbrev, name: t.name };
  };
  return { away: make('away', -1), home: make('home', -1) };
}

/** `homeTeam` / `awayTeam` for the sim, only for sides the player picked: untouched sides stay the seed's own teams, so a seed alone reproduces the old game. */
export function simTeams(m: MatchSetup): { awayTeam?: Team; homeTeam?: Team } {
  const out: { awayTeam?: Team; homeTeam?: Team } = {};
  const build = (c: Club, side: TeamSide) => generateTeam(`club:${c.abbr}`, { side, name: c.name, abbrev: c.abbr });
  if (m.away >= 0) out.awayTeam = build(CLUBS[m.away], 'away');
  if (m.home >= 0) out.homeTeam = build(CLUBS[m.home], 'home');
  return out;
}

/** Two different random clubs. */
export function randomClubs(rnd: () => number = Math.random): { away: number; home: number } {
  const away = Math.floor(rnd() * CLUB_COUNT);
  let home = Math.floor(rnd() * (CLUB_COUNT - 1));
  if (home >= away) home++;
  return { away, home };
}
