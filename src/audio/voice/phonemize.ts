/**
 * Text -> Piper phoneme ids using the voice pack's word lexicon (no espeak-ng in the browser).
 *
 * `tokenize` and `assembleIds` are the twins of the Python functions of the same names in tools/announcer/train/common.py: training data
 * prep builds its ids with that code, the browser builds them with this, and a golden test (golden.json, written by the Python side) keeps
 * the two in lock step. The game's vocabulary is closed (templates, name pools, numbers), so a word that is not in the lexicon is rare;
 * `assembleIds` reports it and the caller falls back to the browser voice for that line.
 */

export type Token = { kind: 'w'; value: string } | { kind: 'p'; value: string };

export interface PhonemeIdMap {
  [symbol: string]: number[];
}

const TOKEN_RE = /[a-z]+(?:'[a-z]+)*|[,.;:!?]/g;

/** Normalised line -> words and punctuation ("..." is a comma pause, hyphens split words). */
export function tokenize(text: string): Token[] {
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\.\.\./g, ',').replace(/…/g, ',').replace(/-/g, ' ');
  const out: Token[] = [];
  for (const m of t.matchAll(TOKEN_RE)) out.push(/[a-z]/.test(m[0][0]) ? { kind: 'w', value: m[0] } : { kind: 'p', value: m[0] });
  return out;
}

export interface Assembled {
  ids: number[] | null;
  /** words that had no lexicon entry */
  missing: string[];
}

/** BOS PAD (phoneme PAD)* EOS, a space token between words, punctuation attached to the word before it. */
export function assembleIds(tokens: Token[], words: Record<string, number[]>, idmap: PhonemeIdMap): Assembled {
  const pad = idmap['_'];
  const ids: number[] = [...idmap['^'], ...pad];
  const missing: string[] = [];
  let first = true;
  for (const t of tokens) {
    if (t.kind === 'w') {
      const w = words[t.value];
      if (!w) {
        missing.push(t.value);
        continue;
      }
      if (!first) ids.push(...idmap[' '], ...pad);
      for (const id of w) ids.push(id, ...pad);
    } else {
      const p = idmap[t.value];
      if (!p) continue;
      ids.push(...p, ...pad);
    }
    first = false;
  }
  ids.push(...idmap['$']);
  return { ids: missing.length ? null : ids, missing };
}

/**
 * Split a line into sentences for synthesis (a model call per sentence keeps each one short and fast); a sentence that is
 * still longer than `maxWords` is cut at a comma.
 */
export function splitSentences(text: string, maxWords = 22): string[] {
  const parts = text.match(/[^.!?]+(?:\.\.\.|[.!?])*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const s of parts) {
    if (s.split(/\s+/).length <= maxWords) {
      out.push(s);
      continue;
    }
    let cur: string[] = [];
    for (const piece of s.split(/(?<=,)\s+/)) {
      if (cur.join(' ').split(/\s+/).length + piece.split(/\s+/).length > maxWords && cur.length) {
        out.push(cur.join(' '));
        cur = [];
      }
      cur.push(piece);
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out;
}
