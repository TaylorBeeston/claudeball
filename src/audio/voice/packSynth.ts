/**
 * `Synth` (the interface the neural speech engine speaks to) backed by the owner's voice pack, running in a module worker. The speech
 * engine asks for a `voice` per role (the HD voice names); here that only tells us the ROLE, and the delivery (calm / building /
 * excited / peak / ...) is chosen per line from the text and the crowd excitement, then mapped to the pack's speaker.
 */
import { HD_VOICES, type Synth } from '../neural';
import type { SpeakRole } from '../types';
import { chooseStyle, type LoadedPack } from './pack';

const ROLE_OF_VOICE: Record<string, SpeakRole> = Object.fromEntries(Object.entries(HD_VOICES).map(([role, v]) => [v, role as SpeakRole]));

export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(m: unknown, t?: Transferable[]): void;
  terminate(): void;
}

export class PackSynth implements Synth {
  private w: WorkerLike | null = null;
  private jobs = new Map<number, { res: (v: { samples: Float32Array; sr: number }) => void; rej: (e: Error) => void }>();
  private seq = 1;
  /** how many lines were synthesised, and the last style used (debug) */
  stats = { lines: 0, lastStyle: '' };

  constructor(
    private pack: LoadedPack,
    private getExcitement: () => number,
    private makeWorker: () => WorkerLike = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
  ) {}

  init(_mode: unknown, _onProgress: (loaded: number, total: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = this.makeWorker();
      this.w = w;
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'audio') {
          const j = this.jobs.get(m.id);
          if (!j) return;
          this.jobs.delete(m.id);
          if (m.error) j.rej(new Error(m.error));
          else j.res({ samples: m.samples, sr: m.sr });
        }
      };
      w.onerror = (e) => reject(new Error(e.message || 'voice worker failed'));
      const model = this.pack.model;
      w.postMessage({ type: 'init', manifest: this.pack.manifest, model, ortUrl: this.pack.manifest.runtime?.ortUrl }, [model]);
    });
  }

  /** `speed` is ignored: the cadence is the one you recorded. */
  generate(text: string, voice: string, _speed: number): Promise<{ samples: Float32Array; sr: number }> {
    return new Promise((res, rej) => {
      if (!this.w) return rej(new Error('no worker'));
      const id = this.seq++;
      const style = chooseStyle(ROLE_OF_VOICE[voice] ?? 'pbp', text, this.getExcitement());
      this.stats.lines++;
      this.stats.lastStyle = style;
      this.jobs.set(id, { res, rej });
      this.w.postMessage({ type: 'gen', id, text, style });
    });
  }

  dispose() {
    this.w?.terminate();
    this.w = null;
    for (const j of this.jobs.values()) j.rej(new Error('disposed'));
    this.jobs.clear();
  }
}
