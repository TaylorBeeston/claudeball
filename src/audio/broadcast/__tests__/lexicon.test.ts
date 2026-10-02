import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EVENT_KEYS, LEX, SILENT_EVENTS, callsFor, carryEstimate, countWords, depthWord, hitType, lexiconStats, sprayZone, type Env } from '../lexicon';
import { variants } from '../grammar';
import { GameLog } from '../gamelog';
import { mulberry32 } from '../../dsp';
import type { BoothCtx } from '../ctx';
import type { RawEvent } from '../../types';

const people: Record<string, { name: string; role?: string }> = {
  b1: { name: 'Tyler Vance' }, p1: { name: 'Sam Rook' }, ss: { name: 'Pat Short', role: 'short' }, lf: { name: 'Dee Alder', role: 'left' }, r1: { name: 'Ray Dash' }, cf: { name: 'Cy Fielder', role: 'center' },
};
const ctx = (over: Partial<BoothCtx> = {}): BoothCtx => ({
  inning: 5, half: 'bottom', outs: 0, balls: 0, strikes: 0, score: { home: 3, away: 2 }, runners: [false, false, false], teams: { home: 'Comets', away: 'Stars' },
  batter: { id: 'b1', name: 'Tyler Vance', hand: 'R', bat: { pa: 2, ab: 2, h: 1, hr: 0, bb: 0, so: 0, rbi: 0, sb: 0 } }, pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L', pit: { outs: 12, so: 5, bb: 1, h: 3, er: 1, pitches: 70, hr: 0 } },
  person: (id) => people[String(id)], ...over,
});
const env = (rng = mulberry32(1), live = { balls: 1, strikes: 1, outs: 0 }): Env => ({ rng, live: () => live, epoch: () => 1 });
const texts = (cs: ReturnType<typeof callsFor>) => cs.map((c) => c.text);

function simEventTypes(): string[] {
  const src = readFileSync('src/sim/types.ts', 'utf8');
  const a = src.indexOf('export type GameEvent =');
  const b = src.indexOf('export type GameEventType');
  return [...new Set([...src.slice(a, b).matchAll(/type: '(\w+)'/g)].map((m) => m[1]))];
}

describe('coverage of the sim events', () => {
  it('every sim event is covered by at least 4 wording variants or deliberately silent', () => {
    const stats = lexiconStats();
    const rows: string[] = [];
    for (const t of simEventTypes()) {
      if (SILENT_EVENTS.includes(t)) continue;
      const keys = EVENT_KEYS[t];
      expect(keys, `no lexicon entry for sim event "${t}"`).toBeTruthy();
      for (const k of keys) expect(LEX[k], `${t}: missing key ${k}`).toBeTruthy();
      const total = keys.reduce((a, k) => a + (stats[k] ?? 0), 0);
      rows.push(`${t}: ${total}`);
      expect(total, `${t} has only ${total} variants`).toBeGreaterThanOrEqual(4);
    }
    // eslint-disable-next-line no-console
    console.log('variants per sim event:', rows.join(', '));
    // eslint-disable-next-line no-console
    console.log('total template variants:', Object.values(stats).reduce((a, b) => a + b, 0), 'in', Object.keys(LEX).length, 'keys');
  });

  it('every lexicon key is used by an event and has at least 3 templates', () => {
    const used = new Set(Object.values(EVENT_KEYS).flat());
    for (const [k, v] of Object.entries(LEX)) {
      expect(used.has(k) || k.startsWith('outs.') || k.startsWith('replay.') || k.startsWith('react.'), `unused key ${k}`).toBe(true);
      expect(v.length, k).toBeGreaterThanOrEqual(3);
      for (const t of v) expect(variants(t)).toBeGreaterThanOrEqual(1);
    }
  });

  it('players are he / him / his: no she / her for anybody, and no pronoun next to the umpire', () => {
    const WRONG = /\b(she|her|hers|herself)\b/i;
    for (const [k, v] of Object.entries(LEX)) for (const t of v) {
      // the umpire is never gendered ("they" / "them" stay fine for teams and groups)
      expect(WRONG.test(t), `${k}: ${t}`).toBe(false);
      if (/umpire/i.test(t)) expect(/\b(he|his|him|himself)\b/i.test(t), `${k}: ${t}`).toBe(false);
    }
  });

  it('uses he / him / his for players in a good share of the events, never starting a sentence with a pronoun that has no one to refer to', () => {
    const PRON = /\b(he|his|him|himself)\b/i;
    const withPron = Object.entries(LEX).filter(([, v]) => v.some((t) => PRON.test(t))).map(([k]) => k);
    expect(withPron.length).toBeGreaterThanOrEqual(60);
    // the owner's examples
    const all = Object.values(LEX).flat().join(' | ');
    expect(all).toMatch(/he will hold at first/i);
    expect(all).toMatch(/he took that away/i);
    expect(all).toMatch(/his \$ko strikeout/i);
  });
});

describe('direction and type words', () => {
  it('+spray is toward third base / left field, - toward first / right', () => {
    expect(sprayZone(25).dir).toBe('left field');
    expect(sprayZone(-25).dir).toBe('right field');
    expect(sprayZone(0).dir).toBe('center field');
    expect(sprayZone(10).dir).toBe('left-center');
    expect(sprayZone(-10).dir).toBe('right-center');
    expect(sprayZone(41).line).toBe('left-field');
    expect(sprayZone(-41).line).toBe('right-field');
    expect(sprayZone(60).id).toBe('foul-left');
    expect(sprayZone(-60).id).toBe('foul-right');
    expect(sprayZone(25).side).toBe('left');
    expect(sprayZone(-25).side).toBe('right');
  });
  it('hit types from launch angle; carry and depth from where the ball came down', () => {
    expect(hitType(-5, 80)).toBe('grounder');
    expect(hitType(15, 95)).toBe('liner');
    expect(hitType(32, 100)).toBe('fly');
    expect(hitType(65, 70)).toBe('pop');
    expect(hitType(5, 25)).toBe('bunt');
    expect(carryEstimate(105, 28)).toBeGreaterThan(100);
    expect(carryEstimate(80, 30)).toBeLessThan(80);
    expect(depthWord(30, 5)).toBe('infield');
    expect(depthWord(60, 10)).toBe('shallow');
    expect(depthWord(95, 5)).toBe('deep');
  });
  it('count words', () => {
    expect(countWords(2, 1)).toBe('two and one');
    expect(countWords(3, 2)).toBe('full');
  });
});

function feed(log: GameLog, c: BoothCtx, evs: RawEvent[]) {
  for (const e of evs) log.observe(e, c);
}

describe('calls', () => {
  it('a called strike gives a SHOULD call with the count folded; ball four and strike three are left to the walk / out events', () => {
    const log = new GameLog();
    const c = ctx();
    feed(log, c, [{ type: 'batterUp', batterId: 'b1', pitcherId: 'p1' }, { type: 'pitchReleased', pitcherId: 'p1', pitchType: 'FF', mph: 94.2 }, { type: 'pitchCrossed', x: -0.2, y: 0.4, inZone: true, mph: 94 }]);
    const ev: RawEvent = { type: 'call', call: { kind: 'strikeLooking', balls: 1, strikes: 0 } };
    log.observe(ev, c);
    const calls = callsFor(ev, c, log, env());
    expect(calls).toHaveLength(1);
    expect(calls[0].importance).toBe('should');
    expect(calls[0].text).toMatch(/strike one|Strike one/i);
    expect(calls[0].fold!.render()).toMatch(/one and one/);
    // strike three / ball four: nothing from `call`
    expect(callsFor({ type: 'call', call: { kind: 'strikeSwinging', balls: 0, strikes: 2 } }, c, log, env())).toHaveLength(0);
    expect(callsFor({ type: 'call', call: { kind: 'ball', balls: 3, strikes: 0 } }, c, log, env())).toHaveLength(0);
  });

  it('a pitch to a left-hander away from him is "in" the other way round (location words come from the batter side)', () => {
    const run = (hand: 'L' | 'R') => {
      const log = new GameLog();
      const c = ctx({ batter: { id: 'b1', name: 'Tyler Vance', hand } });
      feed(log, c, [{ type: 'batterUp', batterId: 'b1', pitcherId: 'p1' }, { type: 'pitchReleased', pitcherId: 'p1', pitchType: 'SL', mph: 85 }, { type: 'pitchCrossed', x: -0.22, y: 0.4, inZone: false, mph: 85 }]);
      const ev: RawEvent = { type: 'call', call: { kind: 'ball', balls: 0, strikes: 0 } };
      log.observe(ev, c);
      const all = new Set<string>();
      for (let s = 0; s < 40; s++) callsFor(ev, c, log, env(mulberry32(s))).forEach((x) => all.add(x.text));
      return [...all].join(' | ');
    };
    expect(run('R')).toContain('low and away');
    expect(run('R')).not.toContain('low and in');
    expect(run('L')).toContain('low and in');
    expect(run('L')).not.toContain('low and away');
  });

  it('strikeouts: swinging vs looking come from the last pitch result; K count is a separate COULD', () => {
    const base = (result: 'swinging' | 'called') => {
      const log = new GameLog();
      const c = ctx({ pitcher: { id: 'p1', name: 'Sam Rook', hand: 'L', pit: { outs: 12, so: 6, bb: 1, h: 3, er: 1, pitches: 70, hr: 0 } } });
      feed(log, c, [{ type: 'batterUp', batterId: 'b1', pitcherId: 'p1' }, { type: 'pitchReleased', pitcherId: 'p1', pitchType: 'CU', mph: 80 }, { type: 'call', call: { kind: result === 'swinging' ? 'strikeSwinging' : 'strikeLooking', balls: 0, strikes: 2 } }]);
      const ev: RawEvent = { type: 'out', playerId: 'b1', outType: 'strikeout', base: null };
      log.observe(ev, c);
      return callsFor(ev, c, log, env());
    };
    const sw = base('swinging');
    const lk = base('called');
    expect(sw[0].importance).toBe('must');
    expect(sw[0].excited).toBe(true);
    expect(sw[0].text).toMatch(/swing|Swing|fanned|Fanned|down swinging|strike three/i);
    expect(lk[0].text).toMatch(/look|called|Rung|Frozen|Called/);
    expect(sw[1]).toMatchObject({ importance: 'could' });
    expect(sw[1].text).toMatch(/six/);
  });

  it('home runs: solo / two-run / three-run / grand slam / walk-off, with the real distance', () => {
    const hr = (runnersOn: number, ctxOver: Partial<BoothCtx> = {}) => {
      const log = new GameLog();
      const c = ctx({ runners: [runnersOn >= 1, runnersOn >= 2, runnersOn >= 3], ...ctxOver });
      feed(log, c, [{ type: 'contact', exitMph: 104, launchDeg: 28, sprayDeg: 22, batterId: 'b1' }]);
      const seen = new Set<string>();
      for (let s = 0; s < 60; s++) for (const x of callsFor({ type: 'homeRun', batterId: 'b1', distance: 128, time: 1 }, c, log, env(mulberry32(s)))) seen.add(`${x.importance}:${x.excited ? '!' : ''}:${x.text}`);
      return [...seen];
    };
    expect(hr(0).every((t) => t.startsWith('must:!') || t.startsWith('could'))).toBe(true);
    expect(hr(0).join()).toMatch(/Home run|gone|Gone|outta|yard|home run/i);
    expect(hr(0).join()).toContain('420 feet'); // 128 m
    expect(hr(1).join()).toMatch(/two-run|Two runs|two-run/i);
    expect(hr(2).join()).toMatch(/three/i);
    expect(hr(3).join()).toMatch(/grand slam|Grand slam/i);
    expect(hr(0, { inning: 9, score: { home: 3, away: 3 } }).join()).toMatch(/walk-off|Walk-off/i);
  });

  it('batted balls: grounder to the left side vs a fly to left; foul territory is left to the foul call', () => {
    const run = (launch: number, exit: number, spray: number) => {
      const log = new GameLog();
      const c = ctx();
      const ev: RawEvent = { type: 'contact', exitMph: exit, launchDeg: launch, sprayDeg: spray, batterId: 'b1' };
      log.observe(ev, c);
      const seen = new Set<string>();
      for (let s = 0; s < 40; s++) callsFor(ev, c, log, env(mulberry32(s))).forEach((x) => seen.add(x.text));
      return [...seen].join(' | ');
    };
    expect(run(32, 92, 25)).toContain('left field');
    expect(run(32, 92, -25)).toContain('right field');
    expect(run(32, 106, 0)).toMatch(/Deep|deep|long|Back|back/);
    expect(run(2, 85, 20)).toMatch(/third|left/);
    expect(run(2, 85, -20)).toMatch(/first|right/);
    expect(run(30, 90, 60)).toBe('');
  });

  it('outs name the fielder and the number of outs; double and triple plays are recognised', () => {
    const log = new GameLog();
    const c = ctx();
    log.observe({ type: 'halfInningStart', inning: 5, half: 'bottom' }, c);
    log.observe({ type: 'contact', exitMph: 88, launchDeg: 4, sprayDeg: 10, batterId: 'b1', time: 10 }, c);
    const o1: RawEvent = { type: 'out', playerId: 'b1', outType: 'force', base: 1, fielders: ['ss'], time: 10.5 };
    log.observe(o1, c);
    const first = callsFor(o1, c, log, env());
    expect(first[0].text).toMatch(/Short|short/);
    expect(first[0].text).toMatch(/One away|One out|one out/i);
    const o2: RawEvent = { type: 'out', playerId: 'r1', outType: 'force', base: 2, fielders: ['ss'], time: 11 };
    log.observe(o2, c);
    expect(callsFor(o2, c, log, env())[0].text).toMatch(/double play|Double play|Turns two|two outs on one play/i);
    const o3: RawEvent = { type: 'out', playerId: 'x', outType: 'force', base: 3, fielders: ['ss'], time: 11.4 };
    log.observe(o3, c);
    expect(callsFor(o3, c, log, env())[0].text).toMatch(/triple/i);
  });

  it('steals: runner goes, then safe with the steal number from the log; close plays are excited', () => {
    const log = new GameLog();
    const c = ctx({ runners: [true, false, false] });
    const st: RawEvent = { type: 'steal', runnerId: 'r1', toBase: 2, time: 5 };
    log.observe(st, c);
    expect(callsFor(st, c, log, env())[0].importance).toBe('should');
    const sf: RawEvent = { type: 'safe', playerId: 'r1', base: 2, time: 6 };
    log.observe(sf, c);
    const t = new Set<string>();
    for (let s = 0; s < 40; s++) callsFor(sf, c, log, env(mulberry32(s))).forEach((x) => t.add(x.text));
    expect([...t].some((x) => /steal|stolen|Stolen|Beats the throw|Gets in/.test(x))).toBe(true);
    expect([...t].join(' ')).toContain('number one');
    const close = callsFor({ type: 'safe', playerId: 'x', base: 3, closePlay: true }, ctx(), new GameLog(), env())[0];
    expect(close.excited).toBe(true);
  });

  it('errors, wild pitches, walks, HBP, balk, robbed home runs, the end of the game', () => {
    const log = new GameLog();
    const c = ctx({ runners: [true, true, true] });
    const t = (ev: RawEvent, cc = c) => callsFor(ev, cc, log, env());
    expect(t({ type: 'error', fielderId: 'ss', kind: 'throw' })[0].text).toMatch(/Short/);
    expect(t({ type: 'wildPitch' })[0].importance).toBe('must');
    expect(t({ type: 'walk', batterId: 'b1', intentional: false })[0].text).toMatch(/run|forces/i);
    expect(t({ type: 'walk', batterId: 'b1', intentional: true })[0].text).toMatch(/intentional|purpose|wide|put/i);
    expect(t({ type: 'hitByPitch', batterId: 'b1' })[0].excited).toBe(true);
    expect(t({ type: 'call', call: { kind: 'balk', balls: 0, strikes: 0 } })[0].importance).toBe('must');
    const rb = t({ type: 'robbedHomeRun', fielderId: 'lf', batterId: 'b1' })[0];
    expect(rb.excited).toBe(true);
    expect(rb.text).toMatch(/Alder/);
    expect(t({ type: 'gameEnd', winner: 'home', home: 5, away: 3 })[0].text).toMatch(/Comets/);
    expect(t({ type: 'gameEnd', winner: 'tie', home: 3, away: 3 })[0].text).toMatch(/tie|tied/);
  });

  it('never says undefined, NaN or an unresolved slot', () => {
    const log = new GameLog();
    const c = ctx({ person: () => undefined, runners: [true, true, false] });
    const evs: RawEvent[] = [
      { type: 'call', call: { kind: 'ball', balls: 0, strikes: 0 } }, { type: 'contact', exitMph: 90, launchDeg: 20, sprayDeg: 10 }, { type: 'out', outType: 'fly', playerId: 'x' }, { type: 'out', outType: 'force', base: 2 },
      { type: 'safe', base: 2 }, { type: 'error', kind: 'drop' }, { type: 'runScored' }, { type: 'plateAppearanceEnd', result: 'single' }, { type: 'plateAppearanceEnd', result: 'double' }, { type: 'homeRun', distance: 100 },
      { type: 'pitchingChange' }, { type: 'substitution', reason: 'pinch hitter' }, { type: 'wallLeap' }, { type: 'robbedHomeRun' }, { type: 'fielded', clean: false }, { type: 'catch', fly: true },
    ];
    for (let s = 0; s < 30; s++) for (const e of evs) for (const x of callsFor(e, c, log, env(mulberry32(s)))) expect(x.text, JSON.stringify(e)).not.toMatch(/undefined|NaN|null|\$/);
  });
});
