/**
 * Scores benchmark outputs: validator pass rate, the reasons for rejections, and prints every line next to the grammar's line for the same moment.
 *   npx tsx scripts/lm/evaluate.ts contexts.json bench1.json [bench2.json ...]
 */
import { readFileSync } from 'node:fs';
import { validateLine, type LmFacts } from '../../src/audio/broadcast/lm';

const [ctxFile, ...files] = process.argv.slice(2);
const contexts = JSON.parse(readFileSync(ctxFile, 'utf8')) as { facts: LmFacts; grammar: string; tag: string }[];
for (const f of files) {
  const r = JSON.parse(readFileSync(f, 'utf8')) as { model: string; dtype: string; loadMs: number; samples: { text: string; firstMs: number; totalMs: number; tps: number; nIn: number; nOut: number }[]; vramBeforeMB: number; vramAfterMB: number };
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const rewrite = (r as { MODE?: string }).MODE === 'rewrite';
  // rewrite mode: the facts are the situation plus the grammar's line (its numbers and names are allowed in the rewrite)
  const factsOf = (i: number): LmFacts => (rewrite ? { ...contexts[i].facts, lastPlay: `${contexts[i].facts.lastPlay ?? ''} ${contexts[i].grammar}`, recentLines: [] } : contexts[i].facts);
  const verdicts = r.samples.map((s, i) => validateLine(s.text.replace(/^"|"$/g, ''), factsOf(i)));
  const ok = verdicts.filter((v) => v.ok).length;
  const inBudget = r.samples.filter((s, i) => verdicts[i].ok && s.totalMs <= 1500).length;
  const reasons: Record<string, number> = {};
  for (const v of verdicts) if (!v.ok) reasons[(v.reason ?? '').replace(/".*"|\d+/g, '#')] = (reasons[(v.reason ?? '').replace(/".*"|\d+/g, '#')] ?? 0) + 1;
  console.log(`\n=== ${r.model} (${r.dtype}) load ${(r.loadMs / 1000).toFixed(0)} s, prompt ~${med(r.samples.map((s) => s.nIn))} tokens, first token ${med(r.samples.map((s) => s.firstMs))} ms, total ${med(r.samples.map((s) => s.totalMs))} ms, ${med(r.samples.map((s) => s.tps))} tok/s, VRAM +${r.vramAfterMB - r.vramBeforeMB} MB`);
  console.log(`validator: ${ok}/${r.samples.length} pass; ${inBudget} pass AND inside 1.5 s; rejections: ${JSON.stringify(reasons)}`);
  if (process.env.SHOW) r.samples.forEach((s, i) => console.log(`${verdicts[i].ok ? 'OK ' : 'BAD'} [${s.totalMs}ms] ${s.text}${verdicts[i].ok ? '' : '   <- ' + verdicts[i].reason}\n      grammar: ${contexts[i].grammar}`));
}
