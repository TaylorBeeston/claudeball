/**
 * Reaction shots over whole real games, without a browser (tools/director/harness.ts through vite's SSR loader, for `import.meta.glob`).
 *
 *   npx tsx tools/director/measure.ts --seeds 1,2,3,24 [--tempo broadcast] [--innings 9] [--reactions off] [--maxSeconds 1000] [--out file.json]
 *   npx tsx tools/director/measure.ts --merge a.json,b.json   (the tables of saved records)
 *
 * Prints, per seed and in total: the strong reactions by kind, how often the camera showed the reacting person while the reaction ran, what the
 * camera showed instead, and the person-shots / reaction shots per game. `--out` keeps the raw record (segments and reactions).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import type { GameResult } from './harness';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const seeds = arg('seeds', '1,2,3,24').split(',').map(Number);
const tempo = arg('tempo', 'broadcast') as 'broadcast';
const innings = +arg('innings', '9');
const out = arg('out', '');
const merge = arg('merge', '');
const reactions = arg('reactions', 'on') !== 'off';
const maxSeconds = +arg('maxSeconds', '20000');

const results: GameResult[] = [];
if (process.argv.includes('--merge') && !merge) throw new Error('--merge needs a comma-separated list of saved records');
if (merge) for (const f of merge.split(',')) results.push(...(JSON.parse(readFileSync(f, 'utf8')) as GameResult[]));
else {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
  const { runGame } = (await server.ssrLoadModule('/tools/director/harness.ts')) as typeof import('./harness');
  for (const seed of seeds) {
    const t0 = Date.now();
    const r = await runGame({ seed, tempo, innings, reactions, maxSeconds });
    results.push(r);
    console.error(`[measure] seed ${seed} ${tempo}: ${r.gameSeconds} game s, ${r.wallSeconds} broadcast s in ${((Date.now() - t0) / 1000).toFixed(0)} s; person-shots ${r.personShots}, reaction shots ${r.reactionShots}, group shots ${r.groupShots}`);
  }
  await server.close();
}

// ---- the table ----
const kinds = new Map<string, { n: number; seen: number; cam: Map<string, number> }>();
const camKey = (s: string) => s.replace(/^broll:/, 'B-roll ').replace(/^(cutaway|toss|coach):.*/, '$1');
for (const r of results)
  for (const x of r.reactions) {
    const k = kinds.get(x.label) ?? { n: 0, seen: 0, cam: new Map() };
    kinds.set(x.label, k);
    k.n++;
    if (x.seen) k.seen++;
    // the shot that had most of the reaction's window
    const top = Object.entries(x.camWindow).sort((a, b) => b[1] - a[1])[0]?.[0] ?? x.camAt;
    const key = camKey(top);
    k.cam.set(key, (k.cam.get(key) ?? 0) + 1);
  }
const rows = [...kinds.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`\n| reaction (${results[0]?.tempo}, seeds ${results.map((r) => r.seed).join(', ')}) | count | per game | reacting person shown | what the camera showed (most of the reaction) |`);
console.log('|---|---|---|---|---|');
for (const [label, k] of rows) {
  const cams = [...k.cam.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${Math.round((100 * n) / k.n)}%`).slice(0, 4).join(', ');
  console.log(`| ${label} | ${k.n} | ${(k.n / results.length).toFixed(1)} | ${k.seen} (${Math.round((100 * k.seen) / k.n)}%) | ${cams} |`);
}
console.log('\n| seed | game s | broadcast s | person-shots | reaction shots (a person-shot that met a running reaction) | per 40 min | of them the new `reaction` cut (< 2 s) | group shots (dugout reaction, mound huddle) | replays | cuts | cuts < 1 s after the last |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.seed} | ${r.gameSeconds} | ${r.wallSeconds} | ${r.personShots} | ${r.reactionShots} | ${((r.reactionShots * 2400) / r.wallSeconds).toFixed(1)} | ${r.reactionCuts ?? 0} (${r.shortReactions ?? 0}) | ${r.groupShots} | ${r.replays ?? '?'} | ${r.cuts ?? '?'} | ${r.quickCuts ?? '?'} |`);
if (out) {
  writeFileSync(out, JSON.stringify(results.map((r) => ({ ...r, segments: r.segments.map((s) => ({ ...s, t0: +s.t0.toFixed(2), t1: +s.t1.toFixed(2) })) }))));
  console.error(`[measure] raw record: ${out}`);
}
