import { describe, expect, it, vi } from 'vitest';
import { SpeechGate } from '../gate';
import { BoothSink } from '../channels';
import { Director } from '../director';
import { SpeechQueue, type SpeakHandle, type SpeakOptions, type SpeechEngine } from '../../speech';
import { mulberry32 } from '../../dsp';

interface Call {
  text: string;
  o: SpeakOptions;
  startedAt: number;
  cancelled: boolean;
  cut: boolean;
}

/** an engine double: `concurrent` or not; lines end when the test calls end() */
function fakeEngine(concurrent: boolean, clock: { t: number }) {
  const calls: Call[] = [];
  let globalCancels = 0;
  const e: SpeechEngine & { calls: Call[]; global: () => number; end: (i: number) => void } = {
    calls,
    global: () => globalCancels,
    concurrent,
    voices: () => [{ name: 'v', lang: 'en' }],
    voiceFor: (r) => `voice-${r}`,
    speak(text, o) {
      const c: Call = { text, o, startedAt: clock.t, cancelled: false, cut: false };
      calls.push(c);
      if (!concurrent) return undefined;
      const h: SpeakHandle = { cancel: () => (c.cancelled = true), cutAtClause: () => (c.cut = true) };
      return h;
    },
    cancel() {
      globalCancels++;
      for (const c of calls) c.cancelled = true;
    },
    pause() {},
    resume() {},
    end(i: number) {
      calls[i].o.onend();
    },
  };
  return e;
}

describe('the speech gate', () => {
  it('concurrent engine: the PA and the booth run at the same time, each view cancels only its own lines', () => {
    const clock = { t: 0 };
    const eng = fakeEngine(true, clock);
    const gate = new SpeechGate(eng, () => clock.t);
    const field = gate.view('field');
    const booth = gate.view('booth');
    field.speak('Now batting, number 23, Tyler Vance.', { role: 'pa', pitch: 1, rate: 1, volume: 1, onend() {}, onerror() {} });
    booth.speak('Fastball, low and away.', { role: 'pbp', pitch: 1, rate: 1, volume: 1, onend() {}, onerror() {} });
    expect(eng.calls).toHaveLength(2); // both started at once: overlap
    expect(gate.busy).toEqual({ field: 1, booth: 1 });
    booth.cancel();
    expect(eng.calls[1].cancelled).toBe(true);
    expect(eng.calls[0].cancelled).toBe(false);
    expect(gate.busy).toEqual({ field: 1, booth: 0 });
    eng.end(0);
    expect(gate.busy.field).toBe(0);
  });

  it('single-line engine (browser voices): one line at a time, the field channel first, stale booth lines dropped', () => {
    const clock = { t: 0 };
    const eng = fakeEngine(false, clock);
    const gate = new SpeechGate(eng, () => clock.t);
    const field = gate.view('field');
    const booth = gate.view('booth');
    const errs: string[] = [];
    booth.speak('Called strike one.', { role: 'pbp', pitch: 1, rate: 1, volume: 1, maxWaitMs: 1500, onend() {}, onerror: () => errs.push('b1') });
    booth.speak('A stale call.', { role: 'pbp', pitch: 1, rate: 1, volume: 1, maxWaitMs: 1000, onend() {}, onerror: () => errs.push('stale') });
    field.speak('Now batting.', { role: 'pa', pitch: 1, rate: 1, volume: 1, onend() {}, onerror() {} });
    expect(eng.calls.map((c) => c.text)).toEqual(['Called strike one.']); // one at a time
    clock.t = 2000;
    eng.end(0); // the first booth line ends; the PA goes before the other waiting booth line
    expect(eng.calls.map((c) => c.text)).toEqual(['Called strike one.', 'Now batting.']);
    clock.t = 2500;
    eng.end(1);
    expect(eng.calls).toHaveLength(2); // the stale booth line was dropped, not spoken
    expect(errs).toContain('stale');
    expect(gate.stats.dropped).toBe(1);
  });

  it('single-line engine: cancelling the booth view does not cut the PA that is speaking', () => {
    const clock = { t: 0 };
    const eng = fakeEngine(false, clock);
    const gate = new SpeechGate(eng, () => clock.t);
    gate.view('field').speak('Now batting.', { role: 'pa', pitch: 1, rate: 1, volume: 1, onend() {}, onerror() {} });
    gate.view('booth').speak('Strike one.', { role: 'pbp', pitch: 1, rate: 1, volume: 1, onend() {}, onerror() {} });
    gate.view('booth').cancel();
    expect(eng.global()).toBe(0);
    expect(eng.calls[0].cancelled).toBe(false);
  });
});

describe('the booth sink', () => {
  it('speaks director starts with per-voice delivery; excited lines are faster and higher; the end is reported', () => {
    const clock = { t: 0 };
    const eng = fakeEngine(true, clock);
    const gate = new SpeechGate(eng, () => clock.t);
    const ended: [string, number][] = [];
    const sink = new BoothSink(gate.view('booth'), { now: () => clock.t / 1000, voiceEnded: (v, t) => ended.push([v, t]), volume: () => 0.8 });
    const d = new Director({ rng: mulberry32(1) });
    d.submit({ importance: 'must', speaker: 'pxp', text: 'Deep drive... gone! Home run!', excited: true, ttl: 60 }, 0);
    d.submit({ importance: 'could', speaker: 'color', text: 'Wow!', interject: true, ttl: 5 }, 0);
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t += 0.05;
      clock.t = t * 1000;
      sink.apply(d.tick(t));
    }
    const hr = eng.calls.find((c) => c.text.includes('Home run'))!;
    expect(hr.o.role).toBe('pbp');
    expect(hr.o.voiceName).toBe('voice-pbp');
    expect(hr.o.rate).toBeGreaterThan(1.1);
    expect(hr.o.pitch).toBeGreaterThan(1.05);
    expect(hr.o.shift).toBeGreaterThan(1);
    expect(hr.o.volume).toBeLessThanOrEqual(0.8);
    const normal = fakeEngine(true, clock);
    const s2 = new BoothSink(normal, { now: () => 0, voiceEnded() {}, volume: () => 1 });
    s2.apply([{ type: 'start', voice: 'color', at: 0, est: 2, item: { id: 'x', importance: 'could', speaker: 'color', text: 'A calm remark.', ttl: 9 }, clauses: [{ text: 'A calm remark.' }] }]);
    expect(normal.calls[0].o.rate).toBeLessThanOrEqual(1.04);
    expect(normal.calls[0].o.shift).toBe(1);
    // the engine reports the real end: the director's voice is freed
    const k = eng.calls.indexOf(hr);
    eng.end(k);
    expect(ended.some(([v]) => v === 'pxp')).toBe(true);
  });

  it('cuts a running line at the next clause through the handle, and with a plain cancel on handle-less engines', () => {
    const clock = { t: 0 };
    const eng = fakeEngine(true, clock);
    const timers: (() => void)[] = [];
    const ended: string[] = [];
    const sink = new BoothSink(eng, { now: () => clock.t / 1000, voiceEnded: (v) => ended.push(v), volume: () => 1, setTimer: (fn) => (timers.push(fn), timers.length) });
    const start = (voice: 'pxp' | 'color') => ({ type: 'start' as const, voice, at: 0, est: 6, item: { id: voice, importance: 'could' as const, speaker: voice, text: 'A long line, with clauses, going on.', ttl: 9 }, clauses: [{ text: 'A long line, with clauses, going on.' }] });
    sink.apply([start('color')]);
    sink.apply([{ type: 'cut', voice: 'color', at: 1.2, reason: 'must' }]);
    expect(eng.calls[0].cut).toBe(false); // scheduled for the clause boundary, not now
    timers[0]();
    expect(eng.calls[0].cut).toBe(true);
    expect(eng.calls[0].cancelled).toBe(false); // not mid-word
    expect(ended).toEqual(['color']);
    // handle-less (browser) engine: a global cancel of this (single-line) engine
    const br = fakeEngine(false, clock);
    const s2 = new BoothSink(br, { now: () => 0, voiceEnded: () => {}, volume: () => 1 });
    s2.apply([start('pxp')]);
    s2.apply([{ type: 'cut', voice: 'pxp', at: 0, reason: 'must' }]);
    expect(br.global()).toBe(1);
  });
});

describe('PA over the booth, end to end (concurrent engine)', () => {
  it('the PA announces while the booth keeps talking: their start times overlap', () => {
    const clock = { t: 0 };
    const eng = fakeEngine(true, clock);
    const gate = new SpeechGate(eng, () => clock.t);
    const q = new SpeechQueue(gate.view('field'), () => clock.t);
    const sink = new BoothSink(gate.view('booth'), { now: () => clock.t / 1000, voiceEnded() {}, volume: () => 1 });
    const d = new Director({ rng: mulberry32(2) });
    d.submit({ importance: 'must', speaker: 'pxp', text: 'Base hit to right field, and the runner will hold at first, a long call to keep the voice busy.', ttl: 60 }, 0);
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 0.05;
      clock.t = t * 1000;
      sink.apply(d.tick(t));
      if (i === 40) q.enqueue({ role: 'pa', text: 'Now batting, number 23, Tyler Vance.', pri: 4, ttl: 10 });
    }
    const booth = eng.calls.find((c) => c.o.role === 'pbp')!;
    const pa = eng.calls.find((c) => c.o.role === 'pa')!;
    expect(booth && pa).toBeTruthy();
    expect(pa.startedAt).toBeGreaterThan(booth.startedAt);
    expect(booth.cancelled).toBe(false); // the booth was not cut or silenced by the PA
    expect(gate.busy.booth).toBe(1);
    expect(gate.busy.field).toBe(1);
  });
});
