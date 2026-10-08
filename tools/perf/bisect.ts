/**
 * A/B (or A/B/C/...) of several builds, interleaved: for each repeat, every build runs once with sound off and once with sound on before the
 * next repeat starts, so the shared machine's drift hits every build alike. Each run is `run.ts --dist <build>` (a fresh Chrome per run).
 *
 *   npx tsx tools/perf/bisect.ts --builds work/bisect/dist-a,work/bisect/dist-b [--presets low,high] [--scenes pitchcam,wide,faces]
 *        [--reps 2] [--audio both|on|off] [--target laptop|emu] [--emu 750x832@2.625 --cpu 2] [--frames 360 --warm 90] [--label name]
 *        [--play 120 --playwarm 20]   the real game instead of the bench scenes (see run.ts --play)
 *        [--report-only]   (re-make the table from the runs already in the folder)
 *
 * Builds: `work/bisect/build.sh <commit> <label>` makes `work/bisect/dist-<label>` (git archive of the commit, shared node_modules).
 * Output: tools/perf/results/bisect-<label>/<build>-<audio>-r<rep>.json and `summary.md` (medians over the repeats).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, systemLoad } from './lib';
import type { Run } from './report';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const builds = opt('builds', '').split(',').filter(Boolean);
const presets = opt('presets', 'low,high');
const scenes = opt('scenes', 'pitchcam,wide,faces');
const reps = +opt('reps', '2');
const audioModes = opt('audio', 'both') === 'both' ? ['off', 'on'] : [opt('audio', 'both')];
const target = opt('target', 'laptop');
const label = opt('label', `bisect-${target}`);
const dir = path.join(ROOT, 'tools/perf/results', `bisect-${label}`);
const name = (b: string) => path.basename(b).replace(/^dist-/, '');

function runAll() {
  fs.mkdirSync(dir, { recursive: true });
  const loads: string[] = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const b of builds) {
      for (const a of audioModes) {
        const out = path.join(dir, `${name(b)}-${a}-r${rep}`);
        if (fs.existsSync(`${out}.json`)) continue;
        const l = systemLoad();
        loads.push(`${name(b)} ${a} r${rep}: load ${l.loadavg.join('/')} gpu ${l.gpu}`);
        console.log(`[bisect] ${name(b)} audio ${a} rep ${rep + 1}/${reps} (load ${l.loadavg[0]}, gpu ${l.gpu.split(', ')[1]})`);
        const args = ['tsx', 'tools/perf/run.ts', '--target', target, '--dist', b, '--presets', presets, '--scenes', scenes, '--frames', opt('frames', '360'), '--warm', opt('warm', '90'), '--quiet', '--out', out, '--label', label];
        if (a === 'on') args.push('--audio', '--audiotrace');
        if (target === 'emu') args.push('--emu', opt('emu', '750x832@2.625'), '--cpu', opt('cpu', '2'));
        if (argv.includes('--uncapped')) args.push('--uncapped');
        if (argv.includes('--play')) args.push('--play', opt('play', '120'), '--playwarm', opt('playwarm', '20'));
        const extra = opt('extra', '');
        if (extra) args.push('--extra', extra);
        const r = spawnSync('npx', args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
        if (r.status !== 0) console.log(`[bisect] run failed (${r.status})`);
      }
    }
  }
  fs.appendFileSync(path.join(dir, 'load.txt'), loads.join('\n') + '\n');
}

const med = (v: number[]) => {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[(s.length - 1) >> 1] * 0.5 + s[s.length >> 1] * 0.5 : NaN;
};
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = any;
function report() {
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
  const rows = new Map<string, { off: R[]; on: R[] }>();
  const order: string[] = [];
  for (const file of files.sort()) {
    const m = /^(.*)-(on|off)-r(\d+)\.json$/.exec(file);
    if (!m) continue;
    const run = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Run;
    for (const x of run.results as R[]) {
      const key = `${m[1]}|${x.preset}|${x.scene}`;
      if (!rows.has(key)) rows.set(key, { off: [], on: [] }), order.push(key);
      rows.get(key)![m[2] as 'on' | 'off'].push(x);
    }
  }
  const bOrder = builds.length ? builds.map(name) : [...new Set(order.map((k) => k.split('|')[0]))];
  order.sort((a, b) => {
    const [ba, pa, sa] = a.split('|'), [bb, pb, sb] = b.split('|');
    return pa.localeCompare(pb) || sa.localeCompare(sb) || bOrder.indexOf(ba) - bOrder.indexOf(bb);
  });
  const L = [
    `# Bisect ${label} (${target}${target === 'emu' ? ` ${opt('emu', '750x832@2.625')} cpu x${opt('cpu', '2')}` : ''}), medians over ${reps} interleaved repeats`,
    '',
    'JS = the engine tick (rAF) on the main thread; main = rAF + timer callbacks (audio controller tick, duck follower, booth timers): what the main thread spends per frame.',
    'off / on = sound off (`noaudio`) / on (muted Chrome, fake voices). tick = the audio controller tick (ms of main thread per second); nodes/s = Web Audio nodes created per second;',
    'graph = Web Audio nodes standing when the scene starts; audio thr = share of the audio render thread (trace); fps p5 with sound on.',
    '',
    '| preset | scene | build | JS off | JS on | main p95 on | Δ main on-off | tick ms/s | timers ms/s | nodes/s | params/s | graph | audio thr | fps p5 | calls | tris | game t |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const key of order) {
    const [b, p, s] = key.split('|');
    const { off, on } = rows.get(key)!;
    const js = (xs: R[]) => med(xs.map((x) => x.stats.jsMs.median));
    const mainMean = (xs: R[]) => med(xs.map((x) => x.stats.probe?.mainMs?.mean ?? x.stats.jsMs.mean));
    const pr = (fn: (p: R) => number) => med(on.map((x) => (x.stats.probe ? fn(x.stats.probe) : NaN)));
    const nodes = pr((q) => Object.values(q.nodesPerSec ?? {}).reduce((a: number, c) => a + (c as number), 0));
    const all = [...on, ...off];
    L.push(
      `| ${p} | ${s} | ${b} | ${f(js(off))} | ${f(js(on))} | ${f(med(on.map((x) => x.stats.probe?.mainMs?.p95 ?? NaN)))} | ${f(mainMean(on) - mainMean(off), 2)} | ${f(pr((q) => q.audioTick?.msPerSec ?? NaN), 2)} | ${f(pr((q) => q.timerMsPerSec), 2)} | ${f(nodes, 0)} | ${f(pr((q) => q.paramCallsPerSec), 0)} | ${f(pr((q) => q.graphNodes), 0)} | ${f(med(on.map((x) => (x.audioThread?.load ?? NaN) * 100)), 1)}% | ${f(med(on.map((x) => x.stats.fps.p5)))} | ${f(med(all.map((x) => x.stats.calls.median)), 0)} | ${f(med(all.map((x) => x.stats.triangles.median)) / 1e6, 2)}M | ${(on[0] ?? off[0])?.gameTime?.join('-') ?? ''} |`,
    );
  }
  const loadFile = path.join(dir, 'load.txt');
  if (fs.existsSync(loadFile)) L.push('', '<details><summary>machine load per run</summary>', '', '```', fs.readFileSync(loadFile, 'utf8').trim(), '```', '</details>');
  fs.writeFileSync(path.join(dir, 'summary.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

if (!argv.includes('--report-only')) runAll();
report();
