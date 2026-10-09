import { describe, expect, it } from 'vitest';
import { clockDisplay, clockText, violationCaption, VIOLATION_FLASH } from '../pitchClockView';
import type { PitchClockView } from '../types';

const clk = (o: Partial<PitchClockView> = {}): PitchClockView => ({ running: true, remainingSec: 12.3, limitSec: 15, kind: 'pitch', disengagementsLeft: 2, batterAlertBy: 8, timeoutAvailable: true, violation: null, ...o });
const st = (c: PitchClockView | null, o: { phase?: string; time?: number; runners?: [boolean, boolean, boolean] } = {}) => ({ pitchClock: c, phase: o.phase ?? 'prePitch', time: o.time ?? 100, runners: o.runners ?? ([false, false, false] as [boolean, boolean, boolean]) });

describe('pitch clock display', () => {
  it('shows whole seconds rounded up, like a stadium clock (m:ss from a minute)', () => {
    expect(clockText(12.3)).toBe('13');
    expect(clockText(15)).toBe('15');
    expect(clockText(0.2)).toBe('1');
    expect(clockText(0)).toBe('0');
    expect(clockText(-1)).toBe('0');
    expect(clockText(75)).toBe('1:15');
  });

  it('amber under 10 s, red under 5 s; the long clocks stay plain', () => {
    expect(clockDisplay(st(clk({ remainingSec: 12 }))).level).toBe('normal');
    expect(clockDisplay(st(clk({ remainingSec: 9.5 }))).level).toBe('amber');
    expect(clockDisplay(st(clk({ remainingSec: 4.2 }))).level).toBe('red');
    expect(clockDisplay(st(clk({ kind: 'break', remainingSec: 4, limitSec: 40 }))).level).toBe('normal');
    expect(clockDisplay(st(clk({ kind: 'betweenBatters', remainingSec: 3, limitSec: 30 }))).level).toBe('red');
  });

  it('hidden with no clock and while the ball is live; shown between pitches, in a time-out and in breaks', () => {
    expect(clockDisplay(st(null)).visible).toBe(false);
    expect(clockDisplay(st(clk({ running: false }), { phase: 'inPlay' })).visible).toBe(false);
    expect(clockDisplay(st(clk({ running: false }), { phase: 'windup' })).visible).toBe(false);
    expect(clockDisplay(st(clk())).visible).toBe(true);
    expect(clockDisplay(st(clk({ running: false }))).visible).toBe(true); // set, waiting for the pitcher to get the ball back
    const to = clockDisplay(st(clk({ running: false, kind: 'timeout', remainingSec: 6, limitSec: 15 })));
    expect(to.visible).toBe(true);
    expect(to.label).toBe('TIME');
    expect(clockDisplay(st(clk({ kind: 'break', remainingSec: 44, limitSec: 50 }), { phase: 'halfBreak' })).label).toBe('BREAK');
  });

  it('disengagement pips with a runner on only', () => {
    expect(clockDisplay(st(clk())).pips).toBeNull();
    expect(clockDisplay(st(clk({ disengagementsLeft: 1 }), { runners: [true, false, false] })).pips).toEqual([true, false]);
    expect(clockDisplay(st(clk({ disengagementsLeft: 0 }), { runners: [false, true, false] })).pips).toEqual([false, false]);
  });

  it('a violation flashes for a few seconds (even as the next play starts) and reads 0', () => {
    const v = { on: 'pitcher' as const, result: 'ball' as const, time: 100 };
    const d = clockDisplay(st(clk({ violation: v, running: false, remainingSec: 0 }), { time: 101, phase: 'inPlay' }));
    expect(d.flash).toBe(true);
    expect(d.visible).toBe(true);
    expect(d.text).toBe('0');
    expect(clockDisplay(st(clk({ violation: v }), { time: 100 + VIOLATION_FLASH + 0.1 })).flash).toBe(false);
    expect(violationCaption(v)).toMatch(/AUTOMATIC BALL/);
    expect(violationCaption({ on: 'batter', result: 'strike', time: 0 })).toMatch(/AUTOMATIC STRIKE/);
  });

  it('the key only changes when what is shown changes (the HUD and the park clocks redraw on it)', () => {
    const a = clockDisplay(st(clk({ remainingSec: 12.9 })));
    const b = clockDisplay(st(clk({ remainingSec: 12.1 })));
    const c = clockDisplay(st(clk({ remainingSec: 11.9 })));
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(b.key);
  });
});
