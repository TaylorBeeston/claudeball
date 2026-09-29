# Humanoid rig + skin-modifier body. Requires common.py exec'd. Blender axes: character faces -Y (= +Z game), left side = +X.
import bpy, math
from mathutils import Vector, Quaternion, Matrix
PFX = "mixamorig:"
def V(x, y, z): return Vector((x, y, z))
# name: (parent, head, tail)  -- left side defined for +X and mirrored programmatically
def joints():
    J = {}
    J["Hips"] = (None, V(0, 0, .96), V(0, 0, 1.03)); J["Spine"] = ("Hips", V(0, 0, 1.03), V(0, 0, 1.17))
    J["Spine1"] = ("Spine", V(0, 0, 1.17), V(0, 0, 1.33)); J["Spine2"] = ("Spine1", V(0, 0, 1.33), V(0, 0, 1.49))
    J["Neck"] = ("Spine2", V(0, 0, 1.49), V(0, 0, 1.585)); J["Head"] = ("Neck", V(0, 0, 1.585), V(0, 0, 1.85))
    d = V(.766, 0, -.643)
    for side, sx in (("Left", 1), ("Right", -1)):
        m = lambda v: V(v.x*sx, v.y, v.z)
        sh = V(.21, 0, 1.50); el = sh + d*.31; wr = el + d*.27; hd = wr + d*.19
        J[side+"Shoulder"] = ("Spine2", m(V(.03, 0, 1.49)), m(sh)); J[side+"Arm"] = (side+"Shoulder", m(sh), m(el))
        J[side+"ForeArm"] = (side+"Arm", m(el), m(wr)); J[side+"Hand"] = (side+"ForeArm", m(wr), m(hd))
        J[side+"UpLeg"] = ("Hips", m(V(.095, 0, .94)), m(V(.09, -.01, .52))); J[side+"Leg"] = (side+"UpLeg", m(V(.09, -.01, .52)), m(V(.09, 0, .085)))
        J[side+"Foot"] = (side+"Leg", m(V(.09, 0, .085)), m(V(.09, -.13, .03))); J[side+"ToeBase"] = (side+"Foot", m(V(.09, -.13, .03)), m(V(.09, -.235, .025)))
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

def skin_to_armature(body, arm):
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
