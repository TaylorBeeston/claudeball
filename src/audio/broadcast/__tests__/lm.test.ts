import { describe, expect, it } from 'vitest';
import { LmColour, buildPrompt, factsFor, validateLine, type LmFacts } from '../lm';
import { GameLog } from '../gamelog';
import type { BoothCtx } from '../ctx';

const c: BoothCtx = {
  inning: 7, half: 'bottom', outs: 1, balls: 2, strikes: 1, score: { home: 3, away: 4 }, runners: [true, false, true], teams: { home: 'Comets', away: 'Stars' },
  batter: { id: 'b1', name: 'Tyler Vance', hand: 'R', bat: { pa: 3, ab: 3, h: 1, hr: 1, bb: 0, so: 1, rbi: 2, sb: 0 }, ratings: { power: 72 } },
  pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L', pit: { outs: 20, so: 8, bb: 1, h: 3, er: 1, pitches: 96, hr: 1 } },
};
const f = (): LmFacts => factsFor(c, new GameLog(), ['Ball one.']);

describe('LM facts, prompt and validator', () => {
  it('facts are compact and carry only game state', () => {
    const facts = f();
    expect(JSON.stringify(facts).length).toBeLessThan(700);
    expect(facts.runners).toBe('first and third');
    expect(facts.batter?.tonight).toBe('1-for-3, 1 HR, 1 K');
    const p = buildPrompt(facts);
    expect(p.system).toMatch(/ONLY the facts/);
    expect(JSON.parse(p.user).pitcher.pitches).toBe(96);
  });

  it('accepts a grounded line', () => {
    expect(validateLine('Vance already has a homer tonight, so Rook has to be careful with the count at two and one.', f()).ok).toBe(true);
    expect(validateLine('Rook is at 96 pitches, and the fastball has to hold up.', f()).ok).toBe(true);
  });

  it('rejects numbers and names that are not in the facts', () => {
    expect(validateLine('Rook is at 112 pitches tonight.', f())).toEqual({ ok: false, reason: 'number 112 not in the facts' });
    expect(validateLine('Johnson would love a double play here.', f()).ok).toBe(true); // a sentence-initial word is not checked as a name...
    expect(validateLine('That is a tough spot for Johnson to be in.', f()).reason).toMatch(/name "Johnson"/);
    expect(validateLine('Rook has struck out nine batters so far tonight.', f()).reason).toMatch(/number word "nine"/);
    expect(validateLine('That is the ninth inning feeling already.', f()).reason).toMatch(/ordinal "ninth"/);
  });

  it('rejects pronouns, symbols, meta talk, bad lengths and repetition', () => {
    expect(validateLine('Vance is hitting the ball well and he looks locked in.', f()).reason).toBe('pronoun');
    expect(validateLine('Vance looks locked in 🔥 tonight for sure.', f()).reason).toBe('symbols');
    expect(validateLine('As an AI I cannot say how Vance feels about it.', f()).ok).toBe(false);
    expect(validateLine('Good swing.', f()).reason).toBe('too short');
    expect(validateLine(Array(40).fill('word').join(' '), f()).reason).toBe('too long');
    const ff = { ...f(), recentLines: ['Vance already has a homer tonight, so Rook has to be careful.'] };
    expect(validateLine('Vance already has a homer tonight so Rook has to be careful here.', ff).reason).toBe('repeats a recent line');
  });
});

describe('LmColour (the plumbing, with a fake model)', () => {
  const mk = (gen: (s: string, u: string) => Promise<string>, now = { t: 0 }) => ({ lm: new LmColour({ generate: gen, now: () => now.t }), now });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  it('precomputes a line, validates it, and hands it over once', async () => {
    const { lm } = mk(async () => 'Vance already has a homer tonight, so Rook has to be careful here.');
    expect(lm.take()).toBeNull(); // nothing ready yet: the grammar speaks
    lm.prepare(f());
    await flush();
    expect(lm.take()).toBe('Vance already has a homer tonight, so Rook has to be careful here.');
    expect(lm.take()).toBeNull();
    expect(lm.stats.ok).toBe(1);
  });

  it('drops invalid lines (invented numbers, pronouns), counting the reasons', async () => {
    let n = 0;
    const lines = ['Rook is at 112 pitches tonight, which is a lot.', 'Vance looks locked in and he is seeing it well.'];
    const { lm } = mk(async () => lines[n++]);
    lm.prepare(f());
    await flush();
    expect(lm.take()).toBeNull();
    lm.prepare(f());
    await flush();
    expect(lm.take()).toBeNull();
    expect(lm.stats.rejected).toBe(2);
    expect(Object.keys(lm.stats.reasons).sort()).toEqual(['number # not in the facts', 'pronoun']);
  });

  it('a late answer is never used, a failure is silent, and a stale line expires', async () => {
    const now = { t: 0 };
    let release: (s: string) => void = () => {};
    const lm = new LmColour({ generate: () => new Promise<string>((r) => (release = r)), now: () => now.t, budgetMs: 1500, staleMs: 10000 });
    lm.prepare(f());
    now.t = 4000;
    release('Vance already has a homer tonight, so Rook has to be careful here.');
    await flush();
    expect(lm.take()).toBeNull();
    expect(lm.stats.late).toBe(1);
    const bad = new LmColour({ generate: async () => { throw new Error('gpu lost'); }, now: () => now.t });
    bad.prepare(f());
    await flush();
    expect(bad.take()).toBeNull();
    expect(bad.stats.failed).toBe(1);
    const ok = new LmColour({ generate: async () => 'Rook is at 96 pitches, and the fastball has to hold up.', now: () => now.t, staleMs: 10000 });
    ok.prepare(f());
    await flush();
    now.t += 20000;
    expect(ok.take()).toBeNull(); // the game moved on
  });

  it('does not start a second generation while one runs or a line is waiting', async () => {
    let calls = 0;
    const { lm } = mk(async () => { calls++; return 'Rook is at 96 pitches, and the fastball has to hold up.'; });
    lm.prepare(f());
    lm.prepare(f());
    await flush();
    lm.prepare(f()); // a ready line is waiting
    await flush();
    expect(calls).toBe(1);
  });
});
