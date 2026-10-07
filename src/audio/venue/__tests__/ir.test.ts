import { describe, expect, it } from 'vitest';
import { stadiumIR, channelCorrelation, VENUES } from '../ir';
import { rt60, rt60Band, mono, onset } from '../analysis';

const SR = 22050;

describe('stadium impulse response', () => {
  const ir = stadiumIR(SR, 'normal');
  const m = mono(ir.ch);

  it('has the wanted broadband RT60 (1.8-2.6 s for the bowl) and a pre-delay', () => {
    const t = rt60(m, SR, 30);
    expect(t).toBeGreaterThan(1.6);
    expect(t).toBeLessThan(2.6);
    // nothing before the pre-delay (early reflections start after ~0.4 x pre-delay + 22 ms)
    const first = onset(m, SR, -60);
    expect(first).toBeGreaterThan(0.045);
    expect(first).toBeLessThan(0.1);
  });

  it('decays faster in the highs than in the lows', () => {
    const lo = rt60Band(m, SR, 250);
    const mid = rt60Band(m, SR, 1000);
    const hi = rt60Band(m, SR, 4000);
    expect(lo).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(hi);
    expect(hi).toBeLessThan(1.6);
    expect(lo).toBeGreaterThan(2);
  });

  it('presets order dry < normal < big', () => {
    const t = (p: 'dry' | 'normal' | 'big') => rt60(mono(stadiumIR(SR, p).ch), SR, 20);
    expect(t('dry')).toBeLessThan(t('normal'));
    expect(t('normal')).toBeLessThan(t('big'));
    expect(VENUES.dry.wet).toBeLessThan(VENUES.big.wet);
  });

  it('has a decorrelated stereo tail, unit energy, and is deterministic', () => {
    expect(Math.abs(channelCorrelation(ir))).toBeLessThan(0.3);
    let e = 0;
    for (const c of ir.ch) for (const v of c) e += v * v;
    expect(e / 2).toBeCloseTo(1, 3);
    const again = stadiumIR(SR, 'normal');
    expect(again.ch[0]).toEqual(ir.ch[0]);
    expect(ir.ch.every((c) => c.every(Number.isFinite))).toBe(true);
  });
});
