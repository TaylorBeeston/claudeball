import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  LEGACY_SEED,
  STORAGE_KEY,
  clearSaved,
  clubFromParam,
  defaultSeed,
  loadSaved,
  parseParams,
  resolve,
  sanitize,
  saveSettings,
  seedFromText,
  shareQuery,
  shouldAutostart,
} from '../settings';
import { deviceQuality, type DeviceInfo } from '../device';
import { QUALITY, pixelRatioFor } from '../../engine/quality';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const ABBRS = ['POR', 'AUS', 'DEN', 'MEM'];

describe('settings store', () => {
  it('defaults when nothing is saved or the storage is missing / broken', () => {
    expect(resolve('', null, false, ABBRS).settings).toEqual(DEFAULT_SETTINGS);
    expect(resolve('', mem(), false, ABBRS).settings).toEqual(DEFAULT_SETTINGS);
    const broken = { getItem: () => { throw new Error('blocked'); } };
    expect(loadSaved(broken)).toEqual({});
    expect(loadSaved(mem({ [STORAGE_KEY]: '{not json' }))).toEqual({});
  });

  it('persists and restores, dropping malformed fields', () => {
    const st = mem();
    const s = { ...DEFAULT_SETTINGS, quality: 'high' as const, tod: 'night' as const, innings: 3, speed: 2 as const, chatter: 'low' as const };
    expect(saveSettings(st, s)).toBe(true);
    expect(resolve('', st, false, ABBRS).settings).toEqual(s);
    st.setItem(STORAGE_KEY, JSON.stringify({ quality: 'ludicrous', tod: 'dusk', innings: 12, speed: 3, replays: 'yes', hud: false }));
    expect(loadSaved(st)).toEqual({ tod: 'dusk', hud: false });
    clearSaved(st);
    expect(loadSaved(st)).toEqual({});
  });

  it('survives a storage that throws on write', () => {
    expect(saveSettings({ setItem: () => { throw new Error('quota'); }, removeItem: () => {} }, DEFAULT_SETTINGS)).toBe(false);
    expect(saveSettings(null, DEFAULT_SETTINGS)).toBe(false);
  });

  it('sanitize ignores non-objects', () => {
    expect(sanitize(null)).toEqual({});
    expect(sanitize('x')).toEqual({});
    expect(sanitize({ innings: 1.5 })).toEqual({});
  });
});

describe('URL parameters', () => {
  it('parses settings, match and flags', () => {
    const p = parseParams('?seed=12&away=den&home=3&innings=3&tod=dusk&quality=LOW&camera=free&replays=0&speed=4&hud=0&box=1&chatter=high&mock&noaudio', ABBRS);
    expect(p.settings).toEqual({ innings: 3, tod: 'dusk', quality: 'low', camera: 'free', replays: false, speed: 4, hud: false, box: true, chatter: 'high' });
    expect(p.match).toEqual({ seed: 12, away: 2, home: 3 });
    expect(p.flags).toMatchObject({ mock: true, noaudio: true, noassets: false, autostart: false });
    expect(p.fromUrl.has('seed')).toBe(true);
  });

  it('ignores invalid values instead of throwing', () => {
    const p = parseParams('?quality=ultra9&tod=noon&innings=0&speed=7&away=ZZZ&home=99&seed=', ABBRS);
    expect(p.settings).toEqual({});
    expect(p.match).toEqual({});
    expect(p.fromUrl.size).toBe(0);
  });

  it('URL beats saved beats default', () => {
    const st = mem({ [STORAGE_KEY]: JSON.stringify({ tod: 'night', innings: 3 }) });
    const r = resolve('?tod=dusk', st, false, ABBRS);
    expect(r.settings.tod).toBe('dusk');
    expect(r.settings.innings).toBe(3);
    expect(r.settings.quality).toBe('auto');
  });

  it('seeds: numbers stay, text is hashed stably, automation gets the legacy seed', () => {
    expect(seedFromText('12')).toBe(12);
    expect(seedFromText('derby')).toBe(seedFromText('derby'));
    expect(seedFromText('derby')).not.toBe(seedFromText('derbz'));
    expect(seedFromText('derby')).toBeGreaterThan(0);
    expect(defaultSeed(true)).toBe(LEGACY_SEED);
    expect(defaultSeed(false, () => 0.5)).toBe(500000);
    expect(resolve('', null, true, ABBRS).match.seed).toBe(LEGACY_SEED);
    expect(resolve('?seed=5', null, true, ABBRS).match.seed).toBe(5);
    expect(resolve('', null, false, ABBRS, () => 0.25).match.seed).toBe(250000);
  });

  it('club params: index, abbreviation, auto', () => {
    expect(clubFromParam('2', ABBRS)).toBe(2);
    expect(clubFromParam('aus', ABBRS)).toBe(1);
    expect(clubFromParam('auto', ABBRS)).toBe(-1);
    expect(clubFromParam('40', ABBRS)).toBeUndefined();
  });

  it('autostart: ?autostart, ?menu=0 and automation skip the menu; ?menu=1 forces it', () => {
    const f = (q: string) => parseParams(q).flags;
    expect(shouldAutostart(f(''), false)).toBe(false);
    expect(shouldAutostart(f('?autostart'), false)).toBe(true);
    expect(shouldAutostart(f('?menu=0'), false)).toBe(true);
    expect(shouldAutostart(f(''), true)).toBe(true);
    expect(shouldAutostart(f('?menu=1'), true)).toBe(false);
    expect(shouldAutostart(f('?autostart=0'), false)).toBe(false);
  });

  it('share link round-trips the match', () => {
    const q = shareQuery({ seed: 77, away: 2, home: -1 }, { ...DEFAULT_SETTINGS, innings: 3, tod: 'night' }, ABBRS);
    expect(q).toBe('seed=77&away=DEN&innings=3&tod=night');
    const r = resolve(`?${q}`, null, false, ABBRS);
    expect(r.match).toEqual({ seed: 77, away: 2, home: -1 });
    expect(r.settings).toMatchObject({ innings: 3, tod: 'night' });
  });
});

describe('device quality and pixel ratio', () => {
  const d = (o: Partial<DeviceInfo>): DeviceInfo => ({ coarse: false, shortSide: 1080, ...o });
  it('picks a starting preset per device class', () => {
    expect(deviceQuality(d({ coarse: true, shortSide: 390, memoryGb: 4 }))).toBe('low');
    expect(deviceQuality(d({ coarse: true, shortSide: 390, memoryGb: 8, cores: 8 }))).toBe('medium');
    expect(deviceQuality(d({ coarse: true, shortSide: 768 }))).toBe('medium');
    expect(deviceQuality(d({ gpu: 'Google SwiftShader' }))).toBe('low');
    expect(deviceQuality(d({ gpu: 'Intel(R) UHD Graphics 620' }))).toBe('medium');
    expect(deviceQuality(d({ gpu: 'NVIDIA GeForce RTX 4090' }))).toBe('high');
    expect(deviceQuality(d({ memoryGb: 2 }))).toBe('low');
    expect(deviceQuality(d({}))).toBe('high');
  });

  it('caps the pixel ratio: preset cap on desktop, a pixel budget on touch screens', () => {
    expect(pixelRatioFor(QUALITY.high, 2, 1920, 1080, false)).toBe(1.5);
    expect(pixelRatioFor(QUALITY.low, 2, 1920, 1080, false)).toBe(1);
    // phone: DPR 3 on a 390x844 screen, Low renders at 1.5 (0.74 MP) instead of 1
    const phone = pixelRatioFor(QUALITY.low, 3, 390, 844, true);
    expect(phone).toBe(1.5);
    expect(390 * 844 * phone * phone).toBeLessThan(0.9e6);
    // a tablet is held to its budget
    const tablet = pixelRatioFor(QUALITY.low, 2, 768, 1024, true);
    expect(768 * 1024 * tablet * tablet).toBeLessThanOrEqual(0.9e6 * 1.01);
    expect(pixelRatioFor(QUALITY.medium, 1, 390, 844, true)).toBe(1);
  });
});
