import { createGame } from '../src/sim/game';
const g = createGame({ seed: '3-g0', pace: 0 });
const w = g._world;
let tr = false, t0 = 0, shown = 0;
g.on('throw', (e) => { if (e.fromId === w.catcher.info.id && e.toBase === 2 && shown === 0) { tr = true; t0 = w.tick; shown = 1; console.log('throw', JSON.stringify(e)); } });
for (let i = 0; i < 240 * 3600 && !g.over && !(shown && !tr); i++) {
  g.step(1 / 240);
  if (tr && (w.tick - t0) % 12 === 0) {
    const R = w.ball.throwTo; const b = w.ball.body;
    console.log(((w.tick - t0) / 240).toFixed(2), w.ball.mode, 'ball', b.x.toFixed(1), b.y.toFixed(1), b.z.toFixed(1), 'R', R?.fieldPos, R && `(${R.x.toFixed(1)},${R.z.toFixed(1)}) goal ${R.goal?.x.toFixed(1)},${R.goal?.z.toFixed(1)}`, 'tgt', w.ball.throwTarget && `${w.ball.throwTarget.x.toFixed(1)},${w.ball.throwTarget.z.toFixed(1)}`);
    if ((w.tick - t0) > 240 * 1.6) tr = false;
  }
}
