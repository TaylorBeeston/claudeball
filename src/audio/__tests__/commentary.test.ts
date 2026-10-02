import { describe, expect, it } from 'vitest';
import { basesText, lastName, locationWords, ord, pitchName } from '../commentary';
import { SpeechQueue, type SpeechEngine } from '../speech';

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

describe('helpers', () => {
  it('names and words', () => {
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
