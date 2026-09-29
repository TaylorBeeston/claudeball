// Lab: throw pitches at a batter (no fielders) to check swing decisions, contact rates and batted-ball distributions.
import { DEFAULT_ENV, flightStep, BallBody } from '../src/sim/ball';
import { DEFAULT_FENCE } from '../src/sim/field';
import { generateTeam } from '../src/sim/roster';
import { throwPitch, strikeZoneFor, pitchTouchesZone } from '../src/sim/pitching';
import { planSwing, BatSwing, batBallCollision, stanceFor } from '../src/sim/batting';
import { Rng } from '../src/sim/rng';
import { MPH } from '../src/sim/math';

const env = DEFAULT_ENV(DEFAULT_FENCE);
const rng = new Rng(Number(process.argv[2] ?? 1));
const N = Number(process.argv[3] ?? 4000);
const team = generateTeam(1);
const oth = generateTeam(2);
const hitters = team.roster.filter((p) => !p.isPitcher).slice(0, 9);
const pitchers = oth.roster.filter((p) => p.isPitcher).slice(0, 5);
let pitches = 0, swings = 0, contacts = 0, zoneP = 0, zSwing = 0, oSwing = 0, zContact = 0, oContact = 0, fair = 0;
const ev: number[] = [];
const la: number[] = [];
const spray: number[] = [];
const ss: number[] = [];
const offs: number[] = [];
const cnts = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2], [3, 2], [3, 1], [3, 0], [2, 0]];
for (let i = 0; i < N; i++) {
  const b = rng.pick(hitters);
  const p = rng.pick(pitchers);
  const spec = (() => {
    let tot = p.arsenal.reduce((s, a) => s + a.usage, 0);
    let x = rng.next() * tot;
    for (const a of p.arsenal) { x -= a.usage; if (x <= 0) return a; }
    return p.arsenal[0];
  })();
  const zone = strikeZoneFor(b.height);
  const cy = (zone.top + zone.bottom) / 2;
  const tx = rng.normal(0, 0.16);
  const ty = cy + rng.normal(0, 0.2);
  const slot = { x: p.traits.armSide, y: p.traits.armHeight, ext: p.traits.extension };
  const pitch = throwPitch(p, slot, spec, tx, ty, { fatigue: 0, rng, env });
  const stance = stanceFor(b.bats, p.throws);
  const c = rng.pick(cnts);
  const plan = planSwing(b, stance, pitch, zone, { balls: c[0], strikes: c[1], outs: 0, runnersOn: false, scoringPosition: false, inning: 1, scoreDiff: 0 }, p.ratings.velocity, rng);
  const inZ = pitchTouchesZone(pitch, zone);
  pitches++;
  if (inZ) zoneP++;
  if (!plan.swing) continue;
  swings++;
  if (inZ) zSwing++; else oSwing++;
  // simulate pitch with bat
  const ball: BallBody = { x: pitch.release.x, y: pitch.release.y, z: pitch.release.z, vx: pitch.vel.x, vy: pitch.vel.y, vz: pitch.vel.z, wx: pitch.spin.x, wy: pitch.spin.y, wz: pitch.spin.z, rolling: false };
  const swing = new BatSwing(plan);
  let t = 0;
  const dtS = 1 / 2400;
  let res = null as ReturnType<typeof batBallCollision>;
  let started = false;
  while (ball.z > -1 && ball.y > 0) {
    flightStep(ball, dtS, env);
    t += dtS;
    if (t >= plan.startTime) { started = true; }
    if (started && !swing.done) {
      swing.advance(dtS);
      res = batBallCollision(ball, swing.pose());
      if (res) break;
    }
  }
  if (res) {
    contacts++;
    if (inZ) zContact++; else oContact++;
    ev.push(res.exitSpeed / MPH);
    la.push(res.launchDeg);
    spray.push(res.sprayDeg);
    ss.push(res.s);
    offs.push(res.offsetY);
    if (Math.abs(res.sprayDeg) < 45 ) fair++;
  }
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (a: number, b: number) => ((100 * a) / Math.max(1, b)).toFixed(1) + '%';
console.log(`pitches ${pitches}  zone% ${pct(zoneP, pitches)}  swing% ${pct(swings, pitches)}  Z-swing% ${pct(zSwing, zoneP)}  O-swing% ${pct(oSwing, pitches - zoneP)}`);
console.log(`contact% (of swings) ${pct(contacts, swings)}  Z-contact ${pct(zContact, zSwing)}  O-contact ${pct(oContact, oSwing)}  whiff/swing ${pct(swings - contacts, swings)}`);
console.log(`EV mean ${mean(ev).toFixed(1)} sd ${sd(ev).toFixed(1)}  LA mean ${mean(la).toFixed(1)} sd ${sd(la).toFixed(1)}  spray mean ${mean(spray).toFixed(1)} sd ${sd(spray).toFixed(1)}`);
const buckets = { gb: 0, ld: 0, fb: 0, pu: 0 };
la.forEach((x) => { if (x < 10) buckets.gb++; else if (x < 25) buckets.ld++; else if (x < 50) buckets.fb++; else buckets.pu++; });
console.log('GB/LD/FB/PU', Object.values(buckets).map((v) => pct(v, la.length)).join(' '));

console.log('fair%', pct(fair, contacts));
const sb = [[0,0.3],[0.3,0.45],[0.45,0.55],[0.55,0.62],[0.62,0.7],[0.7,0.78],[0.78,0.9]];
for (const [lo,hi] of sb) { const idx = ss.map((v,i)=>v>=lo&&v<hi?i:-1).filter(i=>i>=0); console.log(`s ${lo}-${hi}: n=${pct(idx.length, ss.length)} EV ${mean(idx.map(i=>ev[i])).toFixed(1)} LA ${mean(idx.map(i=>la[i])).toFixed(1)}`); }
console.log('offsetY sd', sd(offs).toFixed(4), 'mean', mean(offs).toFixed(4));
{
  const idx = ss.map((v, i) => (v >= 0.5 && v < 0.75 ? i : -1)).filter((i) => i >= 0);
  const l2 = idx.map((i) => la[i]);
  console.log('good contact n', idx.length, 'LA mean', mean(l2).toFixed(1), 'sd', sd(l2).toFixed(1), 'EV', mean(idx.map((i) => ev[i])).toFixed(1));
  const ob = [[-0.08,-0.05],[-0.05,-0.025],[-0.025,0],[0,0.025],[0.025,0.05],[0.05,0.08]];
  for (const [lo,hi] of ob) { const j = offs.map((v,i)=>v>=lo&&v<hi?i:-1).filter(i=>i>=0); console.log(`off ${lo}..${hi}: n=${j.length} LA ${mean(j.map(i=>la[i])).toFixed(1)} EV ${mean(j.map(i=>ev[i])).toFixed(1)}`); }
}
