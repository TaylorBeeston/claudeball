/**
 * Clip-first synthesis: if the line can be built entirely from the owner's recordings (see clips.ts) play those, otherwise ask the
 * neural model. Wraps any `Synth`, so every failure still ends in the browser voice.
 */
import type { Synth } from '../neural';
import { planClips, stitch, trimClip, type ClipIndex } from './clips';

export interface ClipDecoder {
  /** decode an encoded clip (ogg/opus, wav...) to mono floats at its own sample rate */
  decode(bytes: ArrayBuffer): Promise<{ samples: Float32Array; sr: number }>;
}

export const browserDecoder: ClipDecoder = {
  async decode(bytes) {
    const ctx = new OfflineAudioContext(1, 1, 22050);
    const b = await ctx.decodeAudioData(bytes);
    return { samples: new Float32Array(b.getChannelData(0)), sr: b.sampleRate };
  },
};

export class ClipFirstSynth implements Synth {
  stats = { clipLines: 0, modelLines: 0 };
  private decoded = new Map<string, Promise<{ samples: Float32Array; sr: number }>>();

  constructor(
    private inner: Synth,
    private index: ClipIndex,
    private baseUrl: string,
    private decoder: ClipDecoder = browserDecoder,
    private fetcher: typeof fetch = fetch,
  ) {}

  init(mode: Parameters<Synth['init']>[0], onProgress: Parameters<Synth['init']>[1]) {
    return this.inner.init(mode, onProgress);
  }

  private clip(file: string) {
    let p = this.decoded.get(file);
    if (!p) {
      p = this.fetcher(new URL(file, this.baseUrl).toString(), { cache: 'force-cache' }).then(async (r) => {
        if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
        return this.decoder.decode(await r.arrayBuffer());
      });
      p.catch(() => this.decoded.delete(file));
      this.decoded.set(file, p);
    }
    return p;
  }

  async generate(text: string, voice: string, speed: number) {
    const plan = planClips(text, this.index);
    if (plan) {
      try {
        const parts = await Promise.all(plan.map((f) => this.clip(f)));
        const sr = parts[0].sr;
        if (parts.every((p) => p.sr === sr)) {
          this.stats.clipLines++;
          return { samples: stitch(parts.map((p) => trimClip(p.samples, sr)), sr, this.index.gapMs ?? 50), sr };
        }
      } catch {
        /* a clip failed to load: use the model */
      }
    }
    this.stats.modelLines++;
    return this.inner.generate(text, voice, speed);
  }

  dispose() {
    this.decoded.clear();
    this.inner.dispose();
  }
}
