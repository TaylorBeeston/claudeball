import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { SHOULDER_X } from '../batting';
import { WALK_SPEED, WALKUP_SPEED } from '../dugout';
import { walkupStyle } from '../tempo';
import type { PlayerRT } from '../world';

type Tempo = 'broadcast' | 'standard' | 'quick';

/** Two innings at pace 1: every windup (is the batter set?) and every walk-up (from his call to his first windup: top speed, path, hints). */
function walkups(seed: string, tempo: Tempo) {
  const g = createGame({ seed, pace: 1, tempo, innings: 9 });
  const w = g._world;
  type Up = { top: number; past: number; hints: Set<string>; atEdge: boolean; t0: number };
  const ups: Up[] = [];
  let cur = null as Up | null; // (set by the event handlers)
  let crossed = false;
  let windups = 0, unset = 0;
  g.on('batterUp', () => {
    cur = { top: 0, past: 0, hints: new Set(), atEdge: false, t0: w.tick };
    crossed = false;
  });
  g.on('windup', () => {
    const b = w.batter!;
    const side = w.batStance === 'R' ? 1 : -1;
    windups++;
    if (Math.hypot(b.x - side * SHOULDER_X, b.z - 0.15) > 0.35 || Math.hypot(b.vx, b.vz) > 0.4) unset++;
    if (cur) ups.push(cur);
    cur = null;
  });
  let n = 0;
  while (!g.over && w.inning < 3 && n++ < 240 * 3600) {
    g.step(1 / 240);
    const b = w.batter;
    const u = cur;
    if (!u || !b || n % 4) continue;
    const side = w.batStance === 'R' ? 1 : -1;
    // (from 1.5 s after the call: a man called while he was still jogging in from the field slows to a walk first)
    if (w.tick - u.t0 > 360) u.top = Math.max(u.top, Math.hypot(b.vx, b.vz));
    if (side * b.x < 0.5) crossed = true;
    if (crossed) u.past = Math.max(u.past, side * b.x - 2.0);
    if (Math.hypot(b.x - side * 1.8, b.z + 0.15) < 0.5) u.atEdge = true;
    const s = g.getState().players.find((p) => p.id === b.info.id);
    if (s && w.tick - u.t0 > 360) u.hints.add(s.anim);
  }
  return { ups, windups, unset };
}

describe('the walk-up: a hitter walks to the edge of his box, goes through his routine there and steps in', () => {
  for (const tempo of ['broadcast', 'standard', 'quick'] as Tempo[]) {
    it(`${tempo}: walks (never runs) to the plate, without going past the far box; stops at the edge; is set in the box at every windup`, () => {
      const r = walkups(`walkup-${tempo}`, tempo);
      expect(r.ups.length).toBeGreaterThan(12);
      // he was in the box and still at every windup (the old code: also 0; the routine must not change that)
      expect(r.unset).toBe(0);
      // a walk (it was a sprint: 6.2 m/s at the median); a leadoff man the clock is catching jogs (3.2 m/s), rarely
      expect(r.ups.filter((u) => u.top > Math.max(WALK_SPEED, WALKUP_SPEED[tempo]) + 0.05).length / r.ups.length).toBeLessThan(0.1);
      for (const u of r.ups) {
        expect(u.top).toBeLessThanOrEqual(3.25);
        expect(u.past).toBeLessThan(0.3); // (it was 1.9 m past the far box, then a curve back)
        expect(u.hints.has('run')).toBe(false);
      }
      // the hitters come from the circle to the edge of the box and step in from there
      expect(r.ups.filter((u) => u.atEdge && u.hints.has('batter_step_in')).length / r.ups.length).toBeGreaterThan(0.9);
      if (tempo === 'broadcast') expect(r.ups.filter((u) => u.hints.has('batter_wait')).length).toBeGreaterThan(3);
    }, 120_000);
  }
});

describe('walk-up style', () => {
  it('is the same for the same man and the same trip, and varies across men', () => {
    const man = (seed: number) => ({ info: { appearance: { seed } } }) as unknown as PlayerRT;
    expect(walkupStyle(man(12345), 3)).toEqual(walkupStyle(man(12345), 3));
    const styles = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const st = walkupStyle(man(s * 7919), 1);
      styles.add(`${st.glance > 0}-${st.cleats}-${st.swingsFirst}`);
    }
    expect(styles.size).toBeGreaterThanOrEqual(6);
  });
});
