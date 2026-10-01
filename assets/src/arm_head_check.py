# Real-mesh clearance of the arms from the head, helmet and neck, per frame (run in Blender after player_build.py, scene still open).
#   head_clearance(clips, morphs)    -> {clip: (min distance m, frame, arm vertex group)} ; distance = arm sleeve / skin vertex to the evaluated head+helmet+hair surface (negative = inside)
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
def _bvh(objs, dg):
    bm = bmesh.new()
    for o in objs:
        ev = o.evaluated_get(dg); me = ev.to_mesh(); tmp = bmesh.new(); tmp.from_mesh(me); tmp.transform(ev.matrix_world); ev.to_mesh_clear()
        off = len(bm.verts); vs = [bm.verts.new(v.co) for v in tmp.verts]
        for f in tmp.faces: bm.faces.new([vs[v.index] for v in f.verts])
        tmp.free()
    t = BVHTree.FromBMesh(bm); bm.free(); return t
def _arm_vertex_ids(obj, names, w=.5):
    idx = {vg.index: vg.name for vg in obj.vertex_groups}; out = {}
    for v in obj.data.vertices:
        for g in v.groups:
            n = idx[g.group]
            if g.weight > w and any(n.endswith(s) for s in names): out[v.index] = n
    return out
def set_morphs(names, value=1.0, others_zero=True):
    for o in bpy.data.objects:
        sk = getattr(o.data, "shape_keys", None) if o.type == 'MESH' else None
        if not sk: continue
        for kb in sk.key_blocks:
            if kb.name == "Basis": continue
            if kb.name in ("head_narrow", "head_wide", "jaw_square", "nose_large", "ears_large", "brow_heavy", "chin_strong", "cheeks_full", "nose_narrow", "eyes_deep", "hair_under_cap"): kb.value = value if kb.name in names else 0.0
def head_clearance(clips, morphs=(), skin="Body_Skin", sleeve="Jersey", head_objs=("Head", "Gear_Helmet"), step=1):
    arm = bpy.data.objects["Armature"]; set_morphs(morphs); out = {}
    verts = {}
    for nm in (skin, sleeve):
        o = bpy.data.objects[nm]; ids = _arm_vertex_ids(o, ("LeftArm", "LeftForeArm", "RightArm", "RightForeArm")); verts[nm] = (o, ids)
    for c in clips:
        act = bpy.data.actions[c]; arm.animation_data.action = act
        try: arm.animation_data.action_slot = arm.animation_data.action_suitable_slots[0]
        except Exception: pass
        f0, f1 = int(act.frame_range[0]), int(act.frame_range[1]); worst = (9.0, None, None)
        for f in range(f0, f1 + 1, step):
            bpy.context.scene.frame_set(f); dg = bpy.context.evaluated_depsgraph_get(); dg.update()
            T = _bvh([bpy.data.objects[n] for n in head_objs], dg)
            for nm, (o, ids) in verts.items():
                ev = o.evaluated_get(dg); me = ev.to_mesh(); M = ev.matrix_world
                for i, g in ids.items():
                    p = M @ me.vertices[i].co; loc, n_, _, d = T.find_nearest(p)
                    if loc is None: continue
                    sd = d if (p - loc).dot(n_) >= 0 else -d
                    if sd < worst[0]: worst = (sd, f, g)
                ev.to_mesh_clear()
        out[c] = (round(worst[0], 4), worst[1], worst[2])
    set_morphs(())
    return out
