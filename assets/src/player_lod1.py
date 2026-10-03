# LOD1 puppets (far / small on screen): ONE skinned mesh per look group instead of ~30 meshes, no morph targets, no animations (bone names are identical to the
# LOD0 files: drive them with the LOD0 clips), simplified geometry, textures at 512 px after the optimize step.
#   Body   (material `skin`, atlas + normal/ORM like LOD0): Body_Skin + Head + the visible hands, decimated
#   Cloth  (material `lod_cloth`, no texture): jersey / pants / socks / undershirt / cap or helmet / piping / cleats / belt / glove ..., team colours in COLOR_0 and the
#          region of every vertex in the custom attribute `_REGION` (palette in the manifest): the engine recolours by rewriting COLOR_0 from `_REGION` once per team
#   Gear_Hair (material `hair`, alpha cards, tint with baseColorFactor like LOD0) and, when the file has jersey decals, Jersey_BackNumberDecal (own material).
# Requires player_cloth.py (rig) exec'd; called from player_build.py inside the variants loop (objects renamed for the role file).
import bpy, bmesh, numpy as np, re
from mathutils import Vector

REGION = {"uniform_jersey": 0, "jacket": 0, "uniform_pants": 1, "uniform_socks": 2, "uniform_undershirt": 3, "cap": 4, "helmet": 4, "piping": 5, "cleats": 6, "belt": 6, "sole": 6, "mask": 6, "mask_pad": 6, "catcher_gear": 6,
          "glove": 7, "glove_laces": 7, "batting_glove": 10, "wristband": 11, "arm_sleeve": 11, "cap_logo": 12, "button": 8, "laces": 8, "buckle": 9, "spikes": 9}
PALETTE = {0: (.8, .8, .8), 1: (.75, .75, .75), 2: (.05, .08, .3), 3: (.05, .08, .3), 4: (.05, .08, .3), 5: (.05, .08, .3), 6: (.02, .02, .02), 7: (.28, .14, .07), 8: (.9, .9, .85), 9: (.6, .6, .62), 10: (.03, .03, .035), 11: (.9, .9, .9), 12: (.96, .96, .96)}
REGION_NAMES = {0: "jersey / jacket", 1: "pants", 2: "socks", 3: "undershirt", 4: "cap / helmet", 5: "piping", 6: "black leather, belt, soles, masks, catcher gear", 7: "glove", 8: "buttons / laces (white)", 9: "buckle / spikes (metal)", 10: "batting gloves", 11: "wristbands / arm sleeves", 12: "logo"}
SKIP = re.compile(r"^(Eyes|Eyes_Cornea|Gear_Eyebrows|Gear_Eyelashes|Gear_Teeth|Gear_Tongue|Gear_Number_|Jersey_(BackName|BackNumber|FrontNumber|SleeveNumber)Decal|Gear_Spikes|Gear_Soles|Gear_Buttons|Gear_BeltBuckle|Gear_Laces|Gear_Glove.*[Ll]aces|Gear_EyeBlack|Gear_Beard|Gear_Mustache|Gear_Goatee|Gear_CapLogo|Gear_HelmetLogo|Elbow|Umpire_Broom|Ball_Bag|Gear_LineupCard)")
def _ratio(n):
    if n == "Body_Skin": return .20
    if n == "Head": return .17
    if n.startswith("Hand_"): return .12
    if n.startswith("Gear_Glove") or n.startswith("Gear_BattingGlove"): return .07
    if n == "Cleats": return .07
    if n.startswith(("Jersey", "Pants", "Shorts", "Socks", "Undershirt", "Gear_Jacket")): return .18
    if n in ("Gear_Cap", "Gear_Helmet"): return .38
    if n.startswith("Gear_Hair"): return .5
    if n.startswith(("Gear_CatcherMask", "Gear_UmpireMask")): return .35
    return .40
def _mat_name(o):
    m = o.active_material; return re.sub(r"\.\d+$", "", m.name) if m else ""
def _decimated_copy(o, ratio, dg_holder):
    tmp = o.copy(); tmp.data = o.data.copy(); bpy.context.collection.objects.link(tmp)
    # shape keys stay: the evaluated mesh below bakes the current mix (hair_under_cap = 1 squashes the hair under the cap / helmet; a manager / ball kid build is kept)
    for md in list(tmp.modifiers): tmp.modifiers.remove(md)
    if ratio < 1.0:
        d = tmp.modifiers.new("D", 'DECIMATE'); d.ratio = ratio; d.use_collapse_triangulate = True
    bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get(); ev = tmp.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    bpy.data.objects.remove(tmp, do_unlink=True)
    n = bpy.data.objects.new(o.name.replace("__src", "") + "_lod1", me); bpy.context.collection.objects.link(n)
    for vg in o.vertex_groups: n.vertex_groups.new(name=vg.name)
    n.matrix_world = o.matrix_world.copy(); return n
def _paint(n, region, white=False):
    me = n.data
    for nm in ("Color", "_REGION"):
        for coll in (me.color_attributes, me.attributes):
            if nm in coll: coll.remove(coll[nm])
    ca = me.color_attributes.new("Color", 'FLOAT_COLOR', 'POINT'); col = (1, 1, 1) if white else PALETTE.get(region, (.5, .5, .5))
    ca.data.foreach_set("color", np.tile(np.array([*col, 1.0], np.float32), len(me.vertices)))
    ra = me.attributes.new("_REGION", 'FLOAT', 'POINT'); ra.data.foreach_set("value", np.full(len(me.vertices), float(region), np.float32))
def _join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join(); j = bpy.context.view_layer.objects.active; j.name = name; j.data.name = name; return j
def _cloth_material():
    m = bpy.data.materials.get("lod_cloth")
    if m: return m
    m = bpy.data.materials.new("lod_cloth"); m.use_nodes = True; nt = m.node_tree; b = nt.nodes["Principled BSDF"]; ca = nt.nodes.new("ShaderNodeVertexColor"); ca.layer_name = "Color"
    nt.links.new(ca.outputs["Color"], b.inputs["Base Color"]); b.inputs["Roughness"].default_value = .85; b.inputs["Metallic"].default_value = 0.0; m.use_backface_culling = False; return m

def _shrink_copy(o, target, offset=.0015):
    """Copy of `o` projected onto `target` (+offset along the normal): keeps a decal on the decimated cloth."""
    tmp = o.copy(); tmp.data = o.data.copy(); bpy.context.collection.objects.link(tmp)
    for md in list(tmp.modifiers): tmp.modifiers.remove(md)
    sw = tmp.modifiers.new("S", 'SHRINKWRAP'); sw.target = target; sw.wrap_method = 'NEAREST_SURFACEPOINT'; sw.wrap_mode = 'OUTSIDE_SURFACE'; sw.offset = offset
    bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get(); ev = tmp.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg); bpy.data.objects.remove(tmp, do_unlink=True)
    n = bpy.data.objects.new(o.name.replace('__src', ''), me); bpy.context.collection.objects.link(n)
    for vg in o.vertex_groups: n.vertex_groups.new(name=vg.name)
    n.matrix_world = o.matrix_world.copy(); n.data.materials.clear(); n.data.materials.append(o.active_material); return n
def make_lod1(vn, sel, dflt, arm, ROOT):
    """Build and export players/lod1/<vn>.glb from the objects in `sel` that are visible by default. Returns (path, tris, draw calls)."""
    meshes = [o for o in sel if o.type == 'MESH' and o.name in dflt and not SKIP.match(o.name)]
    glove_on = any(o.name.startswith("Gear_Glove") for o in meshes)
    meshes = [o for o in meshes if not (glove_on and o.name == "Hand_L")]                      # the hand inside the glove is never seen
    body, cloth, hair, keep = [], [], [], []
    RN = [(o, o.name) for o in sel if o.type == 'MESH' and (o.name.startswith("Gear_Hair") or o.name == "Jersey_BackNumberDecal")]          # free the names for the merged objects
    for o, nm in RN: o.name = nm + "__src"
    for o in meshes:
        n = _decimated_copy(o, _ratio(o.name), None); mat = _mat_name(o)
        if o.name in ("Body_Skin", "Head") or o.name.startswith("Hand_"):
            n.data.materials.clear(); n.data.materials.append(o.active_material); body.append(n)
        elif o.name.startswith("Gear_Hair"):
            n.data.materials.clear(); n.data.materials.append(o.active_material); hair.append(n)
        else:
            _paint(n, REGION.get(mat, 6)); n.data.materials.clear(); n.data.materials.append(_cloth_material()); cloth.append(n)
    out = []
    for grp, nm in ((body, "Body"), (cloth, "Cloth"), (hair, "Gear_Hair")):
        if grp: j = _join(grp, nm); rig(j, arm); out.append(j)
    decal0 = next((o for o in sel if o.name == "Jersey_BackNumberDecal__src" and "Jersey_BackNumberDecal" in dflt), None); decal = None
    if decal0 and cloth:
        decal = _shrink_copy(decal0, next(o for o in out if o.name == "Cloth")); rig(decal, arm); out.append(decal)
    bpy.ops.object.select_all(action='DESELECT')
    for o in out: o.select_set(True)
    for o in sel:
        if o.type in ('EMPTY',) or o is arm: o.select_set(True)
    arm.select_set(True); bpy.context.view_layer.objects.active = arm
    import os; os.makedirs(ROOT + "/players/lod1", exist_ok=True); path = ROOT + f"/players/lod1/{vn}.glb"
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_yup=True, export_image_format='WEBP', export_animations=False, export_skins=True, export_apply=False,
        export_vertex_color='ACTIVE', export_attributes=True, export_extras=True, export_morph=False)
    tris = sum(len(o.data.polygons) for o in out); calls = sum(max(1, len(o.data.materials)) for o in out)
    for o in out: bpy.data.objects.remove(o, do_unlink=True)
    for o, nm in RN: o.name = nm
    for m in list(bpy.data.meshes):
        if m.users == 0: bpy.data.meshes.remove(m)
    return path, tris, calls
