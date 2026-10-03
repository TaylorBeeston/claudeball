import { describe, expect, it } from 'vitest';
import { contrastRatio, DECAL_SIZE, decalRange, fitText, jerseyPrint, jerseyTextColors, keyString, lastNameOf } from '../jerseyText';

describe('jersey names', () => {
  it('uses the last token, upper case, without a generational suffix', () => {
    expect(lastNameOf('Shane Martin')).toBe('MARTIN');
    expect(lastNameOf('Ken Griffey Jr.')).toBe('GRIFFEY');
    expect(lastNameOf('Luis De La Cruz')).toBe('CRUZ');
    expect(lastNameOf("Dan O'Neil")).toBe("O'NEIL");
    expect(lastNameOf('Madonna')).toBe('MADONNA');
    expect(lastNameOf('Bob Smith III')).toBe('SMITH');
    expect(lastNameOf('  ')).toBe('');
    expect(lastNameOf(undefined)).toBe('');
  });
});

describe('jersey colours', () => {
  it('picks a fill that reads on the jersey and an outline that reads against the fill', () => {
    for (const [jersey, trim] of [['#1d6b3c', '#f2c94c'], ['#ffffff', '#0a5ea8'], ['#e07a1f', '#1a1a1a'], ['#111111', '#222222'], ['#f2c94c', '#f2c94c']] as const) {
      const { fill, outline } = jerseyTextColors(jersey, trim);
      expect(contrastRatio(jersey, fill)).toBeGreaterThan(3);
      expect(outline).not.toBe(fill);
    }
    expect(jerseyTextColors('#ffffff', '#0a5ea8').fill).toBe('#14171c');
    expect(jerseyTextColors('#0a5ea8', '#ffffff').fill).toBe('#ffffff');
  });
});

describe('fitting', () => {
  const measure = (n: number) => (size: number) => n * size * 0.55;
  it('keeps short names at full size, condenses long ones, and shrinks only past the squeeze limit', () => {
    const box = { w: 480, h: 80 };
    const short = fitText(measure(5), box.w, box.h);
    expect(short.squeeze).toBe(1);
    expect(short.size).toBe(80);
    const long = fitText(measure(12), box.w, box.h);
    expect(long.squeeze).toBeLessThan(1);
    expect(long.squeeze).toBeGreaterThanOrEqual(0.62);
    expect(long.width).toBeLessThanOrEqual(box.w + 1e-6);
    const huge = fitText(measure(22), box.w, box.h);
    expect(huge.squeeze).toBe(0.62);
    expect(huge.size).toBeLessThan(80);
    expect(measure(22)(huge.size) * huge.squeeze).toBeLessThanOrEqual(box.w + 1);
  });
});

describe('prints and cache keys', () => {
  it('numbers share one texture across back, front and sleeve; a name needs a name', () => {
    const p = jerseyPrint('Shane Martin', 7, '#1d6b3c', '#f2c94c', 'high', false);
    expect(p.backName?.text).toBe('MARTIN');
    expect(p.backNumber).toBe(p.frontNumber);
    expect(p.backNumber).toBe(p.sleeveNumber);
    expect(p.backNumber?.text).toBe('7');
    expect(jerseyPrint(undefined, 12, '#fff', '#000', 'high', false).backName).toBeUndefined();
    expect(jerseyPrint('A B', undefined, '#fff', '#000', 'high', false).backNumber).toBeUndefined();
    expect(jerseyPrint('A B', 0, '#fff', '#000', 'high', false).backNumber?.text).toBe('0');
  });
  it('the same print has the same key; a different colour, size or handedness has not', () => {
    const a = jerseyPrint('Shane Martin', 7, '#1d6b3c', '#f2c94c', 'high', false).backName!;
    expect(keyString(a)).toBe(keyString(jerseyPrint('Shane Martin', 7, '#1d6b3c', '#f2c94c', 'high', false).backName!));
    expect(keyString(a)).not.toBe(keyString(jerseyPrint('Shane Martin', 7, '#ffffff', '#f2c94c', 'high', false).backName!));
    // two teams with dark jerseys and the same text colours share the texture
    expect(keyString(a)).toBe(keyString(jerseyPrint('Shane Martin', 7, '#0a5ea8', '#f2c94c', 'high', false).backName!));
    expect(keyString(a)).not.toBe(keyString(jerseyPrint('Shane Martin', 7, '#1d6b3c', '#f2c94c', 'low', false).backName!));
    expect(keyString(a)).not.toBe(keyString(jerseyPrint('Shane Martin', 7, '#1d6b3c', '#f2c94c', 'high', true).backName!));
  });
  it('textures get smaller and the small decals disappear on the cheaper tiers', () => {
    expect(DECAL_SIZE.low.name.w).toBeLessThan(DECAL_SIZE.high.name.w);
    expect(DECAL_SIZE.ultra.number.h).toBeGreaterThan(DECAL_SIZE.high.number.h);
    expect(decalRange('sleeveNumber', 'low')).toBe(0);
    expect(decalRange('sleeveNumber', 'high')).toBeGreaterThan(0);
    expect(decalRange('backNumber', 'high')).toBeGreaterThan(decalRange('frontNumber', 'high'));
  });
});
