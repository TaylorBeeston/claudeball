exec(open(CB_SRC + "/common.py").read())
import bmesh, math
from mathutils import Vector
reset_scene()
# Baseball: 73.8 mm leather sphere + real figure-8 (two-piece) seam with 108 red V-stitches.
# Mesh = quad-sphere (cube projected on a sphere) => no pole pinching; UV = 3x2 atlas, one cell per cube face (equal-angle mapping, padded cells).
# Leather grain / raised seam / normal map are evaluated from the 3D direction of every texel, so the pattern is continuous across the cube edges.
R = 0.0369
CELL, PAD = 512, 12
FACE_AX = [(0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1)]        # (axis, sign) of the six cube faces
def face_dir(fi, a, b):
    """cube-face coords a,b in [-1,1] -> unit direction (equal-angle warp)."""
    ax, sg = FACE_AX[fi]; wa, wb = np.tan(np.asarray(a)*np.pi/4), np.tan(np.asarray(b)*np.pi/4)
    o = [(1, 2), (0, 2), (0, 1)][ax]; c = [None]*3; c[ax] = np.full_like(wa, float(sg)); c[o[0]] = wa; c[o[1]] = wb
    v = np.stack(c, -1); return v/np.linalg.norm(v, axis=-1, keepdims=True)
def cell_uv(fi, a, b):
    cx, cy = fi % 3, fi // 3; s = CELL/(CELL+2*PAD)          # inner square of the padded cell
    u = (cx + .5 + .5*a*s)/3.0; v = (cy + .5 + .5*b*s)/2.0; return u, v

# ---- mesh
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=23, use_grid_fill=True)
OAX = [(1, 2), (0, 2), (0, 1)]
for v in bm.verts:                                                   # cube point -> equal-angle sphere point
    d = np.array(v.co[:]); ax = int(np.argmax(np.abs(d))); o = OAX[ax]
    a, b = 4/math.pi*math.atan(d[o[0]]/abs(d[ax])), 4/math.pi*math.atan(d[o[1]]/abs(d[ax]))
    v.co = Vector(face_dir(FACE_AX.index((ax, 1 if d[ax] > 0 else -1)), a, b)*R)
me = bpy.data.meshes.new("ball_mesh"); bm.to_mesh(me); bm.free()
ball = bpy.data.objects.new("ball", me); bpy.context.collection.objects.link(ball)
for p in me.polygons: p.use_smooth = True
uvl = me.uv_layers.new(name="UVMap")                                 # per-face-cell UVs, so vertices on cube edges get one UV per face
for p in me.polygons:
    nrm = np.array(p.center[:]); ax = int(np.argmax(np.abs(nrm))); fi = FACE_AX.index((ax, 1 if nrm[ax] > 0 else -1)); o = OAX[ax]
    for li in p.loop_indices:
        d = np.array(me.vertices[me.loops[li].vertex_index].co[:]); d = d/np.linalg.norm(d)
        a, b = 4/math.pi*math.atan(d[o[0]]/abs(d[ax])), 4/math.pi*math.atan(d[o[1]]/abs(d[ax]))
        uvl.data[li].uv = cell_uv(fi, a, b)

# ---- seam curve (baseball / tennis-ball curve) and its arc-length parametrisation
b_ = 0.4; N = 864
pts = []
for i in range(N):
    t = 2*math.pi*i/N
    v = Vector(((1-b_)*math.cos(t)+b_*math.cos(3*t), (1-b_)*math.sin(t)-b_*math.sin(3*t), 2*math.sqrt(b_*(1-b_))*math.sin(2*t)))
    pts.append(v.normalized())
P = np.array([p[:] for p in pts]); seg = np.linalg.norm(np.roll(P, -1, 0)-P, axis=1)*R; cum = np.concatenate([[0], np.cumsum(seg)]); Lseam = cum[-1]

# ---- textures: baked outside Blender by `python3 src/ball_tex.py assets/` (numpy, ~1-3 min); ball_tex.py must have been run first
alb_img = bpy.data.images.load(ROOT+"/tex/ball_albedo.png"); alb_img.pack(); alb_img.colorspace_settings.name = 'sRGB'
nrm_img = bpy.data.images.load(ROOT+"/tex/ball_normal.png"); nrm_img.colorspace_settings.name = 'Non-Color'; nrm_img.pack()
leather = pbr_material("ball_leather", alb_img, nrm_img, rough=0.62, nstrength=1.0)
me.materials.append(leather)
# ---- stitches: 108 V-stitches (two short slanted threads per stitch, converging on the seam)
red = bpy.data.materials.new("ball_thread"); red.use_nodes = True
red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.60, 0.02, 0.03, 1)
red.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.75
sm = bmesh.new(); K = 108
def surf(p, lift): return p.normalized()*(R+lift)
def add_thread(bm, pts3, r, seg=6):
    rings = []
    for j, p in enumerate(pts3):
        t = (pts3[min(j+1, len(pts3)-1)]-pts3[max(j-1, 0)]).normalized(); nrm = p.normalized(); x = t.cross(nrm).normalized(); y = t.cross(x)
        rings.append([bm.verts.new(p + (x*math.cos(2*math.pi*k/seg)+y*math.sin(2*math.pi*k/seg))*r) for k in range(seg)])
    for j in range(len(rings)-1):
        for k in range(seg): bm.faces.new((rings[j][k], rings[j][(k+1) % seg], rings[j+1][(k+1) % seg], rings[j+1][k]))
def seam_at(s):
    s = s % Lseam; i = int(np.searchsorted(cum, s, side='right')-1) % N; fr = (s-cum[i])/max(seg[i], 1e-9)
    p = pts[i].lerp(pts[(i+1) % N], fr).normalized(); q = pts[(i+2) % N]; tang = (pts[(i+1) % N]-pts[i]).normalized(); return p, tang
for i in range(K):
    p, tang = seam_at((i+.5)*Lseam/K)
    side = p.cross(tang).normalized()
    for s in (-1, 1):
        o = [surf(p*R + side*(s*d_) + tang*t_, dz) for d_, t_, dz in ((.0031, -.0009, .0002), (.0017, -.0002, .0003), (.0004, .0006, .0002))]
        add_thread(sm, o, .00042)
sme = bpy.data.meshes.new("ball_stitch_mesh"); sm.to_mesh(sme); sm.free()
st = bpy.data.objects.new("ball_stitches", sme); bpy.context.collection.objects.link(st)
for p in sme.polygons: p.use_smooth = True
sme.materials.append(red)
me.update(); st.parent = ball
export([ball, st], ROOT+"/ball.glb", jpg=True)
result = {"tris": len(me.polygons)*2 + len(sme.polygons)*2, "dia_mm": R*2000, "seam_len_mm": round(Lseam*1000, 1), "stitch_pitch_mm": round(Lseam*1000/K, 2)}
