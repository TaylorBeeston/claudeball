/**
 * `npm run perf:check`: regression guard. Runs the deterministic bench on a few scenes per preset in desktop Chrome and fails when the draw calls or
 * triangles per frame (medians; counts, not times, so the numbers do not depend on how loaded the machine is) exceed tools/perf/budgets.json.
 *   --update   write the measured numbers (+ 10 % headroom) as the new budgets
 *   --presets low,medium  --scenes pitchcam,wide  --no-build
 *   --no-audio   skip the audio stage; --audio-only   only the audio stage
 *
 * Audio stage: the same bench with sound on (muted Chrome, fake voices; tools/perf/probe.ts), once on the desktop audio path and once on the
 * phone path (`lowpower=1`). Fails when the standing Web Audio graph (venue + crowd beds), the mic count, the IR length / channels, the
 * peak voices, the nodes made per second or the audio layer's main-thread time per second exceed `budgets.json` `audio.desktop|phone`.
 * The audio render thread's load (trace) is printed and only warns: it depends on the machine.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, build } from './lib';
import type { Run } from './report';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const presets = opt('presets', 'low,medium,high,ultra');
const scenes = opt('scenes', 'pitchcam,wide,faces');
const budgetFile = path.join(ROOT, 'tools/perf/budgets.json');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbperf-check-')), 'run');

const audioOnly = argv.includes('--audio-only');
const r = audioOnly ? { status: 0 } : spawnSync('npx', ['tsx', 'tools/perf/run.ts', '--presets', presets, '--scenes', scenes, '--frames', '40', '--warm', '40', '--quiet', '--out', out, '--label', 'check', ...(argv.includes('--no-build') ? ['--no-build'] : [])], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const run = audioOnly ? ({ meta: {}, results: [] } as Run) : (JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')) as Run);

type Budget = Record<string, Record<string, { calls: number; triangles: number }>>;
const measured: Budget = {};
for (const x of run.results) (measured[x.preset] ??= {})[x.scene] = { calls: Math.round(x.stats.calls.median), triangles: Math.round(x.stats.triangles.median) };

// ---- audio stage ------------------------------------------------------------------------------------------------------------------
type AudioBudget = { standingNodes: number; mics: number; irSeconds: number; irChannels: number; voicesMax: number; nodesPerSec: number; mainMsPerSec: number };
const audioMeasured: Record<string, AudioBudget & { audioThread: number }> = {};
if (!argv.includes('--no-audio')) {
  // the audio stage serves dist/ as it is: with --audio-only, build it first unless --no-build
  if (audioOnly && !argv.includes('--no-build')) build(false);
  for (const [path_, low] of [['desktop', '0'], ['phone', '1']] as const) {
    const aout = `${out}-audio-${path_}`;
    const ar = spawnSync('npx', ['tsx', 'tools/perf/run.ts', '--audio', '--audiotrace', '--presets', 'medium', '--scenes', 'pitchcam,wide', '--frames', '120', '--warm', '60', '--quiet', '--out', aout, '--label', 'check-audio', '--extra', `lowpower=${low}`, '--no-build'], { cwd: ROOT, stdio: 'inherit' });
    if (ar.status !== 0) process.exit(ar.status ?? 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (JSON.parse(fs.readFileSync(`${aout}.json`, 'utf8')) as Run).results as any[];
    const max = (f: (x: any) => number) => Math.max(...res.map(f));
    const pr = (x: any) => x.stats.probe;
    if (res.some((x) => pr(x)?.ctx?.state !== 'running' || !pr(x)?.controller?.ready)) {
      console.log(`[perf:check] FAIL audio ${path_}: the audio context did not run or the sounds were not ready (${JSON.stringify(res.map((x) => pr(x)?.controller))})`);
      process.exit(1);
    }
    audioMeasured[path_] = {
      standingNodes: max((x) => (pr(x).audioGraph?.venueNodes ?? 0) + (pr(x).audioGraph?.bedNodes ?? 0)),
      mics: max((x) => pr(x).audioGraph?.mics ?? 0),
      irSeconds: max((x) => pr(x).audioGraph?.irSeconds ?? 0),
      irChannels: max((x) => pr(x).audioGraph?.irChannels ?? 0),
      voicesMax: max((x) => pr(x).audioGraph?.voicesMax ?? 0),
      nodesPerSec: max((x) => Object.values(pr(x).nodesPerSec ?? {}).reduce((a: number, b) => a + (b as number), 0)),
      mainMsPerSec: max((x) => pr(x).timerMsPerSec ?? 0),
      audioThread: max((x) => x.audioThread?.load ?? 0),
    };
  }
}

if (argv.includes('--update')) {
  const old = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : {};
  const b: Record<string, unknown> = audioOnly ? { ...old } : {};
  for (const [p, sc] of Object.entries(measured)) for (const [s, v] of Object.entries(sc)) ((b[p] ??= {}) as Record<string, unknown>)[s] = { calls: Math.ceil((v.calls * 1.1) / 10) * 10, triangles: Math.ceil((v.triangles * 1.1) / 1e4) * 1e4 };
  if (Object.keys(audioMeasured).length) {
    // counts are exact (+ a node or voice of slack); rates and main-thread time get headroom (they depend on the game's events / the machine)
    b.audio = Object.fromEntries(Object.entries(audioMeasured).map(([k, v]) => [k, { standingNodes: v.standingNodes + 4, mics: v.mics, irSeconds: +(v.irSeconds + 0.01).toFixed(2), irChannels: v.irChannels, voicesMax: v.voicesMax + 4, nodesPerSec: Math.ceil(v.nodesPerSec * 1.5 + 10), mainMsPerSec: +(v.mainMsPerSec * 2 + 2).toFixed(1) }]));
  } else if (old.audio) b.audio = old.audio;
  fs.writeFileSync(budgetFile, JSON.stringify(b, null, 1) + '\n');
  console.log('[perf:check] budgets written', budgetFile);
  process.exit(0);
}
const budgets = JSON.parse(fs.readFileSync(budgetFile, 'utf8')) as Record<string, Record<string, { calls: number; triangles: number }>> & { audio?: Record<string, AudioBudget> };
let bad = 0;
for (const [path_, v] of Object.entries(audioMeasured)) {
  const b = budgets.audio?.[path_];
  if (!b) { console.log(`[perf:check] audio ${path_}: no budget (${JSON.stringify(v)}) - run with --update`); continue; }
  for (const k of Object.keys(b) as (keyof AudioBudget)[]) {
    const ok = v[k] <= b[k];
    if (!ok) bad++;
    console.log(`[perf:check] ${ok ? 'ok  ' : 'FAIL'} audio ${path_.padEnd(7)} ${k.padEnd(13)} ${String(+v[k].toFixed(2)).padStart(7)} / ${b[k]}`);
  }
  console.log(`[perf:check] info audio ${path_.padEnd(7)} render thread ${(v.audioThread * 100).toFixed(1)} % of a core (machine-dependent, not a budget)`);
}
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
