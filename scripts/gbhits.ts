import { createGame } from '../src/sim/game';
import { computeIntercept, fielders } from '../src/sim/fielding';
let shown = 0;
for (let s = 1; s <= 30 && shown < 6; s++) {
  const g = createGame({ seed: 'gh' + s, pace: 0 });
  const w = g._world;
  let cur: any = null;
  g.on('contact', (e) => { cur = { t0: w.tick, ev: e.exitMph, la: e.launchDeg, sp: e.sprayDeg, first: null as any, snap: null as any }; });
  g.on('fielded', (e) => { if (cur && !cur.first) { cur.first = e; cur.tf = (w.tick - cur.t0) / 240; } });
  g.on('plateAppearanceEnd', (e) => {
    if (cur && cur.la < 8 && cur.ev < 98 && cur.first && ['single'].includes(e.result) && cur.first.pos && Math.hypot(cur.first.pos.x, cur.first.pos.z) < 45 && shown < 6) {
      shown++;
      console.log('SINGLE EV', cur.ev.toFixed(0), 'LA', cur.la.toFixed(0), 'spray', cur.sp.toFixed(0), 'fielded at', cur.tf.toFixed(2), 's pos', cur.first.pos.x.toFixed(1), cur.first.pos.z.toFixed(1), 'by', cur.first.fielderId.slice(-4), 'BRtime?');
    }
    cur = null;
  });
  g.simulateToEnd(6 * 3600);
}
