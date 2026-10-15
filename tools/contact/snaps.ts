/**
 * One-tick jumps: plays N seeded games (pace 1) and lists every time someone on the field moves further in one tick (1/240 s) than
 * he could run (> 1.5x his top speed, and > 3 cm), outside the dugouts: placements that teleport instead of walking.
 *
 *   npx tsx tools/contact/snaps.ts [games=10] [seed=sn] [tempo=quick]
 */
import { createGame } from '../../src/sim/game';
import { dugoutFloorY } from '../../src/sim/venue';
import type { PlayerRT } from '../../src/sim/world';

const N = Number(process.argv[2] ?? 10);
const seed0 = process.argv[3] ?? 'sn';
const tempo = (process.argv[4] ?? 'quick') as 'quick';
const byKind = new Map<string, { n: number; max: number; ex: string }>();
for (let i = 0; i < N; i++) {
  const g = createGame({ seed: `${seed0}-${i}`, tempo, pace: 1, innings: 9 });
  const w = g._world;
  const prev = new Map<PlayerRT, [number, number, boolean]>();
  let n = 0;
  while (!g.over && n++ < 240 * 6 * 3600) {
    const phase0 = w.phase;
    g.step(1 / 240);
    for (const t of [w.teams.home, w.teams.away]) for (const p of t.players.values()) {
      const vis = (p.onField || !!p.dug) && dugoutFloorY(p.x, p.z) >= 0 && p.dug !== 'bench' && p.dug !== 'bullpen';
      const q = prev.get(p);
      prev.set(p, [p.x, p.z, vis]);
      if (!q || !vis || !q[2]) continue;
      const d = Math.hypot(p.x - q[0], p.z - q[1]);
      if (d > 0.03 && d > (1.5 * Math.max(p.vmax, 3)) / 240) {
        const role = w.runners.some((r) => r.p === p) ? 'runner' : p === w.batter ? 'batter' : p.role;
        const key = `${role} ${phase0}->${w.phase}`;
        const e = byKind.get(key) ?? { n: 0, max: 0, ex: '' };
        e.n++;
        if (d > e.max) {
          e.max = d;
          e.ex = `${seed0}-${i} t=${(w.tick / 240).toFixed(2)} ${p.info.id} ${(d * 100).toFixed(0)} cm`;
        }
        byKind.set(key, e);
      }
    }
  }
  process.stderr.write(`\r${i + 1}/${N}`);
}
process.stderr.write('\n');
console.log(`one-tick jumps over ${N} games (pace 1, ${tempo}):`);
for (const [k, e] of [...byKind].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(36)} ${String(e.n).padStart(5)}  max ${(e.max * 100).toFixed(0)} cm  e.g. ${e.ex}`);
if (!byKind.size) console.log('  none');
