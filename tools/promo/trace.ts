/**
 * What happens in a stretch of a game (for designing shots): the sim's events with times, and at `--at` times where everybody and the ball are.
 *
 *   npx tsx tools/promo/trace.ts <seed> <from> <to> [--tempo standard] [--at 4700.5,4701] [--all]
 */
import { createGame } from '../../src/sim/game';
import type { GameEvent } from '../../src/sim/types';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const [seed, from, to] = [+argv[0], +argv[1], +argv[2]];
const at = opt('at', '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
const noisy = new Set(['decisionRequested', 'decisionResolved', 'coachSignal', 'pitchClockStart', 'signsGiven']);
const g = createGame({ seed, tempo: opt('tempo', 'standard') as 'standard', innings: 9 });
g.on('*', (e: GameEvent) => {
  if (e.time < from || e.time > to || (!argv.includes('--all') && noisy.has(e.type))) return;
  const { type, time, ...rest } = e as GameEvent & Record<string, unknown>;
  console.log(time.toFixed(3).padStart(9), type.padEnd(18), JSON.stringify(rest).slice(0, 200));
});
const f = (v: { x: number; y: number; z: number }) => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
let ai = 0;
while (g.getState().time < to) {
  // coarse steps far from a requested snapshot (the sim is the same however its steps are sliced)
  const t = g.getState().time;
  const near = ai < at.length && at[ai] - t < 0.3;
  g.step(near ? 1 / 240 : Math.min(0.25, Math.max(1 / 240, (ai < at.length ? at[ai] : to) - t - 0.29)));
  if (ai < at.length && g.getState().time >= at[ai]) {
    const st = g.getState();
    console.log(`--- t ${st.time.toFixed(3)} ${st.inning}${st.half[0]} ${st.outs} out ball ${f(st.ball.pos)} v ${f(st.ball.vel)}`);
    for (const p of st.players) console.log(`    ${p.role.padEnd(10)} ${p.id.padEnd(16)} ${f(p.pos)} face ${p.facing.toFixed(2)} ${p.anim}`);
    ai++;
  }
}
