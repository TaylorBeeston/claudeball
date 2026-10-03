import { describe, expect, it } from 'vitest';
import { cardFor, teamColor } from '../subjectCard';
import type { GameState, PlayerSnap, StatsBat, StatsEntry, StatsPit } from '../types';

const bat = (o: Partial<StatsBat> = {}): StatsBat => ({ pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, bb: 0, so: 0, rbi: 0, r: 0, sb: 0, avg: 0, obp: 0, slg: 0, ops: 0, ...o });
const pit = (o: Partial<StatsPit> = {}): StatsPit => ({ outs: 0, bf: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, pitches: 0, strikes: 0, ip: '0.0', era: 0, whip: 0, ...o });
const snap = (o: Partial<PlayerSnap>): PlayerSnap => ({ id: 'x', team: 0, role: 'ondeck', pos: { x: 0, y: 0, z: 0 }, facing: 0, vel: { x: 0, y: 0, z: 0 }, anim: 'idle', ...o });
const entry = (id: string, o: Partial<StatsEntry> = {}): StatsEntry => ({ playerId: id, name: id, jersey: 1, position: 'RF', inGame: true, game: { batting: bat(), pitching: null }, season: { batting: bat(), pitching: null }, ...o });
const state = (o: Partial<GameState> = {}): GameState =>
  ({
    players: [],
    teams: { away: { name: 'Denver', abbr: 'DEN', color: '#6a2c91', trim: '#fff' }, home: { name: 'Provo', abbr: 'PRO', color: '#f4f4f0', trim: '#12305f' } },
    batter: null,
    pitcher: null,
    ...o,
  }) as unknown as GameState;

describe('subject cards for B-roll shots', () => {
  it('on deck: label, number, name, bats, position, ratings bars, today and season line, team colour', () => {
    const s = state({
      players: [snap({ id: 'od', name: 'Frankie Butler', number: 72, hand: 'L', team: 0, role: 'ondeck', ratings: { power: 56, contact: 71, speed: 53, eye: 57 } })],
      stats: {
        away: { batters: [entry('od', { position: 'LF', game: { batting: bat({ ab: 3, h: 1, rbi: 1 }), pitching: null }, season: { batting: bat({ ab: 100, avg: 0.291, hr: 24 }), pitching: null } })], pitchers: [], totals: { runs: 0, hits: 0, errors: 0, lob: 0 } },
        home: { batters: [], pitchers: [], totals: { runs: 0, hits: 0, errors: 0, lob: 0 } },
      },
    });
    const c = cardFor({ kind: 'onDeck', subject: 'od' }, s)!;
    expect(c).toMatchObject({ role: 'ON DECK', number: '72', name: 'Frankie Butler', color: '#6a2c91', today: '1-3  1 RBI' });
    expect(c.detail).toBe('BATS LEFT  ·  LF  ·  .291 AVG  24 HR');
    expect(c.bars.map((b) => [b.label, b.grade])).toEqual([['POWER', 56], ['CONTACT', 71], ['SPEED', 53], ['EYE', 57]]);
    expect(cardFor({ kind: 'ondeck', subject: 'od' }, s)!.role).toBe('ON DECK');
  });

  it('on deck from the side-cast record when the snapshot list does not have him', () => {
    const s = state({ side: { battingSide: 1, onDeck: { id: 'od2', name: 'Sam Reyes', number: 9, hand: 'R' }, bench: [[], []] } });
    const c = cardFor({ kind: 'onDeck', subject: 'od2' }, s)!;
    expect(c).toMatchObject({ role: 'ON DECK', name: 'Sam Reyes', number: '9', bars: [] });
    expect(c.detail).toBe('BATS RIGHT');
    expect(c.color).toBe('#12305f'); // home jersey is the off-white one: the trim colour is used
  });

  it('pitcher face: arsenal from the pitcher record, pitching line, throws', () => {
    const s = state({
      players: [snap({ id: 'p1', name: 'Travis Ramirez', number: 10, hand: 'R', team: 1, role: 'pitcher' })],
      pitcher: { id: 'p1', name: 'Travis Ramirez', number: 10, hand: 'R', ratings: { velocity: 94, control: 55, movement: 60, stamina: 48 }, arsenal: [{ type: 'FF', mph: 95 }, { type: 'SL', mph: 86 }] },
      stats: { away: { batters: [], pitchers: [], totals: { runs: 0, hits: 0, errors: 0, lob: 0 } }, home: { batters: [], pitchers: [entry('p1', { position: 'P', game: { batting: bat(), pitching: pit({ ip: '2.1', so: 3, bb: 1, er: 0, pitches: 38 }) }, season: { batting: bat(), pitching: pit({ era: 3.456 }) } })], totals: { runs: 0, hits: 0, errors: 0, lob: 0 } } },
    });
    const c = cardFor({ kind: 'pitcherFace', subject: 'p1' }, s)!;
    expect(c.role).toBe('PITCHING');
    expect(c.arsenal).toBe('4-SEAM 95  ·  SLIDER 86');
    expect(c.today).toBe('2.1 IP  3 K  1 BB  0 ER  38 P');
    expect(c.detail).toBe('THROWS RIGHT  ·  P  ·  3.46 ERA');
    expect(c.bars.map((b) => b.label)).toEqual(['VELOCITY', 'CONTROL', 'MOVEMENT', 'STAMINA']);
    expect(cardFor({ kind: 'faceCloseup', subject: 'p1' }, s)!.role).toBe('PITCHING');
  });

  it('other subjects: catcher, manager, reliever warming / coming in', () => {
    const s = state({
      players: [
        snap({ id: 'c', name: 'Juan White', number: 22, hand: 'R', team: 1, role: 'catcher' }),
        snap({ id: 'm', name: 'Bud Black', number: 1, team: 0, role: 'manager' }),
        snap({ id: 'r', name: 'Al Reliever', number: 40, hand: 'L', team: 0, role: 'bench', ratings: { velocity: 97 } }),
      ],
    });
    expect(cardFor({ kind: 'catcherSigns', subject: 'c' }, s)).toMatchObject({ role: 'CATCHER', name: 'Juan White', bars: [], detail: 'BATS RIGHT  ·  C' });
    expect(cardFor({ kind: 'managerWalk', subject: 'm' }, s)).toMatchObject({ role: 'MANAGER', name: 'Bud Black', detail: '', today: '', bars: [] });
    expect(cardFor({ kind: 'bullpen', subject: 'r' }, s)!.role).toBe('NOW WARMING');
    expect(cardFor({ kind: 'relieverJog', subject: 'r' }, s)!.role).toBe('COMING IN');
    expect(cardFor({ kind: 'relieverJog', subject: 'r' }, s)!.bars[0].label).toBe('VELOCITY');
  });

  it('no card for shots that are not about a person, or whose person is unknown', () => {
    const s = state({ players: [snap({ id: 'od', name: 'A', number: 1 })] });
    for (const kind of ['crowd', 'sky', 'dugout', 'scoreboard', 'aerial', 'umpires', 'moundWide']) expect(cardFor({ kind, subject: 'od' }, s)).toBeNull();
    expect(cardFor({ kind: 'onDeck' }, s)).toBeNull();
    expect(cardFor({ kind: 'onDeck', subject: 'nobody' }, s)).toBeNull();
    expect(cardFor(null, s)).toBeNull();
    expect(cardFor({ kind: 'onDeck', subject: 'od' }, null)).toBeNull();
    expect(cardFor({ kind: 'onDeck', subject: 'od' }, state({ players: [snap({ id: 'od' })] }))).toBeNull(); // nameless
  });

  it('every shot label the director sends with card: true gets a card (ShotLabel names)', () => {
    const s = state({
      players: [
        snap({ id: 'b', name: 'Bat Man', number: 5, hand: 'L', team: 0, role: 'batter', ratings: { power: 60 } }),
        snap({ id: 'p', name: 'Pitch Man', number: 6, hand: 'R', team: 1, role: 'pitcher' }),
        snap({ id: 'r', name: 'Run Man', number: 7, hand: 'R', team: 0, role: 'runner' }),
        snap({ id: 'rel', name: 'Rel Man', number: 8, hand: 'R', team: 1, role: 'bench' }),
      ],
    });
    const by = { ondeck: 'b', walkup: 'b', shakeOff: 'p', leadOff: 'r', relieverJog: 'rel', relieverFace: 'rel' } as const;
    for (const [kind, subject] of Object.entries(by)) expect(cardFor({ kind, subject }, s), kind).not.toBeNull();
    expect(cardFor({ kind: 'faceCloseup', subject: 'b' }, s)!.role).toBe('AT BAT');
    expect(cardFor({ kind: 'faceCloseup', subject: 'p' }, s)!.role).toBe('PITCHING');
    for (const kind of ['coachSend', 'kidToss', 'infieldDrill', 'outfieldCatch']) expect(cardFor({ kind, subject: 'b' }, s), kind).toBeNull();
  });

  it('team colour falls back sensibly', () => {
    expect(teamColor(undefined)).toBe('#333');
    expect(teamColor({ name: '', abbr: '', color: '#123456', trim: '#fff' })).toBe('#123456');
  });
});
