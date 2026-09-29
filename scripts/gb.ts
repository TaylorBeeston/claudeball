import { createGame } from '../src/sim/game';
const g = createGame({ seed: "gb9", pace: 0 });
const w = g._world;
let cur: any = null; let n = 0;
g.on('contact', (e) => { if (e.launchDeg < 8 && e.exitMph > 60) cur = { t0: w.tick, ev: e.exitMph, la: e.launchDeg, sp: e.sprayDeg, log: [] as string[] }; else cur = null; });
g.on('*', (e: any) => { if (cur && ['fielded','catch','error','throw','out','playEnd'].includes(e.type)) cur.log.push(((w.tick - cur.t0)/240).toFixed(2) + ' ' + e.type + (e.fielderId ? ' ' + e.fielderId.slice(-4) : '') + (e.description ? ' ' + e.description : '') + (e.outType ? ' ' + e.outType : '') + (e.toBase ? ' ->' + e.toBase : '')); if (cur && e.type === 'playEnd') { if (n++ < 14) console.log('EV', cur.ev.toFixed(0), 'LA', cur.la.toFixed(0), 'spray', cur.sp.toFixed(0), '\n  ' + cur.log.join('\n  ')); cur = null; } });
while (n < 14 && !g.over) g.step(1);
