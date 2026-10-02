import { describe, expect, it } from 'vitest';
import { expand, say, tidy, variants } from '../grammar';
import { mulberry32 } from '../../dsp';

describe('grammar', () => {
  it('chooses, nests, fills slots and tidies', () => {
    const r = mulberry32(1);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(expand('{Strike|Strike three} {called|swinging}, $b {walks|{trudges|heads} back} to the dugout.', { b: 'Vance' }, r)!);
    expect(seen.size).toBeGreaterThan(6);
    for (const s of seen) expect(s).toMatch(/^Strike( three)? (called|swinging), Vance (walks|trudges|heads) ?(back )?(back )?to the dugout\.$/);
  });
  it('optional parts appear about half the time', () => {
    const r = mulberry32(2);
    let n = 0;
    for (let i = 0; i < 400; i++) if (expand('Ball one[, low and away].', {}, r)!.includes('low')) n++;
    expect(n).toBeGreaterThan(140);
    expect(n).toBeLessThan(260);
  });
  it('a missing slot yields null, never a made-up fact', () => {
    expect(expand('$b hits it to $dir.', { b: 'Vance' }, () => 0.5)).toBeNull();
    expect(expand('$b hits it.', { b: 'Vance', dir: undefined }, () => 0.5)).toBe('Vance hits it.');
  });
  it('say() falls through to a template whose slots exist', () => {
    expect(say(['$x is out.', 'Out!'], {}, mulberry32(3))).toBe('Out!');
  });
  it('capitalises sentence starts and fixes spacing', () => {
    expect(tidy('ball one .  low and away  !')).toBe('Ball one. Low and away!');
    expect(tidy('he fouls it off,. strike one')).toBe('He fouls it off. Strike one');
  });
  it('counts variants', () => {
    expect(variants('{a|b|c}')).toBe(3);
    expect(variants('{a|b} [c] {d|e|f}')).toBe(12);
  });
});
