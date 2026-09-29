import type { BatterLine, BatterStats, FieldPosition, PitcherLine, PitcherStats, PlayerStatsEntry, PriorStats, TeamStatsSnapshot } from './types';
import type { PlayerRT, TeamRT, World } from './world';

const div = (a: number, b: number) => (b > 0 ? a / b : 0);

export const emptyBatting = (): BatterLine => ({ pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, bb: 0, so: 0, hbp: 0, rbi: 0, r: 0, sb: 0, cs: 0, sf: 0, sh: 0 });
export const emptyPitching = (): PitcherLine => ({ outs: 0, bf: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, hbp: 0, pitches: 0, strikes: 0, wp: 0 });

export function addBatting(a: BatterLine, b: BatterLine): BatterLine {
  const o = { ...a };
  for (const k of Object.keys(o) as (keyof BatterLine)[]) o[k] += b[k];
  return o;
}
export function addPitching(a: PitcherLine, b: PitcherLine): PitcherLine {
  const o = { ...a };
  for (const k of Object.keys(o) as (keyof PitcherLine)[]) o[k] += b[k];
  return o;
}

export function batterStats(line: BatterLine, g: number): BatterStats {
  const singles = line.h - line.doubles - line.triples - line.hr;
  const tb = singles + 2 * line.doubles + 3 * line.triples + 4 * line.hr;
  const avg = div(line.h, line.ab);
  const obp = div(line.h + line.bb + line.hbp, line.ab + line.bb + line.hbp + line.sf);
  const slg = div(tb, line.ab);
  return { ...line, g, tb, avg, obp, slg, ops: obp + slg };
}

export const inningsString = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;

export function pitcherStats(line: PitcherLine, g: number): PitcherStats {
  return { ...line, g, ip: inningsString(line.outs), era: div(line.er * 27, line.outs), whip: div((line.h + line.bb) * 3, line.outs) };
}

function entry(p: PlayerRT, prior: PriorStats | undefined, pos: FieldPosition | 'P', inGame: boolean): PlayerStatsEntry {
  const pr = prior?.[p.info.id];
  const playedBat = p.bat.pa > 0 || p.used ? 1 : 0;
  const pitchedNow = p.pit.pitches > 0 || p.pit.bf > 0 ? 1 : 0;
  const isP = p.info.isPitcher;
  return {
    playerId: p.info.id,
    name: p.info.name,
    jersey: p.info.jersey,
    position: pos,
    inGame,
    game: { batting: batterStats(p.bat, playedBat), pitching: isP ? pitcherStats(p.pit, pitchedNow) : null },
    season: {
      batting: batterStats(addBatting(pr?.bat ?? emptyBatting(), p.bat), (pr?.g ?? 0) + playedBat),
      pitching: isP ? pitcherStats(addPitching(pr?.pit ?? emptyPitching(), p.pit), (pr?.pg ?? 0) + pitchedNow) : null,
    },
  };
}

/** Live box score for one team. */
export function teamStats(w: World, t: TeamRT): TeamStatsSnapshot {
  const prior = w.cfg.priorStats;
  const batters: PlayerStatsEntry[] = [];
  const seen = new Set<PlayerRT>();
  for (const s of t.lineup) {
    seen.add(s.player);
    batters.push(entry(s.player, prior, s.position === 'DH' ? 'DH' : (s.player.fieldPos ?? s.position), s.player.inGame));
  }
  for (const p of t.players.values()) {
    if (seen.has(p) || p.info.isPitcher || !p.used) continue;
    batters.push(entry(p, prior, p.fieldPos ?? p.info.primaryPosition, p.inGame));
  }
  const pitchers = [...t.players.values()].filter((p) => p.info.isPitcher && p.used).map((p) => entry(p, prior, 'P', p === t.pitcher));
  return { batters, pitchers, totals: { runs: t.runs, hits: t.hits, errors: t.errors, lob: t.lob } };
}
