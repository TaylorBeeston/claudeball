import { describe, expect, it, vi } from 'vitest';
import { HD_VOICES, NeuralSpeechEngine, type Synth } from '../neural';
import { SpeechQueue, SwitchEngine, type SpeechEngine } from '../speech';
import { DEFAULT_SETTINGS, Mixer } from '../mixer';

function fakeCtx() {
  const made: { type: string; node: any }[] = [];
  const node = (type: string, extra: object = {}) => {
    const n: any = { connect: vi.fn((to: any) => to), disconnect: vi.fn(), ...extra };
    made.push({ type, node: n });
    return n;
  };
  const param = (v = 0) => ({ value: v, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const ctx: any = {
    state: 'running', sampleRate: 48000, currentTime: 1, destination: node('dest'),
    resume: async () => {}, close: async () => {},
    createGain: () => node('gain', { gain: param(1) }),
    createDynamicsCompressor: () => node('comp', { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createAnalyser: () => node('analyser', { fftSize: 2048 }),
    createBiquadFilter: () => node('biquad', { frequency: param(), Q: param(), gain: param(), type: '' }),
    createConvolver: () => node('conv', { buffer: null }),
    createStereoPanner: () => node('pan', { pan: param() }),
    createDelay: () => node('delay', { delayTime: param() }),
    createWaveShaper: () => node('shaper', { curve: null }),
    createBuffer: (c: number, len: number, sr: number) => ({ length: len, sampleRate: sr, numberOfChannels: c, getChannelData: () => new Float32Array(len), copyToChannel: vi.fn() }),
    createBufferSource: () => node('source', { buffer: null, playbackRate: param(1), start: vi.fn(), stop: vi.fn(), onended: null }),
  };
  return { ctx, made };
}

function fakeSynth(opts: { fail?: boolean; delayMs?: number } = {}) {
  const calls: { text: string; voice: string; speed: number }[] = [];
  const synth: Synth = {
    init: vi.fn(async () => {}),
    generate: vi.fn(async (text: string, voice: string, speed: number) => {
      calls.push({ text, voice, speed });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error('boom');
      return { samples: new Float32Array(24000 * 2), sr: 24000 };
    }),
    dispose: vi.fn(),
  };
  return { synth, calls };
}

function fakeBrowser() {
  const spoken: string[] = [];
  const e: SpeechEngine & { spoken: string[]; cancels: number } = {
    spoken, cancels: 0,
    voices: () => [{ name: 'Browser', lang: 'en-US' }],
    speak: (t, o) => { spoken.push(t); o.onend(); },
    cancel() { e.cancels++; }, pause() {}, resume() {},
  };
  return e;
}

async function setup(synthOpts = {}, mode: 'gpu' | 'cpu' = 'gpu') {
  const f = fakeCtx();
  const mixer = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
  await mixer.unlock();
  const s = fakeSynth(synthOpts);
  const browser = fakeBrowser();
  const eng = new NeuralSpeechEngine(s.synth, mixer, browser, mode);
  await eng.init(mode, () => {});
  return { f, mixer, eng, s, browser };
}
const opts = (role: 'pa' | 'pbp' | 'color' | 'ump', onend = vi.fn(), onerror = vi.fn()) => ({ role, voiceName: HD_VOICES[role], pitch: 1, rate: 1, volume: 0.8, onend, onerror });
const flush = () => new Promise((r) => setTimeout(r, 5));

describe('neural speech engine (mocked synthesiser)', () => {
  it('offers no voices until the model is loaded, then four distinct preset voices (two different male booth voices)', async () => {
    const f = fakeCtx();
    const mixer = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
    const eng = new NeuralSpeechEngine(fakeSynth().synth, mixer, null);
    expect(eng.voices()).toEqual([]);
    await eng.init('cpu', () => {});
    expect(eng.voices().map((v) => v.name).sort()).toEqual(Object.values(HD_VOICES).sort());
    expect(new Set(Object.values(HD_VOICES)).size).toBe(4);
    expect(HD_VOICES.pbp).not.toBe(HD_VOICES.color);
    expect(eng.voiceFor('pa')).toBe(HD_VOICES.pa);
  });

  it('prefetch + speak generate once; playback starts after generation and onend fires when the audio ends', async () => {
    const { eng, s, f } = await setup();
    const o = opts('pbp');
    eng.prefetch('Fastball, 94, low and away.', o);
    eng.speak('Fastball, 94, low and away.', o);
    await flush();
    expect(s.calls).toHaveLength(1);
    const src = f.made.filter((m) => m.type === 'source').at(-1)!.node;
    expect(src.start).toHaveBeenCalled();
    expect(o.onend).not.toHaveBeenCalled();
    src.onended();
    expect(o.onend).toHaveBeenCalledTimes(1);
    expect(eng.stats.played).toBe(1);
  });

  it('the PA voice gets band-limiting, drive, a slap-back delay and the stadium reverb send; booth voices stay dry', async () => {
    const pa = await setup();
    pa.eng.speak('Now batting, number 23, Tyler Vance.', opts('pa'));
    await flush();
    const types = (m: { f: { made: { type: string }[] } }) => m.f.made.map((x) => x.type);
    expect(types(pa)).toContain('delay');
    expect(types(pa)).toContain('shaper');
    expect(pa.f.made.filter((m) => m.type === 'biquad' && ['highpass', 'lowpass'].includes(m.node.type)).length).toBeGreaterThanOrEqual(2);
    const reverbIn = pa.mixer.reverbIn as any;
    expect(pa.f.made.some((m) => m.node.connect.mock?.calls.some((c: any[]) => c[0] === reverbIn))).toBe(true);
    const booth = await setup();
    const before = booth.f.made.filter((m) => m.type === 'delay').length;
    booth.eng.speak('Called strike one.', opts('pbp'));
    await flush();
    expect(booth.f.made.filter((m) => m.type === 'delay').length).toBe(before);
  });

  it('falls back to the browser voice when generation fails, and counts it', async () => {
    const { eng, browser } = await setup({ fail: true });
    const o = opts('color');
    eng.speak('That is a close play.', o);
    await flush();
    expect(browser.spoken).toEqual(['That is a close play.']);
    expect(eng.stats.failures).toBe(1);
    expect(eng.stats.fallbacks).toBe(1);
  });

  it('with no AudioContext at all it falls back immediately', async () => {
    const mixer = new Mixer({ ...DEFAULT_SETTINGS }, () => { throw new Error('none'); });
    const browser = fakeBrowser();
    const eng = new NeuralSpeechEngine(fakeSynth().synth, mixer, browser);
    await eng.init('cpu', () => {});
    eng.speak('hello', opts('pbp'));
    await flush();
    expect(browser.spoken).toEqual(['hello']);
  });

  it('short umpire calls use the browser voice when the CPU model is slower than real time', async () => {
    const { eng, browser, s } = await setup({}, 'cpu');
    expect(eng.rtf).toBeGreaterThan(1);
    eng.speak('Strike!', opts('ump'));
    await flush();
    expect(browser.spoken).toEqual(['Strike!']);
    expect(s.calls).toHaveLength(0);
  });

  it('reports a backlog while lines are being generated and the queue sheds chatter but keeps the PA', async () => {
    const { eng } = await setup({ delayMs: 50 }, 'cpu');
    for (let i = 0; i < 4; i++) eng.prefetch(`A fairly long line of commentary number ${i} about the pitch and the count here.`, opts('color'));
    expect(eng.busyMs()).toBeGreaterThan(7000);
    const spoken: string[] = [];
    const engine: SpeechEngine = { ...eng, voices: () => eng.voices(), speak: (t, o) => { spoken.push(t); o.onend(); }, cancel() {}, pause() {}, resume() {}, busyMs: () => eng.busyMs(), voiceFor: (r) => eng.voiceFor(r) };
    const q = new SpeechQueue(engine, () => 0);
    q.enqueue({ role: 'color', text: 'filler', pri: 1, ttl: 10 });
    q.enqueue({ role: 'pbp', text: 'chatter', pri: 2, ttl: 10 });
    q.enqueue({ role: 'pa', text: 'Now batting', pri: 4, ttl: 10 });
    expect(spoken).toEqual(['Now batting']);
    expect(q.stats.dropped).toBe(2);
  });

  it('cancel stops the playing line; pause freezes it and resume continues (at the shifted rate)', async () => {
    const { eng, f } = await setup();
    const o = opts('pbp');
    eng.speak('A line.', o);
    await flush();
    const src = f.made.filter((m) => m.type === 'source').at(-1)!.node;
    eng.pause();
    expect(src.playbackRate.value).toBe(0);
    eng.resume();
    expect(src.playbackRate.value).toBe(1);
    eng.cancel();
    expect(src.stop).toHaveBeenCalled();
    expect(o.onend).not.toHaveBeenCalled();
  });

  it('keeps only a few generated lines in memory', async () => {
    const { eng, s } = await setup();
    for (let i = 0; i < 70; i++) eng.prefetch(`line ${i}`, opts('pbp'));
    await flush();
    await flush();
    expect(s.calls).toHaveLength(70);
    eng.prefetch('line 69', opts('pbp'));
    eng.prefetch('line 0', opts('pbp'));
    await flush();
    await flush();
    expect(s.calls).toHaveLength(71); // line 0 was evicted, line 69 was still cached
  });
});

describe('switching between browser and neural voices', () => {
  it('uses the browser until the neural engine is ready, then the neural one; cancel reaches both', async () => {
    const browser = fakeBrowser();
    const sw = new SwitchEngine(browser);
    const { eng } = await setup();
    const notReady = new NeuralSpeechEngine(fakeSynth().synth, new Mixer({ ...DEFAULT_SETTINGS }, () => fakeCtx().ctx), null);
    sw.neural = notReady;
    expect(sw.usingNeural).toBe(false);
    expect(sw.voices()[0].name).toBe('Browser');
    sw.speak('hi', { role: 'pbp', pitch: 1, rate: 1, volume: 1, onend() {}, onerror() {} });
    expect(browser.spoken).toEqual(['hi']);
    sw.neural = eng;
    expect(sw.usingNeural).toBe(true);
    expect(sw.voiceFor('color')).toBe(HD_VOICES.color);
    sw.cancel();
    expect(browser.cancels).toBe(1);
    sw.neural = null;
    expect(sw.voiceFor('color')).toBeUndefined();
  });

  it('the queue asks the engine to prefetch the line that will be spoken next', () => {
    const prefetched: string[] = [];
    let t = 1000;
    const engine: SpeechEngine = { voices: () => [{ name: 'x', lang: 'en' }], speak() {}, cancel() {}, pause() {}, resume() {}, prefetch: (text) => prefetched.push(text) };
    const q = new SpeechQueue(engine, () => t);
    q.enqueue({ role: 'pbp', text: 'speaking now', pri: 3, ttl: 20 });
    q.enqueue({ role: 'color', text: 'low priority', pri: 1, ttl: 20 });
    q.enqueue({ role: 'pbp', text: 'next up', pri: 3, ttl: 20 });
    expect(prefetched).toContain('next up');
    expect(prefetched[prefetched.length - 1]).toBe('next up');
  });
});

describe('concurrent channels (PA over booth), clauses, priorities', () => {
  const sourcesOf = (f: ReturnType<typeof fakeCtx>) => f.made.filter((m) => m.type === 'source').map((m) => m.node);

  it('plays several lines at once and cancels only its own line through the handle', async () => {
    const { eng, f } = await setup();
    expect(eng.concurrent).toBe(true);
    const pa = opts('pa');
    const booth = opts('pbp');
    const h1 = eng.speak('Now batting, number 23, Tyler Vance.', pa) as { cancel(): void };
    const h2 = eng.speak('Fastball, low and away.', booth) as { cancel(): void };
    await flush();
    await flush();
    const srcs = sourcesOf(f);
    expect(srcs.length).toBe(2);
    expect(srcs.every((s) => s.start.mock.calls.length === 1)).toBe(true);
    h2.cancel();
    expect(srcs.filter((s) => s.stop.mock.calls.length > 0)).toHaveLength(1);
    expect(pa.onend).not.toHaveBeenCalled();
    srcs[0].onended?.();
    expect(pa.onend).toHaveBeenCalledTimes(1);
    void h1;
  });

  it('routes the PA and the umpire to the PA bus and the booth to the booth bus', async () => {
    const { eng, f, mixer } = await setup();
    const into = (bus: object) => f.made.filter((m) => m.node.connect.mock?.calls.some((c: unknown[]) => c[0] === bus)).length;
    const before = { pa: into(mixer.paBus), booth: into(mixer.boothBus) };
    eng.speak('Now batting.', opts('pa'));
    await flush();
    expect(into(mixer.paBus)).toBeGreaterThan(before.pa);
    expect(into(mixer.boothBus)).toBe(before.booth);
    eng.speak('Strike!', opts('ump'));
    await flush();
    const afterUmp = into(mixer.paBus);
    expect(afterUmp).toBeGreaterThan(before.pa + 1);
    eng.speak('Called strike one.', opts('color'));
    await flush();
    expect(into(mixer.boothBus)).toBeGreaterThan(before.booth);
    expect(into(mixer.paBus)).toBe(afterUmp);
  });

  it('booth lines are synthesised clause by clause and played in order; the first clause starts as soon as it is ready', async () => {
    const { eng, s, f } = await setup();
    const o = opts('pbp');
    eng.speak('Ground ball to short, he throws... in time! One away.', o);
    await flush();
    await flush();
    expect(s.calls.map((c) => c.text)).toEqual(['Ground ball to short, he throws...', 'in time!', 'One away.'].length === 3 ? s.calls.map((c) => c.text) : []);
    expect(s.calls.length).toBeGreaterThanOrEqual(2);
    const src = sourcesOf(f);
    expect(src).toHaveLength(1); // only the first clause is playing
    src[0].onended();
    await flush();
    expect(sourcesOf(f)).toHaveLength(2);
    expect(o.onend).not.toHaveBeenCalled();
  });

  it('cutAtClause lets the current clause finish and then ends the line', async () => {
    const { eng, f } = await setup();
    const o = opts('color');
    const h = eng.speak('First clause here, and a second clause there, then a third one.', o) as { cutAtClause(): void };
    await flush();
    await flush();
    const first = sourcesOf(f)[0];
    h.cutAtClause();
    expect(first.stop).not.toHaveBeenCalled(); // not mid-word
    first.onended();
    await flush();
    expect(sourcesOf(f)).toHaveLength(1); // no second clause
    expect(o.onend).toHaveBeenCalledTimes(1);
  });

  it('a spoken line is generated before background warm-up, one job at a time', async () => {
    const f = fakeCtx();
    const mixer = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
    await mixer.unlock();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const synth: Synth = {
      init: async () => {},
      generate: async (text) => {
        order.push(text);
        if (n++ === 0) await gate; // hold the first job so the others queue up behind it
        return { samples: new Float32Array(2400), sr: 24000 };
      },
      dispose() {},
    };
    const eng = new NeuralSpeechEngine(synth, mixer, null, 'gpu');
    await eng.init('gpu', () => {});
    eng.warm(['warm one', 'warm two'], 'ump'); // the first of these is in flight
    eng.warm(['warm three'], 'ump');
    eng.speak('Fastball.', opts('pbp'));
    release();
    await flush();
    await flush();
    await flush();
    expect(order[0]).toBe('warm one');
    expect(order[1]).toBe('Fastball.'); // jumped ahead of the other warm-up phrases
  });

  it('excited delivery: the line is generated slower by the pitch shift and played back at the shift, so the tempo stays', async () => {
    const { eng, s, f } = await setup();
    const o = { ...opts('pbp'), rate: 1.12, shift: 1.06 };
    eng.speak('Gone! Home run!', o);
    await flush();
    await flush();
    expect(s.calls[0].speed).toBeCloseTo(1.12 / 1.06, 2);
    const src = sourcesOf(f).at(-1)!;
    expect(src.playbackRate.value).toBeCloseTo(1.06, 5);
  });
});
