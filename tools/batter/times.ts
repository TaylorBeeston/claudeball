/**
 * Sim times of the moments the batter tools film (Node, the sim alone, ~2 s per game hour): each batter's walk-up (called -> first pitch),
 * the on-deck hitter's practice swings, the bench reactions.
 *   npx tsx tools/batter/times.ts [--seed 24] [--tempo broadcast] [--until 900]
 */
import { createGame } from '../../src/sim/index';
import { RealSimAdapter } from '../../src/engine/realSimAdapter';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const g = new RealSimAdapter(createGame({ seed: +opt('seed', '24'), tempo: opt('tempo', 'broadcast'), innings: 9 } as never) as never);
const until = +opt('until', '900');
const prev = new Map<string, string>();
let batter = '', called = 0;
let pitched = true;
g.on((ev: { type: string }) => {
  if (ev.type === 'pitch' && !pitched) {
    pitched = true;
    console.log(`walkup ${batter} ${called.toFixed(2)} -> pitch ${g.getState().time.toFixed(2)}`);
  }
});
for (let i = 0; g.getState().time < until; i++) {
  g.step(1 / 120);
  if (i % 6) continue;
  const s = g.getState();
  for (const p of s.players) {
    const was = prev.get(p.id);
    if (p.role === 'batter' && p.id !== batter) ((batter = p.id), (called = s.time), (pitched = false));
    if (p.anim !== was && (p.anim === 'ondeck_swing' || p.anim.startsWith('bench_'))) if (p.anim !== 'bench_sit') console.log(`${p.anim} ${p.role} ${p.id} ${s.time.toFixed(2)}`);
    prev.set(p.id, p.anim);
  }
}
