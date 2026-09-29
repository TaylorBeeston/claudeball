/**
 * A small simulated season: a league of generated teams plays a round robin (each team hosts every other, `rounds` times over), the
 * rotation turns over, and every player's cumulative stats carry from game to game (`GameConfig.priorStats`).
 * Headless; the same seed gives the same season.
 */
import { createGame } from './game';
import { generateTeam } from './roster';
import { addBatting, addPitching, batterStats, emptyBatting, emptyPitching, pitcherStats } from './stats';
import type { BatterStats, PitcherStats, PriorStats, Team } from './types';

export interface SeasonOptions {
  seed: number | string;
  /** Number of teams (default 6). */
  teams?: number;
  /** Times each ordered pair (home, away) plays (default 1: 30 games for 6 teams). */
  rounds?: number;
  /** Spread of team strength (rating points, default 3). */
  strengthSpread?: number;
  innings?: number;
  onGame?: (info: { n: number; total: number; home: string; away: string; homeRuns: number; awayRuns: number }) => void;
}

export interface Standing {
  teamId: string;
  name: string;
  w: number;
  l: number;
  rs: number;
  ra: number;
}

export interface SeasonPlayer {
  playerId: string;
  name: string;
  teamId: string;
  batting: BatterStats;
  pitching: PitcherStats | null;
}

export interface SeasonResult {
  teams: Team[];
  games: number;
  standings: Standing[];
  players: SeasonPlayer[];
  /** The cumulative stats map (pass it on as `priorStats` to continue the season). */
  priorStats: PriorStats;
}

export function simulateSeason(opts: SeasonOptions): SeasonResult {
  const n = opts.teams ?? 6;
  const rounds = opts.rounds ?? 1;
  const teams: Team[] = [];
  for (let i = 0; i < n; i++) {
    const t = generateTeam(`${opts.seed}:season:${i}`, { side: 'home', abbrev: `T${String(i + 1).padStart(2, '0')}`, strength: ((i * 37 + 11) % 7 - 3) * ((opts.strengthSpread ?? 3) / 3) });
    teams.push(t);
  }
  const prior: PriorStats = {};
  const standings = new Map<string, Standing>(teams.map((t) => [t.id, { teamId: t.id, name: t.name, w: 0, l: 0, rs: 0, ra: 0 }]));
  const played = new Map<string, number>();
  const schedule: [number, number][] = [];
  for (let r = 0; r < rounds; r++) for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) if (h !== a) schedule.push([h, a]);
  let gameNo = 0;
  for (const [h, a] of schedule) {
    const start = (t: Team) => {
      const k = played.get(t.id) ?? 0;
      played.set(t.id, k + 1);
      const rot = t.rotation ?? [t.startingPitcherId];
      return { ...t, startingPitcherId: rot[k % rot.length] };
    };
    const home = start(teams[h]);
    const away = start(teams[a]);
    const g = createGame({ seed: `${opts.seed}:g${gameNo}`, homeTeam: home, awayTeam: away, pace: 0, innings: opts.innings, priorStats: prior });
    g.simulateToEnd(6 * 3600);
    const w = g._world;
    for (const side of ['home', 'away'] as const) {
      for (const p of w.teams[side].players.values()) {
        if (!p.used) continue;
        const cur = prior[p.info.id] ?? { g: 0, bat: emptyBatting(), pit: emptyPitching(), pg: 0 };
        prior[p.info.id] = { g: cur.g + 1, bat: addBatting(cur.bat, p.bat), pit: addPitching(cur.pit, p.pit), pg: cur.pg + (p.info.isPitcher && p.pit.bf > 0 ? 1 : 0) };
      }
    }
    const hr = w.teams.home.runs;
    const ar = w.teams.away.runs;
    const sh = standings.get(home.id)!;
    const sa = standings.get(away.id)!;
    sh.rs += hr;
    sh.ra += ar;
    sa.rs += ar;
    sa.ra += hr;
    if (hr > ar) {
      sh.w++;
      sa.l++;
    } else {
      sa.w++;
      sh.l++;
    }
    gameNo++;
    opts.onGame?.({ n: gameNo, total: schedule.length, home: home.name, away: away.name, homeRuns: hr, awayRuns: ar });
  }
  const players: SeasonPlayer[] = [];
  for (const t of teams) {
    for (const p of t.roster) {
      const s = prior[p.id];
      if (!s) continue;
      players.push({ playerId: p.id, name: p.name, teamId: t.id, batting: batterStats(s.bat, s.g), pitching: p.isPitcher ? pitcherStats(s.pit, s.pg) : null });
    }
  }
  return { teams, games: gameNo, standings: [...standings.values()].sort((x, y) => y.w - x.w), players, priorStats: prior };
}
