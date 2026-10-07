/**
 * The booth's facts about the game before the first pitch, read from the sim's own data: the teams (`game.getTeams()`: lineups, starters,
 * arsenals, ratings) and the generated who-and-where (`game.info`: park, officials, managers, records, date). Missing pieces are left out (an
 * older sim without `info` still gets an opening about the clubs and the starters).
 */
import type { ClubFacts, HitterFacts, OpeningFacts, PitcherFacts, Tod } from './pregame';
import { lastNameOf } from './ctx';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** the jersey colours the engine paints (realSimAdapter's palette), in words */
const COLOR_WORDS: Record<string, string> = {
  '#b3202f': 'red', '#161616': 'black', '#f4f4f0': 'white', '#12305f': 'navy', '#0c2340': 'navy', '#c8102e': 'red', '#1d6b3c': 'green', '#f2c94c': 'gold',
  '#e07a1f': 'orange', '#1a1a1a': 'black', '#5b2a86': 'purple', '#e8e8e8': 'silver', '#0a5ea8': 'royal blue', '#ffffff': 'white', '#7a1f2b': 'maroon', '#d8c18a': 'tan',
};
export function colorWords(c?: { color: string; trim: string }): string | undefined {
  if (!c) return undefined;
  const a = COLOR_WORDS[c.color.toLowerCase()];
  const b = COLOR_WORDS[c.trim.toLowerCase()];
  return a && b && a !== b ? `${a} and ${b}` : a;
}

function pitcher(p: any): PitcherFacts | undefined {
  if (!p) return undefined;
  const ars: any[] = Array.isArray(p.arsenal) ? p.arsenal : [];
  const tot = ars.reduce((a, x) => a + (Number(x.usage) || 0), 0) || 1;
  return {
    name: String(p.name),
    last: lastNameOf(String(p.name)),
    throws: p.throws === 'L' ? 'L' : 'R',
    age: typeof p.age === 'number' ? p.age : undefined,
    arsenal: ars.map((x) => ({ type: String(x.type), mph: Number(x.mph) || 0, share: (Number(x.usage) || 0) / tot, grade: typeof x.grade === 'number' ? x.grade : undefined })).sort((a, b) => b.share - a.share),
    control: p.ratings?.control,
    stamina: p.ratings?.stamina,
  };
}

function club(t: any, info: any, side: 'home' | 'away', colors?: (side: 'home' | 'away') => { color: string; trim: string } | undefined): ClubFacts {
  const name = String(t?.name ?? (side === 'home' ? 'Home' : 'Visitors'));
  const parts = name.split(' ');
  const by = new Map<string, any>((t?.roster ?? []).map((p: any) => [p.id, p]));
  const lineup: HitterFacts[] = (t?.lineup ?? [])
    .map((s: any) => {
      const p = by.get(s.playerId);
      if (!p) return null;
      const r = p.ratings ?? {};
      return { name: String(p.name), last: lastNameOf(String(p.name)), pos: String(s.position), bats: p.bats ?? 'R', speed: r.speed ?? 50, power: r.power ?? 50, contact: r.contact ?? 50, eye: r.eye ?? 50 };
    })
    .filter(Boolean) as HitterFacts[];
  const m = info?.managers?.[side];
  return {
    name,
    city: parts[0],
    nick: parts.slice(1).join(' ') || name,
    colors: colorWords(colors?.(side)),
    record: info?.records?.[side],
    manager: m ? { name: m.name, season: m.season, background: m.background, pitchingCoach: m.pitchingCoach } : undefined,
    starter: pitcher(by.get(t?.startingPitcherId)),
    lineup,
  };
}

/** Build the opening's facts from the sim's `Game` (anything with `getTeams()` and optionally `info`). Null when the game has no teams to read. */
export function factsFromGame(game: any, seed: string, tod: Tod, cloudy: boolean, colors?: (side: 'home' | 'away') => { color: string; trim: string } | undefined): OpeningFacts | null {
  const teams = typeof game?.getTeams === 'function' ? game.getTeams() : null;
  if (!teams?.home || !teams?.away) return null;
  const info = game.info ?? null;
  return {
    seed,
    tod,
    cloudy,
    venue: info?.venue,
    date: info?.date,
    umpires: info?.umpires,
    mascot: info?.mascot,
    wind: info?.wind ?? null,
    home: club(teams.home, info, 'home', colors),
    away: club(teams.away, info, 'away', colors),
  };
}
