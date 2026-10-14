/**
 * Nobody sits on anybody: a reliever who came in and was taken out used to walk back to seat 0, where a position player already sat
 * (promo jank log P5: seed 153, bottom of the 9th, two bodies in one place in the home dugout). Every second of two whole games, the
 * seated players of a team are at least a seat's width apart.
 */
import { describe, expect, it } from 'vitest';
import { createGame } from '../game';

describe('bench seats', () => {
  for (const seed of [153, 7]) {
    it(`seed ${seed}: no two seated teammates share a seat`, () => {
      const g = createGame({ seed, tempo: 'standard', innings: 9 });
      let worst = Infinity;
      let where = '';
      while (!g.getState().gameOver && g.getState().time < 8 * 3600) {
        g.step(1);
        const s = g.getState();
        const seated = s.players.filter((p) => p.anim === 'bench_sit');
        for (let i = 0; i < seated.length; i++)
          for (let j = i + 1; j < seated.length; j++) {
            const a = seated[i], b = seated[j];
            if (Math.sign(a.pos.x) !== Math.sign(b.pos.x)) continue; // the other dugout
            const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
            if (d < worst) {
              worst = d;
              where = `${a.id} / ${b.id} at ${s.time.toFixed(0)}`;
            }
          }
      }
      expect(worst, where).toBeGreaterThan(0.6);
    });
  }
});
