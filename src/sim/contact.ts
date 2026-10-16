/**
 * The rules about bodies meeting (bodies.ts finds the contacts):
 *
 * - Obstruction (6.01(h)): a fielder who neither has the ball nor is fielding it (or about to take a throw) runs into, or stands in
 *   the way of, a runner. If a play is being made on that runner (a throw coming to the base he is going to or back to, a fielder
 *   with the ball after him) the ball is dead and he is given the base after the last one he touched (6.01(h)(1)); otherwise play
 *   goes on and he cannot be put out before the base he was running to, which he is given if he did not make it (6.01(h)(2)).
 *   A fielder without the ball blocking the bag or the plate (6.01(i)) is this too.
 * - Runner interference (6.01(a)(10)): a runner who runs into a fielder fielding a batted ball is out, the ball is dead, the batter
 *   gets first and the other runners go back to the bases they had at the pitch unless the batter forces them on.
 * - Out of the baseline (5.09(b)(1)): a runner who goes more than 3 ft off his line to the base to avoid a tag is out (tagging.ts
 *   records his line when the tag comes, this checks it).
 *
 * A fielder with the ball may block the bag and tag with his body against the runner's: that contact is legal.
 */
import { emit } from './events';
import { BASE_POS } from './field';
import type { Contact } from './bodies';
import * as rules from './rules';
import * as running from './running';
import { scheduleCall, nearestUmp } from './umpires';
import type { PlayerRT, RunnerRT, World } from './world';

/** Slower than this (m/s) the two only brushed: no call. */
const CALL_SPEED = 0.8;
/** 3 ft (m). */
export const BASELINE = 0.914;

const UMP = ['plate', 'first', 'second', 'third', 'plate'] as const;

/** He is fielding the batted / loose ball (the man going for it before anyone has it). */
function fieldingBall(w: World, F: PlayerRT): boolean {
  const m = w.ball.mode;
  return (m === 'batted' || m === 'loose') && !w.ball.holder && w.play?.primary === F;
}

/** A throw to him is about to arrive (he is in the act of fielding it). */
function takingThrow(w: World, F: PlayerRT): boolean {
  const b = w.ball;
  if (b.mode !== 'thrown') return false;
  const to = b.throwTo ?? b.lob?.to ?? null;
  if (to !== F) return false;
  const d = Math.hypot(b.body.x - F.x, b.body.z - F.z);
  const v = Math.hypot(b.body.vx, b.body.vz) || 20;
  return d / v < 0.6;
}

export function contactRules(w: World, contacts: Contact[]): void {
  const play = w.play;
  if (!play || play.dead || w.phase !== 'inPlay' || !contacts.length) return;
  for (const k of contacts) {
    if (k.speed < CALL_SPEED) continue;
    const R = k.a.cls === 'R' ? k.a : k.b.cls === 'R' ? k.b : null;
    const F = k.a.cls === 'F' ? k.a : k.b.cls === 'F' ? k.b : null;
    if (!R || !F || !R.run || !F.p) continue;
    const r = R.run, f = F.p;
    if (r.state !== 'live' || r.dead) continue;
    if (fieldingBall(w, f)) {
      interference(w, r, f);
      return;
    }
    if (f.hasBall || w.ball.holder === f || takingThrow(w, f)) continue; // with the ball he may block and tag
    if (!impedes(w, r, f)) continue;
    obstruction(w, r, f);
    if (play.dead) return;
  }
}

/**
 * Did the fielder impede him (rather than the two just meeting): the runner running for a base, the fielder standing in his lane
 * (within ~2 ft of the base path), and not the man covering that bag for a play (who stands beside it, foot on it, by rule).
 */
function impedes(w: World, r: RunnerRT, f: PlayerRT): boolean {
  const p = r.p;
  const sp = Math.hypot(p.vx, p.vz);
  if (sp < 3) return false;
  // on his way to a base (a run-through past first, or a man going back, is not being kept from one)
  if (r.target <= r.base || r.overrun) return false;
  const to = r.target;
  const from = r.base;
  // just out of the box / off the bag: the catcher and the batter-runner crossing at the plate, a man taking off, is incidental
  const fromBag = from === 0 ? { x: 0, z: 0 } : BASE_POS[from];
  if (Math.hypot(p.x - fromBag.x, p.z - fromBag.z) < 3) return false;
  const A = BASE_POS[from % 4], B = BASE_POS[to % 4];
  // running toward the base
  const dx = B.x - p.x, dz = B.z - p.z, dl = Math.hypot(dx, dz) || 1;
  if ((p.vx * dx + p.vz * dz) / dl < 0.7 * sp) return false;
  // the fielder in the lane
  const lx = B.x - A.x, lz = B.z - A.z, ll = lx * lx + lz * lz || 1;
  const t = Math.max(0, Math.min(1, ((f.x - A.x) * lx + (f.z - A.z) * lz) / ll));
  if (Math.hypot(f.x - (A.x + lx * t), f.z - (A.z + lz * t)) > 0.6) return false;
  // covering the bag he is running to (or back to), at it: in the act of fielding the play there
  if ((f.plan.kind === 'cover' || f.plan.kind === 'receive' || f.plan.kind === 'hold') && Math.hypot(f.x - B.x, f.z - B.z) < 1.2) return false;
  // taking a throw that is on its way (or lining up as the relay man for one): in the act of fielding it
  const m = w.ball.mode;
  if ((f.plan.kind === 'receive' && m === 'thrown') || (f.plan.kind === 'cutoff' && (m === 'thrown' || m === 'batted' || m === 'loose'))) return false;
  return true;
}

/** Is a play being made on him right now: a throw coming to the base ahead of or behind him, or a fielder with the ball after him? */
function playOn(w: World, r: RunnerRT): boolean {
  const b = w.ball;
  if (b.mode === 'thrown' && b.throwBase !== null && (b.throwBase === r.target || b.throwBase === r.base)) return true;
  const H = b.holder;
  return !!H && H.team === w.fieldingTeam && H.plan.kind === 'tag' && H.plan.tagTarget === r;
}

export function obstruction(w: World, r: RunnerRT, f: PlayerRT): void {
  if (r.protectTo >= Math.max(r.target, r.base + 1)) return; // (already called on this run)
  const type1 = playOn(w, r);
  const to = Math.min(4, type1 ? r.base + 1 : Math.max(r.target, r.base + 1));
  emit(w, { type: 'obstruction', runnerId: r.p.info.id, fielderId: f.info.id, base: to, deadBall: type1, pos: { x: r.p.x, y: 0, z: r.p.z } });
  // (the ball is dead: the plate umpire calls time; with play on the umpires let it run and give the base after it)
  if (type1) scheduleCall(w, 'plate', 'time', 0.2, { playerId: r.p.info.id });
  if (!type1) {
    // play on: he cannot be put out short of `to`, and gets it after the play if he does not make it
    r.protectTo = to;
    return;
  }
  // a dead ball: he is given the base; the others the bases they were going to (and any they are forced to)
  const play = w.play!;
  play.dead = true;
  play.deadReason = 'obstruction';
  w.ball.mode = 'dead';
  // (lead runners first: a runner behind is never given a base the man ahead still holds)
  const order = w.runners.filter((q) => q.state === 'live').sort((a, b) => b.base - a.base);
  for (const q of order) award(w, q, freeUpTo(w, q, q === r ? to : Math.max(q.target, q.base + (running.forced(w, q) ? 1 : 0))));
}

/** The highest base up to b that no other live runner holds or is being given (a runner is never given an occupied base). */
export function freeUpTo(w: World, r: RunnerRT, b: number): number {
  let to = b;
  while (to > r.base && to < 4 && w.runners.some((q) => q !== r && q.state === 'live' && (q.base === to || (q.dead && q.want === to)))) to--;
  return to;
}

/** Send a runner to base b on a dead ball (he jogs there; the bases between count as touched). */
function award(w: World, r: RunnerRT, b: number): void {
  r.dead = true;
  r.awarded = true;
  r.want = Math.max(r.base, Math.min(4, b));
  r.trot = running.trotSpeed(r.p);
  r.stealing = false;
  r.tagWait = false;
  r.retouch = 0;
  r.overrun = false;
  r.reaction = w.tick + 48;
  r.protectTo = 0;
}

/** A runner the defense could not put out because he was obstructed: he is safe at the base he was running to. */
export function obstructedSafe(w: World, r: RunnerRT): void {
  const to = r.protectTo;
  emit(w, { type: 'obstruction', runnerId: r.p.info.id, fielderId: '', base: to, deadBall: false, awarded: true, pos: { x: r.p.x, y: 0, z: r.p.z } });
  scheduleCall(w, UMP[to], 'safe', 0.3, { atBase: to, playerId: r.p.info.id });
  award(w, r, to);
}

export function interference(w: World, r: RunnerRT, f: PlayerRT): void {
  const play = w.play!;
  emit(w, { type: 'interference', runnerId: r.p.info.id, fielderId: f.info.id, pos: { x: r.p.x, y: 0, z: r.p.z } });
  rules.recordOut(w, r, 'interference', [f], null, false);
  play.dead = true;
  play.deadReason = 'interference';
  w.ball.mode = 'dead';
  scheduleCall(w, nearestUmp(w, r.p.x, r.p.z), 'out', 0.3, { playerId: r.p.info.id });
  if (w.outs >= 3) return;
  // the batter gets first; everyone else goes back to the base he had at the pitch, unless the batter forces him on
  const taken = new Set<number>();
  const br = w.runners.find((q) => q.isBatter && q.state === 'live');
  if (br) taken.add(1);
  const others = w.runners.filter((q) => q.state === 'live' && !q.isBatter).sort((a, b) => a.origin - b.origin);
  for (const q of others) {
    let b = q.origin;
    while (taken.has(b) && b < 4) b++;
    taken.add(b);
    if (q.base > b) {
      // (he had gone on: back to the base he is given)
      q.base = b;
      q.touched[b] = true;
    }
    award(w, q, b);
  }
  if (br) award(w, br, 1);
}

/** 5.09(b)(1): checked every tick of a tag attempt against a runner whose line was taken when it began (tagging.ts). */
export function baselineCheck(w: World, r: RunnerRT): boolean {
  const L = r.tagLine;
  if (!L || r.state !== 'live' || r.dead || r.slideKind) return false;
  const lx = L.bx - L.x0, lz = L.bz - L.z0;
  const ll = Math.hypot(lx, lz);
  if (ll < 1) return false;
  const off = Math.abs((r.p.x - L.x0) * (lz / ll) - (r.p.z - L.z0) * (lx / ll));
  if (off <= BASELINE) return false;
  emit(w, { type: 'outOfBaseline', runnerId: r.p.info.id, offM: off, pos: { x: r.p.x, y: 0, z: r.p.z } });
  rules.recordOut(w, r, 'baseline', w.ball.holder ? [w.ball.holder] : [], null, false);
  scheduleCall(w, nearestUmp(w, r.p.x, r.p.z), 'out', 0.3, { playerId: r.p.info.id });
  return true;
}

export { UMP };
