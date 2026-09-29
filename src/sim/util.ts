import { BALL_RADIUS, groundHeight } from './field';
import type { AnimHint } from './types';
import type { PlayerRT, World } from './world';
import { TICK, secToTicks } from './world';

export function setAnim(w: World, p: PlayerRT, anim: AnimHint, durSec: number): void {
  p.anim = anim;
  p.animStart = w.tick;
  p.animDur = Math.max(1, secToTicks(durSec));
  p.animUntil = w.tick + p.animDur;
}

/** Position of the glove / ball hand of a holder (used when the ball is held). */
export function handPos(p: PlayerRT): { x: number; y: number; z: number } {
  const off = 0.32;
  return { x: p.x + Math.sin(p.facing) * off, y: groundHeight(p.x, p.z) + 1.15, z: p.z + Math.cos(p.facing) * off };
}

export function placeBallInHand(w: World, p: PlayerRT): void {
  const b = w.ball.body;
  let h = handPos(p);
  const gh = p.gloveHold;
  if (gh) {
    // right after a catch the ball is still where the glove met it, and settles into the hand over a third of a second
    const u = (w.tick - gh.t0) / 80;
    if (u >= 1) p.gloveHold = null;
    else {
      const s = u * u * (3 - 2 * u);
      h = { x: gh.x + (h.x - gh.x) * s, y: gh.y + (h.y - gh.y) * s, z: gh.z + (h.z - gh.z) * s };
    }
  }
  b.x = h.x;
  b.y = h.y;
  b.z = h.z;
  b.vx = p.vx;
  b.vy = 0;
  b.vz = p.vz;
  b.wx = b.wy = b.wz = 0;
  b.rolling = false;
}

export function giveBall(w: World, p: PlayerRT): void {
  const ball = w.ball;
  if (ball.holder) ball.holder.hasBall = false;
  ball.holder = p;
  ball.mode = 'held';
  ball.throwTo = null;
  ball.throwBase = null;
  ball.lob = null;
  ball.lastTouch = p;
  p.hasBall = true;
  placeBallInHand(w, p);
}

export function releaseBall(w: World): void {
  if (w.ball.holder) w.ball.holder.hasBall = false;
  w.ball.holder = null;
}

export const ticksToSec = (t: number) => t * TICK;
export const restingBall = (b: { x: number; y: number }) => b.y <= BALL_RADIUS + 1e-3;
export const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
