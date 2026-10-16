/**
 * Before / after tables of two game sweeps (tools/jank/run.ts game): every violation kind per 1000 on-screen puppet frames (all attributions),
 * the bat per clip that holds one, and the engine pops.
 *
 *   npx tsx tools/jank/compare.ts tools/jank/out/before tools/jank/out/after [--out compare.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { family, type Entry } from './agg';

const [A, Bd] = process.argv.slice(2);
const outI = process.argv.indexOf('--out');
const outFile = outI > 0 ? process.argv[outI + 1] : path.join(Bd, 'compare.md');
const load = (d: string) => JSON.parse(fs.readFileSync(path.join(d, 'game.json'), 'utf8')) as { entries: Entry[]; stats: Record<string, number> };
const a = load(A), b = load(Bd);

function kinds(r: ReturnType<typeof load>) {
  const t = new Map<string, { frames: number; score: number; max: number }>();
  for (const e of r.entries) {
    if (!e.src.startsWith('game:')) continue;
    for (const [k, s] of Object.entries(e.kinds)) {
      const f = family(k);
      const x = t.get(f) ?? { frames: 0, score: 0, max: 0 };
      x.frames += s.frames;
      x.score += s.score;
      x.max = Math.max(x.max, s.max);
      t.set(f, x);
    }
  }
  return t;
}
const ka = kinds(a), kb = kinds(b);
const per = (n: number, r: ReturnType<typeof load>) => ((n / Math.max(1, r.stats.visibleFrames)) * 1000).toFixed(1);
const lines = ['# Game sweep: before vs after', '', `before: ${A} (${a.stats.visibleFrames} on-screen puppet frames), after: ${Bd} (${b.stats.visibleFrames}). Integrity (frames off the rendered bones by > 1 cm): ${a.stats.fkMismatch} / ${b.stats.fkMismatch}.`, ''];
const sa = [...ka.values()].reduce((s, x) => s + x.score, 0), sb = [...kb.values()].reduce((s, x) => s + x.score, 0);
lines.push(`Total severity score (on screen, all attributions): ${sa.toFixed(0)} -> ${sb.toFixed(0)} (${(((sb - sa) / Math.max(1e-9, sa)) * 100).toFixed(0)} %)`, '');
lines.push('| kind | before /1k | after /1k | change | worst before | worst after |', '|---|---:|---:|---:|---:|---:|');
const all = [...new Set([...ka.keys(), ...kb.keys()])].sort((x, y) => (ka.get(y)?.score ?? 0) - (ka.get(x)?.score ?? 0));
for (const k of all) {
  const x = ka.get(k), y = kb.get(k);
  const pa = +per(x?.frames ?? 0, a), pb = +per(y?.frames ?? 0, b);
  const ch = pa > 0 ? `${(((pb - pa) / pa) * 100).toFixed(0)} %` : pb > 0 ? 'new' : '';
  lines.push(`| ${k} | ${pa} | ${pb} | ${ch} | ${(x?.max ?? 0).toFixed(2)} | ${(y?.max ?? 0).toFixed(2)} |`);
}
// the bat per clip that holds one: frames with each kind / all frames of the clip (both hands counted for the per-hand kinds)
lines.push('', '## The bat, per clip (share of the clip\'s frames; grip and fist-axis count each hand, so 200 % = both hands every frame)', '', '| clip | frames before | frames after | grip | fist axis | wrong hand at knob | barrel in body |', '|---|---:|---:|---|---|---|---|');
const den = (r: ReturnType<typeof load>) => new Map(r.entries.filter((e) => e.src === 'frames').map((e) => [`${e.file}|${e.clip}`, e.frames]));
const da = den(a), db = den(b);
const batOf = (r: ReturnType<typeof load>, key: string) => {
  const o: Record<string, number> = {};
  for (const e of r.entries) {
    if (!e.src.startsWith('game:') || `${e.file}|${e.clip}` !== key) continue;
    for (const [k, s] of Object.entries(e.kinds)) if (k.startsWith('bat:')) o[k.replace(/-[LR]$/, '')] = (o[k.replace(/-[LR]$/, '')] ?? 0) + s.frames;
  }
  return o;
};
for (const key of ['batter|swing', 'batter|swing:stride', 'batter|swing:finish', 'batter|batting_stance', 'batter|batter_practice_swing', 'ondeck|ondeck_swing', 'ondeck|ondeck_ready']) {
  const x = batOf(a, key), y = batOf(b, key);
  const na = da.get(key) ?? 0, nb = db.get(key) ?? 0;
  const pc = (v: number | undefined, n: number) => (n ? `${(((v ?? 0) / n) * 100).toFixed(1)} %` : '-');
  lines.push(`| ${key} | ${na} | ${nb} | ${pc(x['bat:grip'], na)} -> ${pc(y['bat:grip'], nb)} | ${pc(x['bat:hand-axis'], na)} -> ${pc(y['bat:hand-axis'], nb)} | ${pc(x['bat:order'], na)} -> ${pc(y['bat:order'], nb)} | ${pc(x['bat:body'], na)} -> ${pc(y['bat:body'], nb)} |`);
}
const pops = (r: ReturnType<typeof load>, k: string) => r.entries.reduce((s, e) => s + (e.kinds[k]?.frames ?? 0), 0);
lines.push('', `Engine pops: whole-body mirror ${pops(a, 'pop:mirror')} -> ${pops(b, 'pop:mirror')}, root jumps ${pops(a, 'pop:root-jump')} -> ${pops(b, 'pop:root-jump')}, root spins ${pops(a, 'pop:root-spin')} -> ${pops(b, 'pop:root-spin')}.`);
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(lines.join('\n'));
