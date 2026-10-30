import { describe, expect, it } from 'vitest';
import { CALL, FLY_LOWER, callWave, comfortGloveY, routineGlove } from '../flyCatch';

const gt = { x: 10, y: 2.45, z: 80 };

describe('routineGlove', () => {
  it('a fly ball coming down steeply is taken in front of the face, further down its own line', () => {
    const v = { x: 2, y: -25, z: 10 };
    const c = comfortGloveY(1.88);
    expect(c).toBeGreaterThan(1.8);
    expect(c).toBeLessThan(2.0);
    const g = routineGlove(gt, v, c);
    expect(g.y).toBeCloseTo(c, 5);
    // on the ball's line: the move is parallel to its velocity
    const d = { x: g.x - gt.x, y: g.y - gt.y, z: g.z - gt.z };
    expect(d.x / d.y).toBeCloseTo(v.x / v.y, 6);
    expect(d.z / d.y).toBeCloseTo(v.z / v.y, 6);
  });
  it('a pop-up drops almost straight into the glove', () => {
    const g = routineGlove(gt, { x: 0.5, y: -30, z: 1 }, 1.9);
    expect(g.y).toBeCloseTo(1.9, 5);
    expect(Math.hypot(g.x - gt.x, g.z - gt.z)).toBeLessThan(0.03);
  });
  it('a line drive coming in flat stays where the sim caught it (at most the slide limit)', () => {
    const v = { x: 0, y: -3, z: 30 };
    expect(routineGlove(gt, v, 1.9)).toBe(gt); // not falling fast enough to say where it goes
    const g = routineGlove(gt, { x: 0, y: -6, z: 30 }, 1.9);
    expect(Math.hypot(g.x - gt.x, g.z - gt.z)).toBeLessThanOrEqual(FLY_LOWER.maxSlide + 1e-9);
    expect(gt.y - g.y).toBeLessThan(0.1);
  });
  it('a ball still rising, or already low, is left alone; the drop is capped', () => {
    expect(routineGlove(gt, { x: 0, y: 5, z: 20 }, 1.9)).toBe(gt);
    const low = { x: 0, y: 1.5, z: 40 };
    expect(routineGlove(low, { x: 0, y: -20, z: 5 }, 1.9)).toBe(low);
    const high = { x: 0, y: 3.4, z: 40 };
    expect(routineGlove(high, { x: 0, y: -30, z: 0 }, 1.9).y).toBeCloseTo(3.4 - FLY_LOWER.maxDrop, 5);
  });
});

describe('callWave', () => {
  it('raises the arm, waves it, and brings it down', () => {
    expect(callWave(-0.1).w).toBe(0);
    expect(callWave(0).w).toBe(0);
    expect(callWave(CALL.up + 0.1).w).toBe(1);
    const waves = Array.from({ length: 40 }, (_, i) => callWave(CALL.up + (i / 40) * CALL.hold).wave);
    expect(Math.max(...waves)).toBeGreaterThan(0.9);
    expect(Math.min(...waves)).toBeLessThan(-0.9);
    expect(callWave(CALL.up + CALL.hold + CALL.down + 0.01).w).toBe(0);
  });
  it('the arm is down before the catch clip starts', () => {
    expect(callWave(0.5, CALL.clear).w).toBe(0);
    expect(callWave(0.5, 0.42).w).toBe(0);
    expect(callWave(0.5, 2).w).toBe(1);
    expect(callWave(0.5, CALL.clear + CALL.down / 2).w).toBeCloseTo(0.5, 5);
  });
});
