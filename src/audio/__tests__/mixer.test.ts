import { describe, expect, it, vi } from 'vitest';
import { MAX_VOICES, Mixer, DEFAULT_SETTINGS } from '../mixer';
import { SFX_DEFS, renderSfx, renderCrowd } from '../synth';

/** Minimal AudioContext double: records nodes, connections, starts and disconnects. */
function fakeCtx(state: 'running' | 'suspended' = 'running') {
  const live = new Set<object>();
  const node = (extra: object = {}) => {
    const n: any = {
      connect: vi.fn(function (this: any, to: any) { return to; }),
      disconnect: vi.fn(() => live.delete(n)),
      ...extra,
    };
    live.add(n);
    return n;
  };
  const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const ctx: any = {
    state,
    sampleRate: 44100,
    currentTime: 1,
    destination: node(),
    resume: vi.fn(async () => { ctx.state = 'running'; }),
    close: vi.fn(async () => {}),
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createAnalyser: () => node({ fftSize: 2048, getFloatTimeDomainData: (a: Float32Array) => a.fill(0.1) }),
    createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param(), type: '' }),
    createConvolver: () => node({ buffer: null }),
    createDelay: () => node({ delayTime: param() }),
    createWaveShaper: () => node({ curve: null }),
    createChannelSplitter: () => node(),
    createStereoPanner: () => node({ pan: param() }),
    createBuffer: (ch: number, len: number, sr: number) => ({ numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: () => new Float32Array(len), copyToChannel: () => {} }),
    createBufferSource: () => {
      const s: any = node({ buffer: null, loop: false, playbackRate: param(), start: vi.fn(), stop: vi.fn(), onended: null });
      ctx.sources.push(s);
      return s;
    },
    sources: [] as any[],
  };
  return { ctx, live };
}

async function readyMixer() {
  const f = fakeCtx();
  const m = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
  expect(await m.unlock()).toBe(true);
  await new Promise<void>((res) => {
    const t = setInterval(() => m.ready && (clearInterval(t), res()), 5);
  });
  return { m, f };
}

describe('synth recipes', () => {
  it('render finite, non-silent, in-range audio for every sound', () => {
    for (const id of Object.keys(SFX_DEFS) as (keyof typeof SFX_DEFS)[]) {
      const d = SFX_DEFS[id];
      for (let b = 0; b < d.buckets; b++) {
        const r = renderSfx(id, b, 0);
        let peak = 0;
        for (const c of r.ch) for (const v of c) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(peak, `${id}/${b}`).toBeGreaterThan(0.01); // footsteps on grass are meant to be faint
        expect(peak, `${id}/${b}`).toBeLessThanOrEqual(0.98);
        expect(r.ch[0].length / r.sr, id).toBeLessThan(2.5);
      }
    }
  });

  it('is deterministic per variant', () => {
    expect(Array.from(renderSfx('bat_crack', 2, 1).ch[0].slice(0, 200))).toEqual(Array.from(renderSfx('bat_crack', 2, 1).ch[0].slice(0, 200)));
  });

  it('crowd one-shots are stereo and audible', () => {
    const r = renderCrowd('roar_med');
    expect(r.ch).toHaveLength(2);
    expect(Math.max(...r.ch[0].slice(20000, 30000).map(Math.abs))).toBeGreaterThan(0.1);
  });
});

describe('mixer', () => {
  it('is a silent no-op with no context or a suspended one', async () => {
    const m = new Mixer({ ...DEFAULT_SETTINGS }, () => { throw new Error('no audio'); });
    expect(await m.unlock()).toBe(false);
    expect(m.playSfx({ kind: 'sfx', id: 'bat_crack', imp: 2 })).toBe(false);
    expect(m.playCrowd('roar_big')).toBe(false);
    expect(m.level()).toEqual({ rms: 0, peak: 0 });
  });

  it('plays a cue, disconnects its nodes when it ends, and does not leak', async () => {
    const { m, f } = await readyMixer();
    const baseline = f.live.size;
    const n0 = f.ctx.sources.length;
    expect(m.playSfx({ kind: 'sfx', id: 'bat_crack', bucket: 2, pos: { x: 0, y: 1, z: 0 }, gain: 1, imp: 2 })).toBe(true);
    // one logical voice, heard by several mics: the same buffer and rate, each copy later by its extra flight time
    expect(m.voiceCount).toBe(1);
    const copies = f.ctx.sources.slice(n0);
    expect(copies.length).toBeGreaterThan(1);
    expect(new Set(copies.map((c: any) => c.buffer)).size).toBe(1);
    expect(new Set(copies.map((c: any) => c.playbackRate.value)).size).toBe(1);
    const starts = copies.map((c: any) => c.start.mock.calls[0][0]).sort((a: number, b: number) => a - b);
    expect(starts[0]).toBeCloseTo(f.ctx.currentTime, 6);
    expect(starts.at(-1)).toBeGreaterThan(starts[0]);
    copies[0].onended();
    expect(m.voiceCount).toBe(1);
    for (const c of copies.slice(1)) c.onended();
    // the nodes are released at once; the voice leaves the count when the audio clock passes its end
    f.ctx.currentTime = 10;
    expect(m.voiceCount).toBe(0);
    expect(f.live.size).toBe(baseline);
    expect(m.played.bat_crack).toBe(1);
  });

  it('caps concurrent voices and keeps important ones', async () => {
    const { m } = await readyMixer();
    let ok = 0;
    for (let i = 0; i < MAX_VOICES + 10; i++) if (m.playSfx({ kind: 'sfx', id: 'wall_thud', imp: 0 })) ok++;
    expect(m.voiceCount).toBeLessThanOrEqual(MAX_VOICES);
    expect(ok).toBe(MAX_VOICES);
    expect(m.droppedVoices).toBe(10);
    expect(m.playSfx({ kind: 'sfx', id: 'bat_crack', imp: 3 })).toBe(true); // steals a low-importance voice
    expect(m.voiceCount).toBeLessThanOrEqual(MAX_VOICES);
    expect(m.stolenVoices).toBe(1);
  });

  it('rate-limits rapid repeats of the same sound', async () => {
    const { m } = await readyMixer();
    expect(m.playSfx({ kind: 'sfx', id: 'footstep', imp: 0 })).toBe(true);
    expect(m.playSfx({ kind: 'sfx', id: 'footstep', imp: 0 })).toBe(false);
  });

  it('slow motion replay makes new effects slower and ducks the bus; mute zeroes the master', async () => {
    const { m, f } = await readyMixer();
    m.setMode({ replay: true });
    m.playSfx({ kind: 'sfx', id: 'bat_crack', imp: 2 });
    expect(f.ctx.sources.at(-1).playbackRate.value).toBeLessThan(0.7);
    m.settings.muted = true;
    m.applySettings();
    expect(m.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, expect.any(Number), expect.any(Number));
  });

  it('the park is mixed from fixed mics: no camera listener; venue, perspective and duck settings reach the graph; phones get the small array', async () => {
    const { m } = await readyMixer();
    expect('setListener' in m).toBe(false);
    expect(m.graph!.mics.length).toBe(16);
    m.settings.venue = 'big';
    m.settings.micPerspective = 'close';
    m.settings.duck = 'strong';
    m.applySettings();
    expect(m.graph!.venue).toBe('big');
    expect(m.graph!.perspective).toBe('close');
    expect(m.graph!.duck.depth).toBe(10);
    const f = fakeCtx();
    const low = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
    low.lowPower = true;
    await low.unlock();
    expect(low.graph!.mics.length).toBe(9);
  });

  it('a crowd shot plays in its zone (a couple of mics), a big roar in the whole bowl, the wave section by section', async () => {
    const { m, f } = await readyMixer();
    let n0 = f.ctx.sources.length;
    expect(m.playCrowdShot({ id: 'cheer_short', gain: 0.5, delay: 0, zone: 'line_1b' })).toBe(true);
    const zoneCopies = f.ctx.sources.length - n0;
    expect(zoneCopies).toBeGreaterThanOrEqual(1);
    expect(zoneCopies).toBeLessThanOrEqual(3);
    n0 = f.ctx.sources.length;
    expect(m.playCrowd('roar_big', 1)).toBe(true);
    expect(f.ctx.sources.length - n0).toBeGreaterThanOrEqual(2);
    n0 = f.ctx.sources.length;
    expect(m.playCrowd('whoop', 0.5, 0, { sweep: { from: -0.9, to: 0.9, dur: 6 } })).toBe(true);
    const wave = f.ctx.sources.slice(n0).map((x: any) => x.start.mock.calls[0][0]);
    expect(Math.max(...wave) - Math.min(...wave)).toBeGreaterThan(3); // goes round the bowl over seconds
  });
});

describe('start-up synthesis', () => {
  /** a Worker double that runs the real worker's job function, one message at a time, asynchronously */
  class FakeWorker {
    static made = 0;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private listeners: ((e: MessageEvent) => void)[] = [];
    private q = Promise.resolve();
    constructor() {
      FakeWorker.made++;
    }
    addEventListener(_t: string, f: (e: MessageEvent) => void) {
      this.listeners.push(f);
    }
    postMessage(m: { n: number; job: import('../synthJobs').SynthJob; sr: number }) {
      this.q = this.q.then(async () => {
        const { runJob } = await import('../synthJobs');
        const r = runJob(m.job, m.sr);
        const e = { data: { n: m.n, sr: r.sr, ch: r.ch } } as MessageEvent;
        this.onmessage?.(e);
        for (const f of this.listeners) f(e);
      });
    }
    terminate() {}
  }

  it('runs in a worker when there is one: every sound lands, the same set as on the main thread', async () => {
    const main = await readyMixer();
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const w = await readyMixer();
      expect(FakeWorker.made).toBeGreaterThan(0);
      expect(w.m.prepared).toBe(w.m.totalToPrepare);
      expect([...w.m.buffers.keys()].sort()).toEqual([...main.m.buffers.keys()].sort());
      for (const [k, v] of main.m.buffers) expect(w.m.buffers.get(k)!.map((b) => b.length)).toEqual(v.map((b) => b.length));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the phone IR is one channel of at most 1.6 s, the desktop IR stereo', async () => {
    const { irFor } = await import('../synthJobs');
    const phone = irFor('normal', 48000, true);
    const desk = irFor('normal', 48000, false);
    expect(phone.ch.length).toBe(1);
    expect(phone.ch[0].length).toBeLessThanOrEqual(1.6 * 48000);
    expect(desk.ch.length).toBe(2);
  });
});

describe('hidden page', () => {
  it('suspends a running context while hidden and resumes it when shown; a context that was not running stays as it was', async () => {
    const { m, f } = await readyMixer();
    f.ctx.suspend = vi.fn(async () => { f.ctx.state = 'suspended'; });
    await m.setHidden(true);
    expect(f.ctx.state).toBe('suspended');
    f.ctx.resume.mockClear();
    await m.setHidden(false);
    expect(f.ctx.resume).toHaveBeenCalledTimes(1);
    expect(f.ctx.state).toBe('running');
    // suspended by something else (locked, never unlocked): showing the page does not start it
    f.ctx.state = 'suspended';
    f.ctx.resume.mockClear();
    await m.setHidden(true);
    await m.setHidden(false);
    expect(f.ctx.resume).not.toHaveBeenCalled();
  });
});
