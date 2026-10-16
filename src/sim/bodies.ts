/**
 * Bodies. Everyone on the field (fielders, the batter, runners, umpires, base coaches, ball kids, a manager or batting-side player
 * walking out there) is a body: a vertical capsule seen from above, a circle of his build's half-width; a sliding runner is a thin
 * capsule from his hips to the foot / hand he leads with. Two things keep bodies from passing through each other:
 *
 * - steering (`steer`): a mover looks ahead along the velocity he wants and goes around anyone he would meet within about a second.
 *   Who gives way is baseball's: umpires, coaches and ball kids always do; a fielder who is not fielding the ball gives way to a
 *   runner (else it is obstruction); a runner gives way to a fielder fielding a batted ball (else it is interference); the man
 *   fielding the ball and a fielder with the ball going for a tag do not give way.
 * - contact (`separate`): after everyone has moved, bodies that still overlap are pushed apart by their masses and the speed at which
 *   they were closing is taken out (an inelastic collision). A hard one is a `collision` event, and the rules look at it
 *   (obstruction, interference: contact.ts).
 *
 * Exempt: the batter, catcher and plate umpire while a pitch is coming (they work that close by design), anyone inside a dugout.
 */
import { emit } from './events';
import { BASE_POS } from './field';
import { clamp } from './math';
import { runnerBody } from './tagging';
import { dugoutFloorY } from './venue';
import type { PlayerRT, RunnerRT, StaffRT, UmpireRT, World } from './world';
import { TICK } from './world';

/** F fielder, B batter, R runner (live), X runner out of the play (out / scored, walking off), U umpire, C base coach, K ball kid / bat boy, M manager / pitching coach, D a batting-side player walking on the field. */
export type BodyClass = 'F' | 'B' | 'R' | 'X' | 'U' | 'C' | 'K' | 'M' | 'D';

export interface Body {
  id: string;
  cls: BodyClass;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** half-width (m) */
  r: number;
  mass: number;
  /** the batter, catcher and plate umpire while a pitch is coming */
  battery: boolean;
  /** a sliding runner: his leading foot / hand (the body is the segment from (x, z) to here) */
  tip: { x: number; z: number } | null;
  p: PlayerRT | null;
  run: RunnerRT | null;
  u: UmpireRT | null;
  s: StaffRT | null;
}

/** Half the shoulder width of an average player (m); the build scales it. */
export const BODY_R = 0.24;
/** A sliding body's thickness (m). */
const SLIDE_R = 0.14;
/** How far ahead a mover looks for someone in his way (s), and the extra room he leaves (m). */
const LOOK_S = 1.0;
const ROOM = 0.12;
/** The most an overlap is undone in one tick (m): two bodies found inside each other ease apart (~2.4 m/s), nobody jumps. */
const MAX_PUSH = 0.01;

const radiusOf = (p: PlayerRT) => BODY_R * clamp(Math.sqrt((p.info.physique?.weightKg ?? 90) / 90), 0.9, 1.15);

/** Everyone standing on the playing surface: the people the snapshot shows, less the dugouts and the bullpen. */
export function gatherBodies(w: World): Body[] {
  const out: Body[] = [];
  const pitching = w.phase === 'prePitch' || w.phase === 'windup' || w.phase === 'pitch';
  const seen = new Set<PlayerRT>();
  const add = (p: PlayerRT, cls: BodyClass, run: RunnerRT | null = null) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (dugoutFloorY(p.x, p.z) < 0) return;
    let tip: Body['tip'] = null;
    if (run && run.slideKind && run.state === 'live') {
      const b = runnerBody(run);
      tip = { x: b.tx, z: b.tz };
    }
    out.push({ id: p.info.id, cls, x: p.x, z: p.z, vx: p.vx, vz: p.vz, r: tip ? SLIDE_R : radiusOf(p), mass: p.info.physique?.weightKg ?? 90, battery: pitching && (p === w.catcher || (p === w.batter && cls === 'B')), tip, p, run, u: null, s: null });
  };
  for (const p of w.fieldingTeam.defense.values()) if (p.onField) add(p, 'F');
  for (const r of w.runners) if (r.p.onField) add(r.p, r.state === 'live' ? 'R' : 'X', r);
  for (const l of w.leavers) if (l.p.onField) add(l.p, 'D');
  for (const r of w.exiting) if (r.p.onField) add(r.p, 'X', r);
  if (w.batter && w.batter.onField) add(w.batter, 'B');
  for (const t of [w.teams.home, w.teams.away]) {
    for (const p of t.players.values()) if (!p.onField && (p.dug === 'toBench' || p.dug === 'toDeck' || p.dug === 'deck' || p.dug === 'toMound')) add(p, 'D');
  }
  for (const u of w.umpires) out.push({ id: u.id, cls: 'U', x: u.x, z: u.z, vx: u.vx, vz: u.vz, r: 0.26, mass: 100, battery: pitching && u.key === 'plate', tip: null, p: null, run: null, u, s: null });
  for (const s of w.staff) {
    if (!s.active || dugoutFloorY(s.x, s.z) < 0) continue;
    const cls: BodyClass = s.role === 'coach1b' || s.role === 'coach3b' ? 'C' : s.role === 'ballkid' || s.role === 'batboy' ? 'K' : 'M';
    out.push({ id: s.id, cls, x: s.x, z: s.z, vx: s.vx, vz: s.vz, r: cls === 'K' ? 0.2 : 0.24, mass: cls === 'K' ? 55 : 88, battery: false, tip: null, p: null, run: null, u: null, s });
  }
  return out;
}

/** The man fielding a batted / loose ball (before anyone has it): he has the right of way. */
function fieldingBall(w: World, p: PlayerRT | null): boolean {
  if (!p || !w.play || w.play.dead) return false;
  const m = w.ball.mode;
  return (m === 'batted' || m === 'loose') && !w.ball.holder && w.play.primary === p;
}

/** About to take a throw, or set at a bag / in the relay for one: he is fielding the play and holds his ground. */
function receiving(w: World, p: PlayerRT | null): boolean {
  if (!p) return false;
  const b = w.ball;
  if (b.mode === 'thrown' && (b.throwTo === p || b.lob?.to === p)) return true;
  const k = p.plan.kind;
  // (set at his spot for it: while he is still running there he goes around a runner like anyone)
  return !!w.play && !w.play.dead && (k === 'cover' || k === 'receive' || k === 'cutoff') && Math.hypot(p.x - p.plan.tx, p.z - p.plan.tz) < 1.5;
}

/** How much of the avoiding `me` does when he would meet `o` (0: he holds his line, 1: he goes around). */
export function giveWay(w: World, me: Body, o: Body): number {
  if (o.battery && me.battery) return 0;
  const official = (c: BodyClass) => c === 'U' || c === 'C' || c === 'K' || c === 'M';
  if (official(me.cls)) return official(o.cls) ? 0.5 : 1;
  if (official(o.cls)) return 0.35; // (a player goes around a standing umpire / coach too; they also step aside)
  if (me.cls === 'X' || me.cls === 'D') return o.cls === 'X' || o.cls === 'D' ? 0.5 : 1;
  if (o.cls === 'X' || o.cls === 'D') return 0.2;
  if (me.cls === 'R') {
    if (o.cls === 'F') {
      if (fieldingBall(w, o.p)) return 1;
      // (the man set beside the bag he is going for stands clear of his line: he runs his line to the bag)
      const r = me.run;
      const tb = r && r.target > r.base ? BASE_POS[r.target % 4] : null;
      if (tb && Math.hypot(o.x - tb.x, o.z - tb.z) < 1.2) return 0;
      return o.p?.hasBall ? 0 : 0.15;
    }
    return 0.5;
  }
  if (me.cls === 'F') {
    if (fieldingBall(w, me.p) || receiving(w, me.p)) return 0;
    if (o.cls === 'R') return me.p?.hasBall ? 0 : 1;
    if (o.cls === 'F') return fieldingBall(w, o.p) ? 1 : 0.5;
    return 0.5;
  }
  return 0.5;
}

/** A slide into a bag where a fielder is taking the play: the slide goes in at his feet (the tag is the contact), nobody is pushed. */
function slideTangle(s: Body, f: Body): boolean {
  if (!s.tip || !s.run || f.cls !== 'F') return false;
  const r = s.run;
  const b = r.target > r.base ? r.target : r.base;
  if (b < 1) return false;
  const bp = BASE_POS[b % 4];
  return Math.hypot(f.x - bp.x, f.z - bp.z) < 1.3;
}

/** Distance between two bodies' cores (segments for sliders, points otherwise), and the unit normal from a to b. */
function coreDistance(a: Body, b: Body): { d: number; nx: number; nz: number } {
  const ax2 = a.tip?.x ?? a.x, az2 = a.tip?.z ?? a.z;
  const bx2 = b.tip?.x ?? b.x, bz2 = b.tip?.z ?? b.z;
  // closest points between segments a and b (either may be a point)
  const ux = ax2 - a.x, uz = az2 - a.z, vx = bx2 - b.x, vz = bz2 - b.z;
  const wx = a.x - b.x, wz = a.z - b.z;
  const A = ux * ux + uz * uz, B = ux * vx + uz * vz, C = vx * vx + vz * vz, D = ux * wx + uz * wz, E = vx * wx + vz * wz;
  let s = 0, t = 0;
  const den = A * C - B * B;
  if (A < 1e-9 && C < 1e-9) {
    s = t = 0;
  } else if (A < 1e-9) {
    t = clamp(E / C, 0, 1);
  } else if (C < 1e-9) {
    s = clamp(-D / A, 0, 1);
  } else {
    s = den > 1e-9 ? clamp((B * E - C * D) / den, 0, 1) : 0;
    t = clamp((B * s + E) / C, 0, 1);
    s = clamp((B * t - D) / A, 0, 1);
  }
  const px = a.x + ux * s, pz = a.z + uz * s, qx = b.x + vx * t, qz = b.z + vz * t;
  let nx = qx - px, nz = qz - pz;
  const d = Math.hypot(nx, nz);
  if (d > 1e-6) {
    nx /= d;
    nz /= d;
  } else {
    // on top of each other: apart along the line between their centres, else any way
    const cx = b.x - a.x, cz = b.z - a.z, cl = Math.hypot(cx, cz);
    if (cl > 1e-6) {
      nx = cx / cl;
      nz = cz / cl;
    } else {
      nx = 1;
      nz = 0;
    }
  }
  return { d, nx, nz };
}

/**
 * Steering: the velocity (tvx, tvz) a mover wants, bent around the bodies he would otherwise run into within LOOK_S. He keeps his
 * speed (or slows when someone is right in front of him), and only does his share of the avoiding.
 */
export function steer(w: World, id: string, x: number, z: number, tvx: number, tvz: number): [number, number] {
  const sp = Math.hypot(tvx, tvz);
  const bodies = w.bodies;
  if (!bodies.length) return [tvx, tvz];
  const me = w.bodyById.get(id);
  if (!me || me.tip) return [tvx, tvz];
  if (sp < 0.3) return sidestep(w, me, x, z, tvx, tvz);
  // two steps from the bag he is going for: he goes for it (any contact comes after)
  if (me.p && me.cls === 'R' && me.p.stride.aimK > 0 && me.p.stride.aimK <= 2) return [tvx, tvz];
  let ax = 0, az = 0, slow = 1;
  const reach = sp * LOOK_S + 1.5;
  for (const o of bodies) {
    if (o === me) continue;
    const dx = o.x - x, dz = o.z - z;
    if (dx * dx + dz * dz > reach * reach) continue;
    const share = giveWay(w, me, o);
    if (share <= 0) continue;
    const rvx = tvx - o.vx, rvz = tvz - o.vz;
    const rv2 = rvx * rvx + rvz * rvz;
    if (rv2 < 1e-6) continue;
    const t = clamp((dx * rvx + dz * rvz) / rv2, 0, LOOK_S);
    if (t <= 0 && dx * rvx + dz * rvz < 0) continue; // moving apart
    const cx = dx - rvx * t, cz = dz - rvz * t; // where he will be relative to me at the closest approach
    const cd = Math.hypot(cx, cz);
    const R = me.r + (o.tip ? SLIDE_R + 0.5 : o.r) + ROOM;
    if (cd >= R) continue;
    // sideways, away from where he will be; head-on: to my right
    let sx = -cx, sz = -cz;
    if (cd < 1e-3) {
      sx = rvz;
      sz = -rvx;
    }
    const sl = Math.hypot(sx, sz) || 1;
    const urgency = (1 - t / LOOK_S) * ((R - cd) / R);
    ax += (sx / sl) * urgency * share * sp * 1.6;
    az += (sz / sl) * urgency * share * sp * 1.6;
    // somebody right in front of me, close: ease off
    if (t < 0.35 && cd < R * 0.6) slow = Math.min(slow, 1 - 0.6 * share * (1 - t / 0.35));
  }
  if (ax === 0 && az === 0 && slow === 1) return [tvx, tvz];
  let nx = tvx + ax, nz = tvz + az;
  const nl = Math.hypot(nx, nz) || 1;
  // same speed (he goes around, he does not speed up), less when he has to ease off
  nx = (nx / nl) * sp * slow;
  nz = (nz / nl) * sp * slow;
  return [nx, nz];
}

/** Standing (or barely moving): someone about to run into him who he should make way for, and he steps out of his line. */
function sidestep(w: World, me: Body, x: number, z: number, tvx: number, tvz: number): [number, number] {
  if (me.battery) return [tvx, tvz];
  let ax = 0, az = 0;
  for (const o of w.bodies) {
    if (o === me) continue;
    const ov2 = o.vx * o.vx + o.vz * o.vz;
    if (ov2 < 1) continue;
    const dx = x - o.x, dz = z - o.z;
    if (dx * dx + dz * dz > 49) continue;
    const share = giveWay(w, me, o);
    if (share < 0.5) continue;
    // (his line toward me: when he gets closest and how close)
    const t = (dx * o.vx + dz * o.vz) / ov2;
    if (t <= 0 || t > 0.8) continue;
    const cx = dx - o.vx * t, cz = dz - o.vz * t;
    const cd = Math.hypot(cx, cz);
    const R = me.r + o.r + ROOM;
    if (cd >= R) continue;
    // out of his line, to the side I am already on (behind him if dead centre)
    let sx = cx, sz = cz;
    if (cd < 1e-3) {
      sx = -o.vz;
      sz = o.vx;
    }
    const sl = Math.hypot(sx, sz) || 1;
    const k = share * (1 - t / 0.8) * 2.5;
    ax += (sx / sl) * k;
    az += (sz / sl) * k;
  }
  return ax === 0 && az === 0 ? [tvx, tvz] : [tvx + ax, tvz + az];
}

/** Bodies of the tick, rebuilt after everyone has moved (steering next tick reads them). */
export function refreshBodies(w: World): void {
  w.bodies = gatherBodies(w);
  w.bodyById = new Map(w.bodies.map((b) => [b.id, b]));
}

function shift(b: Body, dx: number, dz: number, dvx: number, dvz: number): void {
  b.x += dx;
  b.z += dz;
  if (b.tip) {
    b.tip.x += dx;
    b.tip.z += dz;
  }
  const o = b.p ?? b.u ?? b.s;
  if (!o) return;
  o.x += dx;
  o.z += dz;
  o.vx += dvx;
  o.vz += dvz;
  b.vx = o.vx;
  b.vz = o.vz;
}

/** A pair in contact this tick (for the rules and the event's rate limit). */
export interface Contact {
  a: Body;
  b: Body;
  /** speed at which they were closing (m/s) */
  speed: number;
  x: number;
  z: number;
}

/**
 * After everyone has moved: overlapping bodies are pushed apart (by mass) and their closing speed taken out. Returns the contacts.
 * Two passes settle a small pile (a tag at a crowded bag) without jitter.
 */
export function separate(w: World): Contact[] {
  const bodies = gatherBodies(w);
  const contacts: Contact[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      const aMoving = a.vx * a.vx + a.vz * a.vz > 1e-4;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!aMoving && b.vx * b.vx + b.vz * b.vz <= 1e-4 && pass > 0) continue;
        if (a.battery && b.battery) continue;
        if (slideTangle(a, b) || slideTangle(b, a)) continue;
        const qx = b.x - a.x, qz = b.z - a.z;
        if (qx * qx + qz * qz > 9) continue; // (a slider is at most ~1 m long)
        const c = coreDistance(a, b);
        const minD = a.r + b.r;
        if (c.d >= minD) continue;
        const overlap = Math.min(minD - c.d, MAX_PUSH);
        const ima = 1 / a.mass, imb = 1 / b.mass;
        const wa = ima / (ima + imb), wb = imb / (ima + imb);
        // the closing speed along the normal, taken out (inelastic)
        const vn = (b.vx - a.vx) * c.nx + (b.vz - a.vz) * c.nz;
        let ja = 0, jb = 0;
        if (vn < 0) {
          const J = -vn / (ima + imb);
          ja = J * ima;
          jb = J * imb;
          if (pass === 0) contacts.push({ a, b, speed: -vn, x: a.x + c.nx * (a.r + c.d / 2), z: a.z + c.nz * (a.r + c.d / 2) });
        }
        shift(a, -c.nx * overlap * wa, -c.nz * overlap * wa, -c.nx * ja, -c.nz * ja);
        shift(b, c.nx * overlap * wb, c.nz * overlap * wb, c.nx * jb, c.nz * jb);
      }
    }
  }
  for (const k of contacts) {
    if (k.speed < 1.5) continue;
    const key = k.a.id < k.b.id ? `${k.a.id}|${k.b.id}` : `${k.b.id}|${k.a.id}`;
    const last = w.collisionTick.get(key) ?? -1e9;
    if (w.tick - last < 240) continue;
    w.collisionTick.set(key, w.tick);
    emit(w, { type: 'collision', aId: k.a.id, bId: k.b.id, kinds: `${k.a.cls}${k.b.cls}`, speed: k.speed, pos: { x: k.x, y: 0, z: k.z } });
  }
  return contacts;
}

void TICK;
