import { describe, expect, it } from 'vitest';
import { createGame } from '../game';

describe('props: one bat at a time', () => {
  it('the swing bat and the dropped bat are never both shown (the swing bat stayed in the air at the end of the follow-through beside the dropped one)', () => {
    const g = createGame({ seed: 'props-1', pace: 1 });
    const w = g._world;
    let both = 0, dropped = 0, n = 0;
    while (!g.over && w.inning < 4 && n++ < 240 * 3000) {
      g.step(1 / 60);
      const b = g.getState().bat;
      if (b.dropped) dropped++;
      if (b.dropped && b.active) both++;
    }
    expect(dropped).toBeGreaterThan(0);
    expect(both).toBe(0);
  });
});
