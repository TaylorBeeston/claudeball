import { describe, expect, it } from 'vitest';
import { BallBody, DEFAULT_ENV, flightStep, newFlags, predictPath, stepBall } from '../ball';
import { DEFAULT_FENCE } from '../field';
import { DEG, MPH, RPM } from '../math';
import { Rng } from '../rng';

const env = DEFAULT_ENV(DEFAULT_FENCE);
const mk = (o: Partial<BallBody> = {}): BallBody => ({ x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, rolling: false, ...o });

/** Simulated batted ball: exit speed mph, launch angle deg, backspin rpm, straight to CF. Returns landing distance (m). */
function hitDistance(mph: number, launch: number, rpm: number, e = env): { dist: number; hang: number; apex: number } {
  const v = mph * MPH;
  // backspin for a ball moving toward +z: Magnus up => w x v up. w=(wx,0,0), v=(0,0,vz): w x v = (0, -wx*vz... ) plain
  const b = mk({ y: 1.0, vy: v * Math.sin(launch * DEG), vz: v * Math.cos(launch * DEG), wx: -rpm * RPM });
  let t = 0;
  let apex = 0;
  while (b.y > 0.0366 || b.vy > 0) {
    flightStep(b, 1 / 240, e);
    t += 1 / 240;
    apex = Math.max(apex, b.y);
    if (t > 15) break;
  }
  return { dist: b.z, hang: t, apex };
}

describe('ball flight', () => {
  it('drag shortens a fly ball vs vacuum', () => {
    const v = 45;
    const ang = 30 * DEG;
    const vac = (v * v * Math.sin(2 * ang)) / 9.80665;
    const d = hitDistance(v / MPH, 30, 0).dist;
    expect(d).toBeLessThan(vac * 0.75);
    expect(d).toBeGreaterThan(vac * 0.4);
  });

  it('backspin carries farther than no spin, topspin dives', () => {
    const none = hitDistance(100, 28, 0).dist;
    const back = hitDistance(100, 28, 2000).dist;
    const top = hitDistance(100, 28, -2000).dist;
    expect(back).toBeGreaterThan(none + 5);
    expect(top).toBeLessThan(none - 5);
  });

  it('a 100 mph / 28 degree drive travels a realistic ~350-410 ft', () => {
    const { dist } = hitDistance(100, 28, 1800);
    expect(dist / 0.3048).toBeGreaterThan(340);
    expect(dist / 0.3048).toBeLessThan(410);
  });

  it('Magnus sign: backspin fastball finishes higher than gravity+drag only', () => {
    // pitch toward -z at 93 mph; desired Magnus force upward => w = v_hat x up(=y)
    const v = 93 * MPH;
    const run = (spinRpm: number) => {
      const b = mk({ x: 0, y: 1.8, z: 16.8, vz: -v, vy: 0.5, wx: spinRpm * RPM });
      while (b.z > 0.2) flightStep(b, 1 / 240, env);
      return b.y;
    };
    // plain cross: w=(+wx,0,0) x v=(0,0,-vz) => (0*-vz - 0*0, 0*0 - wx*-vz... ) = (0, wx*vz', 0) up
    const noSpin = run(0);
    const back = run(2300);
    const top = run(-2300);
    expect(back).toBeGreaterThan(noSpin + 0.2);
    expect(top).toBeLessThan(noSpin - 0.2);
  });

  it('is deterministic and prediction matches simulation on flat ground', () => {
    const b = mk({ vx: 5, vy: 20, vz: 30, wx: -200 });
    const path = predictPath(b, env, 6, 1 / 240);
    const c = { ...b };
    const flags = newFlags();
    let t = 0;
    for (let i = 0; i < 480; i++) {
      stepBall(c, 1 / 240, env, null, flags);
      t += 1 / 240;
    }
    const s = path[480];
    expect(Math.abs(s.z - c.z)).toBeLessThan(0.05);
  });
});

describe('ground and wall', () => {
  it('a bounced ball loses energy and eventually rolls to rest', () => {
    const b = mk({ y: 0.0366, vy: -8, vz: 20 });
    const rng = new Rng(1);
    const flags = newFlags();
    let bounces = 0;
    for (let i = 0; i < 240 * 40; i++) {
      stepBall(b, 1 / 240, env, rng, flags, false);
      if (flags.bounced) bounces++;
    }
    expect(bounces).toBeGreaterThan(0);
    expect(b.rolling).toBe(true);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(0.1);
    expect(b.z).toBeGreaterThan(10);
  });

  it('backspin ball checks up on landing, topspin ball kicks forward', () => {
    const land = (wx: number) => {
      const b = mk({ y: 0.5, z: 0, vy: -10, vz: 15, wx });
      const rng: Rng | null = null;
      const flags = newFlags();
      for (let i = 0; i < 2000; i++) {
        stepBall(b, 1 / 240, env, rng, flags, false);
        if (flags.bounced) return b.vz;
      }
      return NaN;
    };
    expect(land(-300)).toBeLessThan(land(300));
  });

  it('a ball over the wall flags overFence, one below bounces back', () => {
    const flags = newFlags();
    const high = mk({ y: 8, z: 121, vz: 20, vy: 0 });
    let over = false;
    for (let i = 0; i < 240; i++) {
      stepBall(high, 1 / 240, env, null, flags);
      over ||= flags.overFence;
    }
    expect(over).toBe(true);
    const low = mk({ y: 1, z: 121, vz: 25, vy: 0 });
    let hit = false;
    for (let i = 0; i < 240; i++) {
      stepBall(low, 1 / 240, env, null, flags);
      hit ||= flags.wallHit;
    }
    expect(hit).toBe(true);
    expect(low.vz).toBeLessThan(0);
  });
});
