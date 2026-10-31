/**
 * The walk-up and the pace of play at pace 1 (Node, the sim alone): per plate appearance the time from the batter being called to the first
 * windup, his top speed and how far past the far box he went crossing behind the plate, whether he was in the box and still at every windup; per game the minutes,
 * the batter clock violations and the median pitch-to-pitch gaps.
 *   npx tsx tools/batter/pace.ts [--seeds 1-4] [--tempos broadcast,standard,quick] [--innings 9] [--json out.json]
 */
import fs from 'node:fs';
import { createGame } from '../../src/sim/game';
import { SHOULDER_X } from '../../src/sim/batting';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const [s0, s1 = s0] = opt('seeds', '1-4').split('-').map(Number);
const tempos = opt('tempos', 'broadcast,standard,quick').split(',') as ('broadcast' | 'standard' | 'quick')[];
const q = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
const out: Record<string, unknown> = {};

for (const tempo of tempos) {
  const walk: number[] = [], top: number[] = [], past: number[] = [], gaps: number[] = [], mins: number[] = [];
  let windups = 0, notSet = 0, batViol = 0, games = 0, runs = 0;
  for (let seed = s0; seed <= s1; seed++) {
    const g = createGame({ seed: `pace-${seed}`, pace: 1, tempo, innings: +opt('innings', '9') });
    const w = g._world;
    let called = -1, id = '', vmax = 0, beyond = 0, lastPitch = -1, near = false;
    g.on('batterUp', () => {
      called = w.tick / 240;
      id = w.batter!.info.id;
      vmax = 0;
      beyond = 0;
      near = false;
    });
    g.on('windup', () => {
      const b = w.batter!;
      const side = w.batStance === 'R' ? 1 : -1;
      windups++;
      if (Math.hypot(b.x - side * SHOULDER_X, b.z - 0.15) > 0.35 || Math.hypot(b.vx, b.vz) > 0.4) notSet++;
      if (called >= 0 && b.info.id === id) {
        walk.push(w.tick / 240 - called);
        top.push(vmax);
        past.push(beyond);
        called = -1;
      }
    });
    g.on('pitchReleased', () => {
      const t = w.tick / 240;
      if (lastPitch >= 0) gaps.push(t - lastPitch);
      lastPitch = t;
    });
    g.on('pitchClockViolation', (e) => void ((e as { on: string }).on === 'batter' && batViol++));
    let n = 0;
    while (!g.over && n++ < 240 * 3600 * 5) {
      g.step(1 / 240);
      if (called >= 0 && w.batter && n % 4 === 0) {
        const b = w.batter;
        const side = w.batStance === 'R' ? 1 : -1;
        vmax = Math.max(vmax, Math.hypot(b.vx, b.vz));
        // past the box: a hitter crossing behind the plate to the far box, how far out past the box's edge (2 m off the plate) he goes on its side
        if (side * b.x < 0.5) near = true;
        if (near) beyond = Math.max(beyond, side * b.x - 2.0);
      }
    }
    games++;
    mins.push(w.tick / 240 / 60);
    const box = g.getBoxScore();
    runs += box.home.runs + box.away.runs;
  }
  const r = {
    games,
    minutes: +(mins.reduce((a, b) => a + b, 0) / games).toFixed(1),
    runsPerGame: +(runs / games).toFixed(2),
    walkupSec: { p10: +q(walk, 0.1).toFixed(1), p50: +q(walk, 0.5).toFixed(1), p90: +q(walk, 0.9).toFixed(1) },
    topSpeed: { p50: +q(top, 0.5).toFixed(2), p90: +q(top, 0.9).toFixed(2), max: +Math.max(...top).toFixed(2) },
    overshootM: { p50: +q(past, 0.5).toFixed(2), p90: +q(past, 0.9).toFixed(2), max: +Math.max(...past).toFixed(2) },
    windups,
    windupNotSet: notSet,
    batterClockViolationsPerGame: +(batViol / games).toFixed(2),
    pitchGapP50: +q(gaps, 0.5).toFixed(1),
  };
  out[tempo] = r;
  console.log(tempo.padEnd(10), JSON.stringify(r));
}
if (opt('json', '')) fs.writeFileSync(opt('json', ''), JSON.stringify(out, null, 1));
