import { createGame } from '../src/sim/game';
const seed = process.argv[2] ?? '1';
const maxPA = Number(process.argv[3] ?? 400);
const g = createGame({ seed, pace: 0 });
const tally: Record<string, number> = {};
let pa = 0, pitches = 0, errors = 0, ev: number[] = [], la: number[] = [], catches = 0;
g.on('*', (e) => {
  if (e.type === 'plateAppearanceEnd') { tally[e.result] = (tally[e.result] ?? 0) + 1; pa++; }
  if (e.type === 'pitchReleased') pitches++;
  if (e.type === 'error') errors++;
  if (e.type === 'contact') { ev.push(e.exitMph); la.push(e.launchDeg); }
  if (e.type === 'catch') catches++;
});
const w = g._world;
while (pa < maxPA && !g.over) g.step(1/60 * 60);
console.log('PA', pa, 'pitches', pitches, 'errors', errors, 'catches', catches, 'runs', w.teams.home.runs + w.teams.away.runs, 'outs so far');
console.log(Object.entries(tally).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '));
const m = (a:number[])=>a.reduce((s,x)=>s+x,0)/a.length;
console.log('EV', m(ev).toFixed(1), 'LA', m(la).toFixed(1), 'contacts', ev.length);
