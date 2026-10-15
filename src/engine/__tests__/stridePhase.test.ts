import { AnimationClip, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import { strideClipTime, stripGroundTravel } from '../stridePhase';

describe('locomotion clips on the sim\'s footsteps', () => {
  // the run clip: right foot down at 0.326 s, left at 0.660 s, 0.667 s long
  const run = { L: 0.66, R: 0.326, duration: 0.667 };
  it('phase 0 is the last touchdown, phase 1 the next one (the foot the sim says lands next)', () => {
    // left lands next: the right one landed last
    expect(strideClipTime(run, 0, 0, false)).toBeCloseTo(0.326, 6);
    expect(strideClipTime(run, 0, 1, false)).toBeCloseTo(0.66, 6);
    expect(strideClipTime(run, 0, 0.5, false)).toBeCloseTo(0.493, 3);
    // right lands next: from the left touchdown, through the loop, to the right one
    expect(strideClipTime(run, 1, 0, false)).toBeCloseTo(0.66, 6);
    expect(strideClipTime(run, 1, 1, false)).toBeCloseTo(0.326, 6);
    expect(strideClipTime(run, 1, 0.5, false)).toBeCloseTo((0.66 + (0.326 + 0.667 - 0.66) / 2) % 0.667, 3);
  });
  it('a mirrored (left-handed) model shows the clip\'s right foot as his left', () => {
    expect(strideClipTime(run, 0, 1, true)).toBeCloseTo(0.326, 6);
    expect(strideClipTime(run, 1, 1, true)).toBeCloseTo(0.66, 6);
  });
  it('slide clips lose their travel along the ground, keep their height', () => {
    const clip = new AnimationClip('slide_feet', 1, [new VectorKeyframeTrack('mixamorigHips.position', [0, 0.5, 1], [0, 0.86, 0, 0.1, 0.4, 0.8, 0.2, 0.13, 1.62])]);
    stripGroundTravel(clip);
    stripGroundTravel(clip); // (once per shared clip)
    expect(Array.from(clip.tracks[0].values)).toEqual([0, 0.86, 0, 0, 0.4, 0, 0, 0.13, 0].map((v) => Math.fround(v)));
  });
});
