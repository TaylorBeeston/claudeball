/**
 * `npm run perf:check`: regression guard. Runs the deterministic bench on a few scenes per preset in desktop Chrome and fails when the draw calls or
 * triangles per frame (medians; counts, not times, so the numbers do not depend on how loaded the machine is) exceed tools/perf/budgets.json.
 *   --update   write the measured numbers (+ 10 % headroom) as the new budgets
 *   --presets low,medium  --scenes pitchcam,wide  --no-build
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib';
import type { Run } from './report';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const presets = opt('presets', 'low,medium,high,ultra');
const scenes = opt('scenes', 'pitchcam,wide,faces');
const budgetFile = path.join(ROOT, 'tools/perf/budgets.json');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbperf-check-')), 'run');

const r = spawnSync('npx', ['tsx', 'tools/perf/run.ts', '--presets', presets, '--scenes', scenes, '--frames', '40', '--warm', '40', '--quiet', '--out', out, '--label', 'check', ...(argv.includes('--no-build') ? ['--no-build'] : [])], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const run = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')) as Run;

type Budget = Record<string, Record<string, { calls: number; triangles: number }>>;
const measured: Budget = {};
for (const x of run.results) (measured[x.preset] ??= {})[x.scene] = { calls: Math.round(x.stats.calls.median), triangles: Math.round(x.stats.triangles.median) };

if (argv.includes('--update')) {
  const b: Budget = {};
  for (const [p, sc] of Object.entries(measured)) for (const [s, v] of Object.entries(sc)) (b[p] ??= {})[s] = { calls: Math.ceil((v.calls * 1.1) / 10) * 10, triangles: Math.ceil((v.triangles * 1.1) / 1e4) * 1e4 };
  fs.writeFileSync(budgetFile, JSON.stringify(b, null, 1) + '\n');
  console.log('[perf:check] budgets written', budgetFile);
  process.exit(0);
}
const budgets = JSON.parse(fs.readFileSync(budgetFile, 'utf8')) as Budget;
let bad = 0;
for (const [p, sc] of Object.entries(measured)) {
  for (const [s, v] of Object.entries(sc)) {
    const b = budgets[p]?.[s];
    if (!b) { console.log(`[perf:check] ${p}/${s}: no budget (calls ${v.calls}, tris ${v.triangles}) - run with --update`); continue; }
    const ok = v.calls <= b.calls && v.triangles <= b.triangles;
    if (!ok) bad++;
    console.log(`[perf:check] ${ok ? 'ok  ' : 'FAIL'} ${p.padEnd(6)} ${s.padEnd(9)} calls ${String(v.calls).padStart(5)} / ${b.calls}   tris ${(v.triangles / 1000).toFixed(0).padStart(6)}k / ${(b.triangles / 1000).toFixed(0)}k`);
  }
}
process.exit(bad ? 1 : 0);
