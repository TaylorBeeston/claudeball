import { describe, expect, it } from 'vitest';
import { Excitement, baseline } from '../excitement';
import { SpeechQueue, pickVoices, type SpeechEngine } from '../speech';

describe('crowd excitement', () => {
  const calm = { inning: 2, outs: 0, balls: 0, strikes: 0, score: { home: 0, away: 6 }, runners: [false, false, false] as [boolean, boolean, boolean] };
  it('leverage rises late, in close games, with runners in scoring position and two strikes', () => {
    const tense = { inning: 9, outs: 2, balls: 3, strikes: 2, score: { home: 3, away: 3 }, runners: [true, true, true] as [boolean, boolean, boolean] };
    expect(baseline(tense)).toBeGreaterThan(baseline(calm) + 0.4);
    expect(baseline({ ...calm, runners: [false, true, false] })).toBeGreaterThan(baseline(calm));
    expect(baseline({ ...calm, strikes: 2 })).toBeGreaterThan(baseline(calm));
  });

  it('pulses lift the level quickly and it settles back slowly', () => {
    const e = new Excitement();
    e.setBaseline(0.25);
    for (let i = 0; i < 30; i++) e.update(0.1);
    const base = e.level;
    e.add(0.7, 4);
    for (let i = 0; i < 20; i++) e.update(0.1);
    const peak = e.level;
    expect(peak).toBeGreaterThan(base + 0.3);
    for (let i = 0; i < 300; i++) e.update(0.1);
    expect(e.level).toBeCloseTo(base, 1);
  });
});

function fakeSpeech(voices = [{ name: 'Daniel', lang: 'en-GB' }, { name: 'Samantha', lang: 'en-US' }]) {
  const spoken: { text: string; voiceName?: string; done: () => void }[] = [];
  let cancels = 0;
  const engine: SpeechEngine = {
    voices: () => voices,
    speak: (text, o) => { spoken.push({ text, voiceName: o.voiceName, done: o.onend }); },
    cancel: () => {
      cancels++;
    },
    pause: () => {},
    resume: () => {},
  };
  return { engine, spoken, cancels: () => cancels };
}

describe('speech queue', () => {
  it('speaks one line at a time, in priority order', () => {
    let t = 1000;
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => t);
    q.enqueue({ role: 'color', text: 'chatter', pri: 1, ttl: 20 });
    expect(f.spoken.map((s) => s.text)).toEqual(['chatter']);
    q.enqueue({ role: 'pbp', text: 'B', pri: 3, ttl: 20 });
    q.enqueue({ role: 'pa', text: 'A', pri: 4, ttl: 20 });
    expect(f.spoken).toHaveLength(1); // still speaking the first
    f.spoken[0].done();
    t += 200;
    q.pump();
    expect(f.spoken.map((s) => s.text)).toEqual(['chatter', 'A']);
    f.spoken[1].done();
    t += 200;
    q.pump();
    expect(f.spoken.map((s) => s.text)).toEqual(['chatter', 'A', 'B']);
  });

  it('drops stale lines instead of talking over the action', () => {
    let t = 0;
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => t);
    q.enqueue({ role: 'pbp', text: 'first', pri: 3, ttl: 5 });
    q.enqueue({ role: 'pbp', text: 'stale', pri: 3, ttl: 2 });
    t += 6000;
    f.spoken[0].done();
    q.pump();
    expect(f.spoken.map((s) => s.text)).toEqual(['first']);
    expect(q.stats.dropped).toBe(1);
  });

  it('a much more important line cuts off chatter, but never the umpire or the PA', () => {
    let t = 0;
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => t);
    q.enqueue({ role: 'color', text: 'long colour line', pri: 1, ttl: 20 });
    q.enqueue({ role: 'pbp', text: 'IT IS GONE', pri: 6, ttl: 20 });
    expect(f.cancels()).toBe(1);
    t += 100;
    q.pump();
    expect(f.spoken.map((s) => s.text)).toEqual(['long colour line', 'IT IS GONE']);
    q.enqueue({ role: 'pbp', text: 'later', pri: 8, ttl: 20 });
    // the current line is pbp pri 6: 8 >= 6+2 interrupts; but a PA line is protected
    const g = fakeSpeech();
    const q2 = new SpeechQueue(g.engine, () => t);
    q2.enqueue({ role: 'pa', text: 'Now batting', pri: 4, ttl: 20 });
    q2.enqueue({ role: 'pbp', text: 'big', pri: 6, ttl: 20 });
    expect(g.cancels()).toBe(0);
  });

  it('ignores disabled roles, drops duplicates, and is a silent no-op without speech or voices', () => {
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => 0);
    q.enabled.color = false;
    q.enqueue({ role: 'color', text: 'x', pri: 1, ttl: 5 });
    q.enqueue({ role: 'pbp', text: 'same', pri: 3, ttl: 5 });
    q.enqueue({ role: 'pbp', text: 'same', pri: 3, ttl: 5 });
    expect(f.spoken).toHaveLength(1);
    const none = new SpeechQueue(null, () => 0);
    expect(none.available()).toBe(false);
    expect(() => none.enqueue({ role: 'pa', text: 'hello', pri: 4, ttl: 5 })).not.toThrow();
    const noVoices = fakeSpeech([]);
    const q3 = new SpeechQueue(noVoices.engine, () => 0);
    q3.enqueue({ role: 'pa', text: 'hello', pri: 4, ttl: 5 });
    expect(noVoices.spoken).toHaveLength(0);
    expect(q3.available()).toBe(false);
  });

  it('clear() stops the current line and empties the queue', () => {
    const f = fakeSpeech();
    const q = new SpeechQueue(f.engine, () => 0);
    q.enqueue({ role: 'pbp', text: 'one', pri: 3, ttl: 5 });
    q.enqueue({ role: 'pbp', text: 'two', pri: 3, ttl: 5 });
    q.clear();
    expect(f.cancels()).toBe(1);
    expect(q.pending).toBe(0);
    expect(q.speaking).toBeNull();
  });

  it('picks distinct English voices, a female-ish one for colour', () => {
    const v = pickVoices([{ name: 'Google français', lang: 'fr-FR' }, { name: 'Microsoft David', lang: 'en-US' }, { name: 'Microsoft Zira', lang: 'en-US' }, { name: 'Alex', lang: 'en-US' }]);
    expect(v.pa).toBe('Microsoft David');
    expect(v.color).toBe('Microsoft Zira');
    expect(v.pbp).not.toBe(v.color);
    expect(pickVoices([])).toEqual({});
  });
});
