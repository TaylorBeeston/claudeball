import type { ChatCtx } from '../commentary';

/** What the booth knows about the game right now (built from the sim snapshot by the controller; fixtures in tests). */
export interface BoothCtx extends ChatCtx {
  /** a player by id: name and fielding role (`left`, `center`, `short` ...) */
  person?(id: unknown): { name: string; role?: string; number?: number } | undefined;
  /** sim time, seconds */
  time?: number;
}

export const lastNameOf = (full: string) => {
  const p = full.trim().split(/\s+/);
  return p.length > 1 ? p[p.length - 1] : full;
};

const POS_ROLE: Record<string, string> = { P: 'pitcher', C: 'catcher', '1B': 'first', '2B': 'second', '3B': 'third', SS: 'short', LF: 'left', CF: 'center', RF: 'right' };

/** Build the booth's context from the sim's own state snapshot (`game.getState()`); `extra` carries what the sim does not know. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ctxFromRaw(rs: any, extra: { crowd?: number; lastPlay?: string } = {}): BoothCtx {
  const byId = new Map<string, { name: string; role?: string; number?: number; ratings?: Record<string, number> }>();
  for (const p of rs.players ?? []) byId.set(p.id, { name: p.name, role: POS_ROLE[p.position], number: p.jersey, ratings: p.ratings });
  const bi = rs.batter?.info;
  const pi = rs.pitcher?.info;
  const runners = [rs.runners?.first, rs.runners?.second, rs.runners?.third];
  return {
    inning: rs.inning, half: rs.half, outs: rs.outs, balls: rs.balls, strikes: rs.strikes, score: { home: rs.score.home, away: rs.score.away },
    runners: [!!runners[0], !!runners[1], !!runners[2]],
    runnerNames: [runners[0]?.name, runners[1]?.name, runners[2]?.name],
    runnerSpeed: runners.map((r) => (r ? byId.get(r.playerId)?.ratings?.speed : undefined)) as [number?, number?, number?],
    teams: { home: rs.teams.home.name, away: rs.teams.away.name },
    batter: bi && { id: bi.id, name: bi.name, number: bi.jersey, hand: bi.bats, ratings: bi.ratings, bat: rs.batter.line },
    pitcher: pi && { id: pi.id, name: pi.name, number: pi.jersey, hand: pi.throws, ratings: pi.ratings, pit: { ...rs.pitcher.line, pitches: rs.pitcher.pitchCount ?? rs.pitcher.line?.pitches ?? 0 } },
    crowd: extra.crowd ?? 0.3,
    lastPlay: extra.lastPlay,
    person: (id) => byId.get(String(id)),
    time: rs.time,
  };
}
