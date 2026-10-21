/**
 * The sim's swing, measured over a `npm run sim -- N seed` game set (the same games, sharded over the cores): the league line scripts/simulate.ts
 * prints, exit velocity / launch angle distributions, and the bat through every swing against what two hands can hold on the drawn body.
 *   npx tsx tools/swing/run.ts [--games 200] [--seed 7] [--root <tree, default this one>] [--jobs 24] [--every 1] [--out tools/swing/out/<name>]
 * Writes <out>/swing.json (everything) and <out>/report.md (the tables).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hist, MARKS, PHASES } from './agg';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const N = +opt('games', '200'), SEED = opt('seed', '7'), JOBS = Math.min(N, +opt('jobs', String(Math.max(1, os.cpus().length - 4))));
const ROOT = path.resolve(opt('root', HERE));
const OUT = path.resolve(opt('out', path.join(HERE, 'tools/swing/out', `${path.basename(ROOT)}-${N}-${SEED}`)));

const shard = (from: number, to: number, file: string) =>
  new Promise<void>((res, rej) => {
    const p = spawn(path.join(HERE, 'node_modules/.bin/tsx'), [path.join(HERE, 'tools/swing/worker.ts'), '--root', ROOT, '--seed', SEED, '--from', String(from), '--to', String(to), '--out', file, '--every', opt('every', '1')], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`shard ${from}-${to} exited ${c}`))));
  });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const files: string[] = [];
  const jobs: Promise<void>[] = [];
  for (let j = 0; j < JOBS; j++) {
    const from = Math.floor((j * N) / JOBS), to = Math.floor(((j + 1) * N) / JOBS);
    if (to <= from) continue;
    const f = path.join(OUT, `shard-${j}.json`);
    files.push(f);
    jobs.push(shard(from, to, f));
  }
  await Promise.all(jobs);
  const parts = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  for (const f of files) fs.rmSync(f);
  const sum = (k: 'bat' | 'pit' | 'L' | 'calls') => {
    const o: Record<string, number> = {};
    for (const p of parts) for (const [a, v] of Object.entries(p[k] as Record<string, number>)) o[a] = (o[a] ?? 0) + v;
    return o;
  };
  const bat = sum('bat'), pit = sum('pit'), L = sum('L'), calls = sum('calls');
  const contacts = parts.flatMap((p) => p.contacts) as { ev: number; la: number; spray: number; spin: number; res?: string }[];
  const atC = parts.flatMap((p) => p.atContact) as Record<string, number>[];
  const H = Hist.merge(parts.map((p) => p.hist));
  const f = (x: number, d = 3) => x.toFixed(d);
  const pct = (x: number) => (100 * x).toFixed(1) + '%';
  const q = (a: number[], p: number) => {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
  };
  const ab = bat.ab, bip = bat.ab - bat.so - bat.hr + bat.sf;
  const ip = pit.outs / 3;
  const sw = calls.strikeSwinging ?? 0, fl = calls.foul ?? 0;
  const ev = contacts.map((c) => c.ev), la = contacts.map((c) => c.la);
  const stats = {
    games: L.games,
    'R/G': L.runs / L.games / 2,
    AVG: bat.h / ab,
    OBP: (bat.h + bat.bb + bat.hbp) / (bat.ab + bat.bb + bat.hbp + bat.sf),
    SLG: (bat.h + bat.doubles + 2 * bat.triples + 3 * bat.hr) / ab,
    ERA: (9 * pit.er) / ip,
    'K%': bat.so / bat.pa,
    'BB%': bat.bb / bat.pa,
    'HR/PA': bat.hr / bat.pa,
    'HR/G': bat.hr / L.games / 2,
    'HR/FB': L.fairFBhr / Math.max(1, L.fairFB),
    BABIP: (bat.h - bat.hr) / bip,
    '2B/G': bat.doubles / L.games / 2,
    'whiff/swing': sw / L.swings,
    'foul/swing': fl / L.swings,
    'swing%': L.swings / pit.pitches,
    'Z-swing': L.zSw / L.zoneP,
    'O-swing': L.oSw / L.oP,
    'EV mean': ev.reduce((s, x) => s + x, 0) / ev.length,
    'EV p10': q(ev, 0.1),
    'EV p50': q(ev, 0.5),
    'EV p90': q(ev, 0.9),
    'LA mean': la.reduce((s, x) => s + x, 0) / la.length,
    'LA p10': q(la, 0.1),
    'LA p50': q(la, 0.5),
    'LA p90': q(la, 0.9),
    'GB% (<10)': la.filter((x) => x < 10).length / la.length,
    'LD% (10-25)': la.filter((x) => x >= 10 && x < 25).length / la.length,
    'FB% (25-50)': la.filter((x) => x >= 25 && x <= 50).length / la.length,
    'PU% (>50)': la.filter((x) => x > 50).length / la.length,
    'barrel-ish (EV>=98, LA 26-30)': contacts.filter((c) => c.ev >= 98 && c.la >= 26 && c.la <= 30).length / contacts.length,
    'hard% (EV>=95)': ev.filter((x) => x >= 95).length / ev.length,
  };
  const lines: string[] = [`# Swing measurement: ${path.basename(ROOT)}, ${L.games} games, seed ${SEED}`, ''];
  lines.push(`R/G/team ${f(stats['R/G'], 2)}   AVG ${f(stats.AVG)}  OBP ${f(stats.OBP)}  SLG ${f(stats.SLG)}   ERA ${f(stats.ERA, 2)}`);
  lines.push(`K% ${pct(stats['K%'])}  BB% ${pct(stats['BB%'])}  HR/PA ${pct(stats['HR/PA'])}  HR/G ${f(stats['HR/G'], 2)}  HR/FB(fair 20-50deg) ${pct(stats['HR/FB'])}  BABIP ${f(stats.BABIP)}  2B/G ${f(stats['2B/G'], 2)}`);
  lines.push(`per swing: whiff ${pct(stats['whiff/swing'])}  foul ${pct(stats['foul/swing'])}   swing% ${pct(stats['swing%'])}  Z-swing ${pct(stats['Z-swing'])}  O-swing ${pct(stats['O-swing'])}`);
  lines.push(`EV mph mean ${f(stats['EV mean'], 1)}  p10/p50/p90 ${f(stats['EV p10'], 1)} / ${f(stats['EV p50'], 1)} / ${f(stats['EV p90'], 1)}   hard% ${pct(stats['hard% (EV>=95)'])}`);
  lines.push(`LA deg mean ${f(stats['LA mean'], 1)}  p10/p50/p90 ${f(stats['LA p10'], 1)} / ${f(stats['LA p50'], 1)} / ${f(stats['LA p90'], 1)}   GB ${pct(stats['GB% (<10)'])}  LD ${pct(stats['LD% (10-25)'])}  FB ${pct(stats['FB% (25-50)'])}  PU ${pct(stats['PU% (>50)'])}`);
  lines.push('');
  // EV / LA histograms
  const histRow = (a: number[], lo: number, hi: number, step: number) => {
    const out: string[] = [];
    for (let x = lo; x < hi; x += step) out.push(`${x}..${x + step}: ${pct(a.filter((v) => v >= x && v < x + step).length / a.length)}`);
    return out.join('  ');
  };
  lines.push('EV (mph) ' + histRow(ev, 40, 120, 10));
  lines.push('LA (deg) ' + histRow(la, -40, 80, 10));
  lines.push('');
  // swing geometry at contact (every swing at the planned contact instant; hits: the swings that met the ball)
  const ac = (k: string, sel: (r: Record<string, number>) => boolean = () => true) => {
    const a = atC.filter(sel).map((r) => r[k]);
    return `${f(q(a, 0.05), 1)} / ${f(q(a, 0.5), 1)} / ${f(q(a, 0.95), 1)}`;
  };
  lines.push('## At the planned contact instant (p5 / p50 / p95)', '', '| | all swings | pitch < 0.6 m | 0.6-0.9 m | > 0.9 m |', '|---|---|---|---|---|');
  const bands: [string, (r: Record<string, number>) => boolean][] = [['all', () => true], ['lo', (r) => r.py < 0.6], ['mid', (r) => r.py >= 0.6 && r.py < 0.9], ['hi', (r) => r.py >= 0.9]];
  for (const [k, label] of [['vba', 'bat elevation (deg, - = barrel below the hands)'], ['attack', 'attack angle (deg, sweet spot velocity)'], ['tilt', 'swing plane tilt (deg)'], ['sweet', 'sweet spot speed (m/s)'], ['hands', 'knob speed (m/s)'], ['knobY', 'knob height (m)']] as const)
    lines.push(`| ${label} | ${bands.map(([, s]) => ac(k, s)).join(' | ')} |`);
  lines.push('');
  // world angles at the marks
  lines.push('## The bat in world space at fixed instants (elevation above the ground; azimuth from +z, toward the plate side positive for both stances)', '', '| instant | el p5 / p50 / p95 | el min..max | az p5 / p50 / p95 | barrel tip height p5 / p50 (cm) |', '|---|---|---|---|---|');
  for (const m of MARKS) {
    const e = H.pct(`mark:${m}:wel`, [0.05, 0.5, 0.95]), r = H.range(`mark:${m}:wel`), a = H.pct(`mark:${m}:waz`, [0.05, 0.5, 0.95]), t = H.pct(`mark:${m}:tipY`, [0.05, 0.5]);
    lines.push(`| ${m} | ${e.join(' / ')} | ${r[0]}..${r[1]} | ${a.join(' / ')} | ${t.join(' / ')} |`);
  }
  lines.push('');
  // holdability per phase
  lines.push('## Can two hands hold it (60 Hz frames, the sim\'s knob and bat line on the drawn body)', '', 'launch: tau < 0.4 tauC; mid: < 0.85; contact: 0.85-1.15; follow: to 2.1 tauC (the hint); finish: the last pose held 0.1 s into the clip\'s finish.', '', '| phase | frames | strict | relaxed | shoulder az p5/p50/p95 | shoulder el p5/p50/p95 | world el p5/p50/p95 (min..max) | knob off the clip\'s (cm) p50/p95 | past range (deg) p50/p95 | miss (cm) p95 |', '|---|---:|---:|---:|---|---|---|---|---|---|');
  for (const ph of [...PHASES, 'all'] as const) {
    const t = H.t[ph];
    if (!t) continue;
    const P = (n: string, ps = [0.05, 0.5, 0.95]) => (ph === 'all' ? '' : H.pct(`${ph}:${n}`, ps).join(' / '));
    const r = ph === 'all' ? ['', ''] : H.range(`${ph}:wel`);
    lines.push(`| ${ph} | ${t[0]} | ${pct(t[1] / t[0])} | ${pct(t[2] / t[0])} | ${P('az')} | ${P('el')} | ${P('wel')}${ph === 'all' ? '' : ` (${r[0]}..${r[1]})`} | ${P('knobOff', [0.5, 0.95])} | ${P('over', [0.5, 0.95])} | ${P('miss', [0.95])} |`);
  }
  lines.push('', '| split | ' + [...PHASES, 'all'].join(' | ') + ' |', '|---|' + [...PHASES, 'all'].map(() => '---').join('|') + '|');
  const splits = [...new Set(Object.keys(H.t).filter((k) => k.includes('|')).map((k) => k.split('|')[1]))].sort();
  for (const s of splits)
    lines.push(`| ${s} | ` + [...PHASES, 'all'].map((ph) => { const t = H.t[`${ph}|${s}`]; return t ? `${pct(t[2] / t[0])} (${pct(t[1] / t[0])})` : ''; }).join(' | ') + ' |');
  lines.push('', '(relaxed (strict) rates)', '', '## Worst frames per phase', '', '| phase | past range | miss cm | shoulder az / el | world el | context |', '|---|---:|---:|---|---:|---|');
  for (const ph of PHASES) for (const w of H.worst[ph] ?? []) lines.push(`| ${ph} | ${w.over.toFixed(0)} | ${(w.miss * 100).toFixed(1)} | ${w.az.toFixed(0)} / ${w.el.toFixed(0)} | ${w.wel.toFixed(0)} | ${JSON.stringify(w.ctx)} |`);
  lines.push('', `${parts.reduce((s, p) => s + p.nSwings, 0)} swings; wall ${((Date.now() - t0) / 1000).toFixed(0)} s over ${JOBS} jobs.`);
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'swing.json'), JSON.stringify({ stats, bat, pit, L, calls, hist: H.toJSON(), atContact: atC, contacts }));
  console.log(lines.join('\n'));
  console.log(`[swing] wrote ${OUT}/report.md`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
