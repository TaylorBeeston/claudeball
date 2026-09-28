import { createGame } from '../src/sim/game';
const g = createGame({ seed: 'st1', pace: 0 });
const w = g._world;
let n = 0;
g.on('*', (e) => { if (['windup'].includes(e.type) && w.stealing.size) { n++; if (n < 4) console.log('windup with stealers', w.stealing.size); } if (['steal','throw','out','runnerAdvance'].includes(e.type) && w.stealing.size && n < 4) console.log(e.type, JSON.stringify(e).slice(0, 100)); });
g.simulateToEnd(6 * 3600);
console.log('windups with stealers', n);
