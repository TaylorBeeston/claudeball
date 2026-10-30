/**
 * Fly-ball catches in seeded games (sim only): where the glove met the ball (height), the clip the sim chose, the fielder's speed, how long he
 * had been settled under it, and how far he was from the spot when the ball was hit.
 *
 *   npx tsx tools/fly/catches.ts [games=6] [seed=fly] [tempo=quick] [--rows]   (seed `n`: the numeric seeds 1..games, the ones `?seed=` opens)
 */
import { createGame } from '../../src/sim/game';
import type { PlayerRT } from '../../src/sim/world';

const N = Number(process.argv[2] ?? 6);
const seed0 = process.argv[3] ?? 'fly';
const tempo = (process.argv[4] ?? 'quick') as 'quick';
const rows: Record<string, unknown>[] = [];
const calls: { seed: string; t: number; id: string; caught: boolean }[] = [];
for (let i = 0; i < N; i++) {
  const seed = seed0 === 'n' ? i + 1 : `${seed0}-${i}`;
  const g = createGame({ seed, tempo, pace: 1, innings: 9 } as never);
  const w = g._world;
  // per fielder: the tick he last moved faster than 1 m/s during the play (settled = arrival - that)
  const lastMove = new Map<PlayerRT, number>();
  g.on('*', (e: { type: string; fielderId?: string; fly?: boolean; pos?: { x: number; y: number; z: number }; kind?: string }) => {
    if (e.type === 'callForBall') calls.push({ seed: `${seed}`, t: w.tick / 240, id: e.fielderId!, caught: false });
    if (e.type !== 'catch' || !e.fly || !e.pos) return;
    const F = [...w.teams.home.players.values(), ...w.teams.away.players.values()].find((p) => p.info.id === e.fielderId);
    if (!F) return;
    const bip = w.play?.bip;
    const call = w.play?.called;
    const mine = calls.find((c) => c.seed === `${seed}` && c.id === F.info.id && w.tick / 240 - c.t < 8 && !c.caught);
    if (mine) mine.caught = true;
    rows.push({
      called: call ? (call.F === F ? +((w.tick - call.tick) / 240).toFixed(2) : 'other') : null,
      seed, t: +(w.tick / 240).toFixed(2), pos: F.fieldPos, kind: e.kind, y: +e.pos.y.toFixed(2), anim: F.anim, leap: !!F.leap,
      fid: F.info.id, speed: +Math.hypot(F.vx, F.vz).toFixed(2), settled: +(((w.tick - (lastMove.get(F) ?? 0)) / 240)).toFixed(2), launch: bip ? +bip.launchDeg.toFixed(0) : null,
      dist: +Math.hypot(e.pos.x, e.pos.z).toFixed(1), vy: +w.ball.body.vy.toFixed(1),
    });
  });
  let n = 0;
  while (!g.over && n++ < 240 * 6 * 3600) {
    g.step(1 / 240);
    if (w.phase === 'inPlay') for (const t of [w.teams.home, w.teams.away]) for (const p of t.players.values()) if (Math.hypot(p.vx, p.vz) > 1) lastMove.set(p, w.tick);
  }
}
const q = (a: number[], f: number) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
const by = (k: (r: Record<string, unknown>) => string) => {
  const m = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) m.set(k(r), [...(m.get(k(r)) ?? []), r]);
  return m;
};
console.log(`${rows.length} catches in the air`);
for (const [k, rs] of [...by((r) => `${r.kind} ${r.anim}`)].sort((a, b) => b[1].length - a[1].length)) {
  const ys = rs.map((r) => r.y as number), st = rs.map((r) => r.settled as number), sp = rs.map((r) => r.speed as number);
  console.log(`${k.padEnd(28)} n=${String(rs.length).padStart(3)}  y p10/50/90 ${q(ys, 0.1)}/${q(ys, 0.5)}/${q(ys, 0.9)}  speed p50 ${q(sp, 0.5)}  settled p10/50/90 ${q(st, 0.1)}/${q(st, 0.5)}/${q(st, 0.9)} s`);
}
{
  const fl = rows.filter((r) => r.kind !== 'line');
  const lead = fl.map((r) => r.called).filter((c): c is number => typeof c === 'number');
  console.log(`calls ${calls.length}: caught by the caller ${calls.filter((c) => c.caught).length}; fly/pop catches ${fl.length}: called by the catcher ${lead.length}, by another fielder ${fl.filter((r) => r.called === 'other').length}, not called ${fl.filter((r) => r.called === null).length}; call -> catch p10/50/90 ${q(lead, 0.1)}/${q(lead, 0.5)}/${q(lead, 0.9)} s`);
  for (const r of fl.filter((r) => r.called === null)) console.log('  not called:', JSON.stringify(r));
  for (const c of calls.filter((c) => !c.caught)) console.log('  call without his catch:', JSON.stringify(c));
}
if (process.argv.includes('--rows')) for (const r of rows) console.log(JSON.stringify(r));
