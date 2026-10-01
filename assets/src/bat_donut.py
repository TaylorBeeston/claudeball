# On-deck weighted donut: a steel ring (hole 59 mm over the 47-50 mm barrel, outer diameter 136 mm, 30 mm thick) with a rubber-coated outer band, placed on the bat.
# Same frame as bat.glb (knob at the origin, barrel along +Y in glTF = +Z in Blender), so the node `Bat_Donut` can simply be added to the bat's node (identity transform): it sits at s = 0.50 m.
# Run in Blender: exec after setting CB_SRC / ROOT (writes assets/bat_donut.glb).
exec(open(CB_SRC + "/common.py").read())
import bmesh, math
reset_scene()
S0 = .50; RI, RO, HT = .0295, .068, .015                # centre along the barrel, inner / outer radius, half thickness
def rr(c, n=5, r=.004, sx=1, sy=1):                      # rounded corner points
    return [(c[0] + sx*r*(1 - math.cos(math.pi/2*i/n)), c[1] + sy*r*(1 - math.sin(math.pi/2*i/n))) for i in range(n+1)]
prof = [(RI, S0 - HT + .001), (RI + .003, S0 - HT)] + [(RO - .006 + (p[0]-(RO-.006)), p[1]) for p in []]
prof = [(RI + .002, S0 - HT), (RO - .006, S0 - HT), (RO - .002, S0 - HT + .002), (RO, S0 - HT + .006), (RO, S0 + HT - .006), (RO - .002, S0 + HT - .002), (RO - .006, S0 + HT), (RI + .002, S0 + HT), (RI, S0 + HT - .002), (RI, S0 - HT + .002)]
bm = bmesh.new(); N = 64
rings = []
for (r, z) in prof:
    rings.append([bm.verts.new((r*math.cos(2*math.pi*k/N), r*math.sin(2*math.pi*k/N), z)) for k in range(N)])
uv = bm.loops.layers.uv.new("UVMap")
for i in range(len(rings)):
    a, b = rings[i], rings[(i + 1) % len(rings)]
    for k in range(N):
        f = bm.faces.new((a[k], a[(k+1) % N], b[(k+1) % N], b[k]))
        for lp, (kk, ii) in zip(f.loops, ((k, i), (k+1, i), (k+1, i+1), (k, i+1))): lp[uv].uv = (kk/N, ii/len(rings))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("donut_mesh"); bm.to_mesh(me); bm.free()
for p in me.polygons: p.use_smooth = True
o = bpy.data.objects.new("Bat_Donut", me); bpy.context.collection.objects.link(o)
# texture: dark steel with a lighter machined face and a rubber band (outer rim) in the V direction of the UV (profile order)
H, W = 256, 512
v = (np.arange(H)[:, None] + .5)/H; u = (np.arange(W)[None, :] + .5)/W
steel = np.array([.30, .31, .33]); rubber = np.array([.05, .05, .055])
rim = ((v > .30) & (v < .72))                                           # profile entries 3..6 = the outer cylinder
col = np.where(rim[..., None], rubber[None, None, :], steel[None, None, :])*np.ones((H, W, 1))
col = col*(0.9 + .1*noise_tex(512, [16, 64, 256], 4)[:H, :W, None])
# stamped weight mark: a pale band ring on the face
col = np.where(((v > .08) & (v < .12))[..., None], np.array([.75, .1, .08])[None, None, :], col)
alb = make_image("donut_albedo", np.clip(col, 0, 1), path=ROOT + "/tex/donut_albedo.png")
m = pbr_material("donut", alb, None, rough=.42, metal=.7); me.materials.append(m)
o["cb_group"] = "accessory"; o["cb_default"] = 1; o["cb_note"] = "weighted warm-up donut; add as a child of the bat node (identity transform), sits at s = 0.50 m from the knob"
export([o], ROOT + "/bat_donut.glb", jpg=True, export_extras=True)
result = {"tris": len(me.polygons)*2}
