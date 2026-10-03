import { describe, expect, it } from 'vitest';
import { isComfortable, isOver, nextPreset } from '../tune';

const lim = { min: 'low', max: 'high' } as const;
const good = { tickMs: 4, intervalMs: 16.7 };
const meh = { tickMs: 9, intervalMs: 16.7 };
const bad = { tickMs: 15, intervalMs: 33 };

describe('start-up tuning decisions', () => {
  it('classifies measurements', () => {
    expect(isOver(bad)).toBe(true);
    expect(isOver(meh)).toBe(false);
    expect(isComfortable(good)).toBe(true);
    expect(isComfortable(meh)).toBe(false);
  });
  it('steps down while over budget, stops at the floor', () => {
    expect(nextPreset('high', bad, lim, 'start')).toBe('medium');
    expect(nextPreset('medium', bad, lim, 'down')).toBe('low');
    expect(nextPreset('low', bad, lim, 'down')).toBeNull();
  });
  it('steps up once when comfortable, never above the cap, and never twice', () => {
    expect(nextPreset('medium', good, lim, 'start')).toBe('high');
    expect(nextPreset('high', good, lim, 'start')).toBeNull();
    expect(nextPreset('high', good, lim, 'up')).toBeNull();
  });
  it('keeps the preset when neither over nor comfortable', () => {
    expect(nextPreset('medium', meh, lim, 'start')).toBeNull();
  });
  it('a step up that turns out over budget goes back down', () => {
    expect(nextPreset('high', bad, lim, 'up')).toBe('medium');
  });
});
