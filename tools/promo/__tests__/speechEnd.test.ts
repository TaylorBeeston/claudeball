import { describe, expect, it } from 'vitest';
import { speechEnd } from '../dsp';

const SR = 1000;
/** a track with "words" (a 0.5-amplitude tone) at the given [start, end) seconds */
function track(words: [number, number][], seconds = 10) {
  const x = new Float32Array(seconds * SR);
  for (const [a, b] of words) for (let i = a * SR; i < b * SR; i++) x[i] = 0.5 * Math.sin(i);
  return x;
}
const opts = { sr: SR };

describe('speechEnd: a booth window never ends mid-word', () => {
  it('keeps a window that ends in a pause', () => {
    expect(speechEnd(track([[0.5, 2]]), 0, 3 * SR, opts)).toBe(3 * SR);
  });
  it('finishes a word that ends just after the window', () => {
    const n = speechEnd(track([[0.5, 2], [2.8, 3.3]]), 0, 3 * SR, opts);
    expect(n / SR).toBeGreaterThanOrEqual(3.3);
    expect(n / SR).toBeLessThan(3.45);
  });
  it('pulls back to the last pause when the word runs on (the bomb call: "Wow!" cut 0.28 s in)', () => {
    const n = speechEnd(track([[0.6, 2.1], [3.3, 4.5]]), 0, 3.6 * SR, opts);
    expect(n / SR).toBeGreaterThanOrEqual(2.1);
    expect(n / SR).toBeLessThan(2.25);
  });
  it('measures from the window start, not from sample 0', () => {
    const n = speechEnd(track([[5.6, 7.1], [8.3, 9.5]]), 5 * SR, 3.6 * SR, opts);
    expect(n / SR).toBeGreaterThanOrEqual(2.1);
    expect(n / SR).toBeLessThan(2.25);
  });
  it('leaves a window that is all speech alone', () => {
    expect(speechEnd(track([[0, 10]]), 0, 3 * SR, opts)).toBe(3 * SR);
  });
});
