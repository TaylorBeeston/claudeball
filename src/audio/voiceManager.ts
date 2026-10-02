/**
 * "My voice (custom announcer)" as an object that outlives games, like the HD manager: the pack can be loaded, previewed and switched
 * off from the title menu before any game exists. The heavy code stays lazy (voice/controller only imports the engine on opt-in).
 * A game's audio controller binds its mixer and learns about engine changes through `onEngine`.
 */
import { Mixer, DEFAULT_SETTINGS } from './mixer';
import { browserSpeech, type SpeechEngine, type SwitchEngine } from './speech';
import { CustomVoiceController, loadVoiceSettings, type EngineLike } from './voice/controller';
import { hdManager, playPreview } from './hd';

export interface VoiceStatusFull {
  state: 'off' | 'loading' | 'ready' | 'error';
  pct: number;
  message: string;
  name: string;
  url: string;
  previewing: boolean;
}

type NeuralEngine = EngineLike & { setMixer?(m: Mixer | null): void; voiceFor?: SpeechEngine['voiceFor'] };

export class VoiceManager {
  readonly controller: CustomVoiceController;
  private mixer: Mixer | null = null;
  private previewMixer: Mixer | null = null;
  private previewing = false;
  private excitement: () => number = () => 0;
  private listeners = new Set<(s: VoiceStatusFull) => void>();
  private last = { state: 'off' as VoiceStatusFull['state'], pct: 0, message: '', name: '' };
  /** called whenever the custom engine becomes (un)available: a running game plugs it into its speech switch */
  onEngine: ((e: SpeechEngine | null) => void) | null = null;

  constructor() {
    const self = this;
    // the controller only ever assigns `neural` on this holder
    const holder = {
      get neural() {
        return self.controller.engine;
      },
      set neural(e: SpeechEngine | null) {
        (e as NeuralEngine | null)?.setMixer?.(self.mixer ?? self.previewMixer);
        self.onEngine?.(e);
      },
    } as unknown as SwitchEngine;
    this.controller = new CustomVoiceController({
      get mixer() {
        return self.mixer as Mixer; // the engine accepts a mixer later (`setMixer`)
      },
      sw: holder,
      browser: browserSpeech,
      getExcitement: () => this.excitement(),
      beforeEnable: () => {
        if (hdManager.state !== 'off') hdManager.disable();
      },
      onChange: (s) => {
        this.last = s;
        this.emit();
      },
    });
    // and the other way round: switching HD voices on turns the custom voice off
    hdManager.beforeEnable = () => {
      if (this.controller.state !== 'off') this.controller.disable();
    };
  }

  get engine(): SpeechEngine | null {
    return this.controller.engine;
  }
  get state() {
    return this.controller.state;
  }

  status(): VoiceStatusFull {
    return { ...this.last, state: this.controller.state, url: this.controller.settings.url, previewing: this.previewing };
  }
  subscribe(cb: (s: VoiceStatusFull) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  /** at app start: bring the voice back when the owner left it on (its model comes from the browser cache) */
  autoStart(): Promise<void> {
    return loadVoiceSettings().enabled ? this.controller.resume() : Promise.resolve();
  }

  bindMixer(m: Mixer | null, excitement?: () => number) {
    this.mixer = m;
    if (excitement) this.excitement = excitement;
    (this.controller.engine as NeuralEngine | null)?.setMixer?.(m ?? this.previewMixer);
  }

  /** a PA line, a play-by-play call and a colour remark with the custom voice, through a small mixer made on this click */
  async preview(): Promise<void> {
    const e = this.controller.engine as NeuralEngine | null;
    if (!e || this.previewing) return;
    this.previewing = true;
    this.emit();
    try {
      let m = this.mixer;
      if (!m) {
        m = this.previewMixer ??= new Mixer({ ...DEFAULT_SETTINGS });
        if (!(await m.unlock())) throw new Error('audio is blocked');
        e.setMixer?.(m);
      }
      await playPreview(e);
    } catch {
      /* the preview is a convenience */
    } finally {
      this.previewing = false;
      this.emit();
    }
  }
}

export const voiceManager = new VoiceManager();
