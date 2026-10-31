/**
 * Clip time warps: how far into a one-shot clip a sim hint is drawn, from the hint's progress. Most clips are laid on the sim's progress linearly
 * (clip time = progress x clip length); a clip listed here is laid on a curve instead, for one of two reasons:
 *
 * - the clip's own timing is wrong for how the game uses it: the practice swings (on deck, and the batter's outside the box) go from the finish
 *   (bat wrapped behind the head) to the bat lowered across the front in 2-3 frames (assets/src/player_crew.py `_ondeck_swing` keys 24 -> 26,
 *   player_rituals.py `_practice` 20 -> 23): the arms and the bat whipped through the body in under 0.1 s, faster than the swing itself. The
 *   warp plays the swing at its own speed, holds the finish a beat, and spreads the way back over the rest of the hint, eased. (Jumping past
 *   those keys through an inertialized blend measured better in Node, but in the game the elbow-clearance swivel (gltfCharacter armClear)
 *   fought the blended arm and whirled it round at 30-180 m/s: the keys themselves need the re-key, see the report of t-0036.)
 * - one clip is drawn two ways: `bench_sit_down` is `bench_stand_up` played backwards, `batter_tap_cleats` is the cleat-tap part of `batter_step_out`.
 *
 * Pure: (progress 0..1) -> (clip progress 0..1). The jank gate sweeps the warped clips as the game plays them (tools/jank/check.ts `played`).
 */

/** (hint progress, clip progress) knots; `ease`: the segment from this knot to the next is eased in and out (no speed jump at either end) */
export type Knot = [u: number, v: number, ease?: boolean];

export interface Warp {
  /** the clip drawn for the hint */
  clip: string;
  /** seconds the hint lasts (the sim's), what `knots` are laid on */
  sec: number;
  knots: Knot[];
}

/**
 * The warped hints. Practice swings: the clip's frames 0..finish at the clip's own speed, a short hold in the finish, then the fast keys (finish ->
 * the bat lowered across the front: 24 -> 28 on deck, 20 -> 23 -> 26 in the box) over most of the rest of the hint, and the last keys back to the
 * ready pose; each segment eased (finish = the clip's `finish` event / its length: 24/32, 20/31).
 */
export const WARPS: Record<string, Warp> = {
  // sim: 2.0 s on deck (dugout.ts), clip 1.333 s, finish at 1.0 s
  ondeck_swing: { clip: 'ondeck_swing', sec: 2.0, knots: [[0, 0], [0.5, 0.75], [0.58, 0.76, true], [0.88, 28 / 32, true], [1, 1, true]] },
  // sim: 2.0 s outside / in the box (tempo.ts), clip 1.292 s, finish at 0.833 s; its fastest keys (20 -> 23) get their own slow segment
  batter_practice_swing: { clip: 'batter_practice_swing', sec: 2.0, knots: [[0, 0], [0.4165, 0.645], [0.45, 0.65, true], [0.66, 23 / 31, true], [0.82, 26 / 31, true], [1, 1, true]] },
  // the cleat taps of the step-out clip (frames 17-34: three taps, then the bat back up), for a hitter already standing outside the box
  batter_tap_cleats: { clip: 'batter_step_out', sec: 0.75, knots: [[0, 17 / 34], [1, 1]] },
  // the stand-up clip backwards: from standing at the rail down onto the seat
  bench_sit_down: { clip: 'bench_stand_up', sec: 1.167, knots: [[0, 1, true], [1, 0]] },
  // standing at the rail: the stand-up clip's last frame (the look-at keeps the head alive)
  bench_stand: { clip: 'bench_stand_up', sec: 1, knots: [[0, 1], [1, 1]] },
};

const smooth = (x: number) => x * x * (3 - 2 * x);

/** Clip progress (0..1) for a warped hint at hint progress `u` (0..1). */
export function warpProgress(w: Warp, u: number): number {
  const k = w.knots;
  if (u <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) {
    const [u0, v0, ease] = k[i], [u1, v1] = k[i + 1];
    if (u > u1) continue;
    const x = u1 > u0 ? (u - u0) / (u1 - u0) : 1;
    return v0 + (v1 - v0) * (ease ? smooth(x) : x);
  }
  return k[k.length - 1][1];
}
