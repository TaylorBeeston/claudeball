import { createGame } from '../src/sim/game';
const N = Number(process.argv[2] ?? 40);
let bad = 0, maxLen = 0, minLen = 1e9;
for (let i = 0; i < N; i++) {
  const g = createGame({ seed: 'soak' + i, pace: 0.05 });
  try {
    const t = g.simulateToEnd(5 * 3600);
    const w = g._world;
    if (!g.over) { bad++; console.log('NOT OVER', i, w.phase, w.inning, w.half, w.outs, w.play?.kind, w.play?.dead, w.ball.mode); }
    maxLen = Math.max(maxLen, t); minLen = Math.min(minLen, t);
  } catch (e) { bad++; console.log('ERR', i, (e as Error).stack?.split('\n').slice(0, 4).join(' | ')); }
}
console.log('bad', bad, 'of', N, 'len min/max (min)', (minLen / 60).toFixed(0), (maxLen / 60).toFixed(0));
