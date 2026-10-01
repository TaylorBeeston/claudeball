/**
 * "My voice (custom announcer)": the opt-in switch between the game's speech engines and the owner's own trained voice.
 * State machine for the audio panel: off -> loading -> ready | error. Everything heavy (the speech engine, the worker, onnxruntime-web)
 * is imported only after the owner turns it on, and any failure leaves the browser voices in place.
 */
import type { Mixer } from '../mixer';
import type { SpeechEngine, SwitchEngine } from '../speech';
import { forgetPack, loadPackFromFiles, loadPackFromUrl, loadSavedLocalPack, type LoadedPack } from './pack';

export type VoiceState = 'off' | 'loading' | 'ready' | 'error';

const KEY = 'claudeball.voicepack.v1';

export interface VoiceSettings {
  enabled: boolean;
  /** last pack URL typed in; empty when the pack came from local files */
  url: string;
  source: 'url' | 'files' | '';
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { enabled: o.enabled === true, url: typeof o.url === 'string' ? o.url : '', source: o.source === 'url' || o.source === 'files' ? o.source : '' };
  } catch {
    return { enabled: false, url: '', source: '' };
  }
}

function saveVoiceSettings(s: VoiceSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: not remembered */
  }
}

export interface EngineLike extends SpeechEngine {
  ready: boolean;
  init(mode: 'gpu' | 'cpu', onProgress: (l: number, t: number) => void): Promise<void>;
  dispose(): void;
  stats: unknown;
}

export interface ControllerDeps {
  mixer: Mixer;
  sw: SwitchEngine;
  browser: () => SpeechEngine | null;
  /** 0..1 crowd excitement, to pick the delivery */
  getExcitement: () => number;
  /** the other neural engine (Kokoro) must be off while this one is on */
  beforeEnable?: () => void;
  onChange: (s: { state: VoiceState; pct: number; message: string; name: string }) => void;
  /** injectable for tests */
  loaders?: {
    url: typeof loadPackFromUrl;
    files: typeof loadPackFromFiles;
    saved: typeof loadSavedLocalPack;
    makeEngine: (pack: LoadedPack, d: ControllerDeps) => Promise<EngineLike>;
  };
}

async function defaultMakeEngine(pack: LoadedPack, d: ControllerDeps): Promise<EngineLike> {
  const [{ NeuralSpeechEngine }, { PackSynth }] = await Promise.all([import('../neural'), import('./packSynth')]);
  // mode 'gpu' only seeds the speed estimate (a small model runs faster than real time); the engine re-measures it
  let synth: import('../neural').Synth = new PackSynth(pack, d.getExcitement);
  if (pack.manifest.clips && pack.manifestUrl) {
    // the owner's own recordings first, for the lines they cover exactly; the model for everything else
    try {
      const { ClipFirstSynth } = await import('./clipSynth');
      const idxUrl = new URL(pack.manifest.clips.index, pack.manifestUrl).toString();
      const r = await fetch(idxUrl);
      if (r.ok) synth = new ClipFirstSynth(synth, await r.json(), idxUrl);
    } catch {
      /* no clips: model only */
    }
  }
  return new NeuralSpeechEngine(synth, d.mixer, d.browser(), 'gpu') as unknown as EngineLike;
}

export class CustomVoiceController {
  state: VoiceState = 'off';
  pct = 0;
  message = '';
  name = '';
  settings: VoiceSettings = loadVoiceSettings();
  engine: EngineLike | null = null;

  constructor(private d: ControllerDeps) {}

  private set(state: VoiceState, message = '') {
    this.state = state;
    this.message = message;
    this.d.onChange({ state, pct: this.pct, message, name: this.name });
  }

  /** Called at start-up: if the owner left the custom voice on, bring it back (saved local pack, or the URL again). */
  async resume(): Promise<void> {
    if (!this.settings.enabled) return;
    if (this.settings.source === 'files') {
      const pack = await (this.d.loaders?.saved ?? loadSavedLocalPack)().catch(() => null);
      if (pack) return this.start(async () => pack);
      this.settings.enabled = false;
      saveVoiceSettings(this.settings);
      return;
    }
    if (this.settings.url) await this.enableFromUrl(this.settings.url);
  }

  async enableFromUrl(url: string): Promise<void> {
    const load = this.d.loaders?.url ?? loadPackFromUrl;
    await this.start(() => load(url, (l, t) => {
      this.pct = t > 0 ? Math.min(99, Math.round((l / t) * 100)) : 0;
      this.d.onChange({ state: 'loading', pct: this.pct, message: '', name: this.name });
    }), { source: 'url', url });
  }

  async enableFromFiles(files: File[]): Promise<void> {
    await this.start(() => (this.d.loaders?.files ?? loadPackFromFiles)(files), { source: 'files', url: '' });
  }

  private async start(load: () => Promise<LoadedPack>, remember?: Pick<VoiceSettings, 'source' | 'url'>): Promise<void> {
    if (this.state === 'loading') return;
    this.disable(false);
    this.d.beforeEnable?.();
    this.pct = 0;
    this.set('loading');
    try {
      const pack = await load();
      this.name = pack.manifest.name;
      const make = this.d.loaders?.makeEngine ?? defaultMakeEngine;
      const engine = await make(pack, this.d);
      await engine.init('gpu', () => {});
      this.engine = engine;
      this.d.sw.neural = engine;
      this.settings = { enabled: true, url: remember?.url ?? this.settings.url, source: remember?.source ?? this.settings.source };
      saveVoiceSettings(this.settings);
      this.set('ready');
    } catch (e) {
      this.engine?.dispose();
      this.engine = null;
      this.d.sw.neural = null;
      this.settings.enabled = false;
      saveVoiceSettings(this.settings);
      this.set('error', String((e as Error)?.message ?? e));
    }
  }

  /** Back to the browser voices. `remember` = also forget that it was on (the owner switched it off). */
  disable(remember = true): void {
    if (this.engine) {
      if (this.d.sw.neural === this.engine) this.d.sw.neural = null;
      this.engine.dispose();
      this.engine = null;
    }
    if (remember) {
      this.settings.enabled = false;
      saveVoiceSettings(this.settings);
    }
    this.set('off');
  }

  /** Switch off and delete what was saved in this browser (the cached model, the saved URL). */
  async forget(): Promise<void> {
    this.disable();
    this.settings = { enabled: false, url: '', source: '' };
    saveVoiceSettings(this.settings);
    await forgetPack();
  }
}
