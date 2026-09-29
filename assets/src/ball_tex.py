"""Bakes the baseball leather albedo + normal atlas (3x2 padded cube-face cells) with numpy only; run OUTSIDE Blender: python3 src/ball_tex.py assets/
The 3D grain / raised seam is evaluated from each texel's sphere direction, so it is continuous across the cube-sphere edges. ball.py loads the PNGs."""
import numpy as np, math, sys, os
from PIL import Image
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
R = 0.0369; CELL, PAD = 512, 12
FACE_AX = [(0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1)]
def face_dir(fi, a, b):
    ax, sg = FACE_AX[fi]; wa, wb = np.tan(np.asarray(a)*np.pi/4), np.tan(np.asarray(b)*np.pi/4)
    o = [(1, 2), (0, 2), (0, 1)][ax]; c = [None]*3; c[ax] = np.full_like(wa, float(sg)); c[o[0]] = wa; c[o[1]] = wb
    v = np.stack(c, -1); return v/np.linalg.norm(v, axis=-1, keepdims=True)
b_ = 0.4; N = 864
t = 2*np.pi*np.arange(N)/N
P = np.stack([(1-b_)*np.cos(t)+b_*np.cos(3*t), (1-b_)*np.sin(t)-b_*np.sin(3*t), 2*math.sqrt(b_*(1-b_))*np.sin(2*t)], 1); P /= np.linalg.norm(P, axis=1)[:, None]
# ---- textures (3D value noise -> seamless across the cube-sphere edges)
rng = np.random.default_rng(7)
def vnoise(d, freq, seed):
    g = np.random.default_rng(seed).random((17, 17, 17)).astype(np.float64); p = (d*.5+.5)*freq; i = np.floor(p).astype(int); f = p-i; f = f*f*(3-2*f)
    def G(dx, dy, dz): return g[(i[..., 0]+dx) % 17, (i[..., 1]+dy) % 17, (i[..., 2]+dz) % 17]
    x, y, z = f[..., 0], f[..., 1], f[..., 2]
    c00 = G(0, 0, 0)*(1-x)+G(1, 0, 0)*x; c10 = G(0, 1, 0)*(1-x)+G(1, 1, 0)*x; c01 = G(0, 0, 1)*(1-x)+G(1, 0, 1)*x; c11 = G(0, 1, 1)*(1-x)+G(1, 1, 1)*x
    return (c00*(1-y)+c10*y)*(1-z)+(c01*(1-y)+c11*y)*z
def seam_dist(d):
    flat = d.reshape(-1, 3); out = np.empty(len(flat))
    for s in range(0, len(flat), 16000):
        out[s:s+16000] = np.arccos(np.clip((flat[s:s+16000] @ P.T).max(1), -1, 1))*R
    return out.reshape(d.shape[:-1])
W = CELL+2*PAD; ab = (np.arange(W)+.5)/W*2-1
A, Bm = np.meshgrid(ab, ab)                                           # rows = b (v), cols = a (u)
def height(d, sd):
    grain = vnoise(d, 190, 1)*.55 + vnoise(d, 420, 2)*.3 + vnoise(d, 900, 3)*.15                 # fine leather grain
    ridge = np.exp(-(sd/0.0016)**2)                                                                # raised seam welt
    pore = np.exp(-(np.clip(sd-0.0026, 0, None)/0.0006)**2)*(sd > 0.0026)                          # tiny puckering beside the stitches
    return 0.00010*grain + 0.00055*ridge + 0.00006*pore*grain
px = R*(math.pi/4)*(2/W)                                              # metres per texel at the face centre
atlas_a = np.zeros((2*W, 3*W, 3), np.float32); atlas_n = np.zeros((2*W, 3*W, 3), np.float32)
for fi in range(6):
    d = face_dir(fi, A, Bm); sd = seam_dist(d); h = height(d, sd); gy, gx = np.gradient(h, px)
    n = np.stack([-gx, -gy, np.ones_like(h)], -1); n /= np.linalg.norm(n, axis=-1, keepdims=True)
    mott = vnoise(d, 9, 5)*.5 + vnoise(d, 40, 6)*.5
    alb = np.array([.87, .855, .81])[None, None, :]*(.955 + .07*mott[..., None])
    alb = alb*(1 - .08*np.exp(-((sd-0.0021)/0.0007)**2)[..., None]) * (1 + .04*np.exp(-(sd/0.0012)**2)[..., None])
    cx, cy = fi % 3, fi // 3; atlas_a[cy*W:(cy+1)*W, cx*W:(cx+1)*W] = alb; atlas_n[cy*W:(cy+1)*W, cx*W:(cx+1)*W] = n*.5+.5

def save(name, arr): Image.fromarray((np.clip(arr, 0, 1)*255+.5).astype(np.uint8)).save(os.path.join(OUT, "tex", name))
os.makedirs(os.path.join(OUT, "tex"), exist_ok=True)
save("ball_albedo.png", atlas_a[::-1]); save("ball_normal.png", atlas_n[::-1])      # PNG row 0 = top; Blender/glTF v=0 is the bottom row of the atlas arrays
