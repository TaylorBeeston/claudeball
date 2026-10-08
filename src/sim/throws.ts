/**
 * The short / easy throwing motions and how hard they go: an underhand flip up close, a short-arm sidearm flick, a relaxed overhand return, an underhand roll
 * along the ground, and the full throw. Pure functions (shared by the casual returns, the plays' throws and the warm-ups).
 */
import { clamp } from './math';

/** Speed (m/s) of a casual return: 25–40 by distance. */
export const casualSpeed = (dist: number) => clamp(24 + 0.3 * dist, 25, 40);

/** The short / easy throwing motions (their clips; right-handed, glove on the other hand). */
export type ThrowMotion = 'toss_underhand' | 'toss_sidearm_short' | 'throw_casual' | 'roll_ball' | 'throw';
/** Seconds from the start of each motion's clip to its release frame (the manifest's `events_s.release`): the hint starts this long before the ball leaves. */
export const RELEASE_S: Record<ThrowMotion, number> = { toss_underhand: 11 / 24, toss_sidearm_short: 9 / 24, throw_casual: 10 / 24, roll_ball: 14 / 24, throw: 13 / 24 };
/**
 * How a man gets the ball to a teammate `dist` metres away: close by, an underhand flip (casual or in a play); a casual return from 8-25 m is a short-arm
 * sidearm flick and from further a relaxed overhand throw; a play's throw from further than a flip is a real throw.
 */
export function throwMotion(dist: number, casual: boolean): ThrowMotion {
  if (dist < 8) return 'toss_underhand';
  if (!casual) return 'throw';
  return dist < 25 ? 'toss_sidearm_short' : 'throw_casual';
}
/** Speed (m/s) of an easy toss by motion: an underhand flip is a soft lob (7-13 m/s), the others the casual speeds. */
export const tossSpeed = (motion: ThrowMotion, dist: number) => (motion === 'toss_underhand' ? clamp(5 + 0.9 * dist, 7, 13) : casualSpeed(dist));
/** Release height above the ground (m) by motion: an underhand flip leaves from about the waist. */
export const releaseHeight = (motion: ThrowMotion) => (motion === 'toss_underhand' ? 0.95 : motion === 'roll_ball' ? 0.15 : 1.15);
