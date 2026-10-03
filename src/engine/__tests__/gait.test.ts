import { describe, expect, it } from 'vitest';
import { wantsGait } from '../gltfCharacter';

describe('locomotion wins over stationary poses', () => {
  it('a fielder in a ready / idle pose that is travelling gets a gait from ~0.45 m/s, with hysteresis', () => {
    expect(wantsGait('idle', 'left', 0.2, false)).toBe(false);
    expect(wantsGait('idle', 'left', 0.5, false)).toBe(true);
    expect(wantsGait('idle', 'left', 0.35, true)).toBe(true); // already moving: keeps the gait down to 0.3
    expect(wantsGait('idle', 'left', 0.25, true)).toBe(false);
  });
  it('the shufflers (batter, catcher, pitcher, umpires) need a clearly higher speed', () => {
    for (const role of ['batter', 'catcher', 'pitcher', 'umpire']) {
      expect(wantsGait('idle', role, 0.7, false)).toBe(false);
      expect(wantsGait('idle', role, 1.2, false)).toBe(true);
    }
    expect(wantsGait('ump_ready', 'umpire', 4.5, false)).toBe(true);
  });
  it('crew, bench and routine poses give way too (a transfer only when really travelling)', () => {
    for (const h of ['ondeck_ready', 'coach_ready', 'ballkid_sit', 'bench_sit', 'catch_ready', 'mound_talk', 'ump_huddle']) expect(wantsGait(h, 'bench', 1.5, false)).toBe(true);
    expect(wantsGait('transfer', 'short', 1.0, false)).toBe(false);
    expect(wantsGait('transfer', 'short', 4.8, false)).toBe(true);
  });
  it('a walk hint that is really a sprint is replaced; a real walk stays a walk; actions are never overridden', () => {
    expect(wantsGait('walk', 'left', 1.5, false)).toBe(false);
    expect(wantsGait('walk', 'left', 6.2, false)).toBe(true);
    expect(wantsGait('manager_walk', 'manager', 1.6, false)).toBe(false);
    for (const h of ['throw', 'catch_fly', 'slide', 'swing', 'tag_glove', 'windup', 'pitch', 'field_grounder']) expect(wantsGait(h, 'short', 6, false)).toBe(false);
  });
});
