import { createGame } from '../src/sim/game';
const g = createGame({ seed: process.argv[2] ?? '1', pace: 0 });
const w = g._world;
let lastTick = 0, lastPhase = '', since = 0;
for (let i = 0; i < 3000000 && !g.over; i++) {
  g.step(1 / 240);
  if (w.phase !== lastPhase) { lastPhase = w.phase; since = w.tick; }
  if (w.tick - since > 240 * 90) { break; }
}
const s = g.getState();
console.log(w.phase, 'for', (w.tick - since) / 240, 's', 'tick', w.tick, 'inning', w.inning, w.half, 'outs', w.outs, 'count', w.count);
console.log('ball', s.ball.mode, s.ball.pos, s.ball.holderId, 'play', w.play?.kind, 'dead', w.play?.dead);
console.log('pitch', w.pitch && { tPlate: w.pitch.tPlate }, 'elapsed', (w.tick - w.pitchTick) / 240, 'swingStarted', w.swingStarted);
console.log(w.runners.map(r => ({ n: r.p.info.name, base: r.base, target: r.target, want: r.want, state: r.state, dead: r.dead, x: r.p.x.toFixed(1), z: r.p.z.toFixed(1) })));
