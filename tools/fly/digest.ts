/**
 * Determinism check for observer-only sim changes: a hash of every event a seeded game emits (in order, every field) and its final line score.
 * Two builds that must not differ in play print the same digests. Event types in --skip (default: the fly-ball call, which observes only) are left out.
 *
 *   npx tsx tools/fly/digest.ts [--seeds 1-4] [--tempo quick] [--skip callForBall]
 */
import { createHash } from 'node:crypto';
import { createGame } from '../../src/sim/game';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const [a, b = a] = opt('seeds', '1-4').split('-').map(Number);
const skip = new Set(opt('skip', 'callForBall').split(','));
for (let seed = a; seed <= b; seed++) {
  const g = createGame({ seed, tempo: opt('tempo', 'quick') as 'quick', innings: 9 } as never);
  const h = createHash('sha1');
  let n = 0, skipped = 0;
  g.on('*', (e: { type: string }) => {
    if (skip.has(e.type)) return void skipped++;
    n++;
    h.update(JSON.stringify(e));
  });
  let i = 0;
  while (!g.over && i++ < 240 * 6 * 3600) g.step(1 / 240);
  const w = g._world;
  const line = `${w.teams.away.runs ?? ''}-${w.teams.home.runs ?? ''}`;
  console.log(`seed ${seed}: ${h.digest('hex').slice(0, 16)}  ${n} events (${skipped} skipped)  final ${line}  ticks ${w.tick}`);
}
