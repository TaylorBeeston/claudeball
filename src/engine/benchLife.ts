/**
 * Bench life: the people in the dugouts (and the other ambient roles) must not move as one. Every seated puppet was started on the same tick with the
 * same `bench_sit` loop at time 0 and rate 1, and all their heads followed the one ball: a row of bodies leaning and heads turning in unison.
 *
 * - each ambient loop starts at its own phase and plays at its own rate (`loopPhase`, `loopRate`), so the loops drift apart for good;
 * - a bench player's eyes go where his own schedule says (`benchLook`): the plate, the mound, the man beside him, nowhere in particular, each for a few
 *   seconds; a ball in play draws them all, each after his own reaction time.
 *
 * Pure and deterministic from the player id (no Math.random, no frame count): the same game looks the same every time.
 */
import { hash01 } from './sideCast';

/** Where in its loop an ambient clip starts (0..1 of the clip). */
export const loopPhase = (id: string) => hash01(id, 11);
/** How fast an ambient loop plays (x the clip's own rate). */
export const loopRate = (id: string) => 0.86 + 0.28 * hash01(id, 12);

export type BenchLookAt = 'ball' | 'plate' | 'mound' | 'mate' | 'ahead';

/**
 * What a bench player looks at, `t` s into the game: `liveFor` = seconds the ball has been in play (moving fast), or -1 when it is not. His
 * schedule runs in slots of his own length (3-7 s), offset by his own phase; a ball in play takes over once his reaction time (0.1-0.7 s) is up,
 * for most of them.
 */
export function benchLook(id: string, t: number, liveFor: number): { at: BenchLookAt; side: -1 | 1 } {
  const period = 3 + 4 * hash01(id, 13);
  const k = Math.floor((t + period * hash01(id, 14)) / period);
  const h = hash01(id, 100 + (k % 997));
  const side: -1 | 1 = hash01(id, 2000 + (k % 997)) < 0.5 ? -1 : 1;
  if (liveFor >= 0 && liveFor > 0.1 + 0.6 * hash01(id, 15) && h < 0.85) return { at: 'ball', side };
  return { at: h < 0.35 ? 'plate' : h < 0.55 ? 'mound' : h < 0.75 ? 'mate' : 'ahead', side };
}
