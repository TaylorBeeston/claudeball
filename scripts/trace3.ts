import { createGame } from '../src/sim/game';
const g = createGame({ seed: 'gb7', pace: 0 });
const w = g._world;
let cur = false, t0 = 0, count = 0;
g.on('contact', (e) => { cur = false; if (e.launchDeg < 8 && e.exitMph > 60) { count++; if (count === 10) { cur = true; t0 = w.tick; } } });
for (let i = 0; i < 240 * 3600 && !g.over; i++) {
  g.step(1 / 240);
  if (cur && (w.tick - t0) % 24 === 0) {
    const t = (w.tick - t0) / 240;
    if (t > 1 && t < 6) {
      const h = w.ball.holder;
      console.log(t.toFixed(2), w.ball.mode, 'holder', h?.fieldPos, h && `(${h.x.toFixed(1)},${h.z.toFixed(1)}) plan ${h.plan.kind} hold${h.plan.holdUntil - w.tick} rel${h.plan.releaseAt}`, 'BR', w.runners.map((r) => `${r.state} b${r.base} t${r.target} (${r.p.x.toFixed(1)},${r.p.z.toFixed(1)})`).join(' '), 'outs', w.outs);
    }
  }
  if (cur && (w.tick - t0) > 240 * 6) break;
}
