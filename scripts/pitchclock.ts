/**
 * Pitch-clock / pace measurement: plays N games at a tempo and prints the pitch-to-pitch times (release to release inside a plate appearance), the
 * time the pitcher holds the ball before he starts his delivery, the game length, the clock violations and disengagements.
 *   npx tsx scripts/pitchclock.ts [games=8] [seed=1] [tempo=broadcast] [innings=9]
 */
import { createGame } from '../src/sim/game';
import { generateTeam } from '../src/sim/roster';

const N = Number(process.argv[2] ?? 8);
const seed0 = process.argv[3] ?? '1';
const tempo = (process.argv[4] ?? 'broadcast') as 'quick' | 'standard' | 'broadcast';
const innings = Number(process.argv[5] ?? 9);

const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const fmt = (a: number[]) => `n ${a.length}  p10 ${q(a, 0.1).toFixed(1)}  med ${q(a, 0.5).toFixed(1)}  p90 ${q(a, 0.9).toFixed(1)}  max ${q(a, 1).toFixed(1)}`;

const p2pEmpty: number[] = [];
const p2pOn: number[] = [];
const holdEmpty: number[] = [];
const holdOn: number[] = [];
const used: Record<string, number[]> = {};
const lengths: number[] = [];
const viol: Record<string, number> = {};
let disengage = 0;
let balks = 0;
let timeouts = 0;
let denied = 0;
let visits = 0;
let pickoffs = 0;
const seg: Record<string, number> = {};
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const home = generateTeam(`${seed0}-h${i}`, { side: 'home' });
  const away = generateTeam(`${seed0}-a${i}`, { side: 'away' });
  const g = createGame({ seed: `${seed0}-g${i}`, homeTeam: home, awayTeam: away, pace: 1, tempo, innings });
  const w = g._world;
  let lastRel = -1;
  let lastPa = -1;
  let pa = 0;
  let heldAt = -1;
  g.on('batterUp', () => pa++);
  g.on('pitchReleased', (e) => {
    const on = w.runners.some((r) => r.state === 'live' && r.base >= 1);
    if (lastRel >= 0 && lastPa === pa) (on ? p2pOn : p2pEmpty).push(e.time - lastRel);
    lastRel = e.time;
    lastPa = pa;
  });
  g.on('windup', (e) => {
    const on = w.runners.some((r) => r.state === 'live' && r.base >= 1);
    if (heldAt >= 0) (on ? holdOn : holdEmpty).push(e.time - heldAt);
    heldAt = -1;
    const pc = (g.getState() as { pitchClock?: { kind: string; limitSec: number; remainingSec: number } | null }).pitchClock;
    if (pc) (used[`${pc.kind}/${pc.limitSec}`] ??= []).push(pc.limitSec - pc.remainingSec);
  });
  g.on('pitchClockStart' as never, ((e: { time: number }) => {
    if (heldAt < 0) heldAt = e.time;
  }) as never);
  g.on('pitchClockViolation' as never, ((e: { on: string }) => {
    viol[e.on] = (viol[e.on] ?? 0) + 1;
  }) as never);
  g.on('disengagement' as never, (() => disengage++) as never);
  g.on('timeCalled', () => timeouts++);
  g.on('timeDenied' as never, (() => denied++) as never);
  g.on('moundVisit', () => visits++);
  g.on('pickoffAttempt', () => pickoffs++);
  g.on('call', (e) => {
    if (e.call.kind === 'balk') balks++;
  });
  // where the time goes (sampled every 0.25 s of sim time)
  const DT = 0.25;
  let secs = 0;
  while (!g.over && secs < 6 * 3600) {
    g.step(DT);
    secs += DT;
    const k = w.change ? 'pitchingChange' : w.visit ? 'moundVisit' : w.review ? 'review' : w.phase === 'prePitch' ? (w.ball.holder === w.pitcher && !w.ret && !w.ball.lob ? (w.paPitches === 0 ? 'prePitch:firstOfPA' : 'prePitch:pitcherHasBall') : 'prePitch:ballComingBack') : w.phase;
    seg[k] = (seg[k] ?? 0) + DT;
  }
  lengths.push(secs / 60);
}
console.log(`games ${N} tempo ${tempo}  wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`game length (min): ${fmt(lengths)}`);
console.log(`pitch-to-pitch, bases empty: ${fmt(p2pEmpty)}`);
console.log(`pitch-to-pitch, runners on:  ${fmt(p2pOn)}`);
console.log(`clock start -> windup, empty: ${fmt(holdEmpty)}`);
console.log(`clock start -> windup, on:    ${fmt(holdOn)}`);
for (const [k, a] of Object.entries(used)) console.log(`clock used at the windup [${k}]: ${fmt(a)}`);
console.log(`per game: violations ${JSON.stringify(Object.fromEntries(Object.entries(viol).map(([k, v]) => [k, +(v / N).toFixed(3)])))}  disengagements ${(disengage / N).toFixed(2)}  pickoffs ${(pickoffs / N).toFixed(2)}  balks ${(balks / N).toFixed(3)}  timeouts ${(timeouts / N).toFixed(2)} (denied ${(denied / N).toFixed(2)})  visits ${(visits / N).toFixed(2)}`);
console.log('minutes per game by segment:', Object.entries(seg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / 60 / N).toFixed(1)}`).join(', '));
