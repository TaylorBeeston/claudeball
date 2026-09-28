import { createGame } from '../src/sim/game';
const g = createGame({ seed: process.argv[2] ?? '1', pace: 0 });
const w = g._world;
let n = 0, zone = 0, swings = 0, hbp = 0, dx: number[] = [], dy: number[] = [], balls = 0, strikesL = 0, strikesS = 0, contact = 0, inZoneSwing=0, oz=0, ozSwing=0;
g.on('pitchReleased', () => { n++; });
g.on('pitchCrossed', (e) => { if (e.inZone) zone++; });
g.on('swing', () => swings++);
g.on('contact', () => contact++);
g.on('hitByPitch', () => hbp++);
g.on('call', (e) => { if (e.call.kind === 'ball') balls++; if (e.call.kind==='strikeLooking') strikesL++; if (e.call.kind==='strikeSwinging') strikesS++; });
g.on('pitchReleased', (e) => { dx.push(0); void e; });
let last = 0;
while (n < 3000 && !g.over) { g.step(1); }
console.log({ n, zonePct: zone / n, swingPct: swings / n, contactPerSwing: contact / swings, hbp, balls, strikesL, strikesS });
console.log('ump', w.umpBias);
