/**
 * The runtime passes (pose/neck.ts, pose/constrain.ts) must not add the one-frame hand / forearm flips the B1 game sweep found in jog / run:
 * the gait clips swept frame by frame through those passes have no more hand and forearm flips than the raw clips (the B0 baseline).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Agg } from './agg';
import { loadFiles, sweepClip } from './sweep';

const GAITS = ['walk', 'trot', 'jog', 'run', 'run_sprint', 'run_turn', 'run_turn_sprint'];
let files: Awaited<ReturnType<typeof loadFiles>>;
beforeAll(async () => {
  files = await loadFiles(['player_base']);
}, 60_000);

function count(constrain: boolean) {
  const agg = new Agg();
  const { name, rig, info } = files[0];
  for (const c of GAITS) if (rig.clips.has(c)) sweepClip(agg, name, rig, info, c, true, false, constrain);
  const n: Record<string, number> = { 'flip:Hand': 0, 'flip:ForeArm': 0 };
  for (const e of agg.list()) for (const [k, s] of Object.entries(e.kinds)) {
    const f = k.replace(/Left|Right/, '');
    if (f in n) n[f] += s.frames;
  }
  return n;
}

describe('runtime passes on the gait clips', () => {
  it('add no hand or forearm flips to the raw clips', () => {
    const raw = count(false), rt = count(true);
    expect(rt['flip:Hand']).toBeLessThanOrEqual(raw['flip:Hand']);
    expect(rt['flip:ForeArm']).toBeLessThanOrEqual(raw['flip:ForeArm']);
  });
});
