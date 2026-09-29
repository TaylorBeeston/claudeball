import { describe, expect, it } from 'vitest';
import { deliveryClip, deliveryClipTime, DELIVERY_FRAMES, gripFor, pitchBallPlace, planDelivery, SPEED_MAX, SPEED_MIN, windupSeconds } from '../pitchTiming';

describe('delivery timing', () => {
  it('matches the sim: 1.12 s windup / 0.84 s stretch, tempo-adjusted and clamped', () => {
    expect(windupSeconds(1, false)).toBeCloseTo(1.12, 6);
    expect(windupSeconds(1, true)).toBeCloseTo(0.84, 6);
    expect(windupSeconds(1.25, false)).toBeCloseTo(0.896, 6);
    expect(windupSeconds(9, false)).toBeCloseTo(0.896, 6);
    expect(windupSeconds(0.1, true)).toBeCloseTo(1.12, 6);
    expect(windupSeconds(1, true, 70)).toBeLessThan(0.84);
  });
  it('picks the clip and event times from style and stance', () => {
    const w = deliveryClip('overhand', false);
    expect(w.clip).toBe('pitch_overhand_windup');
    expect(w.release).toBeCloseTo(14 / 24, 6);
    expect(w.handBreak).toBeCloseTo(8 / 24, 6);
    const st = deliveryClip('sidearm', true);
    expect(st.clip).toBe('pitch_sidearm_stretch');
    expect(st.release).toBeCloseTo(9 / 24, 6);
    expect(deliveryClip('sidearm', false).release).toBeCloseTo(13 / 24, 6);
    expect(deliveryClip(undefined, false).clip).toBe('pitch_overhand_windup');
    for (const s of Object.keys(DELIVERY_FRAMES) as (keyof typeof DELIVERY_FRAMES)[]) {
      const f = DELIVERY_FRAMES[s];
      expect(f.windup[0]).toBeLessThan(f.windup[2]);
      expect(f.stretch[0]).toBeLessThan(f.stretch[2]);
    }
  });
  it('lands the clip release frame exactly on the end of the sim windup, for any tempo', () => {
    for (const style of ['overhand', 'three_quarter', 'sidearm', 'submarine'] as const) {
      for (const stretch of [false, true]) {
        for (const tempo of [0.75, 0.9, 1, 1.1, 1.25]) {
          const ev = deliveryClip(style, stretch);
          const dur = windupSeconds(tempo, stretch, 50);
          const plan = planDelivery(dur, ev.release);
          const t = deliveryClipTime(plan, dur);
          expect(t).not.toBeNull();
          expect(t!).toBeCloseTo(ev.release, 6);
          expect(plan.speed).toBeGreaterThanOrEqual(SPEED_MIN);
          expect(plan.speed).toBeLessThanOrEqual(SPEED_MAX);
        }
      }
    }
  });
  it('holds the rock / set pose first and never runs the clip backwards', () => {
    const ev = deliveryClip('overhand', false);
    const dur = windupSeconds(1, false);
    const plan = planDelivery(dur, ev.release);
    expect(plan.hold).toBeCloseTo(dur - ev.release, 6);
    expect(deliveryClipTime(plan, plan.hold * 0.5)).toBeNull();
    let prev = -1;
    for (let e = plan.hold; e <= dur + 0.5; e += 0.01) {
      const t = deliveryClipTime(plan, e)!;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
  it('speeds up when a hurried tempo leaves less time and bounds a very long hitch', () => {
    const ev = deliveryClip('overhand', false);
    const quick = planDelivery(0.4, ev.release);
    expect(quick.hold).toBe(0);
    expect(quick.speed).toBeCloseTo(ev.release / 0.4, 6);
    const slow = planDelivery(3, ev.release);
    expect(slow.speed).toBeGreaterThanOrEqual(SPEED_MIN);
    expect(deliveryClipTime(slow, 3)!).toBeCloseTo(ev.release, 6);
  });
  it('keeps the ball in the glove until the hand break, in the hand until release', () => {
    const ev = deliveryClip('three_quarter', false);
    expect(pitchBallPlace(null, ev)).toBe('glove');
    expect(pitchBallPlace(ev.handBreak - 0.01, ev)).toBe('glove');
    expect(pitchBallPlace(ev.handBreak + 0.01, ev)).toBe('hand');
    expect(pitchBallPlace(ev.release - 0.001, ev)).toBe('hand');
    expect(pitchBallPlace(ev.release + 0.001, ev)).toBe('world');
  });
  it('uses the 2-seam grip for two-seam style pitches only', () => {
    for (const t of ['FT', 'SI', 'CH', 'FS']) expect(gripFor(t)).toBe('Ball_Grip_2Seam');
    for (const t of ['FF', 'FC', 'SL', 'CU', 'SW', undefined]) expect(gripFor(t)).toBe('Ball_Grip');
  });
});
