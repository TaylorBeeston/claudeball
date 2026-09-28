import { createGame } from '../src/sim/game';
import { BASE_POS } from '../src/sim/field';
import * as running from '../src/sim/running';
const g = createGame({ seed: 'gh1', pace: 0 });
const w = g._world;
let cur: any = null; let shown = 0;
g.on('contact', (e) => { cur = { t0: w.tick, la: e.launchDeg, ev: e.exitMph, buf: [] as string[], first: null }; });
g.on('fielded', (e) => { if (cur && !cur.first) cur.first = e; });
g.on('plateAppearanceEnd', (e) => {
  if (cur && cur.la < -25 && cur.ev < 98 && cur.first && e.result === 'single' && shown < 1 && Math.hypot(cur.first.pos.x, cur.first.pos.z) < 45) { shown++; console.log(cur.buf.join('\n')); }
  cur = null;
});
for (let i = 0; i < 240 * 3600 && !g.over && shown < 1; i++) {
  g.step(1 / 240);
  if (cur && w.ball.holder && (w.tick - cur.t0) % 12 === 0 && (w.tick - cur.t0) / 240 > 1.5) {
    const F = w.ball.holder;
    const br = w.runners.find((r) => r.isBatter);
    cur.buf.push(`${((w.tick - cur.t0) / 240).toFixed(2)} ${F.fieldPos} (${F.x.toFixed(1)},${F.z.toFixed(1)}) d1B ${Math.hypot(F.x - BASE_POS[1].x, F.z - BASE_POS[1].z).toFixed(2)} plan ${F.plan.kind} hold ${F.plan.holdUntil - w.tick} rel ${F.plan.releaseAt} goal ${F.goal ? F.goal.x.toFixed(1) + ',' + F.goal.z.toFixed(1) : '-'} BR ${br && `${br.state} b${br.base} t${br.target} forced=${running.forced(w, br)} (${br.p.x.toFixed(1)},${br.p.z.toFixed(1)})`} outs ${w.outs}`);
  }
}
