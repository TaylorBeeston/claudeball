import { describe, expect, it } from 'vitest';
import { TopicPicker, collectStories, neutralStories } from '../stories';
import { GameLog } from '../gamelog';
import { mulberry32 } from '../../dsp';
import type { BoothCtx } from '../ctx';
import type { RawEvent } from '../../types';
import { wordCount } from '../text';

const people: Record<string, { name: string; role?: string }> = { b1: { name: 'Tyler Vance' }, p1: { name: 'Sam Rook' }, r1: { name: 'Ray Dash' } };
function ctx(over: Partial<BoothCtx> = {}): BoothCtx {
  return {
    inning: 7, half: 'bottom', outs: 2, balls: 1, strikes: 2, score: { home: 3, away: 4 }, runners: [true, false, true], runnerNames: ['Ray Dash', undefined, 'Lou Stone'], runnerSpeed: [75, undefined, 45],
    teams: { home: 'Comets', away: 'Stars' }, crowd: 0.7,
    batter: { id: 'b1', name: 'Tyler Vance', hand: 'L', ratings: { power: 72, contact: 71 }, bat: { pa: 3, ab: 3, h: 3, hr: 1, bb: 0, so: 0, rbi: 2, sb: 0 } },
    pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L', ratings: { control: 68, velocity: 97 }, pit: { outs: 20, so: 8, bb: 1, h: 0, er: 0, pitches: 96, hr: 0 } },
    person: (id) => people[String(id)], ...over,
  };
}

/** a game with real history: many pitches, results, steals, a comeback */
function seasoned(): { log: GameLog; c: BoothCtx } {
  const log = new GameLog();
  const c = ctx();
  const feed = (e: RawEvent) => log.observe(e, c);
  feed({ type: 'gameStart' });
  let t = 0;
  const pa = (bid: string, pitches: [string, number, 'ball' | 'strikeLooking' | 'strikeSwinging' | 'foul'][], result: string) => {
    feed({ type: 'batterUp', batterId: bid, pitcherId: 'p1' });
    let b = 0, s = 0;
    for (const [type, mph, k] of pitches) {
      c.balls = b; c.strikes = s;
      feed({ type: 'pitchReleased', pitcherId: 'p1', pitchType: type, mph, time: t++ });
      feed({ type: 'pitchCrossed', x: 0, y: 0.8, inZone: true, mph });
      feed({ type: 'call', call: { kind: k, balls: b, strikes: s } });
      if (k === 'ball') b++; else if (s < 2 || k !== 'foul') s++;
    }
    feed({ type: 'plateAppearanceEnd', batterId: bid, result });
  };
  // early: fastballs at 98 and later 95 (velocity drop), 2-2 counts mostly sliders
  for (let i = 0; i < 4; i++) pa('x' + i, [['FF', 98, 'strikeLooking'], ['FF', 98, 'ball'], ['FF', 98, 'ball'], ['FF', 97, 'foul'], ['SL', 88, 'strikeSwinging']], 'strikeout swinging');
  for (let i = 0; i < 4; i++) pa('y' + i, [['FF', 95, 'strikeLooking'], ['FF', 95, 'ball'], ['FF', 95, 'ball'], ['FF', 94, 'foul'], ['SL', 87, 'strikeSwinging']], 'groundout');
  pa('b1', [['FF', 94, 'ball'], ['CH', 85, 'strikeLooking']], 'single');
  pa('b1', [['FF', 94, 'ball'], ['SL', 86, 'strikeLooking']], 'double');
  feed({ type: 'steal', runnerId: 'r1', toBase: 2 }); feed({ type: 'safe', playerId: 'r1', base: 2 });
  feed({ type: 'steal', runnerId: 'r1', toBase: 3 }); feed({ type: 'safe', playerId: 'r1', base: 3 });
  // the current plate appearance: a first-pitch slider, then 2-2 slider history exists
  feed({ type: 'batterUp', batterId: 'b1', pitcherId: 'p1' });
  c.balls = 0; c.strikes = 0;
  feed({ type: 'pitchReleased', pitcherId: 'p1', pitchType: 'SL', mph: 86 });
  feed({ type: 'pitchCrossed', x: 0.1, y: 0.7, inZone: true });
  feed({ type: 'call', call: { kind: 'strikeLooking', balls: 0, strikes: 0 } });
  log.maxDeficit.home = 4;
  log.leadChanges = 3;
  return { log, c };
}

const PRON = /\b(he|she|his|her|hers|him|himself|herself)\b/i;

describe('stories are grounded in the game', () => {
  it('finds the true stories in a seasoned game', () => {
    const { log, c } = seasoned();
    c.balls = 2; c.strikes = 2; // a count the pitcher has thrown the slider on before
    const ids = collectStories(log, c).map((s) => s.id);
    expect(ids).toContain('firstPitchBreaking');
    expect(ids).toContain('velocityDown');
    expect(ids).toContain('countTendency');
    expect(ids).toContain('twoOutRsp');
    expect(collectStories(log, { ...c, outs: 1 }).map((x) => x.id)).toContain('speedster');
    expect(ids).toContain('stealCount');
    expect(ids).toContain('thirdTime');
    expect(ids).toContain('hotBat');
    expect(ids).toContain('perfectNight');
    expect(ids).toContain('noHitter');
    expect(ids).toContain('pitchCount');
    expect(ids).toContain('comeback');
    expect(ids).toContain('crowd');
    expect(ids).toContain('powerGrade');
  });

  it('does not tell stories that are not true', () => {
    const log = new GameLog();
    const c = ctx({ runners: [false, false, false], outs: 0, crowd: 0.1, batter: { id: 'b1', name: 'Tyler Vance', hand: 'R', bat: { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0, rbi: 0, sb: 0 } }, pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L', pit: { outs: 0, so: 0, bb: 0, h: 0, er: 0, pitches: 0, hr: 0 } }, score: { home: 0, away: 0 }, inning: 1 });
    const ids = collectStories(log, c).map((s) => s.id);
    for (const bad of ['firstPitchBreaking', 'velocityDown', 'countTendency', 'twoOutRsp', 'speedster', 'stealCount', 'thirdTime', 'hotBat', 'perfectNight', 'noHitter', 'pitchCount', 'comeback', 'crowd', 'cruising', 'rattled', 'hatTrick', 'loaded', 'tightLate', 'blowout', 'kNight', 'sameHand']) expect(ids).not.toContain(bad);
  });

  it('the count tendency uses the real numbers from the log', () => {
    const { log, c } = seasoned();
    c.balls = 2; c.strikes = 2;
    const cnt = log.onCount('p1', 2, 2);
    expect(cnt.length).toBeGreaterThanOrEqual(4);
    const s = collectStories(log, c).find((x) => x.id === 'countTendency')!;
    const turns = s.build(mulberry32(1), 'color')!;
    expect(turns[0].text).toMatch(/two and two/);
    const sliders = cnt.filter((p) => p.type === 'SL').length;
    expect(turns[0].text).toContain(String(['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][sliders]));
  });
});

describe('topic picker', () => {
  it('turn structure: 1-4 turns, alternating voices, short lines, no pronouns, nothing unresolved', () => {
    const { log, c } = seasoned();
    const seen = new Set<string>();
    for (let seed = 1; seed < 80; seed++) {
      const pk = new TopicPicker(mulberry32(seed));
      for (let i = 0; i < 12; i++) {
        const t = pk.next(log, { ...c, balls: i % 2 ? 2 : 0, strikes: 2 }, i % 3 === 0);
        if (!t) continue;
        seen.add(t.tag);
        expect(t.turns.length).toBeGreaterThanOrEqual(1);
        expect(t.turns.length).toBeLessThanOrEqual(4);
        for (let k = 0; k < t.turns.length; k++) {
          const x = t.turns[k];
          expect(x.text, `${t.tag}: ${x.text}`).not.toMatch(/\$|\{|\}|undefined|NaN/);
          expect(PRON.test(x.text), `${t.tag}: ${x.text}`).toBe(false);
          expect(wordCount(x.text), `${t.tag}: ${x.text}`).toBeGreaterThanOrEqual(2);
          expect(wordCount(x.text), `${t.tag}: ${x.text}`).toBeLessThanOrEqual(36);
          if (k) expect(x.speaker).not.toBe(t.turns[k - 1].speaker);
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(14);
  });

  it('never tells the same fact twice, and never more than 3 neutral lines in a row', () => {
    const log = new GameLog();
    const c = ctx({ runners: [false, false, false], outs: 0, crowd: 0.1, inning: 3, score: { home: 1, away: 1 }, batter: { id: 'b1', name: 'Tyler Vance', hand: 'R' }, pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L' } });
    const pk = new TopicPicker(mulberry32(4));
    let neutralRun = 0;
    let maxRun = 0;
    let nulls = 0;
    for (let i = 0; i < 40; i++) {
      const t = pk.next(log, c, false);
      if (!t) { nulls++; neutralRun = 0; continue; }
      if (t.tag.startsWith('n.')) maxRun = Math.max(maxRun, ++neutralRun); else neutralRun = 0;
    }
    expect(maxRun).toBeLessThanOrEqual(3);
    expect(nulls).toBeGreaterThan(0); // it prefers silence over a fourth filler
    const { log: l2, c: c2 } = seasoned();
    const pk2 = new TopicPicker(mulberry32(9));
    const tags: string[] = [];
    for (let i = 0; i < 30; i++) { const t = pk2.next(l2, c2, false); if (t && !t.tag.startsWith('n.')) tags.push(t.tag); }
    expect(new Set(tags).size).toBe(tags.length); // each (id,key) pair once: the picker consumed every key it used
  });

  it('prefers punchy stories at tense moments', () => {
    const { log, c } = seasoned();
    let tense = 0, calm = 0;
    for (let seed = 1; seed < 60; seed++) {
      const a = new TopicPicker(mulberry32(seed)).next(log, c, true);
      const b = new TopicPicker(mulberry32(seed)).next(log, c, false);
      const tenseIds = new Set(collectStories(log, c).filter((s) => s.tense).map((s) => s.id));
      if (a && tenseIds.has(a.tag)) tense++;
      if (b && tenseIds.has(b.tag)) calm++;
    }
    expect(tense).toBeGreaterThanOrEqual(calm);
  });

  it('neutral lines are claims about nothing', () => {
    const c = ctx({ score: { home: 2, away: 2 } });
    for (const s of neutralStories(c)) for (let seed = 0; seed < 10; seed++) {
      const turns = s.build(mulberry32(seed), 'pxp');
      for (const t of turns ?? []) expect(PRON.test(t.text)).toBe(false);
    }
  });
});
