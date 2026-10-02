import { describe, expect, it } from 'vitest';
import { CueMapper, allowedAtSpeed, classifyContact, engineToRaw, umpireText } from '../cues';
import type { Cue, MapCtx, RawEvent } from '../types';

const people: Record<string, { name: string; number: number; pos: { x: number; y: number; z: number } }> = {
  b1: { name: 'Tyler Vance', number: 23, pos: { x: 0.5, y: 1, z: -0.3 } },
  p1: { name: 'Sam Rook', number: 12, pos: { x: 0, y: 1, z: 18.4 } },
  f1: { name: 'Dee Alder', number: 8, pos: { x: 0, y: 1, z: 100 } },
  ss: { name: 'Pat Short', number: 6, pos: { x: 8, y: 1, z: 30 } },
};

function ctx(over: Partial<MapCtx> = {}): MapCtx {
  return {
    pos: (id) => people[String(id)]?.pos,
    person: (id) => (people[String(id)] ? { name: people[String(id)].name, number: people[String(id)].number } : undefined),
    inning: 3,
    half: 'bottom',
    outs: 1,
    balls: 1,
    strikes: 1,
    score: { home: 2, away: 1 },
    runners: [false, false, false],
    teams: { home: 'Comets', away: 'Stars' },
    speed: 1,
    ...over,
  };
}

const m = (ev: RawEvent, c: MapCtx = ctx(), mapper = new CueMapper()) => mapper.map(ev, c);
const sfx = (cues: Cue[], id: string) => cues.filter((c) => c.kind === 'sfx' && c.id === id);
const says = (cues: Cue[]) => cues.filter((c): c is Extract<Cue, { kind: 'speak' }> => c.kind === 'speak');

describe('bat contact', () => {
  it('hard line drives crack, weak/topped balls thud, foul tips tick, bunts tap', () => {
    expect(classifyContact(105, 20, 5)).toMatchObject({ sound: 'bat_crack', bucket: 2 });
    expect(classifyContact(85, 15, 5)).toMatchObject({ sound: 'bat_crack', bucket: 1 });
    expect(classifyContact(70, 10, 5)).toMatchObject({ sound: 'bat_crack', bucket: 0 });
    expect(classifyContact(90, -20, 5).sound).toBe('bat_thud'); // topped
    expect(classifyContact(50, 20, 10).sound).toBe('bat_thud'); // weak
    expect(classifyContact(50, 70, 5).sound).toBe('bat_tick'); // foul tip
    expect(classifyContact(25, 5, 0).sound).toBe('bunt_tap');
  });

  it('louder for harder contact', () => {
    const soft = classifyContact(70, 10, 0).gain;
    const hard = classifyContact(108, 25, 0).gain;
    expect(hard).toBeGreaterThan(soft);
  });

  it('maps a contact event to a crack at the plate and raises the crowd for a fly ball', () => {
    const cues = m({ type: 'contact', batterId: 'b1', exitMph: 100, launchDeg: 30, sprayDeg: 0 });
    const crack = sfx(cues, 'bat_crack')[0] as Extract<Cue, { kind: 'sfx' }>;
    expect(crack.bucket).toBe(2);
    expect(crack.pos).toMatchObject({ x: 0, z: 0 });
    expect(cues.some((c) => c.kind === 'excite' && c.amount > 0.3)).toBe(true);
    expect(cues.some((c) => c.kind === 'crowd' && c.id === 'swell')).toBe(true);
  });
});

describe('pitches and swings', () => {
  it('pops the mitt at the catcher, louder for faster pitches', () => {
    const c = ctx({ catcher: { x: 0, y: 0.8, z: -1.2 } });
    const slow = sfx(m({ type: 'pitchCrossed', mph: 78, x: 0, y: 0.8, inZone: true }, c), 'mitt_pop')[0] as Extract<Cue, { kind: 'sfx' }>;
    const fast = sfx(m({ type: 'pitchCrossed', mph: 99, x: 0, y: 0.8, inZone: true }, c), 'mitt_pop')[0] as Extract<Cue, { kind: 'sfx' }>;
    expect(slow.bucket).toBe(0);
    expect(fast.bucket).toBe(2);
    expect(fast.gain!).toBeGreaterThan(slow.gain!);
    expect(fast.pos).toEqual({ x: 0, y: 0.8, z: -1.2 });
  });

  it('release whoosh at the release point and swing whoosh at the batter', () => {
    const r = sfx(m({ type: 'pitchReleased', mph: 95, release: { x: 0.3, y: 1.9, z: 16.9 } }), 'pitch_whoosh')[0] as Extract<Cue, { kind: 'sfx' }>;
    expect(r.pos).toMatchObject({ x: 0.3, z: 16.9 });
    const s = sfx(m({ type: 'swing', batterId: 'b1' }), 'swing_whoosh')[0] as Extract<Cue, { kind: 'sfx' }>;
    expect(s.pos).toMatchObject({ x: 0.5 });
  });
});

describe('umpire and PA', () => {
  it('calls balls, strikes, three and fouls', () => {
    expect(umpireText('ball', 1, 0)).toBe('Ball!');
    expect(umpireText('ball', 3, 0)).toBe('Ball four!');
    expect(umpireText('strikeLooking', 0, 1)).toBe('Strike!');
    expect(umpireText('strikeSwinging', 0, 2)).toBe('Strike three!');
    expect(umpireText('foul', 0, 0)).toBe('Foul ball!');
    expect(umpireText('fairBall', 0, 0)).toBeNull();
  });

  it('speaks the call as a high-priority umpire line', () => {
    const s = says(m({ type: 'call', call: { kind: 'strikeLooking', balls: 1, strikes: 2 } }));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ role: 'ump', text: 'Strike three!' });
    expect(s[0].pri).toBeGreaterThan(4);
  });

  it('announces the batter and the pitcher only when it changes', () => {
    const mapper = new CueMapper();
    const first = says(mapper.map({ type: 'batterUp', batterId: 'b1', pitcherId: 'p1' }, ctx()));
    expect(first.map((x) => x.text)).toEqual(['Now pitching, number 12, Sam Rook.', 'Now batting, number 23, Tyler Vance.']);
    const second = says(mapper.map({ type: 'batterUp', batterId: 'b1', pitcherId: 'p1' }, ctx()));
    expect(second.map((x) => x.text)).toEqual(['Now batting, number 23, Tyler Vance.']);
    expect(second[0].role).toBe('pa');
  });

  it('skips the announcement when the player is unknown', () => {
    expect(says(m({ type: 'batterUp', batterId: 'nobody', pitcherId: 'nobody' }))).toHaveLength(0);
  });
});

describe('big moments', () => {
  it('home run: roar, seat thump, fireworks and organ for the home team, boos and no organ for the visitors', () => {
    const ev = { type: 'homeRun', batterId: 'b1', distance: 125, pos: { x: 20, y: 8, z: 105 } } as RawEvent;
    const home = m(ev, ctx({ half: 'bottom' }));
    expect(home.some((c) => c.kind === 'crowd' && c.id === 'roar_big' && (c.gain ?? 1) >= 1)).toBe(true);
    expect(sfx(home, 'seat_thump')).toHaveLength(1);
    expect(sfx(home, 'firework')).toHaveLength(1);
    expect(home.some((c) => c.kind === 'organ' && c.id === 'hr_fanfare')).toBe(true);
    expect(says(home).some((s) => s.role === 'pbp' || s.role === 'color')).toBe(false); // the broadcast booth (src/audio/broadcast) calls it, not the cue mapper
    const away = m(ev, ctx({ half: 'top' }));
    expect(away.some((c) => c.kind === 'organ')).toBe(false);
    expect(away.some((c) => c.kind === 'crowd' && c.id === 'boo')).toBe(true);
    expect(away.some((c) => c.kind === 'crowd' && c.id === 'roar_big' && (c.gain ?? 1) < 0.6)).toBe(true);
  });

  it('robbed home run: gasp first, then the fielding side reacts', () => {
    const cues = m({ type: 'robbedHomeRun', fielderId: 'f1', batterId: 'b1', distance: 120, pos: { x: 0, y: 3, z: 120 } }, ctx({ half: 'top' }));
    const gasp = cues.find((c) => c.kind === 'crowd' && c.id === 'gasp') as Extract<Cue, { kind: 'crowd' }>;
    const cheer = cues.find((c) => c.kind === 'crowd' && c.id === 'roar_big') as Extract<Cue, { kind: 'crowd' }>;
    expect(gasp).toBeTruthy();
    expect(cheer.delay!).toBeGreaterThan(gasp.delay!);
    expect(says(cues)).toHaveLength(0);
  });

  it('strikeout cheers for the home pitcher and does not double up the umpire out call', () => {
    const cues = m({ type: 'out', playerId: 'b1', outType: 'strikeout', base: null }, ctx({ half: 'top' }));
    expect(cues.some((c) => c.kind === 'crowd' && c.id === 'cheer_short')).toBe(true);
    expect(says(cues).some((s) => s.role === 'ump')).toBe(false);
  });

  it('a force out at first: umpire says Out and the tag/glove is heard at the base', () => {
    const cues = m({ type: 'out', playerId: 'b1', outType: 'tag', base: 2 });
    expect(says(cues).some((s) => s.role === 'ump' && s.text === 'Out!')).toBe(true);
    const slap = sfx(cues, 'tag_slap')[0] as Extract<Cue, { kind: 'sfx' }>;
    expect(slap.pos).toMatchObject({ x: 0 });
  });

  it('walk-off style run scoring cheers only for the home side', () => {
    const home = m({ type: 'runScored', playerId: 'b1', team: 'home' });
    const away = m({ type: 'runScored', playerId: 'b1', team: 'away' });
    const g = (cs: Cue[]) => (cs.find((c) => c.kind === 'crowd') as Extract<Cue, { kind: 'crowd' }>).gain!;
    expect(g(home)).toBeGreaterThan(g(away));
  });
});

describe('throws, wall, errors', () => {
  it('a throw whips at the thrower and pops at the target after the flight time', () => {
    const cues = m({ type: 'throw', fromId: 'ss', toId: 'b1', toBase: null, mph: 80 });
    expect(sfx(cues, 'throw_whip')).toHaveLength(1);
    const pop = sfx(cues, 'glove_pop')[0] as Extract<Cue, { kind: 'sfx' }>;
    expect(pop.delay!).toBeGreaterThan(0.3);
    expect(pop.pos).toMatchObject({ x: 0.5 });
  });

  it('wall contact: harder hits are louder and rattle the fence', () => {
    const soft = m({ type: 'wallContact', who: 'ball', speed: 5, pos: { x: 0, y: 1, z: 120 } });
    const hard = m({ type: 'wallContact', who: 'ball', speed: 30, pos: { x: 0, y: 1, z: 120 } });
    const t = (cs: Cue[]) => (sfx(cs, 'wall_thud')[0] as Extract<Cue, { kind: 'sfx' }>).gain!;
    expect(t(hard)).toBeGreaterThan(t(soft));
    expect(sfx(hard, 'fence_rattle')).toHaveLength(1);
    expect(sfx(soft, 'fence_rattle')).toHaveLength(0);
  });

  it('errors groan', () => {
    const cues = m({ type: 'error', fielderId: 'ss', kind: 'throw' });
    expect(cues.some((c) => c.kind === 'crowd' && c.id === 'groan')).toBe(true);
    expect(says(cues)).toHaveLength(0);
  });
});

describe('speech cues are only the stadium side', () => {
  it('the mapper speaks the PA and the umpire; play-by-play and colour belong to the booth', () => {
    const mapper = new CueMapper();
    const evs: RawEvent[] = [
      { type: 'batterUp', batterId: 'b1', pitcherId: 'p1' }, { type: 'homeRun', batterId: 'b1', distance: 120 }, { type: 'robbedHomeRun', fielderId: 'f1', batterId: 'b1' },
      { type: 'error', fielderId: 'ss', kind: 'drop' }, { type: 'gameEnd', winner: 'home', home: 5, away: 3 }, { type: 'playEnd', description: 'Tyler Vance homers to left.' },
      { type: 'contact', batterId: 'b1', exitMph: 105, launchDeg: 25, sprayDeg: 5 }, { type: 'call', call: { kind: 'strikeLooking', balls: 0, strikes: 2 } },
    ];
    for (const e of evs) for (const s of says(mapper.map(e, ctx()))) expect(['pa', 'ump']).toContain(s.role);
  });
});

describe('robustness and gating', () => {
  it('ignores unknown events and never throws on missing fields', () => {
    const mapper = new CueMapper();
    expect(mapper.map({ type: 'somethingNew' }, ctx())).toEqual([]);
    expect(() => mapper.map({ type: 'contact' }, ctx())).not.toThrow();
    expect(() => mapper.map({ type: 'throw' }, ctx())).not.toThrow();
    expect(() => mapper.map({ type: 'call' }, ctx())).not.toThrow();
    expect(() => mapper.map({ type: 'wallContact' }, ctx())).not.toThrow();
    const broken = ctx({ person: () => { throw new Error('boom'); } });
    expect(mapper.map({ type: 'batterUp', batterId: 'x', pitcherId: 'y' }, broken)).toEqual([]);
  });

  it('thins cues out at 2x/4x and drops everything while skipping', () => {
    expect(allowedAtSpeed(0, 1, false)).toBe(true);
    expect(allowedAtSpeed(0, 2, false)).toBe(false);
    expect(allowedAtSpeed(1, 2, false)).toBe(true);
    expect(allowedAtSpeed(1, 4, false)).toBe(false);
    expect(allowedAtSpeed(2, 4, false)).toBe(true);
    expect(allowedAtSpeed(3, 1, true)).toBe(false);
  });

  it('understands the engine-only event stream (mock game)', () => {
    const raw = engineToRaw({ type: 'contact', exitVelo: 45, launchAngle: 25, sprayAngle: 0, batterId: 'b1' })!;
    expect(raw.type).toBe('contact');
    expect(Math.round(raw.exitMph as number)).toBe(101);
    expect(sfx(m(raw), 'bat_crack')).toHaveLength(1);
    expect(engineToRaw({ type: 'strike' })!.call).toMatchObject({ kind: 'strikeLooking' });
    expect(engineToRaw({ type: 'nonsense' })).toBeNull();
  });
});
