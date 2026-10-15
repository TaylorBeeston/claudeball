import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRig, sampleClip, type RigFile } from '../../../tools/jank/glb';
import { B, fk } from './skeleton';
import { measureJoints, restInfo, type RestInfo } from './limits';
import { qdist } from './qmath';
import { limitNeck, neckYaw } from './neck';

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

describe('look distribution (neck limiter)', () => {
  it('leaves a head inside its range untouched', () => {
    const L = at('idle', 0.5);
    expect(limitNeck(L, R)).toBe(0);
  });
  for (const [clip, f] of [['pitcher_look_runner', 0.62], ['swing', 0.58], ['batting_stance', 0.5], ['batter_practice_swing', 0.28]] as const) {
    it(`${clip}: the trunk takes the excess; the gaze and the feet stay`, () => {
      const L = at(clip, f);
      const w0 = fk(L, undefined, R.rest);
      const y0 = neckYaw(w0);
      const head0 = Array.from(w0.wq.subarray(B.Head * 4, B.Head * 4 + 4));
      const feet0 = [B.LeftFoot, B.RightFoot].map((i) => Array.from(w0.wp.subarray(i * 3, i * 3 + 3)));
      limitNeck(L, R);
      const w1 = fk(L, undefined, R.rest);
      const y1 = neckYaw(w1);
      expect(Math.abs(y1)).toBeLessThanOrEqual(Math.min(Math.abs(y0), 78.5));
      expect((qdist(head0, w1.wq, 0, B.Head * 4) * 180) / Math.PI).toBeLessThan(0.5);
      [B.LeftFoot, B.RightFoot].forEach((i, k) => {
        const p = Array.from(w1.wp.subarray(i * 3, i * 3 + 3));
        expect(Math.hypot(p[0] - feet0[k][0], p[1] - feet0[k][1], p[2] - feet0[k][2])).toBeLessThan(0.01);
      });
      const m = measureJoints(w1, R);
      expect(Math.abs(m['spine.yaw'])).toBeLessThan(50);
    });
  }
});
