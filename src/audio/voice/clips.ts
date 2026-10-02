/**
 * Concatenative fallback: the owner's own recordings, indexed by the words they say. For a line the bank knows exactly (an umpire call,
 * "Now batting, number twenty-three, Aaron Abbott" built from "now batting" + "number twenty-three" + "aaron" + "abbott"), the game plays the
 * real recordings instead of synthesising. Pure planning/stitching here; fetching and decoding live in clipSynth.ts.
 */
import { normalizeForSpeech } from './normalize';
import { tokenize } from './phonemize';

export interface ClipIndex {
  version: 1;
  gapMs?: number;
  /** words (lower case, punctuation dropped) -> file name inside the clips folder */
  keys: Record<string, string>;
}

export const wordsKey = (text: string): string[] => tokenize(normalizeForSpeech(text)).filter((t) => t.kind === 'w').map((t) => t.value);

/** Greedy longest-phrase cover of a line by known clips; null if any word is not covered. */
export function planClips(text: string, index: ClipIndex, maxWords = 14): string[] | null {
  const words = wordsKey(text);
  if (!words.length) return null;
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let hit = '';
    for (let n = Math.min(maxWords, words.length - i); n >= 1; n--) {
      const k = words.slice(i, i + n).join(' ');
      if (index.keys[k]) {
        hit = k;
        i += n;
        break;
      }
    }
    if (!hit) return null;
    out.push(index.keys[hit]);
  }
  return out;
}

/** Cut leading/trailing silence (the files keep ~200 ms of room each side), leaving `keepMs` so words do not touch. */
export function trimClip(x: Float32Array, sr: number, keepMs = 35, thresholdDb = -48): Float32Array {
  const thr = 10 ** (thresholdDb / 20);
  const win = Math.max(1, Math.round(sr * 0.005));
  const frame = (i: number) => {
    let s = 0;
    for (let k = i; k < Math.min(x.length, i + win); k++) s += x[k] * x[k];
    return Math.sqrt(s / win);
  };
  let a = 0;
  while (a < x.length && frame(a) < thr) a += win;
  let b = x.length;
  while (b > a && frame(Math.max(0, b - win)) < thr) b -= win;
  const keep = Math.round((sr * keepMs) / 1000);
  return x.slice(Math.max(0, a - keep), Math.min(x.length, b + keep));
}

/** Join clips with a short gap. The word gap after a comma-less join is small; sentences read faster than a model would. */
export function stitch(parts: Float32Array[], sr: number, gapMs = 50): Float32Array {
  const gap = Math.round((sr * gapMs) / 1000);
  const total = parts.reduce((s, p) => s + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    out.set(p, o);
    o += p.length + (i < parts.length - 1 ? gap : 0);
  });
  return out;
}
