/**
 * Clip time warps: how far into a one-shot clip a sim hint is drawn, from the hint's progress. Most clips are laid on the sim's progress linearly
 * (clip time = progress x clip length); a clip listed here is laid on a curve instead, for one of two reasons:
 *
 * - the practice swings (on deck, and the batter's outside the box) are laid at the clip's own speed and their last pose is held for the rest of
 *   the hint: the clips were re-keyed (t-0038: assets/src/player_crew.py `_ondeck_swing`, player_rituals.py `_practice`) so the way back from the
 *   finish takes ~0.5 s and stays on the left side; before, the finish -> lowered-bat keys whipped the arms through the body in 2-3 frames and the
 *   warp here spread them over most of the hint (t-0036).
 * - one clip is drawn two ways: `bench_sit_down` is `bench_stand_up` played backwards, `batter_tap_cleats` is the cleat-tap part of `batter_step_out`.
 *
 * Pure: (progress 0..1) -> (clip progress 0..1). The jank gate sweeps the warped clips as the game plays them (tools/jank/check.ts `played`).
 */

/** (hint progress, clip progress) knots; `ease`: the segment from this knot to the next is eased in and out (no speed jump at either end); `'out'`:
 * eased out only (it leaves at twice its mean speed and comes to rest: after a linear segment at half its speed, no jump) */
export type Knot = [u: number, v: number, ease?: boolean | 'out'];

export interface Warp {
  /** the clip drawn for the hint */
  clip: string;
  /** seconds the hint lasts (the sim's), what `knots` are laid on */
  sec: number;
  knots: Knot[];
}

/**
 * The warped hints. Practice swings: the clip at its own speed (never faster: the shortest hint is the clip's length or more), its last frames
 * eased out to rest at the end of the hint.
 */
export const WARPS: Record<string, Warp> = {
  // sim: 2.0 s on deck (dugout.ts), clip 1.833 s (44 frames, finish at 1.0 s): frames 0-40 at the clip's speed, the last 4 eased out to rest
  // over the rest of the hint (twice their own time: no speed jump, no dead stop)
  ondeck_swing: { clip: 'ondeck_swing', sec: 2.0, knots: [[0, 0], [40 / 24 / 2.0, 40 / 44, 'out'], [1, 1]] },
  // sim: 1.75-1.95 s outside / in the box (tempo.ts), clip 1.667 s (40 frames, finish at 0.833 s): frames 0-38 at the clip's speed, the last 2 eased out
  batter_practice_swing: { clip: 'batter_practice_swing', sec: 1.75, knots: [[0, 0], [38 / 24 / 1.75, 38 / 40, 'out'], [1, 1]] },
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
    return v0 + (v1 - v0) * (ease === 'out' ? 1 - (1 - x) * (1 - x) : ease ? smooth(x) : x);
  }
  return k[k.length - 1][1];
}
