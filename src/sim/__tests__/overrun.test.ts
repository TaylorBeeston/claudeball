import { describe, expect, it } from 'vitest';
import { brakeDecel } from '../attributes';
import { fielders } from '../fielding';
import { createGame } from '../game';
import { stepPlayer } from '../movement';
import { lab } from './helpers';
import type { Ratings } from '../types';

/**
 * Overshoot of a stop goal: after a fielder first comes within 0.5 m of the spot he was sent to, how far past it he gets (along his velocity)
 * before he stops or turns; and the speed at which he first gets there.
 */
function episodes(seed: string, innings = 4) {
  const g = createGame({ seed, pace: 1 });
  const w = g._world;
  const over: number[] = [];
  const arrive: number[] = [];
  const st = new Map<string, { gx: number; gz: number; reached: boolean; maxOver: number }>();
  let n = 0;
  while (!g.over && w.inning < innings && n++ < 60 * 3600 * 2) {
    g.step(1 / 60);
    for (const F of fielders(w)) {
      const goal = F.goal;
      let s = st.get(F.info.id);
      if (!goal || w.phase !== 'inPlay') {
        if (s?.reached) over.push(s.maxOver);
        st.delete(F.info.id);
        continue;
      }
      if (!s || Math.hypot(goal.x - s.gx, goal.z - s.gz) > 1.0) {
        if (s?.reached) over.push(s.maxOver);
        s = { gx: goal.x, gz: goal.z, reached: false, maxOver: 0 };
        st.set(F.info.id, s);
      }
      if (goal.stop === false) continue;
      const d = Math.hypot(F.x - goal.x, F.z - goal.z);
      if (d < 0.5 && !s.reached) {
        s.reached = true;
        arrive.push(Math.hypot(F.vx, F.vz));
      }
      if (s.reached) {
        const sp = Math.hypot(F.vx, F.vz) || 1;
        const along = ((F.x - goal.x) * F.vx + (F.z - goal.z) * F.vz) / sp;
        s.maxOver = Math.max(s.maxOver, along > 0 ? d : 0);
      }
    }
  }
  return { over, arrive };
}

const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];

describe('overrun: people brake for the spot they are going to', () => {
  const runs = [episodes('ov-a'), episodes('ov-b'), episodes('ov-c')];
  const over = runs.flatMap((r) => r.over);
  const arrive = runs.flatMap((r) => r.arrive);

  it('overshoot past a stop goal is small: typically none, rarely more than a metre or two (distribution reported)', () => {
    expect(over.length).toBeGreaterThan(300);
    const dist = { p50: pct(over, 0.5), p90: pct(over, 0.9), p99: pct(over, 0.99), max: Math.max(...over) };
    console.log('fielder overshoot past a stop goal (m):', JSON.stringify(dist), 'n', over.length);
    expect(dist.p50).toBeLessThan(0.2);
    expect(dist.p90).toBeLessThan(0.8);
    expect(dist.p99).toBeLessThan(3.0);
    expect(dist.max).toBeLessThan(4.6);
  });

  it('they arrive at their spot with low speed (the braking started early enough)', () => {
    expect(arrive.length).toBeGreaterThan(300);
    console.log('speed on arrival at a stop goal (m/s): p50', pct(arrive, 0.5).toFixed(2), 'p90', pct(arrive, 0.9).toFixed(2));
    expect(pct(arrive, 0.5)).toBeLessThan(2.0);
    expect(pct(arrive, 0.9)).toBeLessThan(4.5);
  });

  it('braking is a human limit (5-7.5 m/s², about 6.6 for an average fielder), a bit better with fielding IQ and range', () => {
    const a = brakeDecel({ iq: 50, range: 50 } as Ratings);
    expect(a).toBeGreaterThanOrEqual(5);
    expect(a).toBeLessThanOrEqual(7);
    expect(brakeDecel({ iq: 80, range: 80 } as Ratings)).toBeGreaterThan(a);
    expect(brakeDecel({ iq: 80, range: 80 } as Ratings)).toBeLessThanOrEqual(7.5);
    expect(brakeDecel({ iq: 20, range: 20 } as Ratings)).toBeLessThan(a);
  });

  it('a fielder running to a spot slows down on the way in (deceleration during the approach)', () => {
    const l = lab('brake', { pace: 0 });
    const w = l.w;
    const F = fielders(w).find((p) => p.fieldPos === 'CF')!;
    F.x = 0;
    F.z = 60;
    F.vx = F.vz = 0;
    F.reactUntil = 0;
    F.legs = 0;
    F.goal = { x: 0, z: 100, stop: true, mul: 1 };
    let vmax = 0;
    let decel = 0;
    let prev = 0;
    for (let i = 0; i < 240 * 12; i++) {
      const v = Math.hypot(F.vx, F.vz);
      vmax = Math.max(vmax, v);
      if (F.z > 90) decel = Math.max(decel, (prev - v) * 240);
      prev = v;
      stepPlayer(F, w);
      if (Math.hypot(F.vx, F.vz) < 0.05 && F.z > 99) break;
    }
    expect(vmax).toBeGreaterThan(7);
    expect(decel).toBeGreaterThan(3); // he is braking on the way in
    expect(decel).toBeLessThan(8.6); // and never faster than a person can (the acceleration limit)
    expect(Math.abs(F.z - 100)).toBeLessThan(1.0); // and stops on the spot
  });
});
