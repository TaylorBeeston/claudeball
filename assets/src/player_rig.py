# Humanoid rig + skin-modifier body. Requires common.py exec'd. Blender axes: character faces -Y (= +Z game), left side = +X.
import bpy, math
from mathutils import Vector, Quaternion, Matrix
PFX = "mixamorig:"
def V(x, y, z): return Vector((x, y, z))
# name: (parent, head, tail)  -- left side defined for +X and mirrored programmatically
def joints():
    J = {}
    J["Hips"] = (None, V(0, 0, .95), V(0, 0, 1.02)); J["Spine"] = ("Hips", V(0, 0, 1.02), V(0, 0, 1.16))
    J["Spine1"] = ("Spine", V(0, 0, 1.16), V(0, 0, 1.32)); J["Spine2"] = ("Spine1", V(0, 0, 1.32), V(0, 0, 1.47))
    J["Neck"] = ("Spine2", V(0, 0, 1.47), V(0, 0, 1.58)); J["Head"] = ("Neck", V(0, 0, 1.58), V(0, 0, 1.84))
    d = V(.766, 0, -.643)
    for side, sx in (("Left", 1), ("Right", -1)):
        m = lambda v: V(v.x*sx, v.y, v.z)
        sh = V(.20, 0, 1.45); el = sh + d*.30; wr = el + d*.27; hd = wr + d*.19
        J[side+"Shoulder"] = ("Spine2", m(V(.03, 0, 1.44)), m(sh)); J[side+"Arm"] = (side+"Shoulder", m(sh), m(el))
        J[side+"ForeArm"] = (side+"Arm", m(el), m(wr)); J[side+"Hand"] = (side+"ForeArm", m(wr), m(hd))
        J[side+"UpLeg"] = ("Hips", m(V(.09, 0, .93)), m(V(.09, -.01, .50))); J[side+"Leg"] = (side+"UpLeg", m(V(.09, -.01, .50)), m(V(.09, 0, .08)))
        J[side+"Foot"] = (side+"Leg", m(V(.09, 0, .08)), m(V(.09, -.13, .03))); J[side+"ToeBase"] = (side+"Foot", m(V(.09, -.13, .03)), m(V(.09, -.22, .025)))
    return J
JOINTS = joints()
ORDER = list(JOINTS.keys())

def build_armature():
    arm = bpy.data.armatures.new("Armature"); ob = bpy.data.objects.new("Armature", arm); bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True); bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for n in ORDER:
        p, h, t = JOINTS[n]; b = arm.edit_bones.new(PFX+n); b.head, b.tail = h, t
        b.roll = 0.0
        eb[n] = b
    for n in ORDER:
        p = JOINTS[n][0]
        if p: eb[n].parent = eb[p]; eb[n].use_connect = (eb[n].head - eb[p].tail).length < 1e-4
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob

def build_body():
    S = []  # (name-less) skeleton vertices: (pos, (rx, ry)), edges by index
    verts, radii, edges = [], [], []
    def add(p, r, link=None):
        verts.append(p); radii.append(r); i = len(verts)-1
        if link is not None: edges.append((link, i))
        return i
    pel = add(V(0, 0, .98), (.18, .115)); wai = add(V(0, 0, 1.13), (.16, .105), pel); che = add(V(0, 0, 1.29), (.195, .125), wai)
    upc = add(V(0, 0, 1.41), (.20, .115), che); nk = add(V(0, 0, 1.53), (.052, .055), upc); hd0 = add(V(0, 0.0, 1.62), (.06, .07), nk)
    for sx in (1, -1):
        m = lambda v: V(v.x*sx, v.y, v.z)
        sh = add(m(V(.20, 0, 1.44)), (.068, .066), upc); el = add(m(V(.43, 0, 1.257)), (.052, .052), sh)
        wr = add(m(V(.637, 0, 1.083)), (.040, .036), el); hn = add(m(V(.72, 0, 1.01)), (.052, .028), wr); hn2 = add(m(V(.78, 0, .96)), (.042, .024), hn)
        hp = add(m(V(.09, 0, .90)), (.115, .115), pel); kn = add(m(V(.09, -.01, .50)), (.072, .075), hp); an = add(m(V(.09, 0, .10)), (.050, .052), kn)
        ball = add(m(V(.09, -.11, .045)), (.05, .045), an); toe = add(m(V(.09, -.21, .032)), (.045, .034), ball)
    me = bpy.data.meshes.new("Body"); me.from_pydata([tuple(v) for v in verts], edges, [])
    o = bpy.data.objects.new("Body", me); bpy.context.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    sk = o.modifiers.new("Skin", 'SKIN'); sk.branch_smoothing = 0.6; sk.use_smooth_shade = True
    o.modifiers.new("Sub", 'SUBSURF').levels = 2
    me.skin_vertices[0].data[pel].use_root = True
    for i, r in enumerate(radii): me.skin_vertices[0].data[i].radius = r
    dg = bpy.context.evaluated_depsgraph_get(); ev = o.evaluated_get(dg); nm = bpy.data.meshes.new_from_object(ev)
    o.modifiers.clear(); o.data = nm
    for p in nm.polygons: p.use_smooth = True
    return o

def add_head(body):
    import bmesh
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=1.0)
    for v in bm.verts: v.co = Vector((v.co.x*.092, v.co.y*.108, v.co.z*.125 + (0.10*max(0, -v.co.y) if False else 0)))
    for v in bm.verts:                                   # jaw taper + brow/nose hint
        if v.co.z < 0: v.co.x *= 1.0 + v.co.z*2.0*0.35; v.co.y *= 1.0 + v.co.z*2.0*0.2
    bmesh.ops.translate(bm, vec=(0, -0.008, 1.725), verts=bm.verts)
    me = bpy.data.meshes.new("HeadTmp"); bm.to_mesh(me); bm.free()
    h = bpy.data.objects.new("HeadTmp", me); bpy.context.collection.objects.link(h)
    bpy.ops.object.select_all(action='DESELECT'); h.select_set(True); body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    return body

def skin_to_armature(body, arm):
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
