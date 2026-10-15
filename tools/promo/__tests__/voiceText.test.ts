import { describe, expect, it } from 'vitest';
import { NeuralSpeechEngine } from '../../../src/audio/neural';
import { heardText, linePieces } from '../voiceText';

const SR = 1000;
/** a track with "speech" (a 0.5-amplitude tone) at the given [start, end) seconds */
function track(spans: [number, number][], seconds = 12) {
  const x = new Float32Array(seconds * SR);
  for (const [a, b] of spans) for (let i = a * SR; i < b * SR; i++) x[i] = 0.5 * Math.sin(i);
  return x;
}
const CALL = 'High fly ball. Way back. Gone! Pack a lunch, that one is going a long way!';
// the 1080p take of that call: pieces 0.34-1.28, 2.14-3.06 (with 20-40 ms gaps inside), 3.88-4.62, 5.42-6.84
const TAKE = track([[0.34, 1.28], [2.14, 2.6], [2.62, 2.64], [2.68, 3.06], [3.88, 4.62], [5.42, 5.86], [5.88, 6.84]]);

describe('booth captions say what the voice track plays', () => {
  it('splits a line into the pieces the HD voice speaks', () => {
    const engine = (NeuralSpeechEngine.prototype as unknown as { pieces(t: string, r: string): string[] }).pieces;
    for (const t of [CALL, 'Gone! And the game is over, a walk-off homer! Pack a lunch, that one is going a long way!', "It's outta here! Sanders goes yard!", 'Wow!'])
      expect(linePieces(t)).toEqual(engine.call({}, t, 'pbp'));
    expect(linePieces(CALL)).toEqual(['High fly ball.', 'Way back. Gone!', 'Pack a lunch,', 'that one is going a long way!']);
  });
  it('captions only the pieces that have ended when the track stops', () => {
    expect(heardText(CALL, TAKE, 0, 3.6 * SR, { sr: SR })).toBe('High fly ball. Way back. Gone!');
    expect(heardText(CALL, TAKE, 0, 2.0 * SR, { sr: SR })).toBe('High fly ball.');
    expect(heardText(CALL, TAKE, 0, 9 * SR, { sr: SR })).toBe(CALL);
  });
  it("uses the line's own end: whole when it finished, up to there when it was cut (the 4K walk-off: the analyst followed at once)", () => {
    // "It's a walk-off home run!" 0.36-1.70, then the analyst from 1.80 (no pause), the track ends at 4.0
    const x = track([[0.36, 1.7], [1.8, 3.9]]);
    expect(heardText("It's a walk-off home run!", x, 0, 4 * SR, { sr: SR, end: { at: 2.3 * SR, finished: true } })).toBe("It's a walk-off home run!");
    // a line cancelled after its words (in the clip's trailing silence) is heard; one cancelled mid-piece is not
    expect(heardText('That is a grown-man swing.', track([[0.3, 2.0]]), 0, 4 * SR, { sr: SR, end: { at: 2.23 * SR, finished: false } })).toBe('That is a grown-man swing.');
    expect(heardText(CALL, TAKE, 0, 9 * SR, { sr: SR, end: { at: 4.2 * SR, finished: false } })).toBe('High fly ball. Way back. Gone!');
  });
  it('a gap inside a piece is not the end of one, and a piece cut by the track is not captioned', () => {
    expect(heardText(CALL, TAKE, 0, 2.63 * SR, { sr: SR })).toBe('High fly ball.');
    expect(heardText(CALL, TAKE, 0, 0.8 * SR, { sr: SR })).toBe('');
  });
});
