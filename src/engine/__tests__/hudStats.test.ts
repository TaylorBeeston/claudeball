import { describe, expect, it } from 'vitest';
import { arsenalText, batLine, batterBars, batterTotals, boxBatters, boxPitchers, gradeFill, gradeColor, pitcherBars, pitcherTotals, pitLine, rate, velocityGrade } from '../hudStats';
import type { StatsBat, StatsEntry, StatsPit, TeamStatsView } from '../types';

const bat = (o: Partial<StatsBat> = {}): StatsBat => ({ pa: 4, ab: 4, h: 2, doubles: 0, triples: 0, hr: 1, bb: 0, so: 1, rbi: 2, r: 1, sb: 0, avg: 0.3, obp: 0.36, slg: 0.5, ops: 0.86, ...o });
const pit = (o: Partial<StatsPit> = {}): StatsPit => ({ outs: 16, bf: 24, h: 5, r: 2, er: 2, bb: 1, so: 6, hr: 1, pitches: 88, strikes: 58, ip: '5.1', era: 3.4, whip: 1.1, ...o });
const entry = (id: string, o: Partial<StatsEntry> = {}): StatsEntry => ({
  playerId: id, name: id, jersey: 7, position: 'CF', inGame: true, game: { batting: bat(), pitching: null }, season: { batting: bat({ ab: 300, avg: 0.287 }), pitching: null }, ...o,
});

describe('ratings bars', () => {
  it('maps 20-80 to a fill and colours by grade', () => {
    expect(gradeFill(20)).toBe(0);
    expect(gradeFill(50)).toBeCloseTo(0.5, 6);
    expect(gradeFill(80)).toBe(1);
    expect(gradeFill(10)).toBe(0);
    expect(gradeFill(99)).toBe(1);
    expect(gradeColor(75)).not.toBe(gradeColor(35));
  });
  it('maps fastball mph onto the scale', () => {
    expect(velocityGrade(84)).toBe(20);
    expect(velocityGrade(92)).toBeCloseTo(50, 6);
    expect(velocityGrade(100)).toBe(80);
    expect(velocityGrade(70)).toBe(20);
  });
  it('builds the batter and pitcher bars, tolerating missing ratings', () => {
    const b = batterBars({ power: 70, contact: 45, speed: 60, eye: 55 });
    expect(b.map((x) => x.label)).toEqual(['POWER', 'CONTACT', 'SPEED', 'EYE']);
    expect(b[0].grade).toBe(70);
    const p = pitcherBars({ velocity: 96, control: 55, movement: 62, stamina: 48 });
    expect(p.map((x) => x.label)).toEqual(['VELOCITY', 'CONTROL', 'MOVEMENT', 'STAMINA']);
    expect(p[0].text).toBe('96');
    expect(p[0].grade).toBe(65);
    expect(batterBars(undefined)).toEqual([]);
    expect(pitcherBars(undefined)).toEqual([]);
  });
  it('lists the arsenal', () => {
    expect(arsenalText([{ type: 'FF', mph: 95.6 }, { type: 'SL', mph: 86 }])).toBe('4-SEAM 96  ·  SLIDER 86');
    expect(arsenalText(undefined)).toBe('');
  });
});

describe('stat lines and the box score', () => {
  it('formats the live lines', () => {
    expect(batLine(bat())).toBe('2-4  1 HR  2 RBI  1 K');
    expect(batLine(bat({ hr: 0, rbi: 0, so: 0, h: 0 }))).toBe('0-4');
    expect(batLine(undefined)).toBe('');
    expect(pitLine(pit())).toBe('5.1 IP  6 K  1 BB  2 ER  88 P');
    expect(pitLine(null)).toBe('');
  });
  it('formats rate stats like a scorer', () => {
    expect(rate(0.287)).toBe('.287');
    expect(rate(1)).toBe('1.000');
    expect(rate(undefined)).toBe('---');
    expect(rate(NaN)).toBe('---');
  });
  it('turns a team snapshot into rows and totals', () => {
    const t: TeamStatsView = {
      batters: [entry('a'), entry('b', { game: { batting: bat({ ab: 3, h: 1, hr: 0, rbi: 0, r: 0, bb: 1, so: 0 }), pitching: null } })],
      pitchers: [entry('p1', { game: { batting: bat(), pitching: pit() }, season: { batting: bat(), pitching: pit({ era: 2.5 }) } }), entry('p2', { game: { batting: bat(), pitching: pit({ ip: '1.2', outs: 5, h: 1, r: 0, er: 0, bb: 0, so: 2, hr: 0, pitches: 22 }) }, season: { batting: bat(), pitching: null } }), entry('x')],
      totals: { runs: 3, hits: 6, errors: 0, lob: 4 },
    };
    const rows = boxBatters(t);
    expect(rows).toHaveLength(2);
    expect(rows[0].avg).toBe('.287');
    const bt = batterTotals(rows);
    expect(bt).toEqual({ ab: 7, r: 1, h: 3, rbi: 2, bb: 1, so: 1, hr: 1 });
    const prow = boxPitchers(t);
    expect(prow).toHaveLength(2); // the non-pitcher entry is skipped
    expect(prow[0].era).toBe('2.50');
    expect(prow[1].era).toBe('--');
    expect(pitcherTotals(prow).ip).toBe('7.0');
    expect(pitcherTotals(prow)).toMatchObject({ h: 6, so: 8, pitches: 110 });
    expect(boxBatters(undefined)).toEqual([]);
  });
});
