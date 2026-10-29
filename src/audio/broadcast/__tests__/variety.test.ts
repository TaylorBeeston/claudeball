import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createGame } from '../../../sim/index';
import { DENY } from '../../../sim/gameinfo';
import { LEX } from '../lexicon';
import { ANECDOTES, type AnecdoteWhen } from '../anecdotes';
import { CATCHPHRASES, PROMOS, RUNNING_JOKES } from '../cast';
import { BoothMemory, pickFresh, withMemory } from '../memory';
import { say } from '../grammar';
import { openingSegment, type OpeningFacts } from '../pregame';
import { STORY_CAPS } from '../stories';
import { Booth } from '../booth';
import { ctxFromRaw } from '../ctx';
import { factsFromGame } from '../facts';
import { wordCount } from '../text';
import { mulberry32 } from '../../dsp';
import { normalizeForSpeech, wordsOf } from '../../voice/normalize';
import { audioSourceWords, gameInfoWords } from '../../../../tools/announcer/script/words';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** braces and brackets open and close in order (the grammar does not check: an unbalanced one silently eats text) */
function balanced(t: string): boolean {
  const st: string[] = [];
  for (const ch of t) {
    if (ch === '{' || ch === '[') st.push(ch);
    else if (ch === '}' || ch === ']') if (st.pop() !== (ch === '}' ? '{' : '[')) return false;
  }
  return st.length === 0;
}
const PRON = /\b(he|his|him|himself)\b/i;
const SHE = /\b(she|her|hers|herself)\b/i;
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/);

describe('the written lines', () => {
  it('every lexicon template is well-formed', () => {
    for (const [k, v] of Object.entries(LEX)) for (const t of v) expect(balanced(t), `${k}: ${t}`).toBe(true);
  });

  it('the anecdotes: unique, one exchange each (A then B, alternating), short enough, in character, nobody real', () => {
    const ids = new Set<string>();
    const kinds = new Set<AnecdoteWhen>();
    for (const a of ANECDOTES) {
      expect(ids.has(a.id), a.id).toBe(false);
      ids.add(a.id);
      kinds.add(a.when);
      expect(a.lines.length, a.id).toBeGreaterThanOrEqual(2);
      expect(a.lines.length, a.id).toBeLessThanOrEqual(4);
      a.lines.forEach((l, i) => expect(l.who, `${a.id} line ${i}`).toBe(i % 2 === 0 ? 'A' : 'B'));
      // the first two lines are the exchange: never optional
      expect(a.lines[0].opt || a.lines[1].opt, a.id).toBeFalsy();
      for (const l of a.lines)
        for (const t of l.t) {
          expect(balanced(t) && !/[{}[\]]/.test(t), `${a.id}: ${t}`).toBe(true);
          expect(t.replace(/\$(other|mascot|me)\b/g, ''), `${a.id}: unknown slot in ${t}`).not.toMatch(/\$/);
          expect(wordCount(t), `${a.id}: ${t}`).toBeGreaterThanOrEqual(1);
          expect(wordCount(t), `${a.id}: ${t}`).toBeLessThanOrEqual(36);
          expect(SHE.test(t), `${a.id}: ${t}`).toBe(false);
          for (const s of sentences(t)) if (/umpire/i.test(s)) expect(PRON.test(s), `${a.id}: the umpire is never "he": ${s}`).toBe(false);
          for (const d of DENY) expect(t.toLowerCase(), `${a.id}: ${t}`).not.toContain(d);
          // Biscuit's career stays the same: .219, nine home runs, eleven seasons, four clubs
          expect(t.replace(/only eight career home runs/i, ''), `${a.id}: ${t}`).not.toMatch(/\b(ten|eight|seven|twelve) (career )?home runs\b|\btwo (twenty|eighteen)\b|\b(ten|twelve) (seasons|years) (as a|behind)/i);
        }
    }
    expect(ANECDOTES.length).toBeGreaterThanOrEqual(60);
    // every kind of moment has stories of its own
    for (const k of ['lull', 'catcher', 'visit', 'change', 'day', 'night', 'blowout', 'scoreless', 'early', 'steal', 'homer', 'error', 'dp', 'extra', 'strikeouts'] as AnecdoteWhen[]) expect(kinds.has(k), k).toBe(true);
  });

  it('running jokes, catchphrases and promos: alternating turns, known slots, nobody real', () => {
    const ids = new Set<string>();
    for (const j of RUNNING_JOKES) {
      expect(ids.has(j.id), j.id).toBe(false);
      ids.add(j.id);
      expect(j.gap).toBeGreaterThanOrEqual(600);
      for (const stage of j.stages) {
        stage.forEach((l, i) => expect(l.who, `${j.id}`).toBe(i % 2 === 0 ? 'A' : 'B'));
        for (const l of stage) for (const t of l.t) {
          expect(t.replace(/\$(pbp|color)\b/g, ''), `${j.id}: ${t}`).not.toMatch(/[$[\]{}]/);
          expect(SHE.test(t), t).toBe(false);
          expect(wordCount(t), t).toBeLessThanOrEqual(36);
        }
      }
    }
    expect(RUNNING_JOKES.length).toBeGreaterThanOrEqual(10);
    for (const p of PROMOS) expect(p.replace(/\$(park|mascot|color)\b/g, ''), p).not.toMatch(/[$[\]{}]/);
    for (const c of CATCHPHRASES) expect(c.max).toBeLessThanOrEqual(2);
  });

  it('every capped story id is a real story', () => {
    const src = readFileSync('src/audio/broadcast/stories.ts', 'utf8');
    for (const id of Object.keys(STORY_CAPS)) expect(src.includes(`id: '${id}'`) || src.includes(`add('${id}'`), id).toBe(true);
  });
});

describe('the booth memory', () => {
  it('reaches for the never-heard first, then the longest ago', () => {
    const m = new BoothMemory();
    const keys = ['a', 'b', 'c', 'd'];
    const r = mulberry32(5);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push(m.pick(keys, (x) => x, r)!);
    expect(new Set(seen).size).toBe(4); // the whole pool before any repeat
    // the oldest one comes back first
    expect(m.order(keys, r)[0]).toBe(keys.indexOf(seen[0]));
  });

  it('say() cycles through a whole pool before it repeats a template', () => {
    const m = new BoothMemory();
    const pool = ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'];
    const r = mulberry32(9);
    const got = withMemory(m, () => pool.map(() => say(pool, {}, r)));
    expect(new Set(got).size).toBe(pool.length);
    // and inner choices too
    const t = ['{Alpha|Beta|Gamma} line.'];
    const inner = withMemory(m, () => [0, 1, 2].map(() => say(t, {}, r)));
    expect(new Set(inner).size).toBe(3);
    // without a memory, the grammar picks as it always did (seeded tests stay deterministic)
    expect(say(pool, {}, mulberry32(1))).toBe(say(pool, {}, mulberry32(1)));
    expect(pickFresh(mulberry32(2), pool)).toBe(pickFresh(mulberry32(2), pool));
  });

  it('is saved and loaded, and survives a broken store', () => {
    let saved = '';
    const store = { load: () => saved || null, save: (s: string) => void (saved = s) };
    const a = new BoothMemory(store);
    a.use('Here comes $b.');
    a.beginGame();
    const b = new BoothMemory(store);
    expect(b.age('Here comes $b.')).toBeLessThan(Infinity);
    expect(b.age('Never said.')).toBe(Infinity);
    expect(b.games).toBe(1);
    expect(() => new BoothMemory({ load: () => '{not json', save: () => {} })).not.toThrow();
    expect(() => new BoothMemory({ load: () => null, save: () => { throw new Error('full'); } }).beginGame()).not.toThrow();
  });

  it('keeps at most `cap` keys, dropping the oldest', () => {
    const m = new BoothMemory(null, 3);
    for (const k of ['a', 'b', 'c', 'd']) m.use(k);
    expect(m.age('a')).toBe(Infinity);
    expect(m.age('d')).toBeLessThan(Infinity);
  });

  it('with one memory across games, the opening does not repeat its wording until the pool is used up', () => {
    const mem = new BoothMemory();
    const hellos: string[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const g: any = createGame({ seed });
      const f = factsFromGame(g, String(seed), 'night', false)!;
      const seg = withMemory(mem, () => openingSegment(f, { budget: 200 }));
      const h = seg.turns.find((t) => t.block === 'hello');
      if (h) hellos.push(h.text);
    }
    expect(hellos.length).toBe(8);
    expect(new Set(hellos).size).toBe(8);
  });
});

describe('a whole game through the booth', () => {
  it('fills every slot and says only words the custom voice knows (data/vocab.txt)', () => {
    const vocab = new Set(readFileSync('tools/announcer/script/data/vocab.txt', 'utf8').split('\n').filter(Boolean));
    // the written lines: every word any template can say
    const missing = [...audioSourceWords(), ...gameInfoWords()].filter((w) => !vocab.has(w));
    expect(missing, 'new words: run `npm run announcer:vocab`').toEqual([]);
    // and what a real game says (names, numbers, the clock)
    const seed = 31;
    const g: any = createGame({ seed, tempo: 'standard', innings: 3 });
    const booth = new Booth({ rng: mulberry32(seed), level: 'high' });
    booth.setFacts(factsFromGame(g, String(seed), 'day', false) as OpeningFacts, 9);
    const q: any[] = [];
    g.on('*', (e: any) => q.push(e));
    const said: string[] = [];
    let t = 0;
    let over = -1;
    while ((over < 0 || t - over < 60) && t < 3 * 3600) {
      g.step(0.1);
      t += 0.1;
      const rs = g.getState();
      if (rs.gameOver && over < 0) over = t;
      const c = ctxFromRaw(rs, { game: g });
      for (const e of q.splice(0)) booth.observe(e, c, t);
      for (const a of booth.tick(t, c, { suppressed: false })) if (a.type === 'start') said.push(a.clauses.map((x) => x.text).join(' '));
    }
    expect(said.length).toBeGreaterThan(100);
    for (const s of said) expect(s).not.toMatch(/\$|\{|\}|\[|\]|undefined|NaN|null/);
    const unknown = new Set(said.flatMap((s) => wordsOf(normalizeForSpeech(s))).filter((w) => !vocab.has(w)));
    expect([...unknown]).toEqual([]);
  }, 240_000);
});
