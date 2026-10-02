import { afterEach, describe, expect, it, vi } from 'vitest';

const log: string[] = [];
class FakeVoice {
  ready = false;
  stats = {};
  mixer: unknown = 'initial';
  async init() {
    this.ready = true;
  }
  setMixer(m: unknown) {
    this.mixer = m;
    log.push(`voice.mixer:${m === null ? 'null' : 'set'}`);
  }
  voices() {
    return this.ready ? [{ name: 'me', lang: 'en-US' }] : [];
  }
  speak() {}
  cancel() {}
  pause() {}
  resume() {}
  dispose() {
    log.push('voice.dispose');
  }
}
class FakeHd extends FakeVoice {
  rtf = 0.2;
  warm() {}
  busyMs() {
    return 0;
  }
  dispose() {
    log.push('hd.dispose');
  }
}
const hdModule = { NeuralSpeechEngine: FakeHd, WorkerSynth: class {}, isCached: async () => true, clearCache: async () => {} } as never;

function stub() {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] });
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('location', { search: '' });
}

async function fresh() {
  vi.resetModules();
  stub();
  const { hdManager } = await import('../hd');
  hdManager.loader = async () => hdModule;
  const { VoiceManager } = await import('../voiceManager');
  const vm = new VoiceManager();
  (vm.controller as unknown as { d: { loaders: unknown } }).d.loaders = {
    url: async () => ({ manifest: { name: 'My Voice' } }),
    files: async () => ({ manifest: { name: 'My Voice' } }),
    saved: async () => null,
    makeEngine: async () => new FakeVoice(),
  };
  return { vm, hdManager };
}

describe('My voice manager (outlives games, works from the title menu)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    log.length = 0;
  });

  it('loads before any game exists, reports progress to the menu and hands the engine to whoever listens', async () => {
    const { vm } = await fresh();
    const seen: string[] = [];
    const engines: unknown[] = [];
    vm.subscribe((s) => seen.push(s.state));
    vm.onEngine = (e) => engines.push(e);
    await vm.controller.enableFromUrl('https://example.org/pack/');
    expect(vm.state).toBe('ready');
    expect(vm.status()).toMatchObject({ state: 'ready', name: 'My Voice', url: 'https://example.org/pack/' });
    expect(seen.slice(-2)).toEqual(['loading', 'ready']);
    expect(engines).toHaveLength(1);
    expect(vm.engine).toBe(engines[0]);
  });

  it('a game binds its mixer to the running engine and unbinds it at the end; the engine is not reloaded', async () => {
    const { vm } = await fresh();
    await vm.controller.enableFromUrl('https://example.org/pack/');
    const e = vm.engine as unknown as FakeVoice;
    const mixer = {} as never;
    vm.bindMixer(mixer, () => 0.7);
    expect(e.mixer).toBe(mixer);
    vm.bindMixer(null);
    vm.bindMixer(mixer);
    expect(vm.engine).toBe(e);
    expect(log.filter((x) => x === 'voice.dispose')).toHaveLength(0);
  });

  it('switching to the HD voices turns the custom voice off, and the other way round', async () => {
    const { vm, hdManager } = await fresh();
    await vm.controller.enableFromUrl('https://example.org/pack/');
    expect(vm.state).toBe('ready');
    await hdManager.enable();
    expect(hdManager.state).toBe('ready');
    expect(vm.state).toBe('off');
    expect(log).toContain('voice.dispose');
    await vm.controller.enableFromUrl('https://example.org/pack/');
    expect(vm.state).toBe('ready');
    expect(hdManager.state).toBe('off');
    expect(log).toContain('hd.dispose');
  });

  it('off clears the engine for the game', async () => {
    const { vm } = await fresh();
    const engines: unknown[] = [];
    await vm.controller.enableFromUrl('https://example.org/pack/');
    vm.onEngine = (e) => engines.push(e);
    vm.controller.disable();
    expect(engines).toEqual([null]);
    expect(vm.engine).toBeNull();
    expect(vm.status().state).toBe('off');
  });
});
