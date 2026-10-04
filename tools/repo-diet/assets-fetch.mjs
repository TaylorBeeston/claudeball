#!/usr/bin/env node
/**
 * The build intermediates (plain Blender exports, lod1, role files, texture dumps: tools/repo-diet/intermediates.txt) are not in git. Only asset work
 * needs them (assets/optimize.sh, src/perf_all.sh, src/ktx_world.sh, npm run assets:derive); `vite build` and the deploy do not.
 *   npm run assets:fetch            download assets/intermediates.lock.json's archive, check its sha256, unpack into assets/
 *   npm run assets:pack [-- --from <checkout>] [--tag assets-v1] [--out <dir>]   (maintainer) pack the intermediates (tracked ones of a checkout that still
 *                                   tracks them, else every matching file; plus the git-ignored MPFB photos) into <dir> (default dist-intermediates/) into dist-intermediates/<name>.tar.gz and rewrite the lock file;
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
  const walk = (d, test) => { if (!fs.existsSync(path.join(src, d))) return; for (const e of fs.readdirSync(path.join(src, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, test); else if (test(r)) files.push(r); } };
  // a checkout that still tracks the intermediates: exactly the tracked ones (no stray local dumps); else every matching file on disk
  let tracked = [];
  try { tracked = execFileSync('git', ['-C', src, 'ls-files', 'assets'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter((p) => p && rules.slice(0, -1).some((x) => x.test(p))); } catch { /* not a git checkout */ }
  if (tracked.length) files.push(...tracked);
  else walk('assets', (r) => rules.slice(0, -1).some((x) => x.test(r)));
  walk('assets/src/mpfb/tex', () => true);
  if (!files.length) throw new Error('no intermediates found under assets/ (build them first)');
  const ti = process.argv.indexOf('--tag');
  const tag = ti > 0 ? process.argv[ti + 1] : `assets-${new Date().toISOString().slice(0, 10)}`;
  const oi = process.argv.indexOf('--out');
  const outDir = oi > 0 ? path.resolve(process.argv[oi + 1]) : path.join(root, 'dist-intermediates');
  const name = `claudeball-intermediates-${tag}.tar.gz`;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, name);
  // fixed owner / mtime order: the archive (and its sha256) depends only on the files
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=2026-01-01', '-czf', out, '-C', src, ...[...new Set(files)].sort()]);
  // the GitHub repository the release lives in: CB_ASSETS_REPO, else origin (git filter-repo removes origin, hence the fallback)
  let repo = process.env.CB_ASSETS_REPO ?? '';
  if (!repo) { try { repo = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { repo = 'https://github.com/TaylorBeeston/claudeball'; } }
  repo = repo.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  const lock = { url: `${repo}/releases/download/${tag}/${name}`, sha256: sha256(out), bytes: fs.statSync(out).size, files: new Set(files).size, created: new Date().toISOString() };
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 1) + '\n');
  console.log(`packed ${new Set(files).size} files -> ${out} (${(lock.bytes / 1048576).toFixed(0)} MB, sha256 ${lock.sha256})\nnext: gh release create ${tag} ${out} --title "${tag}" --notes "build intermediates" && commit assets/intermediates.lock.json`);
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
