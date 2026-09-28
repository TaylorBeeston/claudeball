import { createGame } from '../src/sim/game';
import { computeIntercept, fielders } from '../src/sim/fielding';
const g = createGame({ seed: 'bip1', pace: 0 });
const w = g._world;
let tracing = false, t0 = 0, n = 0;
g.on('contact', (e) => {
  if (!tracing && e.launchDeg > -5 && e.launchDeg < 6 && e.exitMph > 70 && e.exitMph < 95 && Math.abs(e.sprayDeg) < 30) { tracing = true; t0 = w.tick; console.log('contact', e.exitMph.toFixed(0), e.launchDeg.toFixed(0), e.sprayDeg.toFixed(0)); }
});
g.on('*', (e) => { if (tracing && ['catch','fielded','error','out','playEnd','throw'].includes(e.type)) console.log(((w.tick - t0) / 240).toFixed(2), JSON.stringify(e).slice(0, 160)); });
for (let i = 0; i < 240 * 3600 && !g.over; i++) {
  g.step(1 / 240);
  if (tracing && (w.tick - t0) % 24 === 0 && (w.tick - t0) < 240 * 5) {
    const b = w.ball.body;
    const pr = w.play?.primary;
    console.log(((w.tick - t0) / 240).toFixed(2), 'ball', b.x.toFixed(1), b.y.toFixed(1), b.z.toFixed(1), w.ball.mode, 'primary', pr?.fieldPos, pr && `(${pr.x.toFixed(1)},${pr.z.toFixed(1)}) goal ${pr.goal ? pr.goal.x.toFixed(1)+','+pr.goal.z.toFixed(1) : 'none'} plan ${pr.plan.kind}`);
  }
  if (tracing && w.phase !== 'inPlay' && w.tick - t0 > 240) break;
}
