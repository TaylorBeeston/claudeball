import { describe, expect, it } from 'vitest';
import { createGame } from '../../../sim/index';
import { DENY, buildGameInfo } from '../../../sim/gameinfo';
import { Director, type Action, type Segment, type StartAction } from '../director';
import { CAST, CATCHPHRASES, RUNNING_JOKES, speakerLabel } from '../cast';
import { HD_VOICES } from '../../neural';
import { factsFromGame } from '../facts';
import { clockWords, handoffLine, openingSegment, weatherFor, type OpeningFacts } from '../pregame';
import { Booth } from '../booth';
import { ctxFromRaw } from '../ctx';
import { estimateDuration } from '../text';
import { mulberry32 } from '../../dsp';
import { speakerFor, type VoiceManifest } from '../../voice/pack';

/* eslint-disable @typescript-eslint/no-explicit-any */

const factsOf = (seed: number, tod: 'day' | 'dusk' | 'night' = 'night', tempo: 'quick' | 'standard' | 'broadcast' = 'broadcast') => {
  const g: any = createGame({ seed, tempo });
  return { g, f: factsFromGame(g, String(seed), tod, false)! };
};

/** play a segment through a director with a fake clock; `slow` scales every line's real duration (slower voices) */
function play(seg: Segment, budget: number, slow = 1) {
  const d = new Director({ rng: mulberry32(3), level: 'normal', dur: (t, e) => estimateDuration(t, e ? 1.1 : 1) * slow });
  const starts: (StartAction & { end: number })[] = [];
  d.runSegment(seg, 0, budget);
  for (let t = 0; t < budget + 30; t = Math.round((t + 0.05) * 1000) / 1000) for (const a of d.tick(t)) if (a.type === 'start') starts.push({ ...a, end: a.at + a.est });
  return { d, starts };
}

describe('the cast', () => {
  it('has two distinct booth characters and a PA announcer, with names, labels, pronouns and stable voices', () => {
    expect(CAST.pbp.name).not.toBe(CAST.color.name);
    expect(speakerLabel('pbp')).toBe('LYLE');
    expect(speakerLabel('color')).toBe('BISCUIT');
    expect(speakerLabel('ump')).toBeUndefined();
    for (const m of Object.values(CAST)) {
      expect(m.pronouns.subject).toBe('he');
      expect(m.voice.kokoro).toMatch(/^[ab][mf]_/);
    }
    // the HD voices are the cast's, and the three characters sound different
    expect(HD_VOICES.pbp).toBe(CAST.pbp.voice.kokoro);
    expect(HD_VOICES.color).toBe(CAST.color.voice.kokoro);
    expect(HD_VOICES.pa).toBe(CAST.pa.voice.kokoro);
    expect(new Set([HD_VOICES.pbp, HD_VOICES.color, HD_VOICES.pa]).size).toBe(3);
  });

  it('maps the custom voice pack speakers (playbyplay / hype / color) onto the two booth characters', () => {
    expect(CAST.pbp.voice.packSpeakers).toEqual(expect.arrayContaining(['playbyplay', 'hype']));
    expect(CAST.color.voice.packSpeakers).toEqual(['color']);
    // with a pack that names those speakers, the colour style resolves to the analyst's speaker
    const m = { speakers: { playbyplay: 0, hype: 1, color: 2 }, styleSpeaker: { calm: 'playbyplay', excited: 'hype', peak: 'hype', deadpan: 'color' } } as unknown as VoiceManifest;
    expect(speakerFor(m, 'deadpan')).toBe(2);
    expect(speakerFor(m, 'peak')).toBe(1);
  });

  it('never uses a real person\'s name, and catchphrases / jokes are rationed', () => {
    for (const m of Object.values(CAST)) {
      expect(DENY.has(`${m.first} ${m.last}`.toLowerCase())).toBe(false);
      expect(DENY.has(m.name.toLowerCase())).toBe(false);
    }
    for (const c of CATCHPHRASES) expect(c.max).toBeLessThanOrEqual(2);
    for (const j of RUNNING_JOKES) expect(j.gap).toBeGreaterThanOrEqual(600);
  });
});

describe('game info (sim)', () => {
  it('is deterministic per seed, never names a real umpire or manager, and keeps the records believable', () => {
    for (let s = 1; s <= 200; s++) {
      const g: any = createGame({ seed: s, pace: 0 });
      const i = g.info;
      for (const n of [...i.umpires.map((u: any) => u.name), i.managers.home.name, i.managers.away.name, i.managers.home.pitchingCoach, i.managers.away.pitchingCoach]) expect(DENY.has(n.toLowerCase()), n).toBe(false);
      expect(new Set(i.umpires.map((u: any) => u.name.split(' ')[1])).size).toBe(4);
      expect(i.umpires.filter((u: any) => u.chief)).toHaveLength(1);
      const h = i.records.home;
      const a = i.records.away;
      expect(Math.abs(h.w + h.l - (a.w + a.l))).toBeLessThanOrEqual(2);
      for (const r of [h, a]) {
        expect(r.w + r.l).toBeLessThanOrEqual(162);
        expect(r.last10.filter((x: string) => x === 'W').length).toBeLessThanOrEqual(r.w);
        expect(r.streak.n).toBeGreaterThanOrEqual(1);
      }
    }
    const t = createGame({ seed: 5, pace: 0 }).getTeams();
    expect(buildGameInfo(5, t)).toEqual(buildGameInfo(5, t));
  });

  it('names the umpires and managers in the snapshot, and the park belongs to the home club', () => {
    const g: any = createGame({ seed: 9, pace: 0 });
    const st = g.getState();
    const plate = st.players.find((p: any) => p.role === 'umpire' && p.position === 'HP');
    expect(plate.name).toBe(g.info.umpires.find((u: any) => u.key === 'plate').name);
    const g2: any = createGame({ seed: 10, pace: 0, homeTeam: g.getTeams().home, awayTeam: g.getTeams().away });
    expect(g2.info.venue.name).toBe(g.info.venue.name);
    expect(g2.info.managers.home.name).toBe(g.info.managers.home.name);
  });

  it('gives the pregame 60-90 s at broadcast, ~20 s at quick, and ends it with the umpire\'s play ball before the first pitch', () => {
    for (const [tempo, lo, hi] of [['broadcast', 60, 90], ['standard', 35, 55], ['quick', 14, 23]] as const) {
      const g: any = createGame({ seed: 3, tempo });
      const ev: { t: number; e: any }[] = [];
      let t = 0;
      g.on('*', (e: any) => ev.push({ t, e }));
      while (!ev.some((x) => x.e.type === 'pitchReleased') && t < 200) {
        g.step(0.05);
        t += 0.05;
      }
      const pre = ev.find((x) => x.e.type === 'breakStart')!.e;
      expect(pre.pregame).toBe(true);
      expect(pre.sec).toBeGreaterThanOrEqual(lo);
      expect(pre.sec).toBeLessThanOrEqual(hi);
      const pb = ev.find((x) => x.e.type === 'umpireCall' && x.e.kind === 'play_ball');
      const fp = ev.find((x) => x.e.type === 'pitchReleased')!;
      expect(pb && pb.t).toBeLessThan(fp.t);
      expect(ev.filter((x) => x.e.type === 'breakStart' && x.e.pregame)).toHaveLength(1);
    }
  });
});

describe('the opening segment', () => {
  it('names the booth, the park, the clubs and the starter, and is deterministic per seed', () => {
    const { f } = factsOf(7);
    const a = openingSegment(f, { budget: 70 });
    const b = openingSegment(factsOf(7).f, { budget: 70 });
    expect(a).toEqual(b);
    const text = a.turns.map((t) => t.text).join(' ');
    expect(text).toContain(CAST.pbp.last);
    expect(text).toContain(f.venue!.name);
    expect(text).toContain(f.home.nick);
    expect(text).toContain(f.away.nick);
    expect(text).toContain(f.home.starter!.name);
    expect(a.turns[0].block).toBe('welcome');
    expect(a.turns.some((t) => t.speaker === 'color')).toBe(true);
    expect(text).not.toMatch(/\b(she|her)\b/i);
  });

  it('a different time of day changes only the words that depend on it', () => {
    const night = openingSegment(factsOf(7, 'night').f, { budget: 200 });
    const day = openingSegment(factsOf(7, 'day').f, { budget: 200 });
    const strip = (s: Segment) => s.turns.filter((t) => !['welcome', 'weather'].includes(t.block)).map((t) => t.text);
    expect(strip(day)).toEqual(strip(night));
    expect(day.turns[0].text).toMatch(/^Good afternoon/);
    expect(night.turns[0].text).toMatch(/^Good evening/);
  });

  it('fits the pregame at every tempo, even with voices 30 % slower than estimated', () => {
    for (const seed of [1, 7, 23, 42]) {
      for (const budget of [16.5 - 8.5, 40 - 9.3, 66 - 9.3, 90 - 9.3]) {
        const { f } = factsOf(seed);
        const seg = openingSegment(f, { budget });
        for (const slow of [1, 1.3]) {
          const { starts } = play(seg, budget, slow);
          // every optional turn ends inside the budget; the welcome (essential) is said even when the pregame is tiny
          for (const s of starts) if (s.item.tag !== 'open.welcome') expect(s.end, `${seed} ${budget} ${slow} ${s.item.text}`).toBeLessThanOrEqual(budget + 0.01);
          expect(starts[0].item.tag).toBe('open.welcome');
        }
      }
    }
  });

  it('weather and the clock are flavour that never claims the wind moves the ball unless the sim has a wind', () => {
    const { f } = factsOf(11, 'day');
    const w = weatherFor(f);
    expect(w.realWind).toBe(false);
    expect(w.breeze).not.toMatch(/blowing (out|in)/);
    expect(weatherFor({ ...f, wind: { x: 0, z: 5 } }).breeze).toMatch(/blowing out/);
    expect(clockWords(19, 5)).toBe('seven-oh-five');
    expect(clockWords(13, 10)).toBe('one-ten');
    expect(clockWords(20, 0)).toBe("eight o'clock");
    expect(weatherFor(f)).toEqual(weatherFor(f));
  });

  it('the handoff names the leadoff man and the pitcher and tags the top of the first', () => {
    const { f } = factsOf(7);
    const h = handoffLine(f, 'Mason', 'Davis');
    expect(h).toMatch(/Mason/);
    expect(h).toMatch(/Davis/);
    expect(h).toMatch(/top of the first/);
  });
});

describe('director segments', () => {
  const seg = (n: number): Segment => ({ tag: 'test', turns: Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? 'color' : 'pxp', text: `Turn number ${i} of the segment, a medium length line.`, block: `b${i}`, optional: i > 0 })) });

  it('a MUST pre-empts a turn and the segment resumes after it', () => {
    const d = new Director({ rng: mulberry32(1), level: 'normal' });
    d.runSegment(seg(4), 0, 100);
    const log: Action[] = [];
    let t = 0;
    const run = (secs: number) => {
      for (const end = t + secs; t < end; t = Math.round((t + 0.05) * 1000) / 1000) log.push(...d.tick(t));
    };
    run(1.2);
    d.submit({ importance: 'must', speaker: 'pxp', text: 'Home run!', ttl: 60 }, t);
    run(40);
    const said = log.filter((a): a is StartAction => a.type === 'start').map((a) => a.item.text);
    expect(said).toContain('Home run!');
    expect(said.filter((s) => s.startsWith('Turn number')).length).toBeGreaterThanOrEqual(3);
    expect(said.indexOf('Home run!')).toBeLessThan(said.length - 1);
    expect(d.segmentActive).toBeNull();
  });

  it('skips optional blocks that would end after the deadline, and holds while the PA speaks', () => {
    const d = new Director({ rng: mulberry32(1), level: 'normal' });
    d.runSegment(seg(6), 0, 8);
    d.holdForField = true;
    const starts: StartAction[] = [];
    for (let t = 0; t < 3; t = Math.round((t + 0.05) * 1000) / 1000) for (const a of d.tick(t)) if (a.type === 'start') starts.push(a);
    expect(starts).toHaveLength(0);
    d.holdForField = false;
    for (let t = 3; t < 30; t = Math.round((t + 0.05) * 1000) / 1000) for (const a of d.tick(t)) if (a.type === 'start') starts.push(a);
    expect(starts[0].item.text).toContain('Turn number 0');
    expect(starts.length).toBeLessThan(6);
    expect(d.stats.segmentSkipped).toBeGreaterThan(0);
  });
});

describe('a segment across pause / mute', () => {
  const seg: Segment = { tag: 'open', turns: Array.from({ length: 5 }, (_, i) => ({ speaker: i % 2 ? 'color' : 'pxp', text: `Opening turn ${i}, a line of a few words.`, block: i ? `b${i}` : 'welcome', optional: i > 0 })) };
  const ctx = (remaining: number | null) => ({ ...ctxFromRaw(createGame({ seed: 1, pace: 0 }).getState()), lull: remaining === null ? null : { kind: 'break', sec: 80, remaining } });
  const run = (booth: Booth, from: number, to: number, suppressed: boolean, remaining: (t: number) => number | null) => {
    const said: string[] = [];
    for (let t = from; t < to; t = Math.round((t + 0.05) * 1000) / 1000) for (const a of booth.tick(t, ctx(remaining(t)) as never, { suppressed })) if (a.type === 'start') said.push(a.item.text);
    return said;
  };

  it('resumes with the turns that are left while the pregame lasts', () => {
    const booth = new Booth({ rng: mulberry32(2), level: 'normal' });
    booth.director.runSegment(seg, 0, 80);
    const a = run(booth, 0, 4, false, (t) => 80 - t);
    expect(a).toEqual(['Opening turn 0, a line of a few words.']);
    run(booth, 4, 10, true, (t) => 80 - t); // paused / muted / audio still locked
    expect(booth.director.parked).toBeTruthy();
    const b = run(booth, 10, 40, false, (t) => 80 - t);
    expect(b[0]).toMatch(/Opening turn [12]/);
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(booth.director.stats.segments).toBe(2);
  });

  it('is dropped when the pregame is over by the time the booth can talk again', () => {
    const booth = new Booth({ rng: mulberry32(2), level: 'normal' });
    booth.director.runSegment(seg, 0, 80);
    run(booth, 0, 2, false, () => 70);
    run(booth, 2, 5, true, () => 70);
    const b = run(booth, 5, 30, false, () => null);
    expect(b.filter((x) => x.startsWith('Opening'))).toHaveLength(0);
    expect(booth.director.parked).toBeNull();
  });
});

describe('the pregame through the booth (real sim, fake clock)', () => {
  it('opens before the first pitch, hands off at play ball, and says the top of the first once', () => {
    for (const [seed, tempo, tod] of [[7, 'broadcast', 'night'], [11, 'quick', 'day'], [23, 'standard', 'dusk']] as const) {
      const g: any = createGame({ seed, tempo });
      const booth = new Booth({ rng: mulberry32(seed), level: 'normal' });
      booth.setFacts(factsFromGame(g, String(seed), tod, false) as OpeningFacts, 9);
      const q: any[] = [];
      g.on('*', (e: any) => q.push(e));
      let t = 0;
      let first = -1;
      const said: { t: number; text: string; tag?: string }[] = [];
      while (first < 0 && t < 200) {
        g.step(0.05);
        t += 0.05;
        const c = ctxFromRaw(g.getState());
        for (const e of q.splice(0)) {
          if (e.type === 'pitchReleased' && first < 0) first = t;
          booth.observe(e, c, t);
        }
        for (const a of booth.tick(t, c, { suppressed: false })) if (a.type === 'start') said.push({ t, text: a.clauses.map((x) => x.text).join(' '), tag: a.item.tag });
      }
      expect(said[0].tag).toBe('open.welcome');
      expect(said.filter((s) => /top of the (first|1st)/i.test(s.text))).toHaveLength(1);
      const hand = said.find((s) => s.tag === 'open.handoff')!;
      expect(hand).toBeTruthy();
      expect(hand.t).toBeLessThan(first);
      for (const s of said.filter((x) => x.tag?.startsWith('open.') && x.tag !== 'open.handoff')) expect(s.t).toBeLessThan(hand.t);
      expect(said.some((s) => /Here we go|underway/.test(s.text) && s.tag === 'start')).toBe(false);
    }
  });
});

describe('stable voices per character (browser speech)', () => {
  it('each booth character keeps his own male-ish browser voice when the engine names none', async () => {
    const { BoothSink } = await import('../channels');
    const calls: { text: string; voice?: string }[] = [];
    const engine = {
      concurrent: true,
      voices: () => [{ name: 'Microsoft David', lang: 'en-US' }, { name: 'Microsoft Mark', lang: 'en-US' }, { name: 'Google UK English Male', lang: 'en-GB' }, { name: 'Microsoft Zira', lang: 'en-US' }],
      speak: (text: string, o: any) => {
        calls.push({ text, voice: o.voiceName });
        return { cancel() {} };
      },
      cancel() {},
      pause() {},
      resume() {},
    };
    const sink = new BoothSink(engine as any, { now: () => 0, voiceEnded: () => {}, volume: () => 1 });
    const act = (voice: 'pxp' | 'color', text: string) => ({ type: 'start' as const, voice, at: 0, est: 1, clauses: [{ text }], item: { id: text, importance: 'could' as const, speaker: voice, text, ttl: 5 } });
    sink.apply([act('pxp', 'One.'), act('color', 'Two.'), act('pxp', 'Three.'), act('color', 'Four.')]);
    const v = Object.fromEntries(calls.map((c) => [c.text, c.voice]));
    expect(v['One.']).toBe(v['Three.']);
    expect(v['Two.']).toBe(v['Four.']);
    expect(v['One.']).not.toBe(v['Two.']);
    expect(v['Two.']).not.toMatch(/Zira/);
  });
});
