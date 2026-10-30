/**
 * The practice swings as the game draws them (src/engine/clipWarp.ts): the way back from the finish must not put the bat or a hand through the
 * body, and the hands must come back down slower than the clip laid on the hint linearly (the arms "snapping through the body", t-0036).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Agg } from './agg';
import { loadFiles, sweepClip } from './sweep';
import { sampleClip } from './glb';
import { B, fk, newLocals } from '../../src/engine/pose/skeleton';
import { Inertia } from '../../src/engine/pose/inertia';
import { WARPS, warpProgress, type Warp } from '../../src/engine/clipWarp';

let files: Awaited<ReturnType<typeof loadFiles>>;
beforeAll(async () => {
  files = await loadFiles(['player_base']);
}, 60_000);

const linear = (w: Warp): Warp => ({ ...w, knots: [[0, 0], [1, 1]], jump: undefined });

/** the hands' peak speed (m/s, 60 Hz) once the clip is past its finish */
function handsAfterFinish(w: Warp): number {
  const { rig } = files[0];
  const clip = rig.clips.get(w.clip)!;
  const n = Math.round(w.sec * 60), L = newLocals(), inert = new Inertia(), fin = WARPS[w.clip].knots[1][1];
  let prev: number[] | null = null, peak = 0, jumped = false;
  for (let i = 0; i <= n; i++) {
    const v = warpProgress(w, i / n);
    if (w.jump && !jumped && i / n >= w.jump.at) ((jumped = true), inert.start(L.lq, L.lp, w.jump.sec));
    sampleClip(clip, v * clip.duration, rig.rest, L);
    if (jumped) inert.apply(L, 1 / 60);
    const W = fk(L);
    const h = [B.LeftHand, B.RightHand].flatMap((b) => [W.wp[b * 3], W.wp[b * 3 + 1], W.wp[b * 3 + 2]]);
    if (prev && v > fin + 0.005) peak = Math.max(peak, Math.max(Math.hypot(h[0] - prev[0], h[1] - prev[1], h[2] - prev[2]), Math.hypot(h[3] - prev[3], h[4] - prev[4], h[5] - prev[5])) * 60);
    prev = h;
  }
  return peak;
}

function throughBody(w: Warp): number {
  const { name, rig, info } = files[0];
  const agg = new Agg();
  sweepClip(agg, name, rig, info, w.clip, false, false, true, w);
  let n = 0;
  for (const e of agg.list()) for (const [k, s] of Object.entries(e.kinds)) if (k === 'bat:body' || k.startsWith('body:hand-torso')) n += s.frames;
  return n;
}

describe('the practice swings as played', () => {
  for (const hint of ['ondeck_swing', 'batter_practice_swing']) {
    it(`${hint}: no bat or hand through the body, and the hands come back slower than the clip laid linearly`, () => {
      const w = WARPS[hint];
      expect(throughBody(linear(w))).toBeGreaterThan(0); // (the self-check: the clip itself has them)
      expect(throughBody(w)).toBe(0);
      expect(handsAfterFinish(w)).toBeLessThan(0.75 * handsAfterFinish(linear(w)));
    });
  }
});
