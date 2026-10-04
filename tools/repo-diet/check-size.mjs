#!/usr/bin/env node
/**
 * Repository size guard (CI and the pre-commit hook). Fails when
 *   - a tracked / staged path is a build intermediate (tools/repo-diet/intermediates.txt: plain Blender exports, lod1, unshipped role files, texture dumps),
 *   - a single file is larger than MAX_FILE_MB (GitHub refuses > 100 MB; we stay far below),
 *   - the commit range adds more than MAX_ADD_MB of new blob data (a full re-export of the shipped player files is ~65 MB),
 *   - the tracked tree is larger than MAX_TREE_MB.
 *
 *   node tools/repo-diet/check-size.mjs                 # the tracked tree at HEAD + what HEAD adds over HEAD^ (CI: checkout with fetch-depth 2)
 *   node tools/repo-diet/check-size.mjs --range A..B    # what a push adds (e.g. ${{ github.event.before }}..${{ github.sha }})
 *   node tools/repo-diet/check-size.mjs --staged        # the index (pre-commit hook)
 * Limits can be raised for one run with CB_SIZE_MAX_ADD_MB / CB_SIZE_MAX_FILE_MB / CB_SIZE_MAX_TREE_MB (say why in the commit message).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MB = 1048576;
const MAX_FILE_MB = +(process.env.CB_SIZE_MAX_FILE_MB ?? 25);
const MAX_ADD_MB = +(process.env.CB_SIZE_MAX_ADD_MB ?? 80);
const MAX_TREE_MB = +(process.env.CB_SIZE_MAX_TREE_MB ?? 160);
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const root = git('rev-parse', '--show-toplevel').trim();
const argv = process.argv.slice(2);

// the intermediates list: plain prefixes and `regex:` lines (git filter-repo syntax)
const rules = fs
  .readFileSync(path.join(root, 'tools/repo-diet/intermediates.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => (l.startsWith('regex:') ? new RegExp(l.slice(6)) : { test: (p) => p.startsWith(l) }));
const intermediate = (p) => rules.some((r) => r.test(p));

const problems = [];
const warnings = [];

// files of the tree / index with their sizes
let files;
if (argv.includes('--staged')) {
  files = git('ls-files', '-s')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [meta, p] = l.split('\t');
      const sha = meta.split(' ')[1];
      return { p, size: +git('cat-file', '-s', sha).trim() };
    });
} else {
  files = git('ls-tree', '-r', '-l', 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [meta, p] = l.split('\t');
      return { p, size: +meta.trim().split(/\s+/)[3] || 0 };
    });
}
let tree = 0;
const inter = [];
for (const f of files) {
  tree += f.size;
  if (intermediate(f.p)) inter.push(f.p);
  if (f.size > MAX_FILE_MB * MB) problems.push(`file larger than ${MAX_FILE_MB} MB: ${f.p} (${(f.size / MB).toFixed(1)} MB)`);
}
if (inter.length) problems.push(`${inter.length} build intermediate(s) tracked (regenerable, git-ignored in the lean layout, see docs/repo-size.md): ${inter.slice(0, 6).join(', ')}${inter.length > 6 ? ', ...' : ''}`);
if (tree > MAX_TREE_MB * MB) problems.push(`tracked tree is ${(tree / MB).toFixed(0)} MB (limit ${MAX_TREE_MB} MB)`);

// new blob data the range / the index adds
let added = 0;
const big = [];
const range = argv.includes('--range') ? argv[argv.indexOf('--range') + 1] : argv.includes('--staged') ? null : 'HEAD^..HEAD';
if (argv.includes('--staged')) {
  // lines like ":100644 100644 <old> <new> M\tpath": the new blob of every added / modified file
  for (const l of git('diff', '--cached', '--raw', '--no-renames', '--no-abbrev').split('\n').filter(Boolean)) {
    const m = /^:\S+ \S+ \S+ (\S+) ([AM])\t(.*)$/.exec(l);
    if (!m) continue;
    const s = +git('cat-file', '-s', m[1]).trim();
    added += s;
    if (s > 5 * MB) big.push(`${m[3]} ${(s / MB).toFixed(1)} MB`);
  }
} else if (range) {
  try {
    const [from] = range.split('..');
    if (/^0+$/.test(from)) throw new Error('new branch');
    const out = git('rev-list', '--objects', range, `^${from}`);
    const ids = out.split('\n').filter(Boolean).map((l) => l.split(' '));
    const sizes = execFileSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize)'], { input: ids.map((x) => x[0]).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
    sizes.forEach((l, i) => {
      const [t, , s] = l.split(' ');
      if (t !== 'blob') return;
      added += +s;
      if (+s > 5 * MB) big.push(`${ids[i][1] ?? ids[i][0]} ${(+s / MB).toFixed(1)} MB`);
    });
  } catch (e) {
    warnings.push(`could not measure the range ${range} (${String(e.message).split('\n')[0]}): with actions/checkout use fetch-depth: 2 or pass --range`);
  }
}
if (added > MAX_ADD_MB * MB) problems.push(`adds ${(added / MB).toFixed(0)} MB of new file data (limit ${MAX_ADD_MB} MB): ${big.slice(0, 8).join(', ')}`);
else if (added > 40 * MB) warnings.push(`adds ${(added / MB).toFixed(0)} MB of new file data: ${big.slice(0, 8).join(', ')}`);

console.log(`[size] tree ${(tree / MB).toFixed(1)} MB in ${files.length} files; new data ${(added / MB).toFixed(1)} MB${range ? ` (${range})` : ' (staged)'}`);
for (const w of warnings) console.log(`[size] warning: ${w}`);
for (const p of problems) console.error(`[size] FAIL: ${p}`);
process.exit(problems.length ? 1 : 0);
