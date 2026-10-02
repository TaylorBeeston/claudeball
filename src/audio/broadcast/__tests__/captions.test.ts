import { describe, expect, it } from 'vitest';
import { SpeechGate } from '../gate';
import { estimateSpokenChars, type SpeechEvent } from '../../captions';
import type { SpeakHandle, SpeakOptions, SpeechEngine } from '../../speech';

interface Call {
  text: string;
  o: SpeakOptions;
  handle: SpeakHandle;
  spoken: number;
}

function engine(opts: { concurrent: boolean; emitsStart: boolean; exact?: boolean }) {
  const calls: Call[] = [];
  const e: SpeechEngine & { calls: Call[] } = {
    calls,
    concurrent: opts.concurrent,
    emitsStart: opts.emitsStart,
    voices: () => [{ name: 'v', lang: 'en' }],
    speak(text, o) {
      const c: Call = { text, o, spoken: 0, handle: { cancel: () => {}, cutAtClause: () => {}, ...(opts.exact ? { spokenChars: () => c.spoken } : {}) } };
      calls.push(c);
      return opts.concurrent ? c.handle : undefined;
    },
    cancel() {},
    pause() {},
    resume() {},
  };
  return e;
}
const opt = (role: SpeakOptions['role'], over: Partial<SpeakOptions> = {}): SpeakOptions => ({ role, pitch: 1, rate: 1, volume: 1, onend: () => {}, onerror: () => {}, ...over });
function setup(e: SpeechEngine) {
  const clock = { t: 1000 };
  const g = new SpeechGate(e, () => clock.t, () => clock.t);
  const ev: SpeechEvent[] = [];
  g.onSpeech((x) => ev.push(x));
  return { g, ev, clock };
}

describe('speech captions (speechStart / speechEnd from the gate)', () => {
  it('an engine that reports its start: the start event comes then, with the exact text, the channel and the audio clock', () => {
    const e = engine({ concurrent: true, emitsStart: true });
    const { g, ev, clock } = setup(e);
    g.view('booth').speak('Ground ball to short, one away.', opt('pbp', { shift: 1.06 }));
    expect(ev).toEqual([]); // synthesising: nothing is audible yet
    clock.t = 1400;
    e.calls[0].o.onstart!();
    expect(ev[0]).toMatchObject({ type: 'speechStart', id: 1, channel: 'booth', speaker: 'pbp', text: 'Ground ball to short, one away.', startMs: 1400, excited: true });
    expect((ev[0] as { expectedDurationMs: number }).expectedDurationMs).toBeGreaterThan(800);
    clock.t = 3600;
    e.calls[0].o.onend();
    expect(ev[1]).toEqual({ type: 'speechEnd', id: 1, endMs: 3600, reason: 'finished' });
  });

  it('an engine that does not report starts: the line starts when it is handed over', () => {
    const e = engine({ concurrent: true, emitsStart: false });
    const { g, ev } = setup(e);
    g.view('field').speak('Now batting, number 23.', opt('pa'));
    g.view('field').speak('Strike!', opt('ump'));
    expect(ev.map((x) => (x.type === 'speechStart' ? `${x.channel}/${x.speaker}` : x.type))).toEqual(['pa/pa', 'umpire/ump']);
  });

  it('a line that fails or is dropped before it sounds never produces a caption', () => {
    const e = engine({ concurrent: true, emitsStart: true });
    const { g, ev } = setup(e);
    g.view('booth').speak('Never heard.', opt('color'));
    e.calls[0].o.onerror();
    expect(ev).toEqual([]);
  });

  it('a one-line-at-a-time engine: the queued line is captioned only when it really starts, a stale one never', () => {
    const e = engine({ concurrent: false, emitsStart: true });
    const { g, ev, clock } = setup(e);
    g.view('field').speak('Now batting, number 23.', opt('pa'));
    g.view('booth').speak('He steps in.', opt('pbp', { maxWaitMs: 500 }));
    g.view('booth').speak('Fresh enough.', opt('color', { maxWaitMs: 60000 }));
    e.calls[0].o.onstart!();
    expect(ev).toHaveLength(1);
    clock.t += 2000;
    e.calls[0].o.onend(); // the PA ends: the first booth line waited 2 s > 500 ms: dropped silently, the next one starts
    expect(ev.filter((x) => x.type === 'speechStart').map((x) => (x as { text: string }).text)).toEqual(['Now batting, number 23.']);
    e.calls[1].o.onstart!();
    expect(ev.filter((x) => x.type === 'speechStart').map((x) => (x as { text: string }).text)).toEqual(['Now batting, number 23.', 'Fresh enough.']);
  });

  it('a cancelled line ends where it had got to (by the time, or exactly when the engine knows)', () => {
    const e = engine({ concurrent: true, emitsStart: true });
    const { g, ev, clock } = setup(e);
    const text = 'Deep drive to left field, back, back, and it is gone.';
    const h = g.view('booth').speak(text, opt('pbp')) as SpeakHandle;
    e.calls[0].o.onstart!();
    clock.t += (ev[0] as { expectedDurationMs: number }).expectedDurationMs / 2;
    h.cancel();
    const end = ev[1] as { reason: string; truncatedAt: number };
    expect(end.reason).toBe('cancelled');
    expect(end.truncatedAt).toBeGreaterThan(10);
    expect(end.truncatedAt).toBeLessThan(text.length - 10);
    expect(/\s|^/.test(text[end.truncatedAt] ?? ' ')).toBe(true); // at a word boundary

    const e2 = engine({ concurrent: true, emitsStart: true, exact: true });
    const s2 = setup(e2);
    const h2 = s2.g.view('booth').speak(text, opt('color')) as SpeakHandle;
    e2.calls[0].o.onstart!();
    e2.calls[0].spoken = 22;
    h2.cancel();
    expect(s2.ev[1]).toMatchObject({ reason: 'cancelled', truncatedAt: 22 });
  });

  it('a cut at a clause ends at the end of that clause; a line that was said whole has no truncatedAt', () => {
    const e = engine({ concurrent: true, emitsStart: true });
    const { g, ev, clock } = setup(e);
    const text = 'Ground ball to short, he fields it, throws to first, and he is out.';
    const h = g.view('booth').speak(text, opt('pbp')) as SpeakHandle;
    e.calls[0].o.onstart!();
    clock.t += 700;
    h.cutAtClause!();
    clock.t += 300;
    e.calls[0].o.onend();
    const end = ev[1] as { reason: string; truncatedAt?: number };
    expect(end.reason).toBe('cut');
    expect(end.truncatedAt).toBeDefined();
    expect(text.slice(0, end.truncatedAt)).toMatch(/[,.]$/);
    expect(end.truncatedAt!).toBeLessThan(text.length);

    const e2 = engine({ concurrent: true, emitsStart: false });
    const { g: g2, ev: ev2 } = setup(e2);
    (g2.view('booth').speak('Strike two.', opt('pbp')) as SpeakHandle).cutAtClause!(); // one clause: the cut comes at its end, everything was said
    e2.calls[0].o.onend();
    expect(ev2.map((x) => x.type)).toEqual(['speechStart', 'speechEnd']);
    expect(ev2[1]).toMatchObject({ reason: 'cut' });
    expect('truncatedAt' in ev2[1]).toBe(false);
  });

  it('speakingNow lists the lines that sound at the moment; a throwing listener does not break the speech', () => {
    const e = engine({ concurrent: true, emitsStart: false });
    const { g } = setup(e);
    g.onSpeech(() => {
      throw new Error('ui bug');
    });
    g.view('field').speak('Safe!', opt('ump'));
    expect(g.speakingNow().map((x) => x.text)).toEqual(['Safe!']);
    e.calls[0].o.onend();
    expect(g.speakingNow()).toEqual([]);
  });
});

describe('estimateSpokenChars', () => {
  it('by the fraction of the time, at a word boundary; at the clause end for a clause cut', () => {
    const t = 'one two three four five six seven eight';
    const n = estimateSpokenChars(t, 500, 1000);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(t.length);
    expect(estimateSpokenChars(t, 5000, 1000)).toBe(t.length);
    expect(estimateSpokenChars('Ground ball, to short, out.', 100, 3000, [600, 1300, 2000])).toBe('Ground ball,'.length);
  });
});
