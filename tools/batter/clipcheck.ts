/**
 * The practice swings as the game draws them (src/engine/clipWarp.ts) against the clip laid on the hint linearly (as before the warp): violations
 * by kind and the hands' peak speed after the finish, raw and through the runtime passes.
 *   npx tsx tools/batter/clipcheck.ts
 */
import { Agg } from '../jank/agg';
import { loadFiles, sweepClip } from '../jank/sweep';
import { loadRig, sampleClip } from '../jank/glb';
import { B, fk, newLocals } from '../../src/engine/pose/skeleton';
import { Inertia } from '../../src/engine/pose/inertia';
import { WARPS, warpProgress, type Warp } from '../../src/engine/clipWarp';
import path from 'node:path';
import { ROOT } from '../jank/sweep';

const lin = (w: Warp): Warp => ({ ...w, knots: [[0, 0], [1, 1]], jump: undefined });

async function main() {
  const [{ name, rig, info }] = await loadFiles(['player_base']);
  const r = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  for (const hint of ['ondeck_swing', 'batter_practice_swing']) {
    const w = WARPS[hint];
    const clip = r.clips.get(w.clip)!;
    for (const [label, ww] of [['linear', lin(w)], ['warped', w]] as const) {
      const agg = new Agg();
      sweepClip(agg, name, rig, info, w.clip, false, false, false, ww);
      sweepClip(agg, name, rig, info, w.clip, false, false, true, ww);
      // the hands' speed (m/s) at 60 Hz once the swing is past its finish
      const n = Math.round(w.sec * 60), L = newLocals();
      let prev: number[] | null = null, peak = 0, peakAll = 0;
      const fin = w.knots[1][1];
      const inert = new Inertia();
      let jumped = false;
      for (let i = 0; i <= n; i++) {
        const v = warpProgress(ww, i / n);
        if (ww.jump && !jumped && i / n >= ww.jump.at) ((jumped = true), inert.start(L.lq, L.lp, ww.jump.sec));
        sampleClip(clip, v * clip.duration, r.rest, L);
        if (jumped) inert.apply(L, 1 / 60);
        const W = fk(L);
        const h = [B.LeftHand, B.RightHand].flatMap((b) => [W.wp[b * 3], W.wp[b * 3 + 1], W.wp[b * 3 + 2]]);
        if (prev) {
          const s = Math.max(Math.hypot(h[0] - prev[0], h[1] - prev[1], h[2] - prev[2]), Math.hypot(h[3] - prev[3], h[4] - prev[4], h[5] - prev[5])) * 60;
          peakAll = Math.max(peakAll, s);
          if (v > fin + 0.005) peak = Math.max(peak, s);
        }
        prev = h;
      }
      for (const e of agg.list()) {
        const k = Object.entries(e.kinds).filter(([k]) => /spike|flip|bat:body|hand-torso|behind/.test(k)).map(([k, s]) => `${k}:${s.frames}`);
        console.log(`${hint.padEnd(22)} ${label.padEnd(7)} ${e.src.padEnd(19)} frames ${e.frames} bad ${e.bad} score ${e.score.toFixed(2)}  ${k.join(' ')}`);
      }
      console.log(`${hint.padEnd(22)} ${label.padEnd(7)} hands peak ${peakAll.toFixed(1)} m/s, after the finish ${peak.toFixed(1)} m/s`);
    }
  }
}
if (!process.argv.includes("--frames")) main();

// --frames <hint>: every frame's violations of the warped clip (u = hint progress)
if (process.argv.includes('--frames')) {
  void (async () => {
    const { validateFrame, newTrack, gripBat } = await import('../jank/validate');
    const { BAT_CLIPS, clipFlags } = await import('../jank/clips');
    const hint = process.argv[process.argv.indexOf('--frames') + 1];
    const [{ rig, info }] = await loadFiles(['player_base']);
    const w = WARPS[hint], clip = rig.clips.get(w.clip)!;
    const n = Math.round(w.sec * 60), L = newLocals(), tr = newTrack(), inert = new Inertia();
    let jumped = false;
    for (let i = 0; i <= n; i++) {
      const v = warpProgress(w, i / n);
      if (w.jump && !jumped && i / n >= w.jump.at) ((jumped = true), inert.start(L.lq, L.lp, w.jump.sec));
      sampleClip(clip, v * clip.duration, rig.rest, L);
      if (jumped) inert.apply(L, 1 / 60);
      const out: { kind: string; excess: number }[] = [];
      validateFrame({ L, model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ground: () => 0, dt: i ? 1 / 60 : 0, ...clipFlags(w.clip), bat: gripBat(L, info, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], BAT_CLIPS[w.clip]) }, info, tr, out as never);
      const k = out.filter((x) => /spike|bat:body|hand-torso|behind/.test(x.kind)).map((x) => `${x.kind}:${x.excess.toFixed(2)}`);
      if (k.length) console.log(i, (i / n).toFixed(3), (v * clip.duration).toFixed(3), k.join(' '));
    }
  })();
}
