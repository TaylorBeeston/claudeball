/**
 * Base-touch validator: plays N seeded games headless and checks every time a runner's body passes a bag.
 *
 *   npx tsx tools/contact/bases.ts [games=100] [seed=bt] [tempo=quick] [--pace 0|1] [--list 20]
 *
 * A "pass" is a runner who has not yet been credited with a base coming within 1.2 m of its bag's centre. For each pass it records whether the sim counted a touch
 * (`baseTouch`), how close his body centre came to the bag (0 = over it), and, when the sim models footstrikes
 * (`PlayerRT.stride.last`), whether a footstrike landed on the bag. It reports:
 *   - touched, no foot: a `baseTouch` with no footstrike (or slide limb) on the bag. Without a stride model it falls back to a
 *     proxy: the body centre never came within FOOT_REACH of the bag square, so no foot could have been on it.
 *   - crossed, no touch: the body went over the bag (centre inside the bag square) with no `baseTouch` for that base.
 */
import { createGame } from '../../src/sim/game';
import { BASE_POS } from '../../src/sim/field';
import { shoeOn } from '../../src/sim/stride';
import { runnerBody } from '../../src/sim/tagging';
import type { PlayerRT, World } from '../../src/sim/world';

const args = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = args.indexOf(k);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const pace = Number(flag('--pace', '1'));
const list = Number(flag('--list', '15'));
const N = Number(args[0] ?? 100);
const seed0 = args[1] ?? 'bt';
const tempo = (args[2] ?? 'quick') as 'quick' | 'standard' | 'broadcast';

/** Half the bag's side (15 in square, edges along the base paths). */
const HALF = (15 * 0.0254) / 2;
/** How far from the body centre a planted foot can be (forward reach at touchdown + half a shoe). */
const FOOT_REACH = 0.3;

/** Distance from (x, z) to bag `b`'s square (0 inside). Bags 1-3 are squares turned 45 degrees; home is the plate. */
export function distToBag(b: number, x: number, z: number): number {
  if (b === 4 || b === 0) {
    // home plate: the pentagon, approximated by its 17 in square part plus the point
    const hx = Math.max(0, Math.abs(x) - 0.2159);
    const hz = Math.max(0, z - 0.4318, -z);
    return Math.hypot(hx, hz);
  }
  const c = BASE_POS[b];
  const dx = x - c.x, dz = z - c.z;
  const u = (dx + dz) / Math.SQRT2, v = (dx - dz) / Math.SQRT2;
  return Math.hypot(Math.max(0, Math.abs(u) - HALF), Math.max(0, Math.abs(v) - HALF));
}

interface Pass { id: string; base: number; minCentre: number; touched: boolean; footOn: boolean; strikes: number; crossed: boolean; at: string; trot: boolean }
const passes: Pass[] = [];
let hasStride = false;
const missed = { knows: 0, unaware: 0, seen: 0, list: [] as string[] };

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const g = createGame({ seed: `${seed0}-${i}`, tempo, pace, innings: 9 });
  const w = g._world as World;
  const open = new Map<string, Pass>();
  const lastStrike = new Map<string, number>();
  g.on('baseTouch', (e) => {
    const b = e.base;
    const p = open.get(`${e.playerId}|${b === 4 ? 4 : b}`);
    if (p) {
      p.touched = true;
      p.trot ||= e.trot;
    }
  });
  g.on('baseMissed', (e) => {
    if (e.knows) missed.knows++;
    else missed.unaware++;
    if (e.seen) missed.seen++;
    missed.list.push(`${seed0}-${i} t=${(w.tick / 240).toFixed(2)} ${e.playerId} base ${e.base} by ${(e.by * 100).toFixed(0)} cm ${e.knows ? 'knows' : 'unaware'}${e.seen ? ' seen' : ''}`);
  });
  let n = 0;
  while (!g.over && n++ < 240 * 6 * 3600) {
    g.step(1 / 240);
    for (const r of [...w.runners, ...w.exiting]) {
      const P = r.p as PlayerRT & { stride?: { last?: { x: number; z: number; tick: number; dir: number } } };
      const id = P.info.id;
      const st = P.stride?.last;
      const fresh = !!st && st.tick !== lastStrike.get(id);
      if (st) {
        hasStride = true;
        lastStrike.set(id, st.tick);
      }
      for (let b = 1; b <= 4; b++) {
        const c = b === 4 ? { x: 0, z: 0.2 } : BASE_POS[b];
        const dc = Math.hypot(P.x - c.x, P.z - c.z);
        const key = `${id}|${b}`;
        let ps = open.get(key);
        if (dc < 1.2 && r.state === 'live') {
          // (a runner already credited with this base is standing on it, leading off or going back: not a pass)
          // (nor is one who is not on his way to it: the inning is over, or he is going back)
          if (!ps && (r.base >= b || r.target < b)) continue;
          if (!ps) {
            ps = { id, base: b, minCentre: 9, touched: false, footOn: false, strikes: 0, crossed: false, at: `${seed0}-${i} t=${(w.tick / 240).toFixed(2)}`, trot: r.dead };
            open.set(key, ps);
          }
          const d = distToBag(b, P.x, P.z);
          ps.minCentre = Math.min(ps.minCentre, d);
          if (d === 0 && r.target >= b) ps.crossed = true;
          if (fresh && st) {
            ps.strikes++;
            if (shoeOn(b, st)) ps.footOn = true;
          }
          // a slide: the leading limb reaching the bag is the touch; standing on the bag too
          if (r.slideKind) {
            const body = runnerBody(r);
            if (distToBag(b, body.tx, body.tz) <= 0.04) ps.footOn = true;
          }
          if (Math.hypot(P.vx, P.vz) < 1 && d <= 0.12) ps.footOn = true;
        } else if (ps) {
          passes.push(ps);
          open.delete(key);
        }
      }
    }
  }
  for (const ps of open.values()) passes.push(ps);
  process.stderr.write(`\r${i + 1}/${N} games`);
}
process.stderr.write('\n');

const touched = passes.filter((p) => p.touched);
const noFoot = hasStride ? touched.filter((p) => !p.footOn) : touched.filter((p) => p.minCentre > FOOT_REACH);
const crossedNoTouch = passes.filter((p) => p.crossed && !p.touched);
const hist = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.9, 1.2];
const h = hist.map((lo, k) => touched.filter((p) => p.minCentre >= lo && p.minCentre < (hist[k + 1] ?? 9)).length);
console.log(`bases: ${N} games, seed ${seed0}, tempo ${tempo}, pace ${pace}, ${((Date.now() - t0) / 1000).toFixed(0)} s, stride model: ${hasStride ? 'yes' : 'no (proxy)'}`);
console.log(`passes within 1.2 m of a bag: ${passes.length}   with a baseTouch: ${touched.length}`);
console.log(`touched, no foot on the bag: ${noFoot.length} (${((100 * noFoot.length) / Math.max(1, touched.length)).toFixed(1)}% of touches)${hasStride ? '' : `   [proxy: body centre never within ${FOOT_REACH} m of the bag]`}`);
console.log(`crossed the bag, no touch: ${crossedNoTouch.length}`);
console.log(`closest approach of the body centre to the bag square, per touch: ${hist.map((lo, k) => `${lo}-${hist[k + 1] ?? '+'}m ${h[k]}`).join('  ')}`);
console.log(`missed bags (sim): ${missed.knows} went back, ${missed.unaware} ran on unaware (${missed.seen} seen by a fielder)`);
for (const m of missed.list.slice(0, list)) console.log(`  missed: ${m}`);
for (const p of noFoot.slice(0, list)) console.log(`  no foot: ${p.at} ${p.id} base ${p.base} centre ${(p.minCentre * 100).toFixed(0)} cm${p.trot ? ' (trot)' : ''} strikes ${p.strikes}`);
for (const p of crossedNoTouch.slice(0, list)) console.log(`  crossed: ${p.at} ${p.id} base ${p.base}`);
