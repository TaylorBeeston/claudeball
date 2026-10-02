import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineLog: string[] = [];
class FakeEngine {
  ready = false;
  rtf = 0.2;
  stats = {};
  mixer: unknown = 'initial';
  static cached = true;
  constructor(public synth: unknown, mixer: unknown) {
    this.mixer = mixer;
  }
  async init(_m: string, onProgress: (l: number, t: number) => void) {
    onProgress(50, 100);
    onProgress(100, 100);
    this.ready = true;
  }
  setMixer(m: unknown) {
    this.mixer = m;
    engineLog.push(`mixer:${m === null ? 'null' : 'set'}`);
  }
  warm(texts: string[]) {
    engineLog.push(`warm:${texts.length}`);
  }
  voices() {
    return this.ready ? [{ name: 'am_onyx', lang: 'en-US' }] : [];
  }
  voiceFor() {
    return 'am_onyx';
  }
  speak() {}
  cancel() {}
  pause() {}
  resume() {}
  busyMs() {
    return 0;
  }
  dispose() {
    engineLog.push('dispose');
  }
}
const fakeModule = {
  NeuralSpeechEngine: FakeEngine,
  WorkerSynth: class {},
  isCached: async () => FakeEngine.cached,
  clearCache: async () => {
    engineLog.push('clearCache');
    FakeEngine.cached = false;
  },
} as never;

function stubBrowser(gpu: boolean, stored: Record<string, string> = {}) {
  const store: Record<string, string> = { ...stored };
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] });
  vi.stubGlobal('navigator', gpu ? { gpu: {} } : {});
  vi.stubGlobal('location', { search: '' });
  return store;
}

async function fresh() {
  vi.resetModules();
  const m = await import('../hd');
  const mgr = new m.HdManager();
  mgr.loader = async () => fakeModule;
  return mgr;
}

describe('HD voices manager (outlives games, works without an AudioContext)', () => {
  beforeEach(() => {
    engineLog.length = 0;
    FakeEngine.cached = true;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads from the title menu: progress is reported, no mixer or game needed, and the umpire phrases are warmed', async () => {
    stubBrowser(true);
    const m = await fresh();
    const seen: string[] = [];
    m.subscribe((s) => seen.push(`${s.state}:${s.pct ?? ''}`));
    await m.enable();
    expect(m.state).toBe('ready');
    expect(seen).toContain('loading:50');
    expect(seen[seen.length - 1]).toBe('ready:100');
    expect(engineLog).toContain('warm:12');
    expect(m.status().cached).toBe(true);
    expect(JSON.parse(localStorage.getItem('claudeball.hd.v1')!).enabled).toBe(true);
  });

  it('a new game rebinds its mixer to the same engine: the model is not reloaded', async () => {
    stubBrowser(true);
    const m = await fresh();
    const engines: unknown[] = [];
    m.onEngine = (e) => engines.push(e);
    await m.enable();
    const first = m.engine;
    m.bindMixer({} as never);
    m.bindMixer(null); // game over
    m.bindMixer({} as never); // next game
    expect(m.engine).toBe(first);
    expect(engines).toHaveLength(1);
    expect(m.state).toBe('ready');
    expect(engineLog.filter((x) => x === 'dispose')).toHaveLength(0);
  });

  it('starts silently at app start when it was on and the model is still cached; never a surprise download', async () => {
    stubBrowser(true, { 'claudeball.hd.v1': '{"enabled":true}' });
    const m = await fresh();
    await m.autoStart();
    expect(m.state).toBe('ready');
    FakeEngine.cached = false;
    const store = stubBrowser(true, { 'claudeball.hd.v1': '{"enabled":true}' });
    const m2 = await fresh();
    await m2.autoStart();
    expect(m2.state).toBe('off');
    expect(m2.status().cached).toBe(false);
    expect(JSON.parse(store['claudeball.hd.v1']).enabled).toBe(false);
  });

  it('disable disposes the engine and forgets the opt-in', async () => {
    const store = stubBrowser(true);
    const m = await fresh();
    await m.enable();
    expect(m.state, m.message).toBe('ready');
    m.disable();
    expect(m.state).toBe('off');
    expect(engineLog).toContain('dispose');
    expect(JSON.parse(store['claudeball.hd.v1']).enabled).toBe(false);
  });

  it('remove also clears the download', async () => {
    stubBrowser(true);
    const m = await fresh();
    await m.enable();
    await m.remove();
    expect(engineLog).toContain('clearCache');
    expect(m.status().cached).toBe(false);
  });

  it('not offered without WebGPU', async () => {
    stubBrowser(false);
    const m = await fresh();
    expect(m.status().state).toBe('unavailable');
    await m.enable();
    expect(m.state).toBe('off');
    await m.autoStart();
    expect(m.state).toBe('off');
  });

  it('preview without any audio does not throw and does not stay "previewing"', async () => {
    stubBrowser(true);
    const m = await fresh();
    await m.preview(); // not ready: nothing
    await m.enable();
    await expect(m.preview()).resolves.toBeUndefined();
    expect(m.status().previewing).toBe(false);
  });
});
