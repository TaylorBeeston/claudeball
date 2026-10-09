/** Turn benchmark JSON into markdown tables. Also a CLI: `tsx tools/perf/report.ts results/a.json [results/b.json]` (two files = side-by-side comparison). */
import fs from 'node:fs';

interface Stat { median: number; p5: number; p95: number; p99: number; mean: number; max: number }
interface Result {
  scene: string;
  preset: string;
  tod: string;
  canvas: string;
  pixelRatio: number;
  textureMemory?: { mb: number; textures: number };
  stats: {
    frames: number;
    fps: Stat; frameMs: Stat; jsMs: Stat; gpuMs: Stat; renderCpuMs: Stat;
    laps: Record<string, Stat>; subs: Record<string, Stat>;
    passes: Record<string, { cpu: Stat; gpu: Stat; calls: Stat; tris: Stat }>;
    calls: Stat; triangles: Stat; geometries: Stat; textures: Stat; programs: Stat; heapMB: Stat; allocMBperFrame: Stat;
    gcEvents: number; allocMBps: number; longFramesOver25ms: number; gpuTimer: boolean;
    mainMs?: Stat; outs?: Record<string, Stat>;
  };
}
export interface Run { meta: Record<string, unknown>; device?: Record<string, unknown>; results: Result[] }

const f1 = (x: number) => x.toFixed(1);
const k = (x: number) => (x / 1000).toFixed(0) + 'k';

export function summaryTable(rs: Result[]): string {
  const L = ['| preset | scene | canvas | fps med | fps p5 | frame ms med / p95 / p99 | js ms | main ms (js + outside, mean) | gpu ms | render-cpu ms | calls | tris | heap MB | alloc MB/s | GCs | >25ms |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rs) {
    const s = r.stats;
    L.push(`| ${r.preset}${r.tod !== 'day' ? '/' + r.tod : ''} | ${r.scene} | ${r.canvas} | ${f1(s.fps.median)} | ${f1(s.fps.p5)} | ${f1(s.frameMs.median)} / ${f1(s.frameMs.p95)} / ${f1(s.frameMs.p99)} | ${f1(s.jsMs.median)} | ${s.mainMs ? f1(s.mainMs.mean) : '-'} | ${s.gpuTimer ? f1(s.gpuMs.median) : 'n/a'} | ${f1(s.renderCpuMs.median)} | ${s.calls.median.toFixed(0)} | ${k(s.triangles.median)} | ${s.heapMB.median.toFixed(0)} | ${(s.allocMBps ?? s.allocMBperFrame.median * 60).toFixed(1)} | ${s.gcEvents} | ${s.longFramesOver25ms} |`);
  }
  return L.join('\n');
}

/** CPU lap split and per-pass cpu/gpu/calls, one row per (preset, scene) */
export function breakdownTables(rs: Result[]): string {
  const lapNames = [...new Set(rs.flatMap((r) => Object.keys(r.stats.laps)))].filter((n) => n !== 'end');
  const passNames = [...new Set(rs.flatMap((r) => Object.keys(r.stats.passes)))];
  const A = [`| preset | scene | ${lapNames.join(' | ')} |`, `|---|---|${lapNames.map(() => '---').join('|')}|`];
  for (const r of rs) A.push(`| ${r.preset} | ${r.scene} | ${lapNames.map((n) => f1(r.stats.laps[n]?.median ?? 0)).join(' | ')} |`);
  const B = [`| preset | scene | ${passNames.map((n) => `${n} cpu/gpu ms (calls)`).join(' | ')} |`, `|---|---|${passNames.map(() => '---').join('|')}|`];
  for (const r of rs)
    B.push(`| ${r.preset} | ${r.scene} | ${passNames.map((n) => { const p = r.stats.passes[n]; return p ? `${f1(p.cpu.median)}/${r.stats.gpuTimer ? f1(p.gpu.median) : '-'} (${p.calls.median.toFixed(0)})` : '-'; }).join(' | ')} |`);
  const subNames = [...new Set(rs.flatMap((r) => Object.keys(r.stats.subs)))];
  const C = [`| preset | scene | ${subNames.join(' | ')} |`, `|---|---|${subNames.map(() => '---').join('|')}|`];
  for (const r of rs) C.push(`| ${r.preset} | ${r.scene} | ${subNames.map((n) => f1(r.stats.subs[n]?.median ?? 0)).join(' | ')} |`);
  return `**CPU laps (ms, median, additive: sums to the JS time)**\n\n${A.join('\n')}\n\n**Render passes (cpu submit ms / gpu ms (draw calls))**\n\n${B.join('\n')}\n\n**Nested CPU costs (ms, median; they overlap the laps)**\n\n${C.join('\n')}\n`;
}

export function markdown(run: Run): string {
  const m = run.meta;
  const head = Object.entries(m).map(([k2, v]) => `- ${k2}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const dev = run.device ? `\n**Device**\n\n\`\`\`json\n${JSON.stringify(run.device, null, 1)}\n\`\`\`\n` : '';
  return `${head}\n${dev}\n**Summary**\n\n${summaryTable(run.results)}\n\n${breakdownTables(run.results)}`;
}

/** two runs side by side: fps and frame ms per (preset, scene) */
export function compare(a: Run, b: Run, la = 'A', lb = 'B'): string {
  const L = [`| preset | scene | fps ${la} | fps ${lb} | frame ms ${la} | frame ms ${lb} | js ${la} | js ${lb} | gpu ${la} | gpu ${lb} | calls ${la} | calls ${lb} |`, '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of a.results) {
    const q = b.results.find((x) => x.preset === r.preset && x.scene === r.scene && x.tod === r.tod);
    if (!q) continue;
    L.push(`| ${r.preset} | ${r.scene} | ${f1(r.stats.fps.median)} | ${f1(q.stats.fps.median)} | ${f1(r.stats.frameMs.median)} | ${f1(q.stats.frameMs.median)} | ${f1(r.stats.jsMs.median)} | ${f1(q.stats.jsMs.median)} | ${f1(r.stats.gpuMs.median)} | ${f1(q.stats.gpuMs.median)} | ${r.stats.calls.median.toFixed(0)} | ${q.stats.calls.median.toFixed(0)} |`);
  }
  return L.join('\n');
}

if (process.argv[1]?.endsWith('report.ts')) {
  const [a, b] = process.argv.slice(2);
  if (!a) {
    console.error('usage: tsx tools/perf/report.ts a.json [b.json]');
    process.exit(1);
  }
  const ra = JSON.parse(fs.readFileSync(a, 'utf8')) as Run;
  console.log(b ? compare(ra, JSON.parse(fs.readFileSync(b, 'utf8')) as Run, 'a', 'b') : markdown(ra));
}
