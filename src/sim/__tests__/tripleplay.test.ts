/**
 * A 5-4-3 with two on and nobody out puts out three runners on one grounder: the play is a triple play (it used to be described as a
 * "double play" on the ticker and in the box-score result; promo jank log P5). Seed 23 at standard tempo has one in the bottom of the 1st.
 */
import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import type { GameEvent } from '../types';

describe('triple play', () => {
  it('three outs on one grounder are called a triple play', () => {
    const g = createGame({ seed: 23, tempo: 'standard', innings: 9 });
    const ends: { time: number; description: string }[] = [];
    const pa: string[] = [];
    g.on('*', (e: GameEvent) => {
      if (e.type === 'playEnd') ends.push({ time: e.time, description: e.description });
      if (e.type === 'plateAppearanceEnd' && e.time > 440 && e.time < 446) pa.push(e.result);
    });
    while (g.getState().time < 446) g.step(0.25);
    const play = ends.find((p) => p.time > 440 && p.time < 446);
    expect(play?.description).toMatch(/grounds into a triple play/);
    expect(pa).toEqual(['triple play']);
  });
});
