# Ball-in-hand / ball-in-glove fit report (run in Blender after player_build.py, scene still open). Per frame of a clip it measures the ball (radius 36.9 mm) centred on
# Ball_Grip / Ball_Grip_2Seam against the evaluated claw hand mesh (Hand_R_Ball), and Glove_Pocket against the evaluated glove:
#   gap_mm     = distance from the ball surface to the nearest hand / glove vertex (negative = penetration)
#   contacts   = hand vertices within 3.5 mm of the ball surface (finger pads + thumb)
#   pads       = per digit distance from the ball surface to that digit's fingertip pad (claw hand: index, middle, ring, pinky, thumb)
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
RB = 0.0369
def _bvh(obj, dg):
    ev = obj.evaluated_get(dg); me = ev.to_mesh(); bm = bmesh.new(); bm.from_mesh(me); bm.transform(ev.matrix_world); ev.to_mesh_clear()
    t = BVHTree.FromBMesh(bm); vs = [v.co.copy() for v in bm.verts]; bm.free(); return t, vs
def hand_ball_report(clips, frame_ranges=None, grips=("Ball_Grip", "Ball_Grip_2Seam"), hand="Hand_R_Ball"):
    arm = bpy.data.objects["Armature"]; out = {}
    for nm in clips:
        act = bpy.data.actions[nm]; arm.animation_data.action = act
        try: arm.animation_data.action_slot = arm.animation_data.action_suitable_slots[0]
        except Exception: pass
        f0, f1 = (frame_ranges or {}).get(nm, (int(act.frame_range[0]), int(act.frame_range[1]))); worst = {g: [9.0, None, 999] for g in grips}
        for f in range(f0, f1 + 1):
            bpy.context.scene.frame_set(f); dg = bpy.context.evaluated_depsgraph_get(); dg.update(); bvh, vs = _bvh(bpy.data.objects[hand], dg)
            for g in grips:
                c = bpy.data.objects[g].evaluated_get(dg).matrix_world.translation
                _, _, _, d = bvh.find_nearest(c); gap = d - RB; cont = sum(1 for v in vs if abs((v - c).length - RB) < .0035)
                if abs(gap) < abs(worst[g][0]): worst[g][:2] = [gap, f]
                worst[g][2] = min(worst[g][2], cont)
        out[nm] = {g: dict(gap_mm=round(v[0]*1000, 1), at=v[1], min_contacts=v[2]) for g, v in worst.items()}
    return out
def glove_ball_report(kinds=None):
    arm = bpy.data.objects["Armature"]; res = {}
    for kind, (glove, pocket) in (kinds or {"infield": ("Gear_Glove", "Glove_Pocket"), "outfield": ("Gear_Glove_Outfield", "Glove_Pocket_Outfield"), "firstbase": ("Gear_Glove_FirstBase", "Glove_Pocket_FirstBase"),
                                            "catcher": ("Gear_Glove_Catcher", "Glove_Pocket_Catcher")}).items():
        res[kind] = {}
        for state, vals in (("open", (1, 0)), ("neutral", (0, 0)), ("closed", (0, 1))):
            for o in bpy.data.objects:
                sk = getattr(o.data, "shape_keys", None) if o.type == 'MESH' else None
                if sk and "glove_open" in sk.key_blocks: sk.key_blocks["glove_open"].value = vals[0]; sk.key_blocks["glove_closed"].value = vals[1]
            bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get(); bvh, vs = _bvh(bpy.data.objects[glove], dg)
            c = bpy.data.objects[pocket].evaluated_get(dg).matrix_world.translation; _, _, _, d = bvh.find_nearest(c); res[kind][state] = round((d - RB)*1000, 1)
    for o in bpy.data.objects:
        sk = getattr(o.data, "shape_keys", None) if o.type == 'MESH' else None
        if sk and "glove_open" in sk.key_blocks: sk.key_blocks["glove_open"].value = 0; sk.key_blocks["glove_closed"].value = 0
    return res
