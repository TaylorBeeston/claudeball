import { createGame } from '../src/sim/game';
const games = Number(process.argv[2] ?? 3);
type R = { la: number; ev: number; res: string };
const rows: R[] = [];
let pa = 0;
for (let s = 1; s <= games; s++) {
  const g = createGame({ seed: 'bip' + s, pace: 0 });
  let cur: R | null = null;
  g.on('contact', (e) => { cur = { la: e.launchDeg, ev: e.exitMph, res: '' }; });
  g.on('plateAppearanceEnd', (e) => { pa++; if (cur) { cur.res = e.result; rows.push(cur); cur = null; } });
  g.on('call', (e) => { if (e.call.kind === 'foul' && cur) { cur.res = 'foul'; rows.push(cur); cur = null; } });
  g.simulateToEnd(5 * 3600);
}
const isHit = (r: string) => ['single', 'double', 'triple', 'home run'].includes(r);
const isOut = (r: string) => ['groundout', 'flyout', 'lineout', 'popout', 'infield fly', 'double play', 'sac fly'].includes(r);
const buckets: [string, (r: R) => boolean][] = [
  ['GB <10', (r) => r.la < 10], ['LD 10-25', (r) => r.la >= 10 && r.la < 25], ['FB 25-50', (r) => r.la >= 25 && r.la < 50], ['PU >=50', (r) => r.la >= 50],
];
for (const [name, f] of buckets) {
  const xs = rows.filter((r) => f(r) && r.res !== 'foul');
  const hits = xs.filter((r) => isHit(r.res)).length;
  const outs = xs.filter((r) => isOut(r.res)).length;
  const oth = xs.length - hits - outs;
  console.log(name.padEnd(9), 'n', xs.length, 'hit%', ((100 * hits) / xs.length).toFixed(1), 'out%', ((100 * outs) / xs.length).toFixed(1), 'other%', ((100 * oth) / xs.length).toFixed(1), 'EV', (xs.reduce((s, r) => s + r.ev, 0) / xs.length).toFixed(1));
}
const fair = rows.filter((r) => r.res !== 'foul');
console.log('fair BIP', fair.length, 'foul', rows.length - fair.length, 'PA', pa);
const tally: Record<string, number> = {};
for (const r of rows) tally[r.res] = (tally[r.res] ?? 0) + 1;
console.log(tally);
