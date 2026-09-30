import { describe, expect, it } from 'vitest';
import { CueMapper, umpireCallText } from '../cues';
import { rawBusOf } from '../index';
import { SFX_DEFS } from '../synth';
import type { Cue, MapCtx, RawEvent } from '../types';

const people: Record<string, { name: string; pos: { x: number; y: number; z: number } }> = {
  c1: { name: 'Cal Mask', pos: { x: 0, y: 1, z: -1 } },
  ss: { name: 'Pat Short', pos: { x: 8, y: 1, z: 30 } },
  r1: { name: 'Rob Runner', pos: { x: 0, y: 0, z: 37 } },
};
const ctx = (over: Partial<MapCtx> = {}): MapCtx => ({
  pos: (id) => people[String(id)]?.pos,
  person: (id) => (people[String(id)] ? { name: people[String(id)].name } : undefined),
  inning: 5, half: 'bottom', outs: 1, balls: 0, strikes: 0, score: { home: 1, away: 1 }, runners: [false, false, false],
  teams: { home: 'Comets', away: 'Stars' }, speed: 1, ...over,
});
const sfx = (cues: Cue[], id: string) => cues.filter((c): c is Extract<Cue, { kind: 'sfx' }> => c.kind === 'sfx' && c.id === id);
const says = (cues: Cue[]) => cues.filter((c): c is Extract<Cue, { kind: 'speak' }> => c.kind === 'speak');
const crowd = (cues: Cue[], id: string) => cues.filter((c): c is Extract<Cue, { kind: 'crowd' }> => c.kind === 'crowd' && c.id === id);

describe('umpireCall', () => {
  const uc = (kind: string, extra: Record<string, unknown> = {}): RawEvent => ({ type: 'umpireCall', umpire: 'plate', umpireId: 'u', kind, pos: { x: 0.25, y: 0, z: -2.6 }, time: 10, ...extra });

  it('speaks each ruling from the umpire, timed with the gesture, at the umpire position', () => {
    const cases: [string, string | null][] = [['ball', 'Ball!'], ['ball_four', 'Ball four!'], ['strike_called', 'Strike!'], ['strike_swinging', 'Strike!'], ['strikeout', 'Strike three!'], ['foul', 'Foul ball!'], ['foul_tip', 'Foul tip!'], ['safe', 'Safe!'], ['out', 'Out!'], ['time', 'Time!'], ['fair', null], ['homerun', null]];
    for (const [kind, text] of cases) {
      expect(umpireCallText(kind)).toBe(text);
      const s = says(new CueMapper().map(uc(kind), ctx()));
      if (text) {
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({ role: 'ump', text, pos: { x: 0.25, z: -2.6 } });
        expect(s[0].pri).toBeGreaterThan(4);
      } else expect(s).toHaveLength(0);
    }
  });

  it('does not double-trigger: with detailed events, call / out / safe stay silent, umpireCall speaks once', () => {
    const m = new CueMapper({ detailed: true });
    expect(says(m.map({ type: 'call', call: { kind: 'strikeLooking', balls: 0, strikes: 0 } }, ctx()))).toHaveLength(0);
    expect(says(m.map({ type: 'out', playerId: 'r1', outType: 'force', base: 1, time: 5 }, ctx()))).toHaveLength(0);
    expect(says(m.map({ type: 'safe', playerId: 'r1', base: 2, time: 5 }, ctx()))).toHaveLength(0);
    expect(says(m.map(uc('strike_called'), ctx()))).toHaveLength(1);
  });

  it('turns detailed mode on by itself at the first umpireCall; the plain stream still speaks from call/out/safe', () => {
    const m = new CueMapper();
    expect(says(m.map({ type: 'call', call: { kind: 'ball', balls: 0, strikes: 0 } }, ctx()))).toHaveLength(1);
    m.map(uc('ball'), ctx());
    expect(says(m.map({ type: 'call', call: { kind: 'ball', balls: 0, strikes: 0 } }, ctx()))).toHaveLength(0);
    expect(says(new CueMapper().map({ type: 'safe', playerId: 'r1', base: 2 }, ctx())).map((s) => s.text)).toEqual(['Safe!']);
  });

  it('keeps the crowd reactions of the call event (foul: ooh)', () => {
    const cues = new CueMapper({ detailed: true }).map({ type: 'call', call: { kind: 'foul', balls: 0, strikes: 0 } }, ctx());
    expect(crowd(cues, 'ooh')).toHaveLength(1);
  });
});

describe('tags', () => {
  it('slaps the glove on a tag, once (the out that follows adds no second slap)', () => {
    const m = new CueMapper({ detailed: true });
    const tag = m.map({ type: 'tag', fielderId: 'ss', runnerId: 'r1', pos: { x: 0, y: 0.6, z: 38 }, time: 100 }, ctx());
    expect(sfx(tag, 'tag_slap')).toHaveLength(1);
    expect(sfx(tag, 'tag_slap')[0].pos).toMatchObject({ z: 38 });
    const out = m.map({ type: 'out', playerId: 'r1', outType: 'tag', base: 2, time: 100.2 }, ctx());
    expect(sfx(out, 'tag_slap')).toHaveLength(0);
    // an older sim without `tag` events still gets the slap from the out
    expect(sfx(new CueMapper().map({ type: 'out', playerId: 'r1', outType: 'tag', base: 2, time: 5 }, ctx()), 'tag_slap')).toHaveLength(1);
  });

  it('the sweep itself is quiet; a miss whooshes and the crowd oohs', () => {
    const m = new CueMapper({ detailed: true });
    expect(m.map({ type: 'tagAttempt', fielderId: 'ss', runnerId: 'r1', base: 2, hand: 'glove', pos: { x: 0, y: 0.5, z: 38 } }, ctx())).toHaveLength(0);
    const miss = m.map({ type: 'tagAvoided', fielderId: 'ss', runnerId: 'r1', slide: 'hookL' }, ctx());
    expect(sfx(miss, 'tag_miss')).toHaveLength(1);
    expect(sfx(miss, 'tag_miss')[0].pos).toMatchObject({ x: 8, z: 30 });
    expect(crowd(miss, 'ooh')).toHaveLength(1);
    expect(SFX_DEFS.tag_miss).toBeTruthy();
  });
});

describe('close plays', () => {
  it('tension on a close out/safe, then relief for the side that wins the call', () => {
    const m = new CueMapper({ detailed: true });
    const out = m.map({ type: 'out', playerId: 'r1', outType: 'tag', base: 2, closePlay: true, margin: 0.03, time: 50 }, ctx({ half: 'top' }));
    expect(crowd(out, 'ooh')[0].gain).toBeGreaterThan(0.6);
    expect(crowd(out, 'applause_small')).toHaveLength(0); // no premature reaction
    // top of the inning: the home side is fielding, so an out is the home crowd's win
    const call = m.map({ type: 'umpireCall', umpire: 'second', umpireId: 'u2', kind: 'out', pos: { x: 4, y: 0, z: 42 }, atBase: 2, time: 50.7 }, ctx({ half: 'top' }));
    expect(crowd(call, 'roar_med')).toHaveLength(1);
    // a second, unrelated call does not repeat the reaction
    expect(crowd(m.map({ type: 'umpireCall', umpire: 'plate', umpireId: 'u', kind: 'out', pos: { x: 0, y: 0, z: -2 }, time: 51 }, ctx({ half: 'top' })), 'roar_med')).toHaveLength(0);
  });

  it('a close safe while the visitors bat is a groan', () => {
    const m = new CueMapper({ detailed: true });
    m.map({ type: 'safe', playerId: 'r1', base: 3, closePlay: true, margin: -0.02, time: 20 }, ctx({ half: 'top' }));
    const call = m.map({ type: 'umpireCall', umpire: 'third', umpireId: 'u3', kind: 'safe', pos: { x: 24, y: 0, z: 21 }, time: 20.6 }, ctx({ half: 'top' }));
    expect(crowd(call, 'groan')).toHaveLength(1);
  });

  it('a routine (not close) out gets the normal applause and no tension', () => {
    const cues = new CueMapper({ detailed: true }).map({ type: 'out', playerId: 'r1', outType: 'force', base: 1, closePlay: false, margin: 0.5, time: 5 }, ctx({ half: 'top' }));
    expect(crowd(cues, 'applause_small')).toHaveLength(1);
    expect(crowd(cues, 'ooh')).toHaveLength(0);
  });
});

describe('catches', () => {
  const catchEv = (over: Record<string, unknown>): RawEvent => ({ type: 'catch', fielderId: 'c1', fly: false, pos: { x: 0, y: 0.8, z: -1.2 }, kind: 'pitch', height: 'chest', side: 'glove', firm: true, time: 3, ...over });

  it('the catcher\'s pop comes from the catch, scaled by pitch speed; pitchCrossed adds none in detailed mode', () => {
    const m = new CueMapper({ detailed: true });
    m.map({ type: 'pitchReleased', mph: 98, release: { x: 0, y: 1.8, z: 16.5 } }, ctx());
    expect(sfx(m.map({ type: 'pitchCrossed', mph: 98, x: 0, y: 0.8, inZone: true }, ctx()), 'mitt_pop')).toHaveLength(0);
    const pop = sfx(m.map(catchEv({}), ctx()), 'mitt_pop');
    expect(pop).toHaveLength(1);
    expect(pop[0].pos).toMatchObject({ x: 0, z: -1.2 });
    expect(pop[0].bucket).toBe(2);
  });

  it('a firm catch is sharper and louder than one at the edge of the glove', () => {
    const m = new CueMapper({ detailed: true });
    m.map({ type: 'pitchReleased', mph: 90, release: { x: 0, y: 1.8, z: 16.5 } }, ctx());
    const firm = sfx(m.map(catchEv({ firm: true }), ctx()), 'mitt_pop')[0];
    const soft = sfx(m.map(catchEv({ firm: false }), ctx()), 'mitt_pop')[0];
    expect(firm.gain!).toBeGreaterThan(soft.gain!);
    expect(firm.rate!).toBeGreaterThan(soft.rate!);
    expect(firm.bucket!).toBeGreaterThan(soft.bucket!);
    const g = (o: Record<string, unknown>) => sfx(m.map(catchEv({ kind: 'throw', pos: { x: 0, y: 1, z: 20 }, ...o }), ctx()), 'glove_pop')[0];
    expect(g({ firm: true }).gain!).toBeGreaterThan(g({ firm: false }).gain!);
    expect(g({ firm: true }).bucket).toBe(1);
    expect(g({ firm: false }).bucket).toBe(0);
    expect(g({ side: 'arm' }).gain!).toBeLessThan(g({}).gain!);
  });

  it('throws pop at the receiver from the catch event, not from a guessed flight time', () => {
    const m = new CueMapper({ detailed: true });
    const t = m.map({ type: 'throw', fromId: 'ss', toId: 'c1', toBase: null, mph: 80 }, ctx());
    expect(sfx(t, 'throw_whip')).toHaveLength(1);
    expect(sfx(t, 'glove_pop')).toHaveLength(0);
    expect(sfx(m.map(catchEv({ kind: 'throw', pos: { x: -19, y: 1, z: 19 } }), ctx()), 'glove_pop')).toHaveLength(1);
    // a casual return has no catch event of its own, so its pop is still scheduled
    expect(sfx(m.map({ type: 'ballReturn', fromId: 'ss', toId: 'c1', mph: 40, casual: true }, ctx()), 'glove_pop')).toHaveLength(1);
  });

  it('fly balls and grounders pop too (fielded is the ground ball)', () => {
    const m = new CueMapper({ detailed: true });
    const fly = m.map(catchEv({ kind: 'fly', fly: true, fielderId: 'ss', pos: { x: 8, y: 2, z: 60 } }), ctx());
    expect(sfx(fly, 'glove_pop')).toHaveLength(1);
    const gr = m.map({ type: 'fielded', fielderId: 'ss', clean: false, pos: { x: 8, y: 0.3, z: 30 }, kind: 'ground', firm: false }, ctx());
    expect(sfx(gr, 'glove_pop')).toHaveLength(1);
    expect(crowd(gr, 'ooh')).toHaveLength(1); // a bobble
  });
});

describe('commentary timing', () => {
  it('waits for the umpire\'s ruling before reading the play when umpire events exist', () => {
    const line = (m: CueMapper) => says(m.map({ type: 'playEnd', description: 'Cal Mask strikes out swinging.' }, ctx()))[0];
    expect(line(new CueMapper({ detailed: true })).delay!).toBeGreaterThan(line(new CueMapper()).delay! + 0.5);
  });
});

describe('raw bus lookup', () => {
  it('uses the public RealSimAdapter.game getter, falls back to the old private g, else null', () => {
    const bus = { on: () => () => {} };
    expect(rawBusOf({ game: bus })).toBe(bus);
    expect(rawBusOf({ g: bus })).toBe(bus);
    expect(rawBusOf({ game: {}, g: bus })).toBe(bus);
    expect(rawBusOf({})).toBeNull();
    expect(rawBusOf(null)).toBeNull();
  });
});
