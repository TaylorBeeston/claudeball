exec(open(CB_SRC + "/common.py").read())
import bmesh, math
from mathutils import Vector
reset_scene()
R = 0.0369  # 73.8 mm diameter
bm = bmesh.new(); bm.loops.layers.uv.new('UVMap'); bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=R, calc_uvs=True)
me = bpy.data.meshes.new("ball_mesh"); bm.to_mesh(me); bm.free()
ball = bpy.data.objects.new("ball", me); bpy.context.collection.objects.link(ball)
for p in me.polygons: p.use_smooth = True
# textures
n = 1024
lea = noise_tex(n, [8, 32, 128, 256], 3)
albedo = np.stack([0.86+0.06*lea, 0.84+0.06*lea, 0.78+0.06*lea], -1)
alb = make_image("ball_albedo", albedo, path=ROOT+"/tex/ball_albedo.png")
nrm = make_image("ball_normal", height_to_normal(lea, 6.0), 'Non-Color', ROOT+"/tex/ball_normal.png")
leather = pbr_material("ball_leather", alb, nrm, rough=0.55, nstrength=0.6)
me.materials.append(leather)
# seam curve (baseball / tennis-ball curve), sits just on the surface
b = 0.4; N = 216
pts = []
for i in range(N):
    t = 2*math.pi*i/N
    v = Vector(((1-b)*math.cos(t)+b*math.cos(3*t), (1-b)*math.sin(t)-b*math.sin(3*t), 2*math.sqrt(b*(1-b))*math.sin(2*t)))
    pts.append(v.normalized()*R)
red = bpy.data.materials.new("ball_thread"); red.use_nodes = True
red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.62, 0.02, 0.03, 1)
red.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8
sm = bmesh.new()
# stitches: 108 V-stitches -> two short slanted tubes per stitch, straddling the seam
K = 108
def add_tube(bm, a, c, r=0.00035, seg=5):
    d = c-a; z = d.normalized(); x = z.cross(Vector((0.3, 0.5, 0.8))).normalized(); y = z.cross(x)
    ring0, ring1 = [], []
    for k in range(seg):
        ang = 2*math.pi*k/seg; off = (x*math.cos(ang)+y*math.sin(ang))*r
        ring0.append(bm.verts.new(a+off)); ring1.append(bm.verts.new(c+off))
    for k in range(seg):
        bm.faces.new((ring0[k], ring0[(k+1) % seg], ring1[(k+1) % seg], ring1[k]))
for i in range(K):
    f = i*N/K; i0 = int(f) % N; fr = f-int(f)
    p = pts[i0].lerp(pts[(i0+1) % N], fr).normalized()*R
    q = pts[(i0+1) % N]; tang = (q-pts[i0]).normalized()
    side = p.normalized().cross(tang).normalized()
    for s in (-1, 1):
        a = (p+side*s*0.0016).normalized()*(R+0.0002)
        c = (p+side*s*0.0004+tang*0.0011).normalized()*(R+0.0004)
        # V stitch: outer end back, inner end forward
        a2 = (p+side*s*0.0034-tang*0.0004).normalized()*(R+0.0002)
        add_tube(sm, a2, (p+side*s*0.0006+tang*0.0008).normalized()*(R+0.0002))
sme = bpy.data.meshes.new("ball_stitch_mesh"); sm.to_mesh(sme); sm.free()
st = bpy.data.objects.new("ball_stitches", sme); bpy.context.collection.objects.link(st)
for p in sme.polygons: p.use_smooth = True
sme.materials.append(red)
# thin raised seam ridge (leather seam) via displacing verts near the curve
me.update()
st.parent = ball
export([ball, st], ROOT+"/ball.glb", jpg=True)
result = {"tris": len(me.polygons)*2 + len(sme.polygons)*2, "dia_mm": R*2000}
