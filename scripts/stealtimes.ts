import { createGame } from '../src/sim/game';
const rows: { kind: string; touch: number; arrive: number; pop: number; margin: number }[] = [];
for (let s = 0; s < 60; s++) {
  const g = createGame({ seed: 'sx' + s, pace: 0 });
  const w = g._world;
  let rel = 0, catcherCatch = 0, throwT = 0, arriveT = 0;
  g.on('pitchReleased', () => { rel = w.tick; });
  g.on('catch', (e) => { if (e.fielderId === w.catcher.info.id) catcherCatch = w.tick; else arriveT = w.tick; });
  g.on('throw', (e) => { if (e.fromId === w.catcher.info.id) throwT = w.tick; });
  g.on('steal', () => rows.push({ kind: 'SB', touch: (w.tick - rel) / 240, arrive: arriveT > throwT ? (arriveT - rel) / 240 : NaN, pop: (arriveT - catcherCatch) / 240, margin: 0 }));
  g.on('out', (e) => { if (e.outType === 'caughtStealing') rows.push({ kind: 'CS', touch: NaN, arrive: (arriveT - rel) / 240, pop: (arriveT - catcherCatch) / 240, margin: 0 }); });
  g.simulateToEnd(6 * 3600);
}
const avg = (a: number[]) => a.filter((x) => !isNaN(x)).reduce((s, x) => s + x, 0) / a.filter((x) => !isNaN(x)).length;
const sb = rows.filter((r) => r.kind === 'SB'), cs = rows.filter((r) => r.kind === 'CS');
console.log('SB', sb.length, 'CS', cs.length, 'success', (sb.length / (sb.length + cs.length)).toFixed(2));
console.log('SB touch after release', avg(sb.map((r) => r.touch)).toFixed(2), 'ball arrival', avg(sb.map((r) => r.arrive)).toFixed(2), 'pop', avg(sb.map((r) => r.pop)).toFixed(2));
console.log('CS ball arrival', avg(cs.map((r) => r.arrive)).toFixed(2), 'pop', avg(cs.map((r) => r.pop)).toFixed(2));
