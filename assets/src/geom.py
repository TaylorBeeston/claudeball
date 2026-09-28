# Shared ballpark geometry, in GAME coordinates (meters): origin = home plate apex (back tip),
# +Y up, +Z toward center field, +X toward first base. Blender is built as (x, -z, y) so that
# glTF export (Y-up) yields exactly these coordinates.
import math
FT = 0.3048
IN = 0.0254
def B(x, y, z): return (x, -z, y)                 # game -> blender
def fence_dist(a):                                # a = angle from CF line in radians, |a| <= 45 deg
    return (330 + 70*math.cos(2*a))*FT            # 330 ft at lines, 400 ft to center
def fence_pts(n=181, off=0.0):
    out = []
    for i in range(n):
        a = math.radians(45 - 90*i/(n-1)); d = fence_dist(a) - off
        out.append((d*math.sin(a), d*math.cos(a)))
    return out                                    # RF line -> LF line
POLE_R = (330*FT*math.sqrt(.5), 330*FT*math.sqrt(.5))
POLE_L = (-POLE_R[0], POLE_R[1])
BACKSTOP_Z = -60*FT
_R = [(66, 53), (54, 32), (38, 8), (24, BACKSTOP_Z)]      # foul-territory boundary (right side)
FOUL_R = [POLE_R] + _R
FOUL_L = [(-x, z) for x, z in FOUL_R]
def ground_outline():
    p = wall_path(1.5)[0]
    return [tuple(q) for q in p]
CF = 400*FT
C_MOUND = (0.0, 59*FT)
def base_center(which):
    if which == 2: return (0.0, 127.281*FT)
    d = 90*FT; h = 7.5*IN; s = math.sqrt(.5)
    x, z = (d-h)*s, (d-h)*s
    x, z = x - h*s, z + h*s                          # move inward (toward center of the diamond)
    return (x if which == 1 else -x, z)

# ---- smooth closed wall path (foul-territory wall + outfield fence), clockwise seen with x right / z up
import numpy as _np
POLE_OVER = 4.5
_CHAIN_R = [(67, 57), (58, 40), (46, 22), (34, 6), (26, -6), (19, -14), (10, -17.5)]
def _catmull(pts, closed=True, per=24):
    P = _np.array(pts, float); n = len(P); out = []
    for i in range(n):
        p0, p1, p2, p3 = P[(i-1) % n], P[i], P[(i+1) % n], P[(i+2) % n]
        t0 = 0.0; t1 = t0+_np.linalg.norm(p1-p0)**.5; t2 = t1+_np.linalg.norm(p2-p1)**.5; t3 = t2+_np.linalg.norm(p3-p2)**.5
        for t in _np.linspace(t1, t2, per, endpoint=False):
            a1 = (t1-t)/(t1-t0)*p0+(t-t0)/(t1-t0)*p1; a2 = (t2-t)/(t2-t1)*p1+(t-t1)/(t2-t1)*p2; a3 = (t3-t)/(t3-t2)*p2+(t-t2)/(t3-t2)*p3
            b1 = (t2-t)/(t2-t0)*a1+(t-t0)/(t2-t0)*a2; b2 = (t3-t)/(t3-t1)*a2+(t-t1)/(t3-t1)*a3
            out.append((t2-t)/(t2-t1)*b1+(t-t1)/(t2-t1)*b2)
    return _np.array(out)
def wall_path(step=0.5):
    """Closed wall loop: RF pole -> home -> LF pole -> fence arc -> back to RF pole. Returns (pts[N,2], normals_out[N,2], tangents[N,2], s[N])."""
    ctrl = [(POLE_R[0]+POLE_OVER*.5, POLE_R[1]+POLE_OVER)] + _CHAIN_R + [(0.0, BACKSTOP_Z)] + [(-x, z) for x, z in reversed(_CHAIN_R)] + [(POLE_L[0]-POLE_OVER*.5, POLE_L[1]+POLE_OVER)]
    ctrl += [p for p in fence_pts(61)[::-1][1:-1]]     # LF -> RF along the fence (a from -45 to +45 deg)
    dense = _catmull(ctrl)
    seg = _np.linalg.norm(_np.diff(_np.vstack([dense, dense[:1]]), axis=0), axis=1); s = _np.concatenate([[0], _np.cumsum(seg)]); L = s[-1]
    ss = _np.arange(0, L, step); closed = _np.vstack([dense, dense[:1]])
    pts = _np.stack([_np.interp(ss, s, closed[:, 0]), _np.interp(ss, s, closed[:, 1])], 1)
    # round the corners at the foul poles (Gaussian smoothing weighted by pole proximity)
    k = int(6*8/step); ker = _np.exp(-0.5*(_np.arange(-k, k+1)*step/8.0)**2); ker /= ker.sum()
    sm = _np.stack([_np.convolve(_np.concatenate([pts[-k:, c], pts[:, c], pts[:k, c]]), ker, 'valid') for c in (0, 1)], 1)
    dp = _np.minimum(_np.linalg.norm(pts-_np.array(POLE_R), axis=1), _np.linalg.norm(pts-_np.array(POLE_L), axis=1))
    w = _np.exp(-(dp/22.0)**2)[:, None]; pts = pts*(1-w) + sm*w
    t = _np.roll(pts, -1, 0) - _np.roll(pts, 1, 0); t /= _np.linalg.norm(t, axis=1, keepdims=True)
    n = _np.stack([-t[:, 1], t[:, 0]], 1)
    return pts, n, t, ss
