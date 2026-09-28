import { createGame } from '../src/sim/game';
const g = createGame({ seed: 'bip1', pace: 0 });
const w = g._world;
let tracing = false, t0 = 0;
g.on('contact', (e) => { if (!tracing && e.launchDeg > -5 && e.launchDeg < 6 && e.exitMph > 70 && e.exitMph < 95 && Math.abs(e.sprayDeg) < 30) { tracing = true; t0 = w.tick; } });
for (let i = 0; i < 240 * 3600 && !g.over; i++) {
  g.step(1 / 240);
  if (tracing && (w.tick - t0) % 48 === 0 && (w.tick - t0) < 240 * 3.5 && (w.tick - t0) > 200) {
    console.log(((w.tick - t0) / 240).toFixed(2), w.runners.map((r) => `${r.isBatter ? 'BR' : 'R'} base${r.base} tgt${r.target} want${r.want} st:${r.state} (${r.p.x.toFixed(1)},${r.p.z.toFixed(1)}) v${Math.hypot(r.p.vx, r.p.vz).toFixed(1)} dead:${r.dead}`).join(' | '), 'holder', w.ball.holder?.fieldPos, w.ball.holder && w.ball.holder.plan.holdUntil - w.tick, 'covers', Object.entries(w.play?.covers ?? {}).map(([k, v]) => k + ':' + v?.fieldPos).join(','));
  }
  if (tracing && (w.tick - t0) > 240 * 3.5) break;
}
