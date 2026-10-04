#!/usr/bin/env node
/**
 * The build intermediates (plain Blender exports, lod1, role files, texture dumps: tools/repo-diet/intermediates.txt) are not in git. Only asset work
 * needs them (assets/optimize.sh, src/perf_all.sh, src/ktx_world.sh, npm run assets:derive); `vite build` and the deploy do not.
 *   npm run assets:fetch            download assets/intermediates.lock.json's archive, check its sha256, unpack into assets/
 *   npm run assets:pack [-- --from <checkout>]   (maintainer) pack the intermediates (of this checkout, or of another one that still has them) into dist-intermediates/<name>.tar.gz and rewrite the lock file;
 *                                   upload the archive as a GitHub Release asset (gh release create assets-<date> dist-intermediates/*.tar.gz) and commit the lock
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const lockFile = path.join(root, 'assets/intermediates.lock.json');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

if (process.argv.includes('--pack')) {
  const rules = fs.readFileSync(path.join(root, 'tools/repo-diet/intermediates.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('regex:') ? new RegExp(l.slice(6)) : { test: (p) => p.startsWith(l) }));
  // the CC0 MPFB photos the player build needs (git-ignored) travel in the same archive
  rules.push({ test: (p) => p.startsWith('assets/src/mpfb/tex/') });
  const a = process.argv.indexOf('--from');
  const src = a > 0 ? path.resolve(process.argv[a + 1]) : root;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(src, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r); else if (rules.some((x) => x.test(r))) files.push(r); } };
  walk('assets');
  if (!files.length) throw new Error('no intermediates found under assets/ (build them first)');
  const name = `claudeball-intermediates-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  fs.mkdirSync(path.join(root, 'dist-intermediates'), { recursive: true });
  const out = path.join(root, 'dist-intermediates', name);
  execFileSync('tar', ['-czf', out, '-C', src, ...files.sort()]);
  // the GitHub repository the release lives in: CB_ASSETS_REPO, else origin (git filter-repo removes origin, hence the fallback)
  let repo = process.env.CB_ASSETS_REPO ?? '';
  if (!repo) { try { repo = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { repo = 'https://github.com/TaylorBeeston/claudeball'; } }
  repo = repo.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  const tag = `assets-${new Date().toISOString().slice(0, 10)}`;
  const lock = { url: `${repo}/releases/download/${tag}/${name}`, sha256: sha256(out), bytes: fs.statSync(out).size, files: files.length, created: new Date().toISOString() };
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 1) + '\n');
  console.log(`packed ${files.length} files -> ${out} (${(lock.bytes / 1048576).toFixed(0)} MB)\nnext: gh release create ${tag} ${out} --title "${tag}" --notes "build intermediates" && commit assets/intermediates.lock.json`);
} else {
  if (!fs.existsSync(lockFile)) throw new Error('assets/intermediates.lock.json missing: nothing published yet (npm run assets:pack)');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const tmp = path.join(root, 'dist-intermediates', path.basename(lock.url));
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  if (!fs.existsSync(tmp) || sha256(tmp) !== lock.sha256) {
    console.log(`downloading ${lock.url} (${(lock.bytes / 1048576).toFixed(0)} MB)`);
    const r = await fetch(lock.url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  }
  if (sha256(tmp) !== lock.sha256) throw new Error('checksum mismatch: the archive is not the one the lock file names');
  execFileSync('tar', ['-xzf', tmp, '-C', root]);
  console.log(`unpacked ${lock.files} files into assets/`);
}
