/**
 * Body overlap statistics: plays N seeded games headless and counts, per pair type, how often two people on the field are closer
 * than 20 / 35 / 50 cm (centre to centre, on the ground plane). Two bodies shoulder to shoulder are ~45 cm apart; under 35 cm
 * they are inside each other.
 *
 *   npx tsx tools/contact/overlaps.ts [games=100] [seed=ov] [tempo=quick] [--json out.json]
 *
 * Counts: `ticks` = sampled instants (60 Hz) a pair was under the threshold; `episodes` = separate times a pair went under it.
 * Pair types use one letter per body: F fielder, B batter, R runner, U umpire, C base coach, K ball kid / bat boy, M manager
 * or coach out of the dugout, D a batting-side player walking on the field (on deck, to / from the dugout). `battery` (catcher,
 * batter and plate umpire around the plate while a pitch is coming) is counted on its own: they stand close by design.
 */
import { writeFileSync } from 'node:fs';
import { createGame } from '../../src/sim/game';
import { dugoutFloorY } from '../../src/sim/venue';
import type { PlayerRT, World } from '../../src/sim/world';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const jsonOut = flag('--json');
const N = Number(args[0] ?? 100);
const seed0 = args[1] ?? 'ov';
const tempo = (args[2] ?? 'quick') as 'quick' | 'standard' | 'broadcast';

const TH = [0.2, 0.35, 0.5] as const;

export interface Body {
  id: string;
  kind: string;
  x: number;
  z: number;
  /** around the plate while a pitch is coming: catcher, batter, plate umpire */
  battery: boolean;
}

/** Everyone the snapshot shows standing on the playing surface (the same people `snapshot.ts` lists, minus the dugouts and the bullpen). */
export function gatherBodies(w: World): Body[] {
  const out: Body[] = [];
  const pitching = w.phase === 'prePitch' || w.phase === 'windup' || w.phase === 'pitch';
  const seen = new Set<PlayerRT>();
  const add = (p: PlayerRT, kind: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (dugoutFloorY(p.x, p.z) < 0) return;
    out.push({ id: p.info.id, kind, x: p.x, z: p.z, battery: pitching && (p === w.catcher || (p === w.batter && kind === 'B')) });
  };
  for (const p of w.fieldingTeam.defense.values()) if (p.onField) add(p, 'F');
  for (const r of w.runners) if (r.p.onField) add(r.p, 'R');
  for (const l of w.leavers) if (l.p.onField) add(l.p, 'D');
  for (const r of w.exiting) if (r.p.onField) add(r.p, 'R');
  if (w.batter && w.batter.onField) add(w.batter, 'B');
  for (const t of [w.teams.home, w.teams.away]) {
    for (const p of t.players.values()) if (!p.onField && (p.dug === 'toBench' || p.dug === 'toDeck' || p.dug === 'deck' || p.dug === 'toMound')) add(p, 'D');
  }
  for (const u of w.umpires) out.push({ id: u.id, kind: 'U', x: u.x, z: u.z, battery: pitching && u.key === 'plate' });
  for (const s of w.staff) {
    if (!s.active || dugoutFloorY(s.x, s.z) < 0) continue;
    const kind = s.role === 'coach1b' || s.role === 'coach3b' ? 'C' : s.role === 'ballkid' || s.role === 'batboy' ? 'K' : 'M';
    out.push({ id: s.id, kind, x: s.x, z: s.z, battery: false });
  }
  return out;
}

interface Row { ticks: number[]; episodes: number[]; liveTicks: number[] }
const rows = new Map<string, Row>();
const row = (k: string) => {
  let r = rows.get(k);
  if (!r) rows.set(k, (r = { ticks: [0, 0, 0], episodes: [0, 0, 0], liveTicks: [0, 0, 0] }));
  return r;
};
const worst: { d: number; at: string }[] = [];

const t0 = Date.now();
let samples = 0;
for (let i = 0; i < N; i++) {
  const g = createGame({ seed: `${seed0}-${i}`, tempo, innings: 9 });
  const w = g._world;
  // pair key -> threshold index flags under last sample
  const under = new Map<string, number>();
  let n = 0;
  while (!g.over && n++ < 240 * 6 * 3600) {
    g.step(4 / 240);
    samples++;
    const bs = gatherBodies(w);
    const live = w.phase === 'inPlay';
    const now = new Map<string, number>();
    for (let a = 0; a < bs.length; a++) {
      for (let b = a + 1; b < bs.length; b++) {
        const A = bs[a], B = bs[b];
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d >= TH[2]) continue;
        const pair = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
        const type = A.battery && B.battery ? 'battery' : [A.kind, B.kind].sort().join('');
        const r = row(type);
        let mask = 0;
        TH.forEach((th, k) => {
          if (d < th) {
            mask |= 1 << k;
            r.ticks[k]++;
            if (live) r.liveTicks[k]++;
            if (!((under.get(pair) ?? 0) & (1 << k))) r.episodes[k]++;
          }
        });
        now.set(pair, mask);
        if (d < 0.35 && type !== 'battery') {
          worst.push({ d, at: `${seed0}-${i} t=${(w.tick / 240).toFixed(1)} ${w.phase} ${type} ${A.id} ${B.id}` });
          if (worst.length > 4000) worst.sort((x, y) => x.d - y.d).splice(400);
        }
      }
    }
    under.clear();
    for (const [k, v] of now) under.set(k, v);
  }
  process.stderr.write(`\r${i + 1}/${N} games`);
}
process.stderr.write('\n');
const types = [...rows.keys()].sort((a, b) => rows.get(b)!.episodes[1] - rows.get(a)!.episodes[1]);
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`overlaps: ${N} games, seed ${seed0}, tempo ${tempo}, ${samples} samples at 60 Hz, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`${'pair'.padEnd(8)}${pad('ep<20', 8)}${pad('ep<35', 8)}${pad('ep<50', 8)}${pad('s<20', 9)}${pad('s<35', 9)}${pad('s<50', 9)}${pad('live s<35', 11)}   (ep = episodes per 100 games, s = seconds per 100 games)`);
const per100 = (x: number) => (x * 100) / N;
let tot = [0, 0, 0];
for (const k of types) {
  const r = rows.get(k)!;
  if (k !== 'battery') tot = tot.map((v, j) => v + r.episodes[j]);
  console.log(`${k.padEnd(8)}${pad(per100(r.episodes[0]).toFixed(0), 8)}${pad(per100(r.episodes[1]).toFixed(0), 8)}${pad(per100(r.episodes[2]).toFixed(0), 8)}${pad(per100(r.ticks[0] / 60).toFixed(0), 9)}${pad(per100(r.ticks[1] / 60).toFixed(0), 9)}${pad(per100(r.ticks[2] / 60).toFixed(0), 9)}${pad(per100(r.liveTicks[1] / 60).toFixed(0), 11)}`);
}
console.log(`${'all-bat.'.padEnd(8)}${pad(per100(tot[0]).toFixed(0), 8)}${pad(per100(tot[1]).toFixed(0), 8)}${pad(per100(tot[2]).toFixed(0), 8)}   (all pairs except battery)`);
worst.sort((x, y) => x.d - y.d);
console.log('closest (non-battery):');
const seen = new Set<string>();
for (const x of worst) {
  const key = x.at.replace(/ t=[\d.]+/, '');
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${(x.d * 100).toFixed(0).padStart(3)} cm  ${x.at}`);
  if (seen.size >= 12) break;
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ games: N, seed: seed0, tempo, rows: Object.fromEntries(rows), worst: worst.slice(0, 50) }, null, 1));
