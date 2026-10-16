/**
 * Tags, slides and force touches. A tag is a *sweep*: a fielder with the ball secure in his glove (or, after the transfer, his bare
 * hand) starts a swipe at a runner who is within reach, aims where the runner's body / base-touching limb will be when the hand
 * arrives (~0.2-0.3 s later, with aim error that grows with the runner's speed and shrinks with `glove` / `iq`), and the tag counts
 * only if the glove (or hand) is then within reach of the runner's body — a sliding runner presents a thin body plus a leading foot
 * or hand, and slides away from the glove (hook), dives, or a runner in the open sidesteps a sweep he sees coming. The ball can pop
 * out on contact (a drop = the runner is safe, an error). A runner who has touched the base (foot / hand on the bag) is safe.
 * Force plays are a foot on the bag with the ball secure before the runner touches it.
 */
import { emit } from './events';
import * as contact from './contact';
import { BASE_POS } from './field';
import { clamp } from './math';
import * as fielding from './fielding';
import * as rules from './rules';
import * as running from './running';
import { setGoal } from './movement';
import { distToBase, mirroredOf } from './stride';
import { setAnim } from './util';
import type { AnimHint } from './types';
import type { PlayerRT, RunnerRT, World } from './world';
import { TICK, secToTicks } from './world';

type SlideKind = NonNullable<RunnerRT['slideKind']>;
const bpos = (b: number) => BASE_POS[b % 4];

export const SLIDE_HINT: Record<SlideKind, AnimHint> = { feet: 'slide_feet', head: 'slide_head', hookL: 'slide_hook_left', hookR: 'slide_hook_right', diveBack: 'dive_back' };

/**
 * How far past his hips the leading foot / hand reaches in the slide (m): measured from the shipped slide clips
 * (`tools/contact/clipfeet.ts`: toe or hand minus hips, through the slide), so the limb the sim counts on the bag is the one drawn there.
 */
export const limbLength = (k: SlideKind | null) => (k === 'feet' ? 0.85 : k === 'head' ? 0.86 : k === 'diveBack' ? 0.86 : k ? 0.75 : 0);

/** Dirt friction on a sliding body (m/s^2: a friction coefficient of about 0.35 on loose infield dirt): he slides into the bag still moving. */
export const SLIDE_FRICTION = 3.5;
/** Once the leading foot / hand is on the bag the bag stops him: his leg (or arms) fold over about this much (m). */
export const BAG_STOP = 0.45;

/** Seconds for a body at speed v decelerating at a to cover distance s (Infinity if it stops first). */
export function timeToCover(v: number, a: number, s: number): number {
  if (s <= 0) return 0;
  if (a <= 0) return s / Math.max(0.1, v);
  const disc = v * v - 2 * a * s;
  if (disc < 0) return Infinity;
  return (v - Math.sqrt(disc)) / a;
}
/** Reach of a fielder's glove / bare hand from his body, and the lunge he can add (m). */
export const GLOVE_REACH = 0.72;
export const HAND_REACH = 0.65;
/** What a body can reach from where he stands (the rendered fielder's lunge is ~1.05 m at most): the arm plus a lunge that his range sets. */
export const MAX_TAG_REACH = 1.05;
export const tagReach = (F: PlayerRT, hand: 'glove' | 'hand') => Math.min(MAX_TAG_REACH, (hand === 'glove' ? GLOVE_REACH : HAND_REACH) + 0.16 + 0.2 * (F.info.ratings.range / 100));
/** How far he can step toward the runner while the sweep is made (m). */
const TAG_STEP = 0.55;
/** A foot has to be this close to the middle of the bag (m). */
export const FOOT_ON_BASE = 0.65;

const unit = (x: number, z: number) => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

/** Which base's bag a runner is running or sliding to (or returning to). */
const bagOf = (r: RunnerRT) => (r.target > r.base ? r.target : Math.max(r.base, 1));

export interface Body {
  cx: number;
  cz: number;
  /** Tip of the leading limb (== the centre when he is upright). */
  tx: number;
  tz: number;
  /** Thickness to add to a tag's reach (m). */
  radius: number;
}

/** The runner as a thin segment: centre to the foot / hand nearest the bag when sliding, a fat point when running. */
export function runnerBody(r: RunnerRT): Body {
  const p = r.p;
  if (!r.slideKind) return { cx: p.x, cz: p.z, tx: p.x, tz: p.z, radius: 0.28 };
  // the leading foot / hand where the slide clip has it at this point of the slide (ahead of the hips along his facing, to his left)
  const path = LIMB_PATH[r.slideKind];
  const u = clamp(r.slideProg, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(u)), f = u - i;
  const fwd = path[i][0] + (path[i + 1][0] - path[i][0]) * f;
  const side = path[i][1] + (path[i + 1][1] - path[i][1]) * f;
  const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
  return { cx: p.x, cz: p.z, tx: p.x + fx * fwd + fz * side, tz: p.z + fz * fwd - fx * side, radius: 0.14 };
}

/**
 * The leading foot (hand for head-first and diving back) through each slide: [forward of the hips, to his left] (m) at 13 even steps of
 * the clip, measured from the shipped clips (`tools/contact/clipfeet.ts`; the engine plays them without their ground travel, seeked by
 * the slide's progress). A hook goes in on one side of the bag and catches it with the other foot: `hookL` (body passing on the left)
 * is the right foot hooking (the `slide_hook_right` clip), `hookR` the left one.
 */
const LIMB_PATH: Record<SlideKind, [number, number][]> = {
  feet: [[0.16, -0.02], [0.51, -0.02], [0.7, -0.02], [0.77, -0.01], [0.83, -0.01], [0.91, 0], [0.9, 0], [0.88, 0], [0.87, 0], [0.85, 0], [0.84, 0], [0.83, 0], [0.82, 0]],
  hookL: [[0.16, 0.03], [0.5, 0.03], [0.69, 0.01], [0.74, -0.08], [0.77, -0.23], [0.81, -0.43], [0.79, -0.43], [0.78, -0.43], [0.77, -0.43], [0.75, -0.43], [0.74, -0.43], [0.73, -0.43], [0.72, -0.43]],
  hookR: [[0.16, -0.02], [0.51, -0.02], [0.7, -0.01], [0.75, 0.09], [0.78, 0.23], [0.81, 0.44], [0.8, 0.44], [0.78, 0.44], [0.77, 0.44], [0.75, 0.44], [0.74, 0.44], [0.73, 0.44], [0.72, 0.44]],
  head: [[0.14, 0.05], [0.3, 0.03], [0.44, 0.01], [0.65, 0], [0.77, 0], [0.84, 0], [0.87, 0], [0.88, 0], [0.88, 0], [0.88, 0], [0.88, 0], [0.87, 0], [0.86, 0]],
  diveBack: [[0.37, 0], [0.5, 0], [0.61, 0], [0.74, 0], [0.86, 0], [0.87, 0], [0.88, 0], [0.88, 0], [0.87, 0], [0.86, 0], [0.86, 0], [0.86, 0], [0.86, 0]],
};
/** A hooking foot takes the bag this far to the side of its middle (m): its side corner. */
const BAG_HALF_SIDE = 0.15;
/** Seconds the sim gives a slide hint (the engine seeks the clip over them). */
const SLIDE_S = 0.9;

/** The clip for a slide: a hook is played with the foot on the bag's side; a mirrored (left-handed) model shows the other clip's foot there. */
export function slideHint(kind: SlideKind, mirrored: boolean): AnimHint {
  if (kind === 'hookL') return mirrored ? 'slide_hook_left' : 'slide_hook_right';
  if (kind === 'hookR') return mirrored ? 'slide_hook_right' : 'slide_hook_left';
  return SLIDE_HINT[kind];
}

/** The sliding runner's leading foot / hand is on the bag: the bag stops his body within `BAG_STOP` (a pop-up / the leg folding). */
export function bagStops(r: RunnerRT): void {
  const p = r.p;
  if (!r.slideKind || p.slideDecel <= 0) return;
  const v = Math.hypot(p.vx, p.vz);
  p.slideDecel = Math.max(p.slideDecel, (v * v) / (2 * BAG_STOP));
}

/** Does the sliding runner's leading foot / hand reach the bag (or plate) of `b`? (On his feet he touches with a footstrike: stride.ts.) */
export function slideTouches(r: RunnerRT, b: number): boolean {
  if (!r.slideKind) return false;
  const body = runnerBody(r);
  return distToBase(b, body.tx, body.tz) <= 0.04;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// ---------------------------------------------------------------------------------------------
// the runner's slide
// ---------------------------------------------------------------------------------------------

/** Where the play at base `b` is coming from (the receiver of the throw, or the fielder holding the ball near it). */
function threatAt(w: World, b: number): { x: number; z: number } | null {
  const ball = w.ball;
  const bp = bpos(b);
  if (ball.mode === 'thrown' && ball.throwBase === b && ball.throwTo) return { x: ball.throwTo.x, z: ball.throwTo.z };
  const F = ball.holder;
  if (F && F.team === w.fieldingTeam && Math.hypot(F.x - bp.x, F.z - bp.z) < 9) return { x: F.x, z: F.z };
  return null;
}

/**
 * Called each tick for a runner: begins a slide when he nears a bag with a play coming (or a steal), choosing the slide by the state of
 * the play: away from the glove (a hook to the far side) when the fielder is on the line, head-first when he is fast and late, feet-first
 * otherwise; a dive back for a runner returning to the bag on a pickoff. Returns the lateral offset (m) of his aiming point.
 */
export function updateSlide(w: World, r: RunnerRT): { x: number; z: number } | null {
  const p = r.p;
  const returning = r.target === r.base && r.base >= 1;
  const b = returning ? r.base : r.target;
  if (b < 1 || r.dead || r.overrun) return null;
  // nobody slides into first, and a runner going on past the bag runs through it
  if (!returning && (b === 1 || r.want > r.target)) return null;
  const bp = bpos(b);
  const dd = Math.hypot(p.x - bp.x, p.z - bp.z);
  const speed = Math.hypot(p.vx, p.vz);
  if (r.slideKind) {
    r.slideProg = clamp((w.tick - r.slideAt) / secToTicks(SLIDE_S), 0, 1);
    if (dd > 5.6 || w.tick - r.slideAt > 200) {
      r.slideKind = null; // slide is over
      p.slideDecel = 0;
    } else return slideAim(r, b);
    return null;
  }
  const trigger = returning ? dd > 0.5 && dd < 3.0 : dd < 4.8;
  if (!trigger || speed < 3) return null;
  const threat = threatAt(w, b);
  if (!threat && !r.stealing) return null;
  const dir = unit(bp.x - p.x, bp.z - p.z);
  const left = { x: dir.z, z: -dir.x };
  let kind: SlideKind = 'feet';
  if (returning) kind = 'diveBack';
  else if (threat) {
    const rel = { x: threat.x - bp.x, z: threat.z - bp.z };
    const along = rel.x * dir.x + rel.z * dir.z;
    const lat = rel.x * left.x + rel.z * left.z;
    const onLine = Math.abs(lat) < 1.3 && along > -3.2 && along < 1.6;
    if (onLine || b === 4) kind = lat > 0 ? 'hookR' : 'hookL'; // away from the glove
    else if (speed > 7.4 && p.info.ratings.baserunning > 58) kind = 'head';
  } else if (speed > 7.6 && p.info.ratings.baserunning > 60) kind = 'head';
  // a hook has to be started earlier: the body needs the room to swing out around the glove
  if (dd > slideStart(b, kind === 'hookL' || kind === 'hookR')) return null;
  r.slideKind = kind;
  r.slideAt = w.tick;
  r.slideProg = 0;
  // from here the slide is the dirt's friction, until the bag stops him (`bagStops`); he sets off on the line that brings the limb he
  // leads with to the bag (a hook: the body past it on one side, the foot catching it)
  p.slideDecel = SLIDE_FRICTION;
  // diving back he goes for the bag with his hands: no more friction than gets them onto it
  if (kind === 'diveBack') p.slideDecel = clamp((speed * speed) / (2 * Math.max(0.3, dd - limbLength(kind) * 0.9)), 1, SLIDE_FRICTION);
  const end = LIMB_PATH[kind][LIMB_PATH[kind].length - 1];
  // (a hook: the body goes past wide, the foot takes the side corner of the bag, not the front of it where the glove waits)
  const wide = end[1] === 0 ? 0 : Math.sign(end[1]) * BAG_HALF_SIDE;
  const ax = bp.x - left.x * (end[1] + wide), az = bp.z - left.z * (end[1] + wide);
  const al = Math.hypot(ax - p.x, az - p.z) || 1;
  p.vx = ((ax - p.x) / al) * speed;
  p.vz = ((az - p.z) / al) * speed;
  setAnim(w, p, slideHint(kind, mirroredOf(w, p)), SLIDE_S);
  return slideAim(r, b);
}

/** Distance from the bag at which a slide into base b starts (m): a hook needs the room to swing out around the glove (see `updateSlide`). */
const slideStart = (b: number, hook: boolean) => (hook || b === 4 ? 3.8 : 3.4);

/**
 * When the runner's leading foot / hand will be `dist` from the bag (s), as a fielder reads it: on his feet at his speed until he
 * slides, then the slide's friction (the one he is in, or the one he will make).
 */
export function limbArrival(r: RunnerRT, b: number, speed: number, dist: number): number {
  let d = Math.hypot(r.p.x - bpos(b).x, r.p.z - bpos(b).z);
  let v = speed;
  const kind: SlideKind = r.slideKind ?? (b === 4 ? 'hookL' : 'feet');
  const d0 = slideStart(b, kind === 'hookL' || kind === 'hookR');
  let prog = r.slideKind ? r.slideProg : -1;
  const path = LIMB_PATH[kind];
  const reach = (u: number) => path[Math.min(path.length - 1, Math.round(clamp(u, 0, 1) * (path.length - 1)))][0];
  // step his run and slide forward: on his feet until he slides, then the friction, the leading limb reaching out as the clip does
  const dt = 1 / 120;
  for (let t = 0; t < 3; t += dt) {
    if (prog < 0 && d <= d0) prog = 0;
    const tip = prog < 0 ? 0 : reach(prog);
    if (d - tip <= dist) return t;
    if (prog >= 0) {
      v = Math.max(0, v - SLIDE_FRICTION * dt);
      prog += dt / SLIDE_S;
      if (v <= 0) return Infinity;
    }
    d -= v * dt;
  }
  return Infinity;
}

/**
 * Seconds from starting a feet-first slide at `d0` metres from the middle of base b, at speed v, until the leading foot is on the bag
 * (the friction and the clip's reach): what a runner reckons his slide costs.
 */
export function slideToBag(v: number, d0: number): number {
  const path = LIMB_PATH.feet;
  const dt = 1 / 120;
  let d = d0, prog = 0;
  for (let t = 0; t < 3; t += dt) {
    const tip = path[Math.min(path.length - 1, Math.round(clamp(prog, 0, 1) * (path.length - 1)))][0];
    if (d - tip <= BAG_REACH) return t;
    v = Math.max(0.5, v - SLIDE_FRICTION * dt);
    prog += dt / SLIDE_S;
    d -= v * dt;
  }
  return 3;
}
/** How far short of the middle of the bag a foot / hand is on it, along the base path (m). */
const BAG_REACH = 0.19 + 0.04;
/** Where a feet-first slide into a bag starts (m from its middle). */
export const FEET_SLIDE_AT = 3.4;

/** A hook slide aims a little to the side of the bag; the leading foot swings out and in around the glove (see `runnerBody`). */
function slideAim(r: RunnerRT, b: number): { x: number; z: number } | null {
  if (r.slideKind !== 'hookL' && r.slideKind !== 'hookR') return null;
  const bp = bpos(b);
  const p = r.p;
  const dir = unit(bp.x - p.x, bp.z - p.z);
  const left = { x: dir.z, z: -dir.x };
  const s = r.slideKind === 'hookL' ? 1 : -1;
  return { x: left.x * 0.6 * s, z: left.z * 0.6 * s };
}

// ---------------------------------------------------------------------------------------------
// the fielder's tag
// ---------------------------------------------------------------------------------------------

const handPoint = (F: PlayerRT) => ({ x: F.x + Math.sin(F.facing) * 0.35, z: F.z + Math.cos(F.facing) * 0.35 });

/** Foot on the bag with the ball secure: the fielder can force the runner out. */
export const footOnBase = (F: PlayerRT, b: number) => {
  const bp = bpos(b);
  return Math.hypot(F.x - bp.x, F.z - bp.z) <= FOOT_ON_BASE;
};

/** The tag clips (`tag_glove` / `tag_hand`, 0.583 s) make contact at frame 8 (24 fps): a sweep starts exactly this long before its contact test. */
export const TAG_CONTACT_S = 8 / 24;
/** `catcher_block` (1.5 s): the tag contact is at frame 26. */
export const BLOCK_CONTACT_S = 26 / 24;
const TAG_CLIP_S = 14 / 24;
/** A tag made straight off a late catch (the glove is already down at the bag) still takes this long from the start of the sweep. */
const TAG_MIN_S = 0.15;
const BLOCK_CLIP_S = 36 / 24;

/** How far up the runner's line from the bag the glove is set (m): the tag is made just as the foot / hand comes in. */
const GLOVE_SET = 0.6;

/** The glove point for a tag at bag `b` against `r`: up the runner's line from the bag, with a little aim error. */
function bagGlove(F: PlayerRT, r: RunnerRT, b: number, err: { x: number; z: number }) {
  const bp = bpos(b);
  const d = unit(r.p.x - bp.x, r.p.z - bp.z);
  // the glove is on his side of the line: he sets it a little toward where he stands (a runner who slides into that side finds it)
  const left = { x: -d.z, z: d.x }; // left of the runner's heading toward the bag
  const lat = clamp((F.x - bp.x) * left.x + (F.z - bp.z) * left.z, -0.5, 0.5) * 0.4;
  return { x: bp.x + d.x * GLOVE_SET + left.x * lat + err.x, z: bp.z + d.z * GLOVE_SET + left.z * lat + err.z };
}

/** Start sweeps and bag tags for the man holding the ball; advance and resolve those in progress. */
export function tickTagging(w: World): void {
  const ball = w.ball;
  const F = ball.holder;
  const fielding = F && F.team === w.fieldingTeam && w.play && !w.play.dead ? F : null;
  // gloves set at a bag: the tag is made the moment the runner's foot / hand reaches the glove, before it reaches the bag
  if (w.bagTags.length) {
    const keep: typeof w.bagTags = [];
    for (const g of w.bagTags) {
      const r = g.r;
      const done = !fielding || g.F !== fielding || (r.state !== 'live' && r.state !== 'scored') || r.dead || r.contactBase === g.base || (r.base >= g.base && r.touched[g.base]);
      if (done) {
        // the runner got to the bag: if he had to get around a glove to do it, say so, at the clip's contact frame
        const got = r.state !== 'out' && (r.contactBase === g.base || r.touched[g.base]);
        if (g.announced && g.F === fielding && got) {
          if (w.tick < g.contactTick) {
            keep.push(g);
            continue;
          }
          const how = r.slideKind ?? (r.dodged ? ('dodge' as const) : null);
          if (how) emit(w, { type: 'tagAvoided', fielderId: g.F.info.id, runnerId: r.p.info.id, slide: how });
        }
        continue;
      }
      const dRun = Math.hypot(r.p.x - bpos(g.base).x, r.p.z - bpos(g.base).z);
      // he tracks the runner until he is committed (about 2.4 m out), then holds the glove there
      if (!g.frozen) {
        g.glove = bagGlove(g.F, r, g.base, { x: 0, z: 0 });
        // he starts the clip so that its contact frame is when the runner reaches the glove (the catcher's block clip is longer)
        const lead = g.F === w.catcher ? BLOCK_CONTACT_S - 0.1 : TAG_CONTACT_S; // (a runner who slides at the plate is slower than his approach speed)
        const spd = Math.max(1.5, Math.hypot(r.p.vx, r.p.vz));
        // (the tag lands when the leading limb comes within the glove's hit radius of it)
        const tc = limbArrival(r, g.base, spd, GLOVE_SET + (g.hand === 'glove' ? 0.22 : 0.14) + 0.14);
        if (dRun < 2.4 || tc <= lead) {
          g.frozen = true;
          const rr = g.F.info.ratings;
          const sigma = 0.08 * clamp(1.5 - rr.glove / 100, 0.7, 1.3) * clamp(1.2 - rr.iq / 250, 0.85, 1.1);
          g.glove.x += w.rng.normal(0, sigma);
          g.glove.z += w.rng.normal(0, sigma);
          // he sees the foot swinging out and moves the glove partway toward it (the foot comes back in as it hooks the bag)
          if (r.slideKind === 'hookL' || r.slideKind === 'hookR') {
            const bp = bpos(g.base);
            const hd = unit(bp.x - r.p.x, bp.z - r.p.z);
            const lf = { x: hd.z, z: -hd.x };
            const body = runnerBody(r);
            const lateral = clamp((body.tx - bp.x) * lf.x + (body.tz - bp.z) * lf.z, -0.7, 0.7);
            g.glove.x += lf.x * 0.20 * lateral;
            g.glove.z += lf.z * 0.20 * lateral;
          }
          // he steps toward the glove point while the sweep is made, and the glove cannot be set beyond what he can reach from there
          const gdx = g.glove.x - g.F.x, gdz = g.glove.z - g.F.z;
          const gd = Math.hypot(gdx, gdz);
          const reach = tagReach(g.F, g.hand);
          const stepLen = clamp(gd - reach * 0.75, 0, TAG_STEP * 0.7);
          const ux = gd > 1e-6 ? gdx / gd : 0, uz = gd > 1e-6 ? gdz / gd : 0;
          const nT = Math.max(1, secToTicks(TAG_CONTACT_S));
          g.step = { x: (ux * stepLen) / nT, z: (uz * stepLen) / nT };
          const fx = g.F.x + ux * stepLen, fz = g.F.z + uz * stepLen;
          const rest = Math.hypot(g.glove.x - fx, g.glove.z - fz);
          if (rest > reach) {
            g.glove.x = fx + ((g.glove.x - fx) / rest) * reach;
            g.glove.z = fz + ((g.glove.z - fz) / rest) * reach;
          }
          g.announced = true;
          // the hint starts with the sweep; contact is not before the clip's contact frame (a tag made straight off a late catch still has its swing)
          g.earliest = w.tick + secToTicks(TAG_MIN_S);
          g.contactTick = w.tick + secToTicks(g.F === w.catcher ? BLOCK_CONTACT_S : TAG_CONTACT_S);
          if (g.F === w.catcher) setAnim(w, g.F, 'catcher_block', BLOCK_CLIP_S);
          else setAnim(w, g.F, g.hand === 'glove' ? 'tag_glove' : 'tag_hand', TAG_CLIP_S);
          emit(w, { type: 'tagAttempt', fielderId: g.F.info.id, runnerId: r.p.info.id, base: g.base, hand: g.hand, pos: { x: g.glove.x, y: r.slideKind ? 0.3 : 0.7, z: g.glove.z } });
        }
      }
      if (g.frozen) {
        if (w.tick < g.contactTick && g.step) {
          g.F.x += g.step.x;
          g.F.z += g.step.z;
        }
        const body = runnerBody(r);
        const hitR = (g.hand === 'glove' ? 0.22 : 0.14) + body.radius;
        const d = distToSegment(g.glove.x, g.glove.z, body.cx, body.cz, body.tx, body.tz);
        if (d <= hitR && g.F.tagReady <= w.tick && w.tick >= g.earliest) {
          tagLands(w, g.F, r, g.glove, g.base);
          continue;
        }
      }
      keep.push(g);
    }
    w.bagTags = keep;
  }
  // open-field sweeps
  if (w.tags.length) {
    const still: typeof w.tags = [];
    for (const s of w.tags) {
      if (s.dodgeAt && w.tick >= s.dodgeAt && !s.r.dodged && s.r.state === 'live' && !s.r.slideKind) {
        // the runner has seen it coming and steps away from the glove
        s.r.dodged = true;
        s.r.p.vx += s.dodgeDir.x * 1.7;
        s.r.p.vz += s.dodgeDir.z * 1.7;
      }
      if (w.tick < s.contact) {
        // he steps / lunges toward the glove point while the sweep is made
        s.F.x += s.step.x;
        s.F.z += s.step.z;
        still.push(s);
        continue;
      }
      resolve(w, s);
    }
    w.tags = still;
  }
  for (const r of w.runners) {
    if (!r.tagLine) continue;
    if (w.tick > r.tagLine.until || r.state !== 'live') r.tagLine = null;
    else if (contact.baselineCheck(w, r)) r.tagLine = null;
  }
  // start
  if (!fielding) return;
  const H = fielding;
  if (H.plan.releaseAt > 0) return;
  const hp = handPoint(H);
  // ready once the ball is secure (a glove tag can be made straight off the catch)
  const secure = w.tick >= H.plan.lastAttempt + secToTicks(0.1);
  let sweep: { r: RunnerRT; d: number } | null = null;
  for (const r of w.runners) {
    if (r.state !== 'live' || r.dead || !running.vulnerable(r)) continue;
    const b = r.target > r.base ? r.target : r.base >= 1 ? r.base : 0;
    const bp = b >= 1 ? bpos(b) : null;
    // (the catcher's block clip is long, 26/24 s to its tag contact: he starts it when the runner is still ~1.1 s away)
    const atBag = !!bp && Math.hypot(H.x - bp.x, H.z - bp.z) <= (H === w.catcher && b === 4 ? 1.7 : 1.1) && Math.hypot(r.p.x - bp.x, r.p.z - bp.z) < (H === w.catcher ? 13 : 6);
    if (atBag) {
      if (secure && !w.bagTags.some((g) => g.F === H && g.r === r)) {
        const hand: 'glove' | 'hand' = H.plan.kind === 'tag' && w.tick >= H.plan.holdUntil + 24 ? 'hand' : 'glove';
        w.bagTags.push({ F: H, r, base: b, hand, glove: bagGlove(H, r, b, { x: 0, z: 0 }), frozen: false, announced: false, earliest: 0, contactTick: 0 });
      }
      continue;
    }
    // open field: a sweep once he is within reach (not while he is about to reach a bag: that is a bag tag)
    if (w.tick < H.tagReady || w.tags.some((s) => s.F === H) || !secure) continue;
    const body = runnerBody(r);
    const d = distToSegment(hp.x, hp.z, body.cx, body.cz, body.tx, body.tz) - body.radius;
    if (d <= 2.2 && (!sweep || d < sweep.d)) sweep = { r, d };
  }
  if (sweep) startSweep(w, H, sweep.r);
}

/** The glove / hand meets the runner: the ball may pop out, otherwise he is out. */
function tagLands(w: World, F: PlayerRT, r: RunnerRT, at: { x: number; z: number }, b: number | null): void {
  const vc = Math.hypot(r.p.vx - F.vx, r.p.vz - F.vz);
  const jar = 2.7 - 0.06 * vc + 0.006 * (F.info.ratings.glove - 50);
  if (w.rng.normal(0, 1) > jar) {
    fielding.dropBall(w, F, at);
    return;
  }
  // (whatever was aimed at, the announced contact is inside what his body can reach)
  const rch = tagReach(F, F.plan.kind === 'tag' && w.tick >= F.plan.holdUntil + 24 ? 'hand' : 'glove');
  const ad = Math.hypot(at.x - F.x, at.z - F.z);
  if (ad > rch) at = { x: F.x + ((at.x - F.x) / ad) * rch, z: F.z + ((at.z - F.z) / ad) * rch };
  emit(w, { type: 'tag', fielderId: F.info.id, runnerId: r.p.info.id, pos: { x: at.x, y: r.slideKind ? 0.3 : 0.9, z: at.z } });
  const type = w.play!.kind === 'steal' && r.stealing ? 'caughtStealing' : w.play!.kind === 'pickoff' ? 'pickoff' : 'tag';
  if (type === 'caughtStealing') r.p.bat.cs++;
  const margin = b && b >= 1 ? Math.max(0, running.runnerETA(r, b)) : 0.3;
  rules.recordOut(w, r, type, [F], null, false, { margin });
}

function startSweep(w: World, F: PlayerRT, r: RunnerRT): void {
  // the glove is his working hand; he uses the bare hand only once the ball has been moved into it and he is chasing a runner down
  const hand: 'glove' | 'hand' = F.plan.kind === 'tag' && w.tick >= F.plan.holdUntil + 24 ? 'hand' : 'glove';
  const T = TAG_CONTACT_S;
  const ticks = secToTicks(T);
  const body = runnerBody(r);
  const p = r.p;
  // aim at where the runner's body / limb will be when the hand arrives (he does not see a hook or a sidestep before it happens)
  const px = p.x + p.vx * T;
  const pz = p.z + p.vz * T;
  const tipx = body.tx + p.vx * T;
  const tipz = body.tz + p.vz * T;
  const wLimb = r.slideKind ? 0.6 : 0;
  const ax = px + (tipx - px) * wLimb;
  const az = pz + (tipz - pz) * wLimb;
  const vrel = Math.hypot(p.vx - F.vx, p.vz - F.vz);
  const rr = F.info.ratings;
  const sigma = (0.07 + 0.014 * vrel) * clamp(1.55 - rr.glove / 100, 0.75, 1.3) * clamp(1.25 - rr.iq / 200, 0.85, 1.15);
  const aim = { x: ax + w.rng.normal(0, sigma), z: az + w.rng.normal(0, sigma) };
  // the runner sees the sweep and, if he is in the open and not sliding, sidesteps away from the glove
  const dir = unit(aim.x - F.x, aim.z - F.z);
  const nearBag = [1, 2, 3, 4].some((b) => Math.hypot(p.x - bpos(b).x, p.z - bpos(b).z) < 2.2);
  const react = Math.max(0.08, 0.14 - 0.0006 * (p.info.ratings.baserunning - 50));
  const sweep = {
    F,
    r,
    start: w.tick,
    contact: w.tick + ticks,
    hand,
    aim,
    base: r.target > r.base ? r.target : r.base >= 1 ? r.base : null,
    dodgeAt: !r.slideKind && !nearBag && T > react + 0.05 ? w.tick + secToTicks(react) : 0,
    dodgeDir: dodgeDir(F, p, dir),
    step: { x: 0, z: 0 },
  };
  {
    const dAim = Math.hypot(aim.x - F.x, aim.z - F.z);
    const stepLen = clamp(dAim - tagReach(F, hand) * 0.75, 0, TAG_STEP);
    sweep.step = { x: (dir.x * stepLen) / ticks, z: (dir.z * stepLen) / ticks };
    F.facing = Math.atan2(dir.x, dir.z);
  }
  w.tags.push(sweep);
  // his line to the base as the tag comes: he may not go more than 3 ft off it to get away (contact.baselineCheck)
  if (!r.tagLine && sweep.base) {
    const tb = bpos(sweep.base);
    r.tagLine = { x0: p.x, z0: p.z, bx: tb.x, bz: tb.z, until: w.tick + ticks + secToTicks(0.6) };
  }
  F.tagReady = w.tick + ticks + secToTicks(0.35);
  setAnim(w, F, hand === 'glove' ? 'tag_glove' : 'tag_hand', TAG_CLIP_S);
  F.lookAt = null;
  emit(w, { type: 'tagAttempt', fielderId: F.info.id, runnerId: r.p.info.id, base: sweep.base, hand, pos: { x: aim.x, y: r.slideKind ? 0.3 : 0.9, z: aim.z } });
}

/** Sidestep direction: perpendicular to the sweep, toward the side the runner is already on. */
function dodgeDir(F: PlayerRT, p: PlayerRT, dir: { x: number; z: number }): { x: number; z: number } {
  const perp = { x: -dir.z, z: dir.x };
  const side = Math.sign((p.x - F.x) * perp.x + (p.z - F.z) * perp.z) || 1;
  return { x: perp.x * side, z: perp.z * side };
}

function resolve(w: World, s: NonNullable<World['tags']>[number]): void {
  const { F, r } = s;
  if (r.state !== 'live' || r.dead || w.ball.holder !== F || !w.play || w.play.dead) return; // the play moved on (he threw it, the runner is out / safe)
  const b = r.target > r.base ? r.target : r.base;
  // a runner whose foot / hand is on the bag is safe
  if (b >= 1 && (r.contactBase === b || running.isOnBase(r))) return;
  const body = runnerBody(r);
  const hp = handPoint(F);
  const reach = tagReach(F, s.hand);
  let gx = s.aim.x;
  let gz = s.aim.z;
  const dx = gx - F.x;
  const dz = gz - F.z;
  const dl = Math.hypot(dx, dz);
  if (dl > reach) {
    gx = F.x + (dx / dl) * reach;
    gz = F.z + (dz / dl) * reach;
  }
  const hitR = (s.hand === 'glove' ? 0.22 : 0.14) + body.radius;
  const d = distToSegment(gx, gz, body.cx, body.cz, body.tx, body.tz);
  void hp;
  if (d <= hitR) {
    tagLands(w, F, r, { x: gx, z: gz }, b >= 1 ? b : null);
    return;
  }
  // a miss: if the runner made himself hard to tag, say so
  const avoided = r.slideKind ? r.slideKind : r.dodged ? ('dodge' as const) : null;
  if (avoided) emit(w, { type: 'tagAvoided', fielderId: F.info.id, runnerId: r.p.info.id, slide: avoided });
}

/** Seconds until the defense could complete the play at base `b` (the ball arriving, or the man with it getting there), for a `safe` call's margin. */
export function fielderETA(w: World, b: number): number {
  const bp = bpos(b);
  const ball = w.ball;
  if (ball.mode === 'thrown' && ball.throwBase === b) {
    const bb = ball.body;
    return clamp(Math.hypot(bb.x - bp.x, bb.z - bp.z) / Math.max(Math.hypot(bb.vx, bb.vy, bb.vz), 10), 0.02, 1.5);
  }
  const F = ball.holder;
  if (F && F.team === w.fieldingTeam) return clamp(Math.hypot(F.x - bp.x, F.z - bp.z) / 7 + 0.05, 0.02, 1.5);
  return 1.0;
}

/** The catcher gives up the lane unless he has the ball: with it, he sets up on the line to the plate to block it. */
export function catcherBlock(w: World): void {
  const C = w.catcher;
  const F = w.ball.holder;
  if (F !== C) return;
  const r = w.runners.find((q) => q.state === 'live' && !q.dead && q.target === 4 && Math.hypot(q.p.x, q.p.z) < 7);
  if (!r) return;
  const dir = unit(r.p.x, r.p.z);
  // stands a step up the line from the plate, facing the runner
  setGoal(C, dir.x * 0.75, dir.z * 0.75, true, 1);
  C.lookAt = { x: r.p.x, z: r.p.z };
}

export { TICK };
