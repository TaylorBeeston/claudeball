/**
 * The HD (neural) voices manager: one object that outlives games and the audio controller, so the download, its progress and the
 * "is it cached" check work from the title menu before any game (or AudioContext) exists, and a new game does not reload the model.
 *
 * Everything heavy (`neural.ts`, the worker, the model) is imported only after the player opts in. The audio controller of a game
 * binds its mixer to the engine with `bindMixer` and unbinds on dispose; the preview button makes its own small mixer (an
 * `AudioContext` needs a user gesture, which the click is).
 */
import { HD_MODES, hdSupported, pickMode, type HdMode } from './hdInfo';
import { Mixer, DEFAULT_SETTINGS } from './mixer';
import { browserSpeech, type SpeechEngine } from './speech';

export interface HdStatus {
  state: 'off' | 'loading' | 'ready' | 'error' | 'unavailable';
  pct?: number;
  text?: string;
  /** the model is already in the browser cache */
  cached?: boolean;
  /** size of the download for this device, MB */
  mb?: number;
  previewing?: boolean;
}

const KEY = 'claudeball.hd.v1';

export interface HdEngine extends SpeechEngine {
  ready: boolean;
  init(mode: HdMode, onProgress: (loaded: number, total: number) => void): Promise<void>;
  setMixer(m: Mixer | null): void;
  warm?(texts: string[], role: 'pa' | 'ump' | 'pbp' | 'color'): void;
  dispose(): void;
  stats: unknown;
  rtf: number;
  busyMs(): number;
}

function loadFlag(): boolean {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}').enabled === true;
  } catch {
    return false;
  }
}
function saveFlag(enabled: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled }));
  } catch {
    /* private window: not remembered */
  }
}

/** the umpire's calls and the counts the booth folds in: generated ahead so they are instant */
export const WARM_UMP = ['Ball!', 'Ball four!', 'Strike!', 'Strike three!', 'Foul ball!', 'Foul tip!', 'Safe!', 'Out!', 'Time!', 'Take your base!', 'Infield fly!', 'Balk!'];

export type NeuralModule = typeof import('./neural');

export class HdManager {
  /** how the heavy module is loaded (a dynamic import; tests inject a fake) */
  loader: () => Promise<NeuralModule> = () => import('./neural');
  state: HdStatus['state'] = 'off';
  pct = 0;
  message = '';
  cached: boolean | undefined;
  engine: HdEngine | null = null;
  private listeners = new Set<(s: HdStatus) => void>();
  private mixer: Mixer | null = null;
  private previewMixer: Mixer | null = null;
  private previewing = false;
  private generation = 0;
  /** called whenever the engine becomes (un)available: the controller of a running game plugs it into its speech switch */
  onEngine: ((e: HdEngine | null) => void) | null = null;

  status(): HdStatus {
    const mb = HD_MODES[pickMode()].mb;
    if (!hdSupported() && this.state !== 'ready') return { state: 'unavailable', mb, text: 'HD voices need WebGPU, which this browser does not offer: the CPU version is slower than real time, so it is not offered.' };
    const base: HdStatus = { state: this.state, pct: this.pct, cached: this.cached, mb, previewing: this.previewing };
    if (this.state === 'ready') base.text = `Kokoro HD voices on (${HD_MODES[pickMode()].device}). Lines that cannot be generated in time use the browser voice.`;
    if (this.state === 'error') base.text = `HD voices could not start (${this.message}). Using the browser voices.`;
    return base;
  }

  subscribe(cb: (s: HdStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  /** at app start: switch on silently when the player had it on and the model is still cached (never a surprise download) */
  async autoStart(): Promise<void> {
    if (!hdSupported()) return;
    try {
      const { isCached } = await this.loader();
      this.cached = await isCached(pickMode());
      this.emit();
      if (loadFlag() && this.cached) await this.enable();
      else if (loadFlag()) saveFlag(false);
    } catch {
      /* stays off */
    }
  }

  private checkSeq = 0;
  async checkCached(): Promise<boolean> {
    const n = ++this.checkSeq;
    let c = false;
    try {
      const { isCached } = await this.loader();
      c = await isCached(pickMode());
    } catch {
      c = false;
    }
    if (n === this.checkSeq) {
      this.cached = c; // only the newest check counts (a slower, older one must not overwrite it)
      this.emit();
    }
    return !!this.cached;
  }

  async enable(): Promise<void> {
    if (this.state === 'loading' || this.state === 'ready' || !hdSupported()) return;
    const mode = pickMode();
    const gen = ++this.generation;
    this.state = 'loading';
    this.pct = 0;
    this.emit();
    try {
      const { NeuralSpeechEngine, WorkerSynth } = await this.loader();
      const engine = new NeuralSpeechEngine(new WorkerSynth(), this.mixer, browserSpeech(), mode) as unknown as HdEngine;
      await engine.init(mode, (l, t) => {
        this.pct = t > 0 ? Math.min(99, Math.round((l / t) * 100)) : 0;
        this.emit();
      });
      if (gen !== this.generation) {
        engine.dispose();
        return;
      }
      this.engine = engine;
      if (this.mixer) engine.setMixer(this.mixer);
      this.state = 'ready';
      this.pct = 100;
      this.cached = true;
      saveFlag(true);
      engine.warm?.(WARM_UMP, 'ump');
      this.onEngine?.(engine);
    } catch (e) {
      this.message = String((e as Error)?.message ?? e);
      this.state = 'error';
      this.engine = null;
      saveFlag(false);
      this.onEngine?.(null);
    }
    this.emit();
  }

  disable() {
    this.generation++;
    this.engine?.dispose();
    this.engine = null;
    this.state = 'off';
    this.pct = 0;
    saveFlag(false);
    this.onEngine?.(null);
    this.emit();
    void this.checkCached();
  }

  toggle() {
    return this.state === 'ready' ? this.disable() : this.enable();
  }

  async remove() {
    this.disable();
    try {
      const { clearCache } = await this.loader();
      await clearCache();
    } catch {
      /* ignore */
    }
    this.checkSeq++; // drop any check that started before the cache was cleared
    this.cached = false;
    this.emit();
  }

  /** the audio controller of a running game: audio plays through its mixer (null again when the game ends) */
  bindMixer(m: Mixer | null) {
    this.mixer = m;
    this.engine?.setMixer(m ?? this.previewMixer);
  }

  /** "Preview voice": a PA line, a play-by-play call and a colour remark, through a small mixer made on this click */
  async preview(): Promise<void> {
    const e = this.engine;
    if (!e || this.previewing) return;
    this.previewing = true;
    this.emit();
    try {
      let m = this.mixer;
      if (!m) {
        m = this.previewMixer ??= new Mixer({ ...DEFAULT_SETTINGS });
        if (!(await m.unlock())) throw new Error('audio is blocked');
        e.setMixer(m);
      }
      const say = (role: 'pa' | 'pbp' | 'color', text: string, ex = false) =>
        new Promise<void>((res) => {
          e.speak(text, { role, voiceName: e.voiceFor?.(role), pitch: ex ? 1.1 : 1, shift: ex ? 1.06 : 1, rate: ex ? 1.12 : role === 'pbp' ? 1.04 : role === 'pa' ? 0.92 : 1, volume: 0.8, onend: res, onerror: res });
        });
      await say('pa', 'Now batting, number 23, Tyler Vance.');
      await say('pbp', 'Deep drive to left... gone! Home run!', true);
      await say('color', 'What a swing. That ball is not coming back.');
    } catch {
      /* the preview is a convenience */
    } finally {
      this.previewing = false;
      this.emit();
    }
  }
}

export const hdManager = new HdManager();
