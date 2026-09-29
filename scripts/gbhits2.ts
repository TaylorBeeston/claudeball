import { createGame } from '../src/sim/game';
let shown = 0;
for (let s = 1; s <= 30 && shown < 3; s++) {
  const g = createGame({ seed: 'gh' + s, pace: 0 });
  const w = g._world;
  let cur: any = null;
  g.on('contact', (e) => { cur = { t0: w.tick, ev: e.exitMph, la: e.launchDeg, sp: e.sprayDeg, log: [] as string[], first: null, runners: w.runners.length }; });
  g.on('*', (e: any) => { if (cur && ['fielded','catch','error','throw','out','safe','runnerAdvance'].includes(e.type)) { if (e.type==='fielded'&&!cur.first) cur.first=e; cur.log.push(((w.tick - cur.t0) / 240).toFixed(2) + ' ' + e.type + (e.fielderId ? ' ' + e.fielderId.slice(-4) : '') + (e.outType ? ' ' + e.outType : '') + (e.toBase ? ' ->' + e.toBase : '') + (e.toBase===0||e.base!==undefined?' base'+e.base:'')); } });
  g.on('plateAppearanceEnd', (e) => {
    if (cur && cur.la < -25 && cur.ev < 98 && cur.first && e.result === 'single' && Math.hypot(cur.first.pos.x, cur.first.pos.z) < 45 && shown < 3) {
      shown++;
      console.log('SINGLE EV', cur.ev.toFixed(0), 'LA', cur.la.toFixed(0), 'spray', cur.sp.toFixed(0), 'runners on', cur.runners); console.log('  ' + cur.log.join('\n  '));
    }
    cur = null;
  });
  g.simulateToEnd(6 * 3600);
}
