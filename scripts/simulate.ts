/**
 * Headless season sim: plays N full games and prints league-wide stats for a realism check.
 *   npm run sim -- [games=20] [seed=1] [pace=0]
 */
import { createGame } from '../src/sim/game';
import { generateTeam } from '../src/sim/roster';
import type { BatterLine, PitcherLine } from '../src/sim/types';

const N = Number(process.argv[2] ?? 20);
const seed0 = process.argv[3] ?? '1';
const pace = Number(process.argv[4] ?? 0);

const bat: BatterLine = { pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, bb: 0, so: 0, hbp: 0, rbi: 0, r: 0, sb: 0, cs: 0, sf: 0, sh: 0 };
const pit: PitcherLine = { outs: 0, bf: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, hbp: 0, pitches: 0, strikes: 0, wp: 0 };
let runs = 0, errors = 0, innings = 0, extra = 0, pitches = 0, gameSecs = 0, dps = 0;
const contact: { ev: number; la: number }[] = [];
let fly = 0;
let swings = 0, zoneP = 0, whiffs = 0, oSw = 0, oP = 0, zSw = 0;
const calls: Record<string, number> = {};
const errKinds: Record<string, number> = {};
let sbAtt = 0, cs = 0, passed = 0, wp = 0, pickoffs = 0;
const t0 = Date.now();
const margins: number[] = [];
for (let i = 0; i < N; i++) {
  const home = generateTeam(`${seed0}-h${i}`, { side: 'home' });
  const away = generateTeam(`${seed0}-a${i}`, { side: 'away' });
  const g = createGame({ seed: `${seed0}-g${i}`, homeTeam: home, awayTeam: away, pace });
  g.on('pitchCrossed', (e) => { pitches += 0; if (e.inZone) zoneP++; else oP++; });
  g.on('swing', () => { swings++; });
  g.on('contact', (e) => contact.push({ ev: e.exitMph, la: e.launchDeg }));
  g.on('call', (e) => { calls[e.call.kind] = (calls[e.call.kind] ?? 0) + 1; });
  g.on('error', (e) => { errors++; errKinds[e.kind] = (errKinds[e.kind] ?? 0) + 1; });
  g.on('steal', () => sbAtt++);
  g.on('wildPitch', () => wp++);
  g.on('passedBall', () => passed++);
  g.on('pickoffAttempt', () => pickoffs++);
  g.on('out', (e) => { if (e.outType === 'caughtStealing') cs++; });
  gameSecs += g.simulateToEnd(6 * 3600);
  const box = g.getBoxScore();
  const w = g._world;
  runs += box.home.runs + box.away.runs;
  margins.push(Math.abs(box.home.runs - box.away.runs));
  innings += w.inning;
  if (w.inning > 9) extra++;
  for (const t of [box.home, box.away]) {
    for (const b of t.batters) for (const k of Object.keys(bat) as (keyof BatterLine)[]) bat[k] += b.line[k];
    for (const p of t.pitchers) for (const k of Object.keys(pit) as (keyof PitcherLine)[]) pit[k] += p.line[k];
  }
}
void fly;
const ab = bat.ab;
const bip = bat.ab - bat.so - bat.hr + bat.sf;
const avg = bat.h / ab;
const obp = (bat.h + bat.bb + bat.hbp) / (bat.ab + bat.bb + bat.hbp + bat.sf);
const tb = bat.h + bat.doubles + 2 * bat.triples + 3 * bat.hr;
const slg = tb / ab;
const ip = pit.outs / 3;
const flyBalls = contact.filter((c) => c.la >= 25);
const gb = contact.filter((c) => c.la < 10).length;
const f = (x: number, d = 3) => x.toFixed(d);
const pct = (x: number) => (100 * x).toFixed(1) + '%';
console.log(`games ${N}  wall ${((Date.now() - t0) / 1000).toFixed(1)}s (${((Date.now() - t0) / N).toFixed(0)} ms/game)  avg sim length ${(gameSecs / N / 60).toFixed(0)} min  extra-inning games ${extra}`);
console.log(`R/G/team ${f(runs / N / 2, 2)}   AVG ${f(avg)}  OBP ${f(obp)}  SLG ${f(slg)}   ERA ${f((9 * pit.er) / ip, 2)}`);
console.log(`PA/G/team ${f(bat.pa / N / 2, 1)}  K% ${pct(bat.so / bat.pa)}  BB% ${pct(bat.bb / bat.pa)}  HBP% ${pct(bat.hbp / bat.pa)}  HR/PA ${pct(bat.hr / bat.pa)}  HR/FB ${pct(bat.hr / Math.max(1, flyBalls.length))}`);
console.log(`BABIP ${f((bat.h - bat.hr) / bip)}   2B/G ${f(bat.doubles / N / 2, 2)}  3B/G ${f(bat.triples / N / 2, 2)}  HR/G ${f(bat.hr / N / 2, 2)}`);
console.log(`pitches/G/team ${f(pit.pitches / N / 2, 0)}  pitches/PA ${f(pit.pitches / pit.bf, 2)}  strike% ${pct(pit.strikes / pit.pitches)}  zone% ${pct(zoneP / (zoneP + oP))}  swing% ${pct(swings / pit.pitches)}`);
console.log(`batted balls: EV ${f(contact.reduce((s, c) => s + c.ev, 0) / contact.length, 1)} mph  LA ${f(contact.reduce((s, c) => s + c.la, 0) / contact.length, 1)}  GB% ${pct(gb / contact.length)}  FB(>=25) ${pct(flyBalls.length / contact.length)}`);
console.log(`errors/G/team ${f(errors / N / 2, 2)}  SB/G ${f(sbAtt / N / 2, 2)}  CS/G ${f(cs / N / 2, 2)}  WP/G ${f(wp / N / 2, 2)}  PB/G ${f(passed / N / 2, 2)}  pickoff att/G ${f(pickoffs / N / 2, 2)}  SF/G ${f(bat.sf / N / 2, 2)}`);
console.log(`avg run margin ${f(margins.reduce((a, b) => a + b, 0) / N, 1)}  innings/G ${f(innings / N, 1)}`);

console.log('calls', calls, 'swings', swings, 'contacts', contact.length);
console.log('error kinds', errKinds);
