/**
 * Ground balls fielded in seeded games (sim only), and the throw that follows: when the fielder took it, his position, how fast he was moving,
 * and when he let the throw go (the catch-to-throw pivot is the time between).
 *   npx tsx tools/fly/grounders.ts [games=2] [seed=n] [tempo=quick]   (seed `n`: the numeric seeds 1..games)
 */
import { createGame } from '../../src/sim/game';

const N = Number(process.argv[2] ?? 2);
const ONLY = process.argv[5] ? +process.argv[5] : 0;
const seed0 = process.argv[3] ?? 'n';
const tempo = (process.argv[4] ?? 'quick') as 'quick';
for (let i = 0; i < N; i++) {
  const seed = ONLY || (seed0 === "n" ? i + 1 : `${seed0}-${i}`);
  const g = createGame({ seed, tempo, pace: 1, innings: 9 } as never);
  const w = g._world;
  let open: Record<string, unknown> | null = null;
  g.on('*', (e: { type: string; fielderId?: string; fromId?: string; pos?: { x: number; z: number } }) => {
    const t = +(w.tick / 240).toFixed(2);
    if (e.type === 'fielded') {
      const F = [...w.teams.home.players.values(), ...w.teams.away.players.values()].find((p) => p.info.id === e.fielderId);
      open = { seed, t, id: e.fielderId, pos: F?.fieldPos, speed: F ? +Math.hypot(F.vx, F.vz).toFixed(2) : null, dist: e.pos ? +Math.hypot(e.pos.x, e.pos.z).toFixed(1) : null };
    }
    if (e.type === 'throw' && open && e.fromId === open.id) {
      console.log(JSON.stringify({ ...open, throwAt: t, pivot: +(t - (open.t as number)).toFixed(2) }));
      open = null;
    }
  });
  let n = 0;
  while (!g.over && n++ < 240 * 6 * 3600) g.step(1 / 240);
}
