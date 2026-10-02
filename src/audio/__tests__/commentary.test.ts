import { describe, expect, it } from 'vitest';
import { ALL_TEMPLATES, Chatter, LEVELS, basesText, locationWords, lastName, ord, pitchName, type ChatCtx, type ChatLine, type ChatPerson } from '../commentary';
import { mulberry32 } from '../dsp';
import { SpeechQueue, type SpeechEngine } from '../speech';
import type { RawEvent } from '../types';

const batter = (over: Partial<ChatPerson> = {}): ChatPerson => ({
  id: 'b1', name: 'Tyler Vance', number: 23, hand: 'R',
  ratings: { power: 72, contact: 58, eye: 66, speed: 71 },
  bat: { pa: 3, ab: 3, h: 2, hr: 1, bb: 0, so: 1, rbi: 2, sb: 0 },
  ...over,
});
const pitcher = (over: Partial<ChatPerson> = {}): ChatPerson => ({
  id: 'p1', name: 'Sam Rook', number: 12, hand: 'L',
  ratings: { velocity: 97, control: 68 },
  pit: { outs: 14, so: 5, bb: 2, h: 3, er: 1, pitches: 71, hr: 1 },
  ...over,
});
const ctx = (over: Partial<ChatCtx> = {}): ChatCtx => ({
  inning: 7, half: 'bottom', outs: 1, balls: 1, strikes: 2, score: { home: 3, away: 2 }, runners: [true, false, true],
  runnerNames: ['Ray Dash', undefined, 'Lou Stone'], runnerSpeed: [75, undefined, 45],
  teams: { home: 'Comets', away: 'Stars' }, batter: batter(), pitcher: pitcher(), crowd: 0.7, lastPlay: 'Tyler Vance singles to left.', ...over,
});

const pitchEvents = (ch: Chatter, c: ChatCtx, type: string, mph: number, x: number, y: number, kind = 'strike_called') => {
  const evs: RawEvent[] = [
    { type: 'pitchReleased', pitcherId: 'p1', pitchType: type, mph },
    { type: 'pitchCrossed', x, y, inZone: true, mph },
    { type: 'call', call: { kind: kind === 'strike_called' ? 'strikeLooking' : kind === 'ball' ? 'ball' : kind, balls: c.balls, strikes: c.strikes } },
  ];
  const out: ChatLine[] = [];
  for (const e of evs) {
    ch.observe(e, c);
    out.push(...ch.react(e, c, 'high'));
  }
  return out;
};

describe('location words (inside / away depend on the batter\'s hand)', () => {
  it('right-handed: +X (toward third base, his side) is inside, -X is away', () => {
    expect(locationWords(0.2, 0.4, 'R')).toBe('low and in');
    expect(locationWords(-0.2, 0.4, 'R')).toBe('low and away');
    expect(locationWords(0.2, 1.1, 'R')).toBe('up and in');
    expect(locationWords(-0.2, 1.1, 'R')).toBe('up and away');
    expect(locationWords(0.2, 0.8, 'R')).toBe('inside');
    expect(locationWords(-0.2, 0.8, 'R')).toBe('away');
  });
  it('left-handed: reversed', () => {
    expect(locationWords(0.2, 0.4, 'L')).toBe('low and away');
    expect(locationWords(-0.2, 0.4, 'L')).toBe('low and in');
    expect(locationWords(0.2, 0.8, 'L')).toBe('away');
    expect(locationWords(-0.2, 0.8, 'L')).toBe('inside');
  });
  it('the same pitch is opposite for the two hands, and the middle and the dirt are the same for both', () => {
    for (const x of [-0.25, 0.25]) expect(locationWords(x, 0.4, 'R')).not.toBe(locationWords(x, 0.4, 'L'));
    expect(locationWords(0.02, 0.8, 'R')).toBe('right down the middle');
    expect(locationWords(0.02, 0.8, 'L')).toBe('right down the middle');
    expect(locationWords(0.1, 0.05, 'L')).toBe('in the dirt');
  });
});

describe('pitch narration', () => {
  it('names the pitch, speed, location from the batter\'s side, and the count after the call', () => {
    const ch = new Chatter(() => 0.01);
    const c = ctx({ balls: 0, strikes: 0 });
    const out = pitchEvents(ch, c, 'FF', 94.3, -0.22, 0.4);
    const pbp = out.find((l) => l.tag === 'pitch')!;
    expect(pbp.role).toBe('pbp');
    expect(pbp.text).toBe('Fastball, 94, low and away. Called strike one.');
    // the same pitch to a left-handed batter is "in"
    const ch2 = new Chatter(() => 0.01);
    const out2 = pitchEvents(ch2, ctx({ balls: 0, strikes: 0, batter: batter({ hand: 'L' }) }), 'SL', 85, -0.22, 0.4, 'ball');
    expect(out2.find((l) => l.tag === 'pitch')!.text).toBe('Slider, 85, low and in. Ball one.');
  });

  it('tells a pitch once even though both call events arrive', () => {
    const ch = new Chatter(() => 0.01);
    const c = ctx({ balls: 0, strikes: 0 });
    const first = pitchEvents(ch, c, 'CU', 78, 0, 0.8);
    const umpire = ch.react({ type: 'umpireCall', kind: 'strike_called' }, c, 'high');
    expect(first.filter((l) => l.tag === 'pitch')).toHaveLength(1);
    expect(umpire).toHaveLength(0);
  });

  it('pairs the call with a colour line from the pitch history in one group', () => {
    const ch = new Chatter(() => 0.01);
    const c = ctx({ balls: 0, strikes: 0 });
    const all: ChatLine[] = [];
    for (let i = 0; i < 4; i++) all.push(...pitchEvents(ch, c, 'FF', 95, -0.1, 0.8));
    for (const col of all.filter((l) => l.role === 'color')) {
      const pbp = all.find((l) => l.tag === 'pitch' && l.group === col.group);
      expect(pbp, col.text).toBeTruthy();
    }
    expect(all.some((l) => /three fastballs in a row/i.test(l.text))).toBe(true);
  });

  it('every number in a pitch line is the real one', () => {
    const ch = new Chatter(() => 0.01);
    const out = pitchEvents(ch, ctx({ balls: 2, strikes: 1 }), 'CH', 83.6, 0.1, 0.9, 'ball');
    expect(out.find((l) => l.tag === 'pitch')!.text).toMatch(/^Changeup, 84,/);
    expect(out.find((l) => l.tag === 'pitch')!.text).toContain('Ball three.');
  });
});

describe('memory-based facts', () => {
  it('remembers each pitcher\'s mix across plate appearances', () => {
    const ch = new Chatter(() => 0.5);
    const c = ctx();
    for (const t of ['FF', 'FF', 'SL', 'FF', 'CH']) ch.observe({ type: 'pitchReleased', pitcherId: 'p1', pitchType: t, mph: 90 }, c);
    const f = ch.facts(c);
    expect(f.types).toEqual(['FF', 'FF', 'SL', 'FF', 'CH']);
    expect(f.fbCount).toBe(3);
    expect(f.brkCount).toBe(1);
    expect(f.offCount).toBe(1);
    expect(f.streak).toBe(1);
  });

  it('hat trick at three strikeouts, golden sombrero at four', () => {
    const run = (so: number) => {
      const ch = new Chatter(() => 0);
      const c = ctx({ batter: batter({ bat: { pa: so, ab: so, h: 0, hr: 0, bb: 0, so, rbi: 0, sb: 0 } }) });
      return ch.react({ type: 'plateAppearanceEnd', batterId: 'b1', result: 'strikeout swinging' }, c, 'high').map((l) => l.text).join(' ');
    };
    expect(run(3)).toContain('hat trick');
    expect(run(3)).not.toContain('sombrero');
    expect(run(4)).toContain('golden sombrero');
  });

  it('close play uses the real margin; runs scored note ties and lead changes', () => {
    const ch = new Chatter(() => 0);
    const c = ctx({ score: { home: 3, away: 3 } });
    ch.observe({ type: 'safe', playerId: 'r', base: 2, closePlay: true, margin: -0.04 }, c);
    const close = ch.react({ type: 'safe', playerId: 'r', base: 2, closePlay: true, margin: -0.04 }, c, 'high');
    expect(close[0].text).toMatch(/hundredths|close/);
    ch.m.lastScore = { home: 3, away: 2 };
    const tie = ch.react({ type: 'runScored', playerId: 'r' }, c, 'high');
    expect(tie[0].text).toBe('And the game is tied at 3.');
  });

  it('half inning summaries use the tracked half', () => {
    const ch = new Chatter(() => 0);
    const c = ctx({ half: 'top', inning: 3, score: { home: 1, away: 0 } });
    ch.observe({ type: 'halfInningStart', inning: 3, half: 'top' }, c);
    ch.observe({ type: 'halfInningEnd', inning: 3, half: 'top' }, c);
    const out = ch.react({ type: 'halfInningEnd', inning: 3, half: 'top' }, c, 'high');
    expect(out.map((l) => l.text).join(' ')).toMatch(/Stars 0, Comets 1|nobody reached|lead 1 to 0|clean half/);
    expect(out.length).toBeGreaterThanOrEqual(1);
    if (out.length > 1) expect(out[0].group).toBe(out[1].group);
  });
});

describe('idle chatter', () => {
  it('never repeats a template within the window', () => {
    const ch = new Chatter(mulberry32(5), 28);
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) for (const l of ch.pull(ctx(), i % 3 === 0 ? 'betweenBatters' : 'prePitch', 'high')) seen.push(l.tag);
    for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < Math.min(seen.length, i + 20); j++) expect(seen[j] === seen[i] && seen[i] !== 'pitch', `${seen[i]} repeated`).toBe(false);
    expect(new Set(seen).size).toBeGreaterThan(6);
  });

  it('banter: the colour reply shares its group with the play-by-play line', () => {
    let found = 0;
    for (let s = 1; s < 60; s++) {
      const ch = new Chatter(mulberry32(s));
      const out = ch.pull(ctx(), 'prePitch', 'high');
      if (out.length === 2) {
        found++;
        expect(out[0].role).toBe('pbp');
        expect(out[1].role).toBe('color');
        expect(out[1].group).toBe(out[0].group);
      }
    }
    expect(found).toBeGreaterThan(5);
  });

  it('break chatter is about the score and the half inning, never a pitch', () => {
    const ch = new Chatter(mulberry32(3));
    const lines = ch.pull(ctx({ half: 'top' }), 'break', 'high');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.text).not.toMatch(/Fastball|pitch count/i);
  });

  it('says nothing it has no facts for', () => {
    const ch = new Chatter(mulberry32(2));
    const bare: ChatCtx = { inning: 1, half: 'top', outs: 0, balls: 0, strikes: 0, score: { home: 0, away: 0 }, runners: [false, false, false], teams: { home: 'A', away: 'B' } };
    for (let i = 0; i < 30; i++) for (const l of ch.pull(bare, 'prePitch', 'high')) expect(l.text).not.toMatch(/undefined|NaN|null/);
  });

  it('the chatter level changes how often the booth talks', () => {
    const count = (level: 'low' | 'normal' | 'high') => {
      let n = 0;
      for (let s = 0; s < 200; s++) {
        const ch = new Chatter(mulberry32(s * 7 + 1));
        const c = ctx({ balls: 0, strikes: 0 });
        n += pitchEvents(ch, c, 'FF', 94, -0.2, 0.6).length > 0 ? 0 : 0;
        for (const e of [{ type: 'pitchReleased', pitcherId: 'p1', pitchType: 'FF', mph: 94 }, { type: 'pitchCrossed', x: 0, y: 0.8, inZone: true }, { type: 'call', call: { kind: 'strikeLooking', balls: 0, strikes: 0 } }] as RawEvent[]) {
          ch.observe(e, c);
          n += ch.react(e, c, level).length;
        }
      }
      return n;
    };
    expect(count('low')).toBeLessThan(count('normal'));
    expect(count('normal')).toBeLessThan(count('high'));
    expect(LEVELS.low.quiet).toBeGreaterThan(LEVELS.normal.quiet);
    expect(LEVELS.normal.quiet).toBeGreaterThan(LEVELS.high.quiet);
  });
});

describe('grounding and style', () => {
  const numbersIn = (s: string) => (s.match(/\d+/g) ?? []).map(Number);

  it('every number the booth says appears in the game state it was given', () => {
    const c = ctx();
    const allowed = new Set<number>();
    JSON.stringify(c).replace(/\d+/g, (m) => { allowed.add(Number(m)); return m; });
    for (const r of [...Object.values(c.batter!.ratings!), ...Object.values(c.pitcher!.ratings!), ...(c.runnerSpeed ?? []).filter((x): x is number => x !== undefined)]) allowed.add(Math.round(r / 5) * 5);
    allowed.add(Math.round(c.pitcher!.ratings!.velocity));
    const mphs = [94, 88, 97, 82, 95, 91];
    for (const m of mphs) allowed.add(m);
    allowed.add(Math.floor(c.pitcher!.pit!.outs / 3));
    allowed.add(c.pitcher!.pit!.outs % 3);
    const lines: string[] = [];
    for (let s = 0; s < 120; s++) {
      const ch = new Chatter(mulberry32(s + 11));
      const types = ['FF', 'SL', 'FF', 'CH', 'FF', 'CU'];
      types.forEach((t, i) => ch.observe({ type: 'pitchReleased', pitcherId: 'p1', pitchType: t, mph: mphs[i] }, c));
      allowed.add(Math.round((types.filter((t) => t === 'FF').length / types.length) * 100));
      ch.m.lastExit = 103.4;
      allowed.add(103);
      for (const ph of ['prePitch', 'betweenBatters', 'break'] as const) lines.push(...ch.pull(c, ph, 'high').map((l) => l.text));
      for (const ev of [
        { type: 'batterUp', batterId: 'b1' }, { type: 'plateAppearanceEnd', batterId: 'b1', result: 'double' }, { type: 'plateAppearanceEnd', batterId: 'b1', result: 'home run' },
        { type: 'halfInningEnd', inning: 7, half: 'bottom' }, { type: 'runScored' }, { type: 'steal' }, { type: 'pitchingChange' },
      ] as RawEvent[]) lines.push(...ch.react(ev, c, 'high').map((l) => l.text));
      lines.push(...ch.replay(c).map((l) => l.text));
    }
    expect(lines.length).toBeGreaterThan(100);
    for (const l of lines) for (const n of numbersIn(l)) expect(allowed.has(n), `"${l}" mentions ${n}`).toBe(true);
  });

  it('uses no pronouns for people: in any template or any generated line', () => {
    const PRON = /\b(he|she|his|her|hers|him|himself|herself)\b/i;
    for (const tpl of ALL_TEMPLATES) {
      // literal text of the template: strip code, scan the string pieces
      const src = String(tpl.say);
      const literals = (src.match(/(`[^`]*`|'[^']*'|"[^"]*")/g) ?? []).join(' ');
      expect(PRON.test(literals), `${tpl.id}: ${literals}`).toBe(false);
    }
    const c = ctx();
    for (let s = 0; s < 80; s++) {
      const ch = new Chatter(mulberry32(s));
      for (const l of [...ch.pull(c, 'prePitch', 'high'), ...ch.pull(c, 'break', 'high'), ...ch.replay(c)]) expect(PRON.test(l.text), l.text).toBe(false);
    }
  });

  it('template ids are unique', () => {
    const ids = ALL_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(60);
  });

  it('helpers', () => {
    expect(lastName('Tyler Vance')).toBe('Vance');
    expect(ord(7)).toBe('seventh');
    expect(pitchName('SW')).toBe('sweeper');
    expect(basesText([true, false, true])).toBe('runners on the corners');
    expect(basesText([true, true, true])).toBe('the bases loaded');
    expect(basesText([false, false, false])).toBe('nobody on');
  });
});

describe('exchanges in the speech queue', () => {
  function fakeSpeech() {
    const spoken: string[] = [];
    const engine: SpeechEngine = { voices: () => [{ name: 'A', lang: 'en-US' }, { name: 'B', lang: 'en-US' }], speak: (t) => { spoken.push(t); }, cancel() {}, pause() {}, resume() {} };
    return { engine, spoken };
  }
  it('drops the reply when the first line of its exchange goes stale', () => {
    let t = 0;
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => t);
    q.enqueue({ role: 'pbp', text: 'busy line', pri: 3, ttl: 30 });
    q.enqueue({ role: 'pbp', text: 'question', pri: 1, ttl: 2, group: 7 });
    q.enqueue({ role: 'color', text: 'answer', pri: 1, ttl: 30, group: 7 });
    t += 5000;
    q.pump();
    expect(q.pending).toBe(0);
  });
  it('drops the reply when the first line is interrupted by something bigger', () => {
    let t = 0;
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => t);
    q.enqueue({ role: 'pbp', text: 'question', pri: 1, ttl: 30, group: 9 });
    q.enqueue({ role: 'color', text: 'answer', pri: 1, ttl: 30, group: 9 });
    q.enqueue({ role: 'pbp', text: 'IT IS GONE', pri: 6, ttl: 30 });
    t += 200;
    q.pump();
    expect(f.spoken).toEqual(['question', 'IT IS GONE']);
    expect(q.pending).toBe(0);
  });
  it('reports how long the booth has been silent', () => {
    let t = 1000;
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => t);
    t += 4000;
    expect(q.idleMs()).toBe(4000);
    q.enqueue({ role: 'pbp', text: 'x', pri: 3, ttl: 30 });
    expect(q.idleMs()).toBe(0);
  });
});
