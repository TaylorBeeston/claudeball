import { createGame } from '../../src/sim/index';
import { RealSimAdapter } from '../../src/engine/realSimAdapter';
const seed = +(process.argv[2] ?? 24), tempo = (process.argv[3] ?? 'broadcast') as 'broadcast';
const N = +(process.argv[4] ?? 5);
const g = new RealSimAdapter(createGame({ seed, tempo, innings: 9 } as never) as never);
let pa = 0, id: string | null = null, t0 = 0, pitched = false;
g.on((ev: any) => { if (ev.type === 'pitch' && id && !pitched) { pitched = true; console.log(`  PITCH at +${(g.getState().time - t0).toFixed(2)}`); } });
for (let i = 0; i < 120 * 3000 && pa <= N; i++) {
  g.step(1 / 120);
  if (i % 12) continue;
  const s: any = g.getState();
  const b = s.players.find((p: any) => p.role === 'batter');
  if (!b) continue;
  if (b.id !== id) { id = b.id; pa++; t0 = s.time; pitched = false; console.log(`PA ${pa} ${b.name} t=${t0.toFixed(1)} hand=${b.hand}`); }
  if (pitched) continue;
  console.log(`  +${(s.time - t0).toFixed(1)} x=${b.pos.x.toFixed(2)} z=${b.pos.z.toFixed(2)} v=${Math.hypot(b.vel.x, b.vel.z).toFixed(2)} f=${b.facing.toFixed(2)} ${b.anim} ${s.lull?.detail ?? ''}`);
}
