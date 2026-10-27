import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, type RigFile } from '../../../tools/jank/glb';
import { B, fk } from './skeleton';
import { restInfo, type RestInfo } from './limits';
import { qrot } from './qmath';
import { LOOK, applyLook, chestLean, gazeOf, headRoll, lookFrame, lookInput, neckPitch, yawPitchIn } from './look';
import { measureJoints } from './limits';
import { lookTarget } from '../headLook';

let rig: RigFile, R: RestInfo;
beforeAll(async () => {
  rig = await loadRig(path.join(path.resolve(__dirname, '../../..'), 'assets/optimized/players/player_base.glb'));
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  R = restInfo(rw);
});
const at = (clip: string, f: number) => {
  const c = rig.clips.get(clip)!;
  return sampleClip(c, f * c.duration, rig.rest);
};
const DEG = Math.PI / 180;

describe('head look-at in a level frame', () => {
  it('the ready crouches lean the chest far forward (the case that rolled the head)', () => {
    for (const clip of ['field_ready_hands_knees', 'field_ready_infield', 'coach_ready']) expect(chestLean(fk(at(clip, 0.5), undefined, R.rest))).toBeGreaterThan(35);
  });
  // a target at head height (and a ball on the ground ahead) at these bearings from the chest's heading, 20 m out
  for (const clip of ['field_ready_hands_knees', 'field_ready_infield', 'coach_ready', 'catcher_crouch', 'ump_ready', 'batting_stance', 'idle']) {
    for (const [bearing, drop] of [[0, 0], [45, 0], [-45, 0], [90, 0], [-90, 0], [60, 1.5], [-30, -3]] as const) {
      it(`${clip}: looking ${bearing} deg ${drop > 0 ? 'down' : drop < 0 ? 'up' : 'across'} keeps the head level and points it at the target`, () => {
        const L = at(clip, 0.5);
        const w0 = fk(L, undefined, R.rest);
        const f = lookFrame(w0);
        const h = w0.wp.subarray(B.Head * 3, B.Head * 3 + 3);
        const c = Math.cos(bearing * DEG), s = Math.sin(bearing * DEG);
        const T = [h[0] + 20 * (f.fwd[0] * c + f.left[0] * s), h[1] - drop, h[2] + 20 * (f.fwd[2] * c + f.left[2] * s)];
        const li = lookInput(L, R, T);
        const t = lookTarget(li.dx, li.dy, li.dz, li.clipYaw, li.clipPitch);
        expect(t.valid).toBe(true);
        const p0 = t.pitch;
        t.pitch = neckPitch(t.pitch, t.yaw, li);
        applyLook(L, R, t.yaw, t.pitch, t.yaw * 0.25);
        const w1 = fk(L, undefined, R.rest);
        // level: a few degrees of tilt into the turn at most (the clips themselves hold the head level)
        expect(Math.abs(headRoll(w1))).toBeLessThan(6);
        // the gaze turned by exactly the offset (yaw about the vertical, pitch off the horizon) in the level frame; inside the neck's range
        // (no clamp: the eyes cover the rest) that is on the target
        const got = yawPitchIn(f, gazeOf(w1));
        expect(Math.abs(got[0] - li.clipYaw - t.yaw) / DEG).toBeLessThan(0.5);
        expect(Math.abs(got[1] - li.clipPitch - t.pitch) / DEG).toBeLessThan(0.5);
        const want = yawPitchIn(f, [T[0] - w0.wp[B.Head * 3], T[1] - w0.wp[B.Head * 3 + 1], T[2] - w0.wp[B.Head * 3 + 2]]);
        const clamped = p0 !== t.pitch || Math.abs(want[1] - li.clipPitch) > 34 * DEG || Math.abs(want[0]) > 114 * DEG || Math.abs(want[0] - li.clipYaw) > 114 * DEG;
        if (!clamped) {
          // the head moved a little (the neck and the chest turned): measured from where it is now
          const now = yawPitchIn(f, [T[0] - w1.wp[B.Head * 3], T[1] - w1.wp[B.Head * 3 + 1], T[2] - w1.wp[B.Head * 3 + 2]]);
          expect(Math.abs(got[0] - now[0]) / DEG).toBeLessThan(1.5);
          expect(Math.abs(got[1] - now[1]) / DEG).toBeLessThan(1.5);
        }
        // the neck shares the turn: it moved, but less than the head
        const nz = qrot(w1.aq, 0, 0, 1, [0, 0, 0], B.Neck * 4), nz0 = qrot(w0.aq, 0, 0, 1, [0, 0, 0], B.Neck * 4);
        const neckTurn = Math.acos(Math.min(1, nz[0] * nz0[0] + nz[1] * nz0[1] + nz[2] * nz0[2])) / DEG;
        if (Math.abs(bearing) >= 45) expect(neckTurn).toBeGreaterThan(5);
      });
    }
  }
  for (const clip of ['field_ready_hands_knees', 'field_ready_infield', 'catcher_crouch', 'coach_ready']) {
    it(`${clip}: looking up at a pop-up keeps the head inside the neck's range from the chest (the eyes do the rest)`, () => {
      for (const bearing of [0, 60]) {
        const L = at(clip, 0.5);
        const w0 = fk(L, undefined, R.rest);
        const clipNeck = measureJoints(w0, R)['neck.pitch'];
        const f = lookFrame(w0);
        const h = w0.wp.subarray(B.Head * 3, B.Head * 3 + 3);
        const c = Math.cos(bearing * DEG), s = Math.sin(bearing * DEG);
        const li = lookInput(L, R, [h[0] + 6 * (f.fwd[0] * c + f.left[0] * s), h[1] + 25, h[2] + 6 * (f.fwd[2] * c + f.left[2] * s)]);
        const t = lookTarget(li.dx, li.dy, li.dz, li.clipYaw, li.clipPitch);
        applyLook(L, R, t.yaw, neckPitch(t.pitch, t.yaw, li), t.yaw * 0.25);
        const m = measureJoints(fk(L, undefined, R.rest), R);
        // no further back than the range, or than the clip already holds it (the hands-on-knees crouch is ~80 deg back with a level head)
        expect(m['neck.pitch']).toBeGreaterThan(Math.min(clipNeck, -LOOK.up) - 8);
        expect(Math.abs(m['neck.roll'])).toBeLessThan(45);
      }
    });
  }
  it('no offset leaves the pose untouched', () => {
    const L = at('field_ready_infield', 0.3);
    expect(applyLook(L, R, 0, 0, 0)).toBe(0);
  });
  it('tilts the head a little into the turn, ear down on the side it turns to', () => {
    const L = at('idle', 0.5);
    applyLook(L, R, 80 * DEG, 0);
    // turning to the model's left (+yaw): the left ear dips
    expect(headRoll(fk(L, undefined, R.rest))).toBeLessThan(-2);
  });
});
