import { describe, expect, it } from 'vitest';
import { apertureFor, circleOfConfusion, RackFocus, SHARP, sharpHalfDepth, slabFor } from '../autofocus';

describe('autofocus aperture', () => {
  it('keeps the requested slab sharp around the subject', () => {
    for (const [focus, half] of [[121, 5], [30, 4.5], [90, 14], [12, 2.8]] as const) {
      const a = apertureFor(focus, half);
      if (a < 1.2) {
        // the slab edges are exactly at the sharpness threshold, and a metre inside is sharp
        expect(circleOfConfusion(focus + half, focus, a)).toBeLessThanOrEqual(SHARP * 1.02);
        expect(circleOfConfusion(focus + half * 0.5, focus, a)).toBeLessThan(SHARP);
        expect(sharpHalfDepth(focus, a)).toBeCloseTo(half, 3);
      }
    }
  });
  it('gives deep focus (no blur) when there is no slab and bounds the aperture', () => {
    expect(apertureFor(100, 0)).toBe(0);
    expect(apertureFor(NaN, 5)).toBe(0);
    expect(apertureFor(100, 0.001)).toBeLessThanOrEqual(1.2);
    expect(slabFor('wide')).toBe(0);
    expect(slabFor('cutaway', { cutaway: 'wide' })).toBe(0);
    expect(slabFor('cutaway', { cutaway: 'crowd' })).toBeGreaterThan(0);
  });
  it('blurs the background more than the foreground, and never past the maximum', () => {
    const a = apertureFor(100, 5);
    const behind = circleOfConfusion(130, 100, a), inFront = circleOfConfusion(100 - (130 - 100) * 0.0 - 23, 100, a);
    expect(behind).toBeGreaterThan(0);
    // the same relative error in front of the subject is softer than behind it
    expect(circleOfConfusion(80, 100, a)).toBeLessThan(circleOfConfusion(125, 100, a));
    expect(inFront).toBeGreaterThanOrEqual(0);
    expect(circleOfConfusion(1e6, 100, 5, 0.012)).toBeLessThanOrEqual(0.012);
  });
  it('a high fly keeps the ground under it sharp: the slab grows with the ball height', () => {
    expect(slabFor('follow', { ballHeight: 40 })).toBeGreaterThan(slabFor('follow', { ballHeight: 2 }));
    expect(slabFor('follow', { ballHeight: 40 })).toBeGreaterThanOrEqual(40);
  });
});

describe('rack focus', () => {
  it('starts on the subject, settles on a new one in about a quarter second without overshoot', () => {
    const r = new RackFocus(0.22, 6);
    expect(r.step(100, 1 / 60)).toBe(100);
    let peak = 100;
    let settledAt = -1;
    for (let i = 1; i <= 120; i++) {
      const d = r.step(60, 1 / 60);
      peak = Math.min(peak, d);
      if (settledAt < 0 && Math.abs(d - 60) < 1) settledAt = i / 60;
    }
    expect(peak).toBeGreaterThanOrEqual(59.9); // never past the target
    expect(settledAt).toBeGreaterThan(0.15);
    expect(settledAt).toBeLessThan(0.6);
  });
  it('limits how fast the focus can be pulled', () => {
    const r = new RackFocus(0.05, 2);
    r.snap(50);
    const d = r.step(5000, 1 / 60);
    expect(d - 50).toBeLessThan(2 * 50 / 60 + 1e-6 + 1);
  });
  it('snaps on a cut and survives bad frames', () => {
    const r = new RackFocus();
    r.snap(40);
    expect(r.distance).toBe(40);
    for (const dt of [0, 5, 1e-9, 0.1]) expect(Number.isFinite(r.step(70, dt))).toBe(true);
  });
});
