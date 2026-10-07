/**
 * The umpires: they move to see the play (a base umpire goes to his ideal spot for the bag the play is at, out of the fielders' way; the
 * plate umpire stays behind the catcher and steps aside from the runner's lane on a play at the plate), and they make their calls
 * *after* the play — a strike a moment after the catch, safe / out ~0.2-0.6 s after the tag or the touch (longer when it is close) —
 * each an `umpireCall` event with his position and a gesture hint (`ump_*`) on his `anim`.
 */
import { emit } from './events';
import { BASE_POS } from './field';
import { clamp } from './math';
import type { AnimHint, UmpireCallKind } from './types';
import type { UmpKey, UmpireRT, World } from './world';
import { TICK, secToTicks } from './world';

const bpos = (b: number) => BASE_POS[b % 4];
const KEY_OF_BASE: Record<number, UmpKey> = { 1: 'first', 2: 'second', 3: 'third', 4: 'plate' };
const SPEED = 4.5;

export const HINT_OF: Record<UmpireCallKind, AnimHint> = {
  ball: 'ump_ball',
  ball_four: 'ump_ball',
  strike_called: 'ump_strike',
  strike_swinging: 'ump_strike_swinging',
  strikeout: 'ump_out_strikeout',
  foul: 'ump_foul',
  foul_tip: 'ump_foul',
  fair: 'ump_fair',
  safe: 'ump_safe',
  out: 'ump_out',
  homerun: 'ump_homerun',
  time: 'ump_time',
  play_ball: 'ump_fair', // a point toward the pitcher: "Play ball!"
};

export const umpFor = (w: World, key: UmpKey): UmpireRT => w.umpires.find((u) => u.key === key)!;

/** Where a base umpire wants to be to see a play at base `b`: in foul territory / on the outfield grass, a few metres from the bag, off the fielders' side. */
export function idealSpot(w: World, b: number): { x: number; z: number } {
  switch (b) {
    case 1:
      return { x: -23.0, z: 21.0 };
    case 3:
      return { x: 23.0, z: 21.0 };
    case 2:
      return { x: 4.2, z: 42.2 };
    default: {
      // at the plate: to the side of the runner's lane (the runner comes up the third-base line)
      return { x: -2.4, z: -1.9 };
    }
  }
}

function restSpot(u: UmpireRT) {
  return u.position === 'HP' ? { x: 0.25, z: -2.6 } : u.position === '1B-U' ? { x: -24.5, z: 24.0 } : u.position === '2B-U' ? { x: 6, z: 42.0 } : { x: 24.5, z: 24.0 };
}

/** The bases at which a play is developing. */
function playBases(w: World): number[] {
  const out = new Set<number>();
  if (w.phase !== 'inPlay' || !w.play || w.play.dead) return [];
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead) continue;
    if (r.target > r.base) out.add(r.target);
    else if (r.base >= 1 && !r.overrun) out.add(r.base);
  }
  if (w.ball.mode === 'thrown' && w.ball.throwBase) out.add(w.ball.throwBase);
  return [...out];
}

/** Queue a call for the umpire who has the play. */
export function scheduleCall(w: World, ump: UmpKey, kind: UmpireCallKind, delaySec: number, extra: { atBase?: number; playerId?: string; swinging?: boolean } = {}): void {
  w.umpQueue.push({ due: w.tick + secToTicks(delaySec), ump, kind, ...extra });
}

/** Delay before a base call: quick when it is clear, a beat longer when it was close. */
export const baseCallDelay = (closePlay: boolean) => (closePlay ? 0.55 : 0.25);

/** The umpire nearest a spot (for fair / foul and home-run calls). */
export function nearestUmp(w: World, x: number, z: number): UmpKey {
  let best: UmpKey = 'first';
  let bd = Infinity;
  for (const u of w.umpires) {
    if (u.key === 'plate') continue;
    const d = Math.hypot(u.x - x, u.z - z);
    if (d < bd) {
      bd = d;
      best = u.key;
    }
  }
  return best;
}

export function tickUmpires(w: World): void {
  // goals: the bases the play is at, or back to rest
  const bases = playBases(w);
  for (const u of w.umpires) {
    let goal = restSpot(u);
    for (const b of bases) if (KEY_OF_BASE[b] === u.key) goal = idealSpot(w, b);
    if (u.hold) goal = u.hold;
    if (Math.abs(goal.x - u.gx) > 0.01 || Math.abs(goal.z - u.gz) > 0.01) {
      u.gx = goal.x;
      u.gz = goal.z;
      u.goalSince = w.tick;
    }
    // he reacts a moment after the play changes, then walks / jogs there
    let vx = 0;
    let vz = 0;
    if (w.tick >= u.goalSince + secToTicks(0.3)) {
      const dx = u.gx - u.x;
      const dz = u.gz - u.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const sp = Math.min(SPEED, Math.sqrt(2 * 3.5 * d));
        vx = (dx / d) * sp;
        vz = (dz / d) * sp;
      }
    }
    u.vx = vx;
    u.vz = vz;
    u.x += vx * TICK;
    u.z += vz * TICK;
    // he watches the ball (the plate umpire the pitcher / catcher)
    const bx = w.ball.body.x;
    const bz = w.ball.body.z;
    const target = u.key === 'plate' && w.phase !== 'inPlay' ? { x: 0, z: 18 } : { x: bx, z: bz };
    const want = Math.atan2(target.x - u.x, target.z - u.z);
    let dth = want - u.facing;
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    u.facing += clamp(dth, -6 * TICK, 6 * TICK);
  }
  // calls whose moment has come
  if (w.umpQueue.length) {
    const rest: typeof w.umpQueue = [];
    for (const c of w.umpQueue) {
      if (w.tick < c.due) {
        rest.push(c);
        continue;
      }
      const u = umpFor(w, c.ump);
      u.anim = HINT_OF[c.kind];
      u.animStart = w.tick;
      u.animUntil = w.tick + secToTicks(c.kind === 'ball' || c.kind === 'ball_four' ? 0.6 : 1.3);
      emit(w, { type: 'umpireCall', umpire: c.ump, umpireId: u.id, kind: c.kind, pos: { x: u.x, y: 0, z: u.z }, ...(c.atBase !== undefined ? { atBase: c.atBase } : {}), ...(c.playerId ? { playerId: c.playerId } : {}) });
    }
    w.umpQueue = rest;
  }
}
