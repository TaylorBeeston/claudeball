/**
 * Clip time warps: how far into a one-shot clip a sim hint is drawn, from the hint's progress. Most clips are laid on the sim's progress linearly
 * (clip time = progress x clip length); a clip listed here is laid on a curve instead, for one of two reasons:
 *
 * - the clip's own timing is wrong for how the game uses it: the practice swings (on deck, and the batter's outside the box) go from the finish
 *   (bat wrapped behind the head) to the bat lowered across the front in 2-3 frames (assets/src/player_crew.py `_ondeck_swing` keys 24 -> 26,
 *   player_rituals.py `_practice` 20 -> 23): the arms and the bat whipped through the body in under 0.1 s, faster than the swing itself. The
 *   warp plays the swing at its own speed and holds the finish a beat; then the clip jumps to a later key (the bat already lowered in front) and the engine's
 *   inertialization (pose/inertia.ts) carries the finish pose down to it over `jump.sec`: the bad keys between are never drawn; the clip plays on to its ready pose. Only slowing
 *   them down (measured, tools/batter/clipcheck.ts) halved the speed but showed the bat and the hand through the body for longer.
 * - one clip is drawn two ways: `bench_sit_down` is `bench_stand_up` played backwards.
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
  /** at hint progress `at` the clip jumps to clip progress `to` (an inertialized blend of `sec` from the pose shown then) and plays on from
   *  there to its end over the rest of the hint, eased */
  jump?: { at: number; to: number; sec: number };
}

/**
 * The warped hints. Practice swings: the clip's frames 0..finish at the clip's own speed, a short hold in the finish, then the blend back to the
 * ready pose (finish = the clip's `finish` event / its length: 24/32 on deck, 20/31 in the box).
 */
export const WARPS: Record<string, Warp> = {
  // sim: 2.0 s on deck (dugout.ts), clip 1.333 s, finish at 1.0 s
  ondeck_swing: { clip: 'ondeck_swing', sec: 2.0, knots: [[0, 0], [0.5, 0.75], [0.56, 0.755, true]], jump: { at: 0.56, to: 28 / 32, sec: 0.5 } },
  // sim: 1.2 s outside / in the box (tempo.ts), clip 1.292 s, finish at 0.833 s; with the hold the hint is laid on 1.6 s (NOMINAL)
  batter_practice_swing: { clip: 'batter_practice_swing', sec: 1.6, knots: [[0, 0], [0.52, 0.645], [0.58, 0.65, true]], jump: { at: 0.58, to: 1, sec: 0.5 } },
  // the stand-up clip backwards: from standing at the rail down onto the seat
  bench_sit_down: { clip: 'bench_stand_up', sec: 1.167, knots: [[0, 1, true], [1, 0]] },
};

const smooth = (x: number) => x * x * (3 - 2 * x);

/** Clip progress (0..1) for a warped hint at hint progress `u` (0..1). */
export function warpProgress(w: Warp, u: number): number {
  const j = w.jump;
  if (j && u >= j.at) return j.to + (1 - j.to) * smooth(Math.min(1, (u - j.at) / Math.max(1e-6, 1 - j.at)));
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
