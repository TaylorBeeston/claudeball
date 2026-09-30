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
import { BASE_POS } from './field';
import { clamp } from './math';
import * as fielding from './fielding';
import * as rules from './rules';
import * as running from './running';
import { setGoal } from './movement';
import { setAnim } from './util';
import type { AnimHint } from './types';
import type { PlayerRT, RunnerRT, World } from './world';
import { TICK, secToTicks } from './world';

type SlideKind = NonNullable<RunnerRT['slideKind']>;
const bpos = (b: number) => BASE_POS[b % 4];

export const SLIDE_HINT: Record<SlideKind, AnimHint> = { feet: 'slide_feet', head: 'slide_head', hookL: 'slide_hook_left', hookR: 'slide_hook_right', diveBack: 'dive_back' };

/** How far past his centre the leading foot / hand reaches (m). */
export const limbLength = (k: SlideKind | null) => (k === 'feet' ? 1.0 : k === 'head' ? 1.25 : k === 'diveBack' ? 1.2 : k ? 0.95 : 0);
/** Reach of a fielder's glove / bare hand from his body, and the lunge he can add (m). */
export const GLOVE_REACH = 0.95;
export const HAND_REACH = 0.85;
export const LUNGE = 0.35;
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
  const bp = bpos(bagOf(r));
  const d = unit(bp.x - p.x, bp.z - p.z);
  const L = limbLength(r.slideKind);
  let tx = p.x + d.x * L;
  let tz = p.z + d.z * L;
  if (r.slideKind === 'hookL' || r.slideKind === 'hookR') {
    // the hooking foot swings out to the side and back in to catch the corner of the bag: away from a glove waiting on the line
    const dd = Math.hypot(bp.x - p.x, bp.z - p.z);
    const prog = clamp((4.8 - dd) / 4.2, 0, 1);
    const s = (r.slideKind === 'hookL' ? 1 : -1) * 0.75 * Math.sin(Math.PI * prog);
    tx += d.z * s;
    tz += -d.x * s;
  }
  return { cx: p.x, cz: p.z, tx, tz, radius: 0.14 };
}

/** Does the runner's foot / hand (or body) touch the bag of `b`? */
export function touchesBag(r: RunnerRT, b: number): boolean {
  const bp = bpos(b);
  const p = r.p;
  if (Math.hypot(p.x - bp.x, p.z - bp.z) < 0.9) return true;
  if (!r.slideKind) return false;
  const body = runnerBody(r);
  return Math.hypot(body.tx - bp.x, body.tz - bp.z) < 0.45;
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
    if (dd > 5.6 || w.tick - r.slideAt > 200) r.slideKind = null; // slide is over
    else return slideAim(r, b);
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
  if (kind !== 'hookL' && kind !== 'hookR' && dd > 3.4) return null;
  r.slideKind = kind;
  r.slideAt = w.tick;
  setAnim(w, p, SLIDE_HINT[kind], 0.9);
  return slideAim(r, b);
}

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
      const done = !fielding || g.F !== fielding || r.state !== 'live' || r.dead || r.contactBase === g.base || (r.base >= g.base && r.touched[g.base]);
      if (done) {
        // the runner got to the bag: if he had to get around a glove to do it, say so
        if (g.announced && g.F === fielding && r.state === 'live' && (r.contactBase === g.base || r.touched[g.base])) {
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
        const lead = g.F === w.catcher ? BLOCK_CONTACT_S : TAG_CONTACT_S;
        const spd = Math.max(1.5, Math.hypot(r.p.vx, r.p.vz));
        const tc = (dRun - GLOVE_SET - 0.5) / spd;
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
          g.announced = true;
          // the hint starts with the sweep; contact is not before the clip's contact frame (a tag made straight off a late catch still has its swing)
          g.earliest = w.tick + secToTicks(TAG_MIN_S);
          if (g.F === w.catcher) setAnim(w, g.F, 'catcher_block', BLOCK_CLIP_S);
          else setAnim(w, g.F, g.hand === 'glove' ? 'tag_glove' : 'tag_hand', TAG_CLIP_S);
          emit(w, { type: 'tagAttempt', fielderId: g.F.info.id, runnerId: r.p.info.id, base: g.base, hand: g.hand, pos: { x: g.glove.x, y: r.slideKind ? 0.3 : 0.7, z: g.glove.z } });
        }
      }
      if (g.frozen) {
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
        still.push(s);
        continue;
      }
      resolve(w, s);
    }
    w.tags = still;
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
    const atBag = !!bp && Math.hypot(H.x - bp.x, H.z - bp.z) <= 1.1 && Math.hypot(r.p.x - bp.x, r.p.z - bp.z) < 6;
    if (atBag) {
      if (secure && !w.bagTags.some((g) => g.F === H && g.r === r)) {
        const hand: 'glove' | 'hand' = H.plan.kind === 'tag' && w.tick >= H.plan.holdUntil + 24 ? 'hand' : 'glove';
        w.bagTags.push({ F: H, r, base: b, hand, glove: bagGlove(H, r, b, { x: 0, z: 0 }), frozen: false, announced: false, earliest: 0 });
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
  };
  w.tags.push(sweep);
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
  const reach = (s.hand === 'glove' ? GLOVE_REACH : HAND_REACH) + LUNGE;
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
