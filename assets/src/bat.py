exec(open(CB_SRC + "/common.py").read())
import bmesh, math
reset_scene()
L = 0.864  # 34 in
# (distance from knob [m], radius [m])
prof = [(0,0),(0.002,0.012),(0.008,0.0215),(0.016,0.0245),(0.026,0.0225),(0.040,0.0155),(0.06,0.0122),(0.10,0.0115),(0.20,0.0117),
        (0.30,0.0135),(0.40,0.0185),(0.50,0.0250),(0.58,0.0300),(0.66,0.0328),(0.74,0.0333),(0.80,0.0325),(0.845,0.0295),(0.858,0.0235),(0.864,0.0)]
def prof_r(d):
    for (d0,r0),(d1,r1) in zip(prof, prof[1:]):
        if d0 <= d <= d1: t=(d-d0)/(d1-d0); return r0+(r1-r0)*(t*t*(3-2*t) if d1-d0>0.05 else t)
    return 0
# densify profile
ds = sorted(set([p[0] for p in prof] + [i*L/60 for i in range(61)]))
S = 48
bm = bmesh.new(); uv = bm.loops.layers.uv.new("UVMap")
rings = []
for d in ds:
    r = max(prof_r(d), 0.0004)
    rings.append([bm.verts.new((r*math.cos(2*math.pi*k/S), r*math.sin(2*math.pi*k/S), d)) for k in range(S)])
for i in range(len(rings)-1):
    for k in range(S):
        f = bm.faces.new((rings[i][k], rings[i][(k+1)%S], rings[i+1][(k+1)%S], rings[i+1][k]))
        for lp, (kk, ii) in zip(f.loops, ((k,i),((k+1),i),((k+1),i+1),(k,i+1))):
            lp[uv].uv = (ds[ii]/0.25, kk/S)      # grain (texture u) runs along the bat; one texture turn round the circumference
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("bat_mesh"); bm.to_mesh(me); bm.free()
for p in me.polygons: p.use_smooth = True
bat = bpy.data.objects.new("bat", me); bpy.context.collection.objects.link(bat)
# wood texture: long grain along V (image y), ash-like
W, H = 512, 2048
rng = np.random.default_rng(5)
stretch = noise_tex(512, [4, 16, 64], 11)[:, :]
x = np.linspace(0, 1, W)[None, :]; y = np.linspace(0, 1, H)[:, None]
n1 = noise_tex(2048, [2, 8, 32, 128], 21)[:H, :W*1]; n1 = np.resize(n1, (H, W))
rings_t = np.sin((x*38 + 2.5*np.resize(noise_tex(512,[3,9],2),(H,W)) + 0.6*y)*2*math.pi)*0.5+0.5
fine = np.resize(noise_tex(1024, [64, 256, 512], 9), (H, W))
wood = 0.55*rings_t + 0.45*fine
base = np.array([0.80, 0.60, 0.36]); dark = np.array([0.52, 0.34, 0.17])
col = dark[None, None, :]*(1-wood[..., None]) + base[None, None, :]*wood[..., None]
# lower handle band darker (tape-free but stained), and a black-ish knob/handle tint region
alb = make_image("bat_albedo", col, path=ROOT+"/tex/bat_albedo.png")
nrm = make_image("bat_normal", height_to_normal(fine*0.6+rings_t*0.2, 2.0), 'Non-Color', ROOT+"/tex/bat_normal.png")
m = pbr_material("bat_wood", alb, nrm, rough=0.4, nstrength=0.4)
exec(open(CB_SRC + "/textures.py").read())
bpy.data.materials.remove(m)
me.materials.append(acg_pbr("bat_wood", acg("Wood049", gain=1.0), .45, .7))      # CC0 ambientCG wood photo (see CREDITS.md); replaces the procedural grain above
# axis: knob at origin, barrel toward +Z (Blender) => +Y up in glTF.
export([bat], ROOT+"/bat.glb", jpg=True)
result = {"len": L, "tris": len(me.polygons)*2}
