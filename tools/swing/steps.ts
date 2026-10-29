/**
 * The sim's bat frame to frame: how far the knob travels and how far the bat turns between the game's 60 Hz frames, per frame of the swing
 * (from the sim alone: no engine ease, no arms). A jump here is the drawn bat jumping, and the arms' IK follows it.
 *   npx tsx tools/swing/steps.ts [--seed 7] [--from 0] [--to 6] [--frames 14] [--swing '<SWING overrides, JSON>'] [--cache plans.json] [--json out.json]
 * Prints, per frame k (k-1 -> k), knob travel (cm), bat turn (deg), the turn over the pure plane's own (the bat's real speed, which no blend
 * can lower) and the knob's speed step (cm/frame, the jump on top of the swing's own
 * acceleration: |d(k) - d(k-1)| of the travel vectors), p50 / p90 / p95, and each swing's peak before contact (u < 0.95).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGame } from '../../src/sim/game';
import { generateTeam } from '../../src/sim/roster';
import { BatSwing, SWING } from '../../src/sim/batting';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const SEED = opt('seed', '7'), FROM = +opt('from', '0'), TO = +opt('to', '6'), NF = +opt('frames', '14');
const deep = (o: any, v: any) => { for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') deep(o[k], v[k]); else o[k] = v[k]; };

// --cache <file>: keep the plans (the games take ~20 s; the plan does not depend on the path's shape, so every variant replays the same ones)
const CACHE = opt('cache', '');
let plans: any[] = [];
if (CACHE && fs.existsSync(CACHE)) plans = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
else {
  for (let i = FROM; i < TO; i++) {
    const home = generateTeam(`${SEED}-h${i}`, { side: 'home' });
    const away = generateTeam(`${SEED}-a${i}`, { side: 'away' });
    const g = createGame({ seed: `${SEED}-g${i}`, homeTeam: home, awayTeam: away, pace: 0, tempo: 'quick' });
    g.on('swing', () => {
      const p = g._world.swingPlan;
      if (p && !p.bunt) plans.push(JSON.parse(JSON.stringify(p)));
    });
    g.simulateToEnd(6 * 3600);
  }
  if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(plans));
}
// the plan does not depend on inStart / turnStart / blendIn / via (BatSwing.at reads them), so the same plans replay any variant of the path
if (opt('swing', '')) deep(SWING, JSON.parse(opt('swing', '{}')));

const DEG = 180 / Math.PI;
const q = (a: number[], p: number) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const rows = Array.from({ length: NF + 1 }, () => ({ knob: [] as number[], turn: [] as number[], jerk: [] as number[], xturn: [] as number[], u: [] as number[] }));
const peak = { knob: [] as number[], turn: [] as number[], jerk: [] as number[], xturn: [] as number[] };
for (const plan of plans) {
  const bs = new BatSwing(plan);
  const P = Array.from({ length: NF + 1 }, (_, k) => bs.at(k / 60));
  // the pure plane (no blend from the clip's path, no follow-through wrap): the bat's own turn rate, which no blend can lower
  const Q = Array.from({ length: NF + 1 }, (_, k) => bs.plane(k / 60));
  const ang = (a: { dir: { x: number; y: number; z: number } }, b: typeof a) => Math.acos(Math.max(-1, Math.min(1, a.dir.x * b.dir.x + a.dir.y * b.dir.y + a.dir.z * b.dir.z))) * DEG;
  let pk = 0, pt = 0, pj = 0, px = 0;
  for (let k = 1; k <= NF; k++) {
    const a = P[k - 1], b = P[k];
    const d = { x: b.knob.x - a.knob.x, y: b.knob.y - a.knob.y, z: b.knob.z - a.knob.z };
    const kn = Math.hypot(d.x, d.y, d.z) * 100;
    const tu = ang(a, b);
    const xt = tu - ang(Q[k - 1], Q[k]);
    let jk = NaN;
    if (k >= 2) {
      const z = P[k - 2];
      jk = Math.hypot(d.x - (a.knob.x - z.knob.x), d.y - (a.knob.y - z.knob.y), d.z - (a.knob.z - z.knob.z)) * 100;
    }
    const u = k / 60 / plan.tauC;
    rows[k].knob.push(kn);
    rows[k].turn.push(tu);
    rows[k].jerk.push(jk);
    rows[k].u.push(u);
    if (u < SWING.outStart) rows[k].xturn.push(xt);
    if (u < 0.95) {
      pk = Math.max(pk, kn);
      pt = Math.max(pt, tu);
      px = Math.max(px, xt);
      if (k >= 2) pj = Math.max(pj, jk);
    }
  }
  peak.knob.push(pk);
  peak.turn.push(pt);
  peak.jerk.push(pj);
  peak.xturn.push(px);
}
const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const tri = (a: number[]) => `${f(q(a, 0.5))} / ${f(q(a, 0.9))} / ${f(q(a, 0.95))}`;
console.log(`${plans.length} swings, seed ${SEED}, games ${FROM}-${TO - 1}; SWING ${JSON.stringify({ inStart: SWING.inStart, turnStart: SWING.turnStart, blendIn: SWING.blendIn })}`);
console.log('| frame | u p50 | knob speed step cm p50 / p90 / p95 | knob travel cm p50 / p90 / p95 | bat turn deg p50 / p90 / p95 | turn over the plane\'s own, deg p50 / p90 / p95 |');
console.log('|---:|---:|---|---|---|---|');
for (let k = 1; k <= NF; k++) console.log(`| ${k} | ${q(rows[k].u, 0.5).toFixed(2)} | ${tri(rows[k].jerk)} | ${tri(rows[k].knob)} | ${tri(rows[k].turn)} | ${tri(rows[k].xturn)} |`);
console.log(`| peak before contact (u < 0.95), per swing | | ${tri(peak.jerk)} | ${tri(peak.knob)} | ${tri(peak.turn)} | ${tri(peak.xturn)} |`);
if (opt('json', '')) {
  fs.mkdirSync(path.dirname(opt('json', '')), { recursive: true });
  fs.writeFileSync(opt('json', ''), JSON.stringify({ n: plans.length, rows: rows.map((r) => ({ knob: [q(r.knob, 0.5), q(r.knob, 0.9), q(r.knob, 0.95)], turn: [q(r.turn, 0.5), q(r.turn, 0.9), q(r.turn, 0.95)] })), peak }));
}
