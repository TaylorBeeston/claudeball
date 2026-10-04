#!/usr/bin/env python3
"""Read-only repository size analysis: which paths take the space in git history.
   python3 tools/repo-diet/analyze.py [--ref --all] [--top 30]
Counts every blob reachable from the refs once (by the first path it was seen at), with its uncompressed size and its on-disk (packed,
delta-compressed) size, then sums by path prefix. Nothing is written."""
import subprocess, sys, collections
args = sys.argv[1:]
ref = args[args.index('--ref') + 1] if '--ref' in args else '--all'
top = int(args[args.index('--top') + 1]) if '--top' in args else 30
objs = subprocess.run(['git', 'rev-list', '--objects', ref], capture_output=True, text=True, check=True).stdout.splitlines()
inp = '\n'.join(l.split(' ', 1)[0] for l in objs) + '\n'
paths = {l.split(' ', 1)[0]: (l.split(' ', 1)[1] if ' ' in l else '') for l in objs}
out = subprocess.run(['git', 'cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize) %(objectsize:disk)'], input=inp, capture_output=True, text=True, check=True).stdout.splitlines()
blobs = []
for l in out:
    t, h, s, d = l.split()
    if t == 'blob': blobs.append((h, int(s), int(d), paths.get(h, '')))
MB = 1 / 1048576
tot_s = sum(b[1] for b in blobs); tot_d = sum(b[2] for b in blobs)
print(f'blobs {len(blobs)}  uncompressed {tot_s*MB:.0f} MB  on disk {tot_d*MB:.0f} MB')
def bucket(p):
    for pre in ('assets/players/lod1/', 'assets/players/textures/', 'assets/players/', 'assets/optimized/players_1k/', 'assets/optimized/lod1/', 'assets/optimized/lod/', 'assets/optimized/players/', 'assets/optimized/',
                'assets/src/', 'assets/tex/', 'assets/', 'public/crowd/', 'public/audio/', 'public/', 'tools/', 'src/', 'docs/', 'scripts/'):
        if p.startswith(pre): return pre
    return p.split('/')[0] + ('/' if '/' in p else '')
agg = collections.defaultdict(lambda: [0, 0, 0])
for h, s, d, p in blobs:
    a = agg[bucket(p)]; a[0] += 1; a[1] += s; a[2] += d
print(f'\n{"prefix":34} {"blobs":>6} {"raw MB":>8} {"disk MB":>8}')
for k, (n, s, d) in sorted(agg.items(), key=lambda kv: -kv[1][2]):
    if d * MB >= 0.5: print(f'{k:34} {n:6} {s*MB:8.1f} {d*MB:8.1f}')
print(f'\nbiggest blobs (on disk) in history:')
for h, s, d, p in sorted(blobs, key=lambda b: -b[2])[:top]:
    print(f'{d*MB:7.1f} MB disk {s*MB:7.1f} MB raw  {h[:10]}  {p}')
# versions per path
per = collections.defaultdict(lambda: [0, 0])
for h, s, d, p in blobs: per[p][0] += 1; per[p][1] += d
print('\npaths with the most history (versions, MB on disk):')
for p, (n, d) in sorted(per.items(), key=lambda kv: -kv[1][1])[:top]:
    print(f'{d*MB:7.1f} MB  {n:3} versions  {p}')
