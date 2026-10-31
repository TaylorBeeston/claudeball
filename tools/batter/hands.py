"""The hands' speed per frame of a film (tools/batter/film.ts json): the peak, and the peak after the swing's finish (clip time past `--finish`).
    python3 tools/batter/hands.py tools/batter/out/<name>.json [--finish 1.0] [--show]"""
import json, math, sys
f = sys.argv[1]
fin = float(sys.argv[sys.argv.index('--finish') + 1]) if '--finish' in sys.argv else 1.0
d = json.load(open(f)); fr = d['frames']; dt = d['dt']
peak = after = 0; prev = None; swing = False
for i, x in enumerate(fr):
    if not x.get('handL'): continue
    sp = 0
    if prev: sp = max(math.dist(x['handL'], prev['handL']), math.dist(x['handR'], prev['handR'])) / dt
    if x['clip'] == 'ondeck_swing' or x['clip'] == 'batter_practice_swing': swing = True
    if swing:
        peak = max(peak, sp)
        if x['clip'] in ('ondeck_swing', 'batter_practice_swing') and x['clipT'] is not None and x['clipT'] > fin: after = max(after, sp)
    if '--show' in sys.argv and sp > 3: print(i, x['t'], x['hint'], x['clip'], x['clipT'], f'{sp:.1f} m/s')
    prev = x
print(f'{f}: hands peak {peak:.1f} m/s, after the finish {after:.1f} m/s')
