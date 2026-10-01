import { describe, expect, it } from 'vitest';
import { assembleIds, splitSentences, tokenize } from '../voice/phonemize';

const idmap = { _: [0], '^': [1], $: [2], ' ': [3], ',': [4], '.': [5], '!': [6], '?': [7], ';': [8], ':': [9] };
const words = { now: [10, 11], batting: [12, 13, 14], number: [15], seven: [16, 17] };

describe('voice phonemizer', () => {
  it('tokenizes words and punctuation, hyphens and ellipses', () => {
    expect(tokenize("Now batting, number twenty-three! It's gone...")).toEqual([
      { kind: 'w', value: 'now' }, { kind: 'w', value: 'batting' }, { kind: 'p', value: ',' }, { kind: 'w', value: 'number' },
      { kind: 'w', value: 'twenty' }, { kind: 'w', value: 'three' }, { kind: 'p', value: '!' }, { kind: 'w', value: "it's" }, { kind: 'w', value: 'gone' }, { kind: 'p', value: ',' },
    ]);
  });

  it('assembles ids like Piper: BOS PAD, phoneme+PAD..., spaces between words, punctuation attached, EOS', () => {
    const r = assembleIds(tokenize('Now batting, number seven.'), words, idmap);
    expect(r.missing).toEqual([]);
    expect(r.ids).toEqual([1, 0, /*now*/ 10, 0, 11, 0, /*sp*/ 3, 0, /*batting*/ 12, 0, 13, 0, 14, 0, /*,*/ 4, 0, /*sp*/ 3, 0, /*number*/ 15, 0, /*sp*/ 3, 0, /*seven*/ 16, 0, 17, 0, /*.*/ 5, 0, 2]);
  });

  it('reports words that are not in the lexicon', () => {
    const r = assembleIds(tokenize('Now batting, Fuentes.'), words, idmap);
    expect(r.ids).toBeNull();
    expect(r.missing).toEqual(['fuentes']);
  });

  it('splits long text into sentences, and long sentences at commas', () => {
    expect(splitSentences('Strike one! Ball two. And the pitch...')).toEqual(['Strike one!', 'Ball two.', 'And the pitch...']);
    const long = 'one two three four five six seven eight, nine ten eleven twelve thirteen fourteen fifteen, sixteen seventeen eighteen nineteen twenty.';
    const parts = splitSentences(long, 10);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ')).toBe(long);
  });
});
