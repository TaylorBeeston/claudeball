import { createGame } from '../src/sim/game';
const g = createGame({ seed: 'st1', pace: 0 });
const w = g._world;
let tr = 0, t0 = 0, shown = 0;
g.on('windup', () => { if (w.stealing.size && shown === 0) { tr = 1; t0 = w.tick; shown = 1; } });
for (let i = 0; i < 240 * 3600 && !g.over; i++) {
  g.step(1 / 240);
  if (tr && (w.tick - t0) % 30 === 0) {
    const t = (w.tick - t0) / 240;
    console.log(t.toFixed(2), w.phase, w.runners.map((r) => `b${r.base} t${r.target} w${r.want} st${r.stealing} ${r.state} (${r.p.x.toFixed(1)},${r.p.z.toFixed(1)}) v${Math.hypot(r.p.vx, r.p.vz).toFixed(1)} rx${r.reaction - w.tick} goal ${r.p.goal ? r.p.goal.x.toFixed(1) + ',' + r.p.goal.z.toFixed(1) : '-'}`).join(' | '), 'ball', w.ball.mode, 'outs', w.outs);
    if (t > 5) break;
  }
}
