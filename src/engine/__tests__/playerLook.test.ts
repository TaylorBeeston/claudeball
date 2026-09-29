import { describe, expect, it } from 'vitest';
import { computeLook, hashString, MODEL_HEIGHT, SKIN_TONES } from '../playerLook';

const app = (seed: number, over: Partial<{ skin: number; hairColor: number; hairStyle: number; facialHair: number }> = {}) => ({ skin: 2, hairColor: 1, hairStyle: 1, facialHair: 0, seed, ...over });
const ph = (heightM: number, weightKg: number, build: 'lean' | 'athletic' | 'stocky' | 'heavy') => ({ heightM, weightKg, build });

describe('computeLook', () => {
  it('is deterministic for the same player', () => {
    const a = computeLook(ph(1.85, 90, 'athletic'), app(12345), hashString('p1'));
    const b = computeLook(ph(1.85, 90, 'athletic'), app(12345), hashString('p1'));
    expect(a).toEqual(b);
  });
  it('scales the model from height, within sane bounds', () => {
    expect(computeLook(ph(MODEL_HEIGHT, 88, 'athletic'), app(1)).scale).toBeCloseTo(1, 6);
    expect(computeLook(ph(1.95, 95, 'athletic'), app(1)).scale).toBeGreaterThan(1.04);
    expect(computeLook(ph(1.6, 70, 'lean'), app(1)).scale).toBeGreaterThanOrEqual(0.88);
    expect(computeLook(ph(2.4, 120, 'heavy'), app(1)).scale).toBeLessThanOrEqual(1.14);
  });
  it('drives the body morphs from build and weight, never blending lean with stocky', () => {
    const lean = computeLook(ph(1.85, 72, 'lean'), app(2));
    expect(lean.morphs.build_lean).toBeGreaterThan(0.5);
    expect(lean.morphs.build_stocky).toBe(0);
    const heavy = computeLook(ph(1.85, 118, 'heavy'), app(2));
    expect(heavy.morphs.build_stocky).toBeGreaterThan(0.8);
    expect(heavy.morphs.build_lean).toBe(0);
    const ath = computeLook(ph(1.85, 92, 'athletic'), app(2));
    expect(ath.morphs.build_muscular).toBeGreaterThan(0.2);
    for (const l of [lean, heavy, ath]) for (const k of Object.keys(l.morphs)) {
      expect(l.morphs[k]).toBeGreaterThanOrEqual(0);
      expect(l.morphs[k]).toBeLessThanOrEqual(1);
    }
  });
  it('gives different seeds different faces', () => {
    const heads = new Set<string>();
    for (let s = 1; s <= 30; s++) {
      const l = computeLook(ph(1.85, 90, 'athletic'), app(s * 7919));
      heads.add([l.morphs.jaw_square, l.morphs.nose_large, l.morphs.ears_large, l.morphs.head_wide, l.morphs.head_narrow].map((v) => v.toFixed(2)).join());
    }
    expect(heads.size).toBeGreaterThan(25);
  });
  it('maps the sim appearance indices onto the palettes and nodes', () => {
    const l = computeLook(ph(1.85, 90, 'athletic'), app(5, { skin: 5, hairColor: 3, hairStyle: 0, facialHair: 2 }));
    expect(SKIN_TONES.indexOf(l.skin)).toBeGreaterThanOrEqual(5);
    expect(l.hairNode).toBe('Gear_Hair_Buzz');
    expect(['Gear_Beard_Full', 'Gear_Goatee', 'Gear_Mustache']).toContain(l.facialNode);
    expect(computeLook(ph(1.85, 90, 'athletic'), app(5, { facialHair: 1 })).facialNode).toBe('Gear_Beard_Stubble');
    expect(computeLook(ph(1.85, 90, 'athletic'), app(5, { facialHair: 0 })).facialNode).toBeNull();
    expect(computeLook(ph(1.85, 90, 'athletic'), app(5, { hairStyle: 3 })).hairNode).toBe('Gear_Hair_Long');
    // light-skinned players get light tones
    expect(SKIN_TONES.indexOf(computeLook(ph(1.85, 90, 'athletic'), app(5, { skin: 0 })).skin)).toBeLessThanOrEqual(8);
  });
  it('is robust to a missing physique / appearance', () => {
    const l = computeLook(undefined, undefined, 3);
    expect(l.scale).toBeCloseTo(1, 6);
    expect(l.hairNode).toBeTruthy();
  });
  it('varies accessories across a roster', () => {
    let eye = 0, wrist = 0, sleeve = 0, long = 0;
    for (let s = 1; s <= 200; s++) {
      const l = computeLook(ph(1.85, 90, 'athletic'), app(s * 2654435761));
      eye += +l.eyeBlack;
      wrist += +(l.wristbands.L || l.wristbands.R);
      sleeve += +(l.armSleeves.L || l.armSleeves.R);
      long += +(l.pantsNode === 'Pants_Long');
    }
    for (const n of [eye, wrist, sleeve, long]) {
      expect(n).toBeGreaterThan(5);
      expect(n).toBeLessThan(120);
    }
  });
});
