"""How much the men on a bench move as one, from a film with --probe bench:<team> (tools/batter/film.ts): the mean pairwise correlation of
their chest lean and of their head yaw over the clip (1 = in unison, 0 = each his own), and how many of them change direction on the same frame.
    python3 tools/batter/sync.py tools/batter/out/<name>.json [...]"""
import json, sys, itertools, statistics as st

def corr(a, b):
    ma, mb = st.fmean(a), st.fmean(b)
    va = sum((x - ma) ** 2 for x in a); vb = sum((y - mb) ** 2 for y in b)
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / ((va * vb) ** 0.5) if va > 1e-12 and vb > 1e-12 else float('nan')

for f in sys.argv[1:]:
    fr = [x['bench'] for x in json.load(open(f))['frames'] if x.get('bench')]
    ids = sorted(set.intersection(*[set(r[0] for r in b) for b in fr]))
    lean = {i: [next(r[1] for r in b if r[0] == i) for b in fr] for i in ids}
    yaw = {i: [next(r[2] for r in b if r[0] == i) for b in fr] for i in ids}
    out = {}
    for name, ser in (('lean', lean), ('headYaw', yaw)):
        cs = [c for a, b in itertools.combinations(ids, 2) if (c := corr(ser[a], ser[b])) == c]
        out[name] = round(st.fmean(cs), 2) if cs else None
    print(f'{f}: {len(ids)} men, {len(fr)} frames, mean pairwise correlation: chest lean {out["lean"]}, head yaw {out["headYaw"]}')
