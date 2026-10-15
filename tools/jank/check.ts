/**
 * `npm run jank:check`: the animation ratchet. Runs the static sweep (every clip of every shipped player file) and the crossfade sweep (every clip
 * switch in tools/jank/transitions.json) in Node and fails when any kind of violation got worse than tools/jank/baseline.json: more frames
 * breaking a limit, or a higher severity score. Both sweeps are deterministic and independent of the sim, so the ratchet is exact (a small
 * tolerance absorbs floating-point noise between machines).
 *
 *   --update   write the measured numbers as the new baseline (do it when a change improved things, so they cannot come back)
 *
 * The game sweep (runtime overrides: look-at, IK; `npx tsx tools/jank/run.ts game`) depends on the sim and the GPU and is reported, not gated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { family, type Entry } from './agg';
import { doFades, doStatic } from './run';
import { ROOT } from './sweep';

const FILE = path.join(ROOT, 'tools/jank/baseline.json');
type Fam = Record<string, { frames: number; score: number }>;

export function summarize(entries: Entry[]): Fam {
  const out: Fam = {};
  for (const e of entries) {
    if (e.src === 'static-mirror') continue;
    for (const [k, s] of Object.entries(e.kinds)) {
      const f = (out[family(k)] ??= { frames: 0, score: 0 });
      f.frames += s.frames;
      f.score += s.score;
    }
  }
  for (const v of Object.values(out)) v.score = +v.score.toFixed(3);
  return out;
}

async function main() {
  const st = await doStatic(false);
  const fd = await doFades(false);
  // self-test: the mirrored bat clips must measure exactly like the right-handed ones
  let mirrorBad = 0;
  const by = new Map(st.entries.map((e) => [`${e.src}|${e.file}|${e.clip}`, e]));
  for (const e of st.entries) {
    if (e.src !== 'static-mirror') continue;
    const o = by.get(`static|${e.file}|${e.clip}`);
    if (!o || o.bad !== e.bad) {
      mirrorBad++;
      console.log(`[jank:check] FAIL mirror: ${e.file} ${e.clip} ${o?.bad} vs mirrored ${e.bad} bad frames`);
    }
  }
  const now = { static: summarize(st.entries), fades: summarize(fd.entries) };
  if (process.argv.includes('--update')) {
    fs.writeFileSync(FILE, JSON.stringify({ _: 'npm run jank:check baseline (tools/jank/check.ts): violation frames and severity score per kind; lower is better', ...now }, null, 1) + '\n');
    console.log(`[jank:check] baseline written: ${FILE}`);
    return;
  }
  if (!fs.existsSync(FILE)) {
    console.log('[jank:check] no baseline yet: run with --update');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { static: Fam; fades: Fam };
  let bad = mirrorBad, better = 0;
  for (const src of ['static', 'fades'] as const) {
    const kinds = new Set([...Object.keys(base[src] ?? {}), ...Object.keys(now[src])]);
    for (const k of [...kinds].sort()) {
      const b = base[src]?.[k] ?? { frames: 0, score: 0 }, n = now[src][k] ?? { frames: 0, score: 0 };
      const worse = n.frames > b.frames * 1.002 + 1 || n.score > b.score * 1.002 + 0.01;
      const impr = n.frames < b.frames * 0.998 - 1 || n.score < b.score * 0.998 - 0.01;
      if (worse) bad++;
      if (impr) better++;
      if (worse || impr || process.argv.includes('--verbose')) console.log(`[jank:check] ${worse ? 'FAIL' : impr ? 'better' : 'ok  '} ${src.padEnd(6)} ${k.padEnd(26)} frames ${String(n.frames).padStart(6)} / ${b.frames}   score ${n.score.toFixed(2).padStart(8)} / ${b.score.toFixed(2)}`);
    }
  }
  if (better && !bad) console.log(`[jank:check] ${better} kinds improved: ratchet the baseline with \`npm run jank:check -- --update\``);
  console.log(`[jank:check] ${bad ? `FAIL (${bad})` : 'ok'}`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
