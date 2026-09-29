# Pure numpy stadium generator (no bpy). Game coords: x = first base, y = up, z = center field. Origin = home plate apex.
import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geom

RM = (20, 9, 16)                 # max rows per tier
RUN = (0.86, 0.95, 0.80); RISE = (0.40, 0.50, 0.65)

def smooth01(t): t = np.clip(t, 0, 1); return t*t*(3-2*t)

def generate(step=0.5):
    P, N, T, S = geom.wall_path(step)
    M = len(P); x, z = P[:, 0], P[:, 1]
    s = np.clip((z-32)/40.0, 0, 1)
    hw = 1.1 + (2.44-1.1)*s
    y0 = 1.35 + (3.0-1.35)*s
    N1 = np.round(20 - 10*s).astype(int)
    N2 = np.round(9*np.clip(1-2*s, 0, 1)).astype(int); N3 = np.round(16*np.clip(1-2*s, 0, 1)).astype(int)
    off = N2 < 3; N2[off] = 0; N3[off] = 0
    w2 = (N2 > 0)
    K = 1 + 2*sum(RM) + 3*3 - 0
    prof = np.zeros((M, K, 2)); tag = np.zeros((M, K-1), np.int8)   # tag 1 = fascia
    rows = [{'o': np.zeros((M, RM[t])), 'y': np.zeros((M, RM[t])), 'N': [N1, N2, N3][t]} for t in range(3)]
    marks = {}
    NS = [N1, N2, N3]
    for j in range(M):
        pts = [(0.3, hw[j])]
        start = (0.3, y0[j])
        for t in range(3):
            Nt = int(NS[t][j]); E = start
            for r in range(RM[t]):
                if r < Nt:
                    A = (start[0]+r*RUN[t], start[1]+r*RISE[t]); B = (A[0]+RUN[t], A[1]); E = B
                    rows[t]['o'][j, r] = A[0]; rows[t]['y'][j, r] = A[1]
                else:
                    A = B = E
                pts += [A, B]
            if t < 2:
                nxt = int(NS[t+1][j]) > 0
                W = (E[0], E[1]+3.0)
                if nxt: D = (E[0]+(7.0 if t == 0 else 6.0), E[1]+3.0); F = (D[0], D[1]+(4.5 if t == 0 else 4.0))
                elif t == 0: D = (E[0]+1.0, E[1]+3.0); F = D
                else: D = F = W
                pts += [W, D, F]
                marks.setdefault(t, {})[j] = (D, F, E)
                start = F
            else:
                pts += [(E[0], E[1]+2.5), (E[0]+1.0, E[1]+2.5), (E[0]+1.0, 0.0)]
        prof[j] = np.array(pts)
    # fascia tag: segments between D and F of tiers 1,2 and the outer facade; find by index
    i1 = 1 + 2*RM[0]; i2 = i1 + 3 + 2*RM[1]; i3 = i2 + 3 + 2*RM[2]
    tag[:, i1+1] = 1; tag[:, i2+1] = 1; tag[:, i3+1] = 1        # D->F (x2) and cap->ground
    # world verts
    V = np.zeros((M, K, 3))
    V[:, :, 0] = x[:, None] + N[:, 0, None]*prof[:, :, 0]; V[:, :, 2] = z[:, None] + N[:, 1, None]*prof[:, :, 1]*0 + N[:, 1, None]*prof[:, :, 0]
    V[:, :, 1] = prof[:, :, 1]
    # batter's-eye zone (dark, no seats)
    eye = (np.abs(x) < 13) & (z > 100)
    cols = np.where(eye[:, None], np.array([[0.05, 0.08, 0.05]]), np.array([[1.0, 1.0, 1.0]]))
    # ---- seats
    seats = {}
    for t in range(3):
        pos, yaw = [], []
        for r in range(RM[t]):
            valid = (rows[t]['N'] > r) & (~eye if t == 0 else True)
            if not valid.any(): continue
            oc = rows[t]['o'][:, r] + RUN[t]*0.5; yc = rows[t]['y'][:, r]
            Q = np.stack([x+N[:, 0]*oc, yc, z+N[:, 1]*oc], 1)
            # contiguous circular runs of valid samples
            idx = np.where(valid)[0]
            if len(idx) == 0: continue
            start = 0
            if valid.all(): runs = [np.r_[np.arange(M), 0]]
            else:
                rot = int(np.where(~valid)[0][0]); order = (np.arange(M)+rot) % M; v = valid[order]
                runs = []; cur = []
                for k, ok in zip(order, v):
                    if ok: cur.append(k)
                    elif cur: runs.append(np.array(cur)); cur = []
                if cur: runs.append(np.array(cur))
            for run in runs:
                if len(run) < 3: continue
                q = Q[run]; seg = np.linalg.norm(np.diff(q[:, [0, 2]], axis=0), axis=1); cs = np.r_[0, np.cumsum(seg)]
                targets = np.arange(0.3, cs[-1]-0.2, 0.52)
                if len(targets) == 0: continue
                px = np.interp(targets, cs, q[:, 0]); py = np.interp(targets, cs, q[:, 1]); pz = np.interp(targets, cs, q[:, 2])
                bs = np.interp(targets, cs, S[run] if run[-1] >= run[0] else S[run])   # base arclength (aisles)
                nrm = np.stack([np.interp(targets, cs, N[run, 0]), np.interp(targets, cs, N[run, 1])], 1)
                keep = (np.mod(bs, 15.0) > 1.3)
                pos.append(np.stack([px, py, pz], 1)[keep]); yaw.append(np.arctan2(-nrm[keep, 0], -nrm[keep, 1]))
        seats[t] = (np.concatenate(pos).astype(np.float32), np.concatenate(yaw).astype(np.float32)) if pos else (np.zeros((0, 3), np.float32), np.zeros(0, np.float32))
    return dict(P=P, N=N, T=T, S=S, V=V, prof=prof, tag=tag, cols=cols, hw=hw, seats=seats, marks=marks, eye=eye, s=s,
                N1=N1, N2=N2, N3=N3, K=K, M=M)

if __name__ == '__main__':
    import time; t = time.time(); g = generate()
    print('M', g['M'], 'K', g['K'], 'seats', [len(g['seats'][i][0]) for i in range(3)], 'time', time.time()-t)
    print('extent x', g['V'][..., 0].min(), g['V'][..., 0].max(), 'z', g['V'][..., 2].min(), g['V'][..., 2].max(), 'y', g['V'][..., 1].max())
