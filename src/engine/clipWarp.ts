/**
 * Clip time warps: how far into a one-shot clip a sim hint is drawn, from the hint's progress. Most clips are laid on the sim's progress linearly
 * (clip time = progress x clip length); a clip listed here is laid on a curve instead, for one of two reasons:
 *
 * - the practice swings (on deck, and the batter's outside the box): the swing at the clip's own speed, the way back from the finish slower,
 *   over the rest of the hint. The clips were re-keyed (t-0038: assets/src/player_crew.py `_ondeck_swing`, player_rituals.py `_practice`) so
 *   the way back takes ~0.5 s and stays on the left side; before, the finish -> lowered-bat keys whipped the arms through the body in 2-3 frames
 *   and the warp spread them over most of the hint with a hold at the finish (t-0036).
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
 * The warped hints. Practice swings: the swing to its finish at the clip's own speed, then the way back (finish -> the bat lowered in front ->
 * ready) laid over the rest of the hint, ~0.7 of its keyed speed: the re-keyed way back still peaked at 6.6 m/s at the hands laid linearly,
 * above the 5.5 m/s the old warp held them to.
 */
export const WARPS: Record<string, Warp> = {
  // sim: 2.2 s on deck (dugout.ts), clip 1.833 s (44 frames, finish at frame 24 = 1.0 s)
  ondeck_swing: { clip: 'ondeck_swing', sec: 2.2, knots: [[0, 0], [1.0 / 2.2, 24 / 44], [1, 1]] },
  // sim: 2.0-2.2 s outside / in the box (tempo.ts), clip 1.667 s (40 frames, finish at frame 20 = 0.833 s)
  batter_practice_swing: { clip: 'batter_practice_swing', sec: 2.0, knots: [[0, 0], [0.8333 / 2.0, 20 / 40], [1, 1]] },
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
