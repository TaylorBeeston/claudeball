import { describe, expect, it, vi } from 'vitest';
import { CustomVoiceController, type EngineLike } from '../voice/controller';
import { chooseStyle, loadPackFromUrl, manifestUrlOf, parseManifest, speakerFor, type LoadedPack, type VoiceManifest } from '../voice/pack';
import { PackSynth, type WorkerLike } from '../voice/packSynth';
import { MissingWordsError, SynthCore, type OrtLike, type SessionLike } from '../voice/synthCore';
import { HD_VOICES } from '../neural';

const manifest = (over: Partial<VoiceManifest> = {}): VoiceManifest => ({
  format: 1, name: 'Test', sampleRate: 22050,
  models: { fp32: { file: 'model.onnx', bytes: 10 }, int8: { file: 'model.int8.onnx', bytes: 4 } }, default: 'int8',
  speakers: { playbyplay: 0, hype: 1, color: 2 },
  styleSpeaker: { calm: 'playbyplay', building: 'playbyplay', crisp: 'playbyplay', deflated: 'playbyplay', excited: 'hype', peak: 'hype', deadpan: 'color' },
  scales: { noise: 0.667, length: 1, noiseW: 0.8 },
  phonemeIdMap: { _: [0], '^': [1], $: [2], ' ': [3], ',': [4], '.': [5], '!': [6] },
  lexicon: { strike: [10, 11], one: [12], it: [13], is: [14], gone: [15, 16], forty: [17], four: [18] },
  ...over,
});

describe('manifest', () => {
  it('accepts a good one and rejects broken ones with readable messages', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(manifest()))).name).toBe('Test');
    expect(() => parseManifest(null)).toThrow(/not a JSON object/);
    expect(() => parseManifest({ ...manifest(), format: 2 })).toThrow(/format 2/);
    expect(() => parseManifest({ ...manifest(), default: 'fp16' })).toThrow(/default/);
    expect(() => parseManifest({ ...manifest(), lexicon: {} })).toThrow(/lexicon/);
    expect(() => parseManifest({ ...manifest(), phonemeIdMap: { _: [0] } })).toThrow(/phonemeIdMap/);
  });
  it('resolves pack URLs', () => {
    expect(manifestUrlOf('https://huggingface.co/u/r/resolve/main')).toBe('https://huggingface.co/u/r/resolve/main/voice.json');
    expect(manifestUrlOf('https://x.test/a/voice.json')).toBe('https://x.test/a/voice.json');
  });
});

describe('delivery by situation', () => {
  it('PA and umpire are crisp, colour is deadpan, the play-by-play man follows the crowd and the line', () => {
    expect(chooseStyle('pa', 'Now batting, number seven.', 0.9)).toBe('crisp');
    expect(chooseStyle('ump', 'Strike!', 0.9)).toBe('crisp');
    expect(chooseStyle('color', 'He is hitting two forty-one.', 0.9)).toBe('deadpan');
    expect(chooseStyle('pbp', 'Pitch, low and away.', 0.1)).toBe('calm');
    expect(chooseStyle('pbp', 'Two on, two out.', 0.4)).toBe('building');
    expect(chooseStyle('pbp', 'Smacked down the line!', 0.2)).toBe('excited');
    expect(chooseStyle('pbp', "Mike Smith swings, and it's outta here! 412 feet!", 0.3)).toBe('peak');
    expect(chooseStyle('pbp', 'He leaves them stranded.', 0.2)).toBe('deflated');
  });
  it('maps styles to the pack speakers, and to nothing for a single-voice pack', () => {
    const m = manifest();
    expect(speakerFor(m, 'peak')).toBe(1);
    expect(speakerFor(m, 'deadpan')).toBe(2);
    expect(speakerFor(m, 'calm')).toBe(0);
    expect(speakerFor(manifest({ speakers: null, styleSpeaker: null }), 'peak')).toBeUndefined();
  });
});

function mockOrt(withSid = true) {
  const runs: Record<string, any>[] = [];
  const ort: OrtLike = { Tensor: class { constructor(public type: string, public data: any, public dims: readonly number[]) {} } as any };
  const session: SessionLike = {
    inputNames: withSid ? ['input', 'input_lengths', 'scales', 'sid'] : ['input', 'input_lengths', 'scales'],
    async run(feeds) {
      runs.push(feeds);
      return { output: { data: new Float32Array(2205).fill(0.5), dims: [1, 1, 2205] } };
    },
  };
  return { ort, session, runs };
}

describe('synthesis core', () => {
  it('normalises, phonemizes per sentence and runs the model with the style speaker', async () => {
    const { ort, session, runs } = mockOrt();
    const core = new SynthCore(ort, session, manifest());
    const r = await core.synth('Strike one! It is gone!', 'peak');
    expect(r.sr).toBe(22050);
    expect(runs.length).toBe(2); // two sentences
    expect((runs[0].sid as any).data[0]).toBe(1n); // hype speaker
    expect((runs[0].scales as any).data[0]).toBeCloseTo(0.667);
    expect(Array.from((runs[0].input as any).data.slice(0, 2))).toEqual([1n, 0n]);
    expect(r.samples.length).toBe(2205 * 2 + Math.round(0.16 * 22050)); // two sentences + the gap
    expect(Math.max(...r.samples)).toBeLessThanOrEqual(0.97 + 1e-6);
  });
  it('speaks numbers as the game wrote them', async () => {
    const { ort, session, runs } = mockOrt();
    await new SynthCore(ort, session, manifest()).synth('Strike 4.', 'calm');
    expect(runs.length).toBe(1);
  });
  it('omits sid for a single-voice model', async () => {
    const { ort, session, runs } = mockOrt(false);
    await new SynthCore(ort, session, manifest({ speakers: null, styleSpeaker: null })).synth('Strike one.', 'calm');
    expect('sid' in runs[0]).toBe(false);
  });
  it('refuses lines with words that have no pronunciation (the caller falls back to the browser voice)', async () => {
    const { ort, session } = mockOrt();
    await expect(new SynthCore(ort, session, manifest()).synth('Strike Fuentes.', 'calm')).rejects.toBeInstanceOf(MissingWordsError);
  });
});

function fakeWorker(reply: (m: any) => any) {
  const w: WorkerLike & { sent: any[] } = {
    sent: [], onmessage: null, onerror: null, terminate: vi.fn(),
    postMessage(m: any) {
      this.sent.push(m);
      queueMicrotask(() => this.onmessage?.({ data: reply(m) } as MessageEvent));
    },
  };
  return w;
}

describe('PackSynth', () => {
  const pack = (): LoadedPack => ({ manifest: manifest(), model: new ArrayBuffer(8), source: { kind: 'files', names: [] } });
  it('picks the delivery from the role behind the HD voice name and the crowd, and passes it to the worker', async () => {
    const w = fakeWorker((m) => (m.type === 'init' ? { type: 'ready' } : { type: 'audio', id: m.id, samples: new Float32Array(100), sr: 22050 }));
    let crowd = 0.6;
    const s = new PackSynth(pack(), () => crowd, () => w);
    await s.init('gpu', () => {});
    await s.generate('Smacked down the line!', HD_VOICES.pbp, 1);
    await s.generate('Now batting, number seven.', HD_VOICES.pa, 1);
    crowd = 0.05;
    await s.generate('Two outs.', HD_VOICES.pbp, 1);
    expect(w.sent.filter((m) => m.type === 'gen').map((m) => m.style)).toEqual(['excited', 'crisp', 'calm']);
  });
  it('surfaces worker errors so the engine falls back', async () => {
    const w = fakeWorker((m) => (m.type === 'init' ? { type: 'ready' } : { type: 'audio', id: m.id, error: 'no pronunciation' }));
    const s = new PackSynth(pack(), () => 0, () => w);
    await s.init('gpu', () => {});
    await expect(s.generate('x', HD_VOICES.pbp, 1)).rejects.toThrow('no pronunciation');
  });
});

describe('URL loading', () => {
  it('fetches the manifest and the default model, with progress', async () => {
    const m = manifest();
    const f = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith('voice.json')) return new Response(JSON.stringify(m));
      if (u.endsWith('model.int8.onnx')) return new Response(new Uint8Array(4));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const p = await loadPackFromUrl('https://host.test/pack/', undefined, f);
    expect(p.model.byteLength).toBe(4);
    expect(p.manifest.default).toBe('int8');
  });
  it('explains CORS / 404 problems', async () => {
    const f = (async () => new Response('x', { status: 404 })) as unknown as typeof fetch;
    await expect(loadPackFromUrl('https://host.test/pack/', undefined, f)).rejects.toThrow(/CORS|HTTP 404/);
  });
});

describe('CustomVoiceController', () => {
  function setup(opts: { fail?: boolean } = {}) {
    const sw: any = { neural: null };
    const changes: string[] = [];
    const engine: EngineLike = { ready: true, voices: () => [{ name: 'x', lang: 'en' }], speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), init: vi.fn(async () => { if (opts.fail) throw new Error('model rejected'); }), dispose: vi.fn(), stats: {} };
    const before = vi.fn();
    const c = new CustomVoiceController({
      mixer: {} as any, sw, browser: () => null, getExcitement: () => 0, beforeEnable: before, onChange: (s) => changes.push(s.state),
      loaders: { url: async () => ({ manifest: manifest(), model: new ArrayBuffer(4), source: { kind: 'url', url: 'u' } }), files: async () => ({ manifest: manifest(), model: new ArrayBuffer(4), source: { kind: 'files', names: ['voice.json'] } }), saved: async () => null, makeEngine: async () => engine },
    });
    return { c, sw, changes, engine, before };
  }
  it('loads, installs its engine in the switch, and can be switched off', async () => {
    const { c, sw, changes, engine, before } = setup();
    await c.enableFromUrl('https://host.test/pack/');
    expect(c.state).toBe('ready');
    expect(sw.neural).toBe(engine);
    expect(before).toHaveBeenCalled();
    c.disable();
    expect(sw.neural).toBeNull();
    expect(engine.dispose).toHaveBeenCalled();
    expect(changes.filter((s, i) => s !== changes[i - 1])).toEqual(['off', 'loading', 'ready', 'off']);
  });
  it('keeps the browser voices when the model fails to start', async () => {
    const { c, sw } = setup({ fail: true });
    await c.enableFromFiles([]);
    expect(c.state).toBe('error');
    expect(c.message).toMatch(/model rejected/);
    expect(sw.neural).toBeNull();
  });
});
