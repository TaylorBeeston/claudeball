/**
 * How a fly ball meets the glove, and the fielder calling for it. Pure: no three.js (unit-tested under node).
 *
 * The sim takes a ball in the air the first tick it falls inside his reach column (about 2.45 m up: fielding.ts `reachV`), so every catch it reports
 * is at the top of what a man can reach standing, and the reach IK used to hop him up to it. A ball falling steeply goes on down its own line to
 * where a settled fielder really takes it (in front of his face) in a frame or two of its flight, so the glove is drawn there: the same catch, the
 * same instant to the eye (a fly ball falls 0.3-0.5 m a frame), nothing in the sim changed. A ball that comes in flat (a line drive) cannot be
 * moved down its line without going past him: that one stays where the sim caught it, a stretch or a leap.
 */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** furthest the glove point moves along the ball's line: down (m), and sideways (m: the ball would pass him) */
export const FLY_LOWER = { maxDrop: 0.75, maxSlide: 0.45, minFall: 4 };

/**
 * The glove height of a routine catch in the air (m): the pocket in front of the forehead, a little above the eyes, for a player of `height` m
 * (shoulders at ~0.82 of the height, the pocket ~0.36 m above them: the arm bent, well inside its reach).
 */
export const comfortGloveY = (height: number) => 0.818 * height + 0.36;

/**
 * Where a fielder settled under a fly ball takes it: the sim's glove point `gt` moved down the ball's line (`vel`, m/s, at the arrival) to
 * `comfortY`, as far as the limits allow. Returns `gt` itself for a ball that is not coming down (a riser, a flat liner) or already low enough.
 */
export function routineGlove(gt: V3, vel: V3, comfortY: number, lim = FLY_LOWER): V3 {
  const drop = gt.y - comfortY;
  if (drop <= 0.01 || vel.y > -lim.minFall) return gt;
  const fall = -vel.y;
  const vh = Math.hypot(vel.x, vel.z);
  // sideways travel per metre of fall; the drop is cut to what the slide limit allows
  const k = vh / fall;
  const d = Math.min(drop, lim.maxDrop, k > 1e-6 ? lim.maxSlide / k : Infinity);
  if (d <= 0.01) return gt;
  return { x: gt.x + (vel.x / fall) * d, y: gt.y - d, z: gt.z + (vel.z / fall) * d };
}

/**
 * The call for a fly ball ("I got it!"): the throwing arm goes up and waves over his head while the ball is still well up, then comes down so the
 * hands are free for the catch clip. `ago`: seconds since the sim's call; `catchIn`: seconds to the catch (undefined: unknown). Returns the arm's
 * weight (0..1) and the wave (-1..1: the hand's side-to-side swing).
 */
export const CALL = { up: 0.18, hold: 0.85, down: 0.3, hz: 2.4, clear: 0.5 };
export function callWave(ago: number, catchIn?: number): { w: number; wave: number } {
  if (!(ago >= 0)) return { w: 0, wave: 0 };
  const end = CALL.up + CALL.hold + CALL.down;
  let w = ago < CALL.up ? ago / CALL.up : ago < CALL.up + CALL.hold ? 1 : Math.max(0, 1 - (ago - CALL.up - CALL.hold) / CALL.down);
  if (ago >= end) w = 0;
  // the arm is down before the catch clip starts (it starts ~0.42 s ahead of the ball): it never fights the clip's own arms
  if (catchIn !== undefined) w = Math.min(w, Math.max(0, (catchIn - CALL.clear) / CALL.down));
  const s = w * w * (3 - 2 * w);
  return { w: s, wave: Math.sin(2 * Math.PI * CALL.hz * Math.max(0, ago - CALL.up * 0.5)) };
}
