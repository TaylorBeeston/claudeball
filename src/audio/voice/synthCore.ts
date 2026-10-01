/**
 * The synthesis core: text -> audio with a Piper/VITS ONNX model. It only needs an `ort`-shaped object, so the same code runs in the
 * worker (real onnxruntime-web) and in tests (a mock). No DOM, no globals.
 */
import { normalizeForSpeech } from './normalize';
import { speakerFor, type StyleName, type VoiceManifest } from './pack';
import { assembleIds, splitSentences, tokenize } from './phonemize';

export interface TensorLike {
  data: Float32Array | BigInt64Array | Int32Array;
  dims: readonly number[];
}
export interface SessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}
export interface OrtLike {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: readonly number[]) => unknown;
}

/** A word the voice pack has no pronunciation for: the caller speaks the line with another voice. */
export class MissingWordsError extends Error {
  constructor(readonly words: string[]) {
    super(`no pronunciation in the voice pack for: ${words.slice(0, 6).join(', ')}`);
  }
}

const SENTENCE_GAP_S = 0.16;

export class SynthCore {
  constructor(private ort: OrtLike, private session: SessionLike, readonly manifest: VoiceManifest) {}

  /** Phoneme ids per sentence; throws MissingWordsError for the whole line if any word is unknown. */
  plan(text: string): number[][] {
    const out: number[][] = [];
    const missing = new Set<string>();
    for (const s of splitSentences(normalizeForSpeech(text))) {
      const r = assembleIds(tokenize(s), this.manifest.lexicon, this.manifest.phonemeIdMap);
      r.missing.forEach((w) => missing.add(w));
      if (r.ids) out.push(r.ids);
    }
    if (missing.size) throw new MissingWordsError([...missing]);
    return out;
  }

  async synth(text: string, style: StyleName): Promise<{ samples: Float32Array; sr: number }> {
    const sentences = this.plan(text);
    if (!sentences.length) throw new Error('nothing to say');
    const sid = speakerFor(this.manifest, style);
    const { noise, length, noiseW } = this.manifest.scales;
    const parts: Float32Array[] = [];
    const gap = new Float32Array(Math.round(SENTENCE_GAP_S * this.manifest.sampleRate));
    for (let i = 0; i < sentences.length; i++) {
      const ids = sentences[i];
      const feeds: Record<string, unknown> = {
        input: new this.ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
        input_lengths: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new this.ort.Tensor('float32', Float32Array.from([noise, length, noiseW]), [3]),
      };
      if (this.session.inputNames.includes('sid')) feeds.sid = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(sid ?? 0)]), [1]);
      const res = await this.session.run(feeds);
      const out = res.output ?? Object.values(res)[0];
      if (!out || !(out.data instanceof Float32Array)) throw new Error('model returned no audio');
      if (i > 0) parts.push(gap);
      parts.push(new Float32Array(out.data));
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      samples.set(p, o);
      o += p.length;
    }
    // keep the level steady and never clip: the model's output can overshoot a little
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak > 0.97) for (let i = 0; i < samples.length; i++) samples[i] *= 0.97 / peak;
    return { samples, sr: this.manifest.sampleRate };
  }
}
