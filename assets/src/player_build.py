for f in ("common", "player_rig", "player_anim", "player_clips", "player_pitch", "player_body", "player_cloth"): exec(open(CB_SRC + f"/{f}.py").read())
import os
reset_scene()
arm = build_armature()
body = body_skin(2)
skin_to_armature(body, arm)
bpy.context.view_layer.objects.active = body; bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.vertex_group_limit_total(limit=4); bpy.ops.object.vertex_group_normalize_all(lock_active=False)
body.data.validate()
# ---------------- clothing shells (copy weights) and the remaining skin
SH = {}
for nm, reg, off in (("Jersey", "jersey", .012), ("Undershirt", "undershirt", .0055), ("Pants", "pants", .0125), ("Socks", "socks", .005), ("Cleats", "cleats", .011)):
    SH[nm] = make_shell(body, nm, reg, off)
keep_skin_only(body); body.name = "Body_Skin"
# ---------------- head, eyes, hands
head = build_head(); ears_ = ears()
bpy.ops.object.select_all(action='DESELECT'); head.select_set(True)
for e in ears_: e.select_set(True)
bpy.context.view_layer.objects.active = head; bpy.ops.object.join(); head.name = "Head"
eyes = eyes_meshes(); bpy.ops.object.select_all(action='DESELECT')
for e in eyes: e.select_set(True)
bpy.context.view_layer.objects.active = eyes[0]; bpy.ops.object.join(); eyeobj = eyes[0]; eyeobj.name = "Eyes"
handL, handR = hand_mesh("Left"), hand_mesh("Right"); handL.name, handR.name = "Hand_L", "Hand_R"
BALL_C = (.058, 0, .110)                                                                  # ball centre in the right hand frame (x = palm normal, y = thumb side, z = along the hand)
handRB = hand_mesh("Right", curl=.4, thumb_tip=(.058, -.040, .085), name="Hand_R_Ball")   # open claw grip that holds the ball in the fingertips (no penetration, 47 contact verts)
# ---------------- gear
gear = {}
def G(name, bone, fn):
    me = bm_from(fn); o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); set_weight(o, arm, bone); gear[name] = o; return o
G("Gear_Cap", "Head", cap); G("Gear_Helmet", "Head", helmet); G("Gear_Hair", "Head", hair); G("Gear_Glove", "LeftHand", glove)
G("Gear_CatcherMask", "Head", cage_mask); G("Gear_ChestProtector", "Spine1", chest_prot)
G("Gear_ShinGuard_L", "LeftLeg", lambda bm: shin_guard(bm, 1)); G("Gear_ShinGuard_R", "RightLeg", lambda bm: shin_guard(bm, -1))
G("Gear_Belt", "Hips", belt); G("Gear_Collar", "Spine2", collar)
set_weight(head, arm, "Head"); set_weight(eyeobj, arm, "Head"); set_weight(handL, arm, "LeftHand"); set_weight(handR, arm, "RightHand"); set_weight(handRB, arm, "RightHand")
# ---------------- box-projected UVs (1 tile = 0.25 m) for everything without UVs
def box_uv(o, tile=4.0):
    me = o.data
    if "UVMap" in me.uv_layers and o.name in ("Head", "Eyes"): return
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        n = p.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            c = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = ((c.y, c.z) if ax == 0 else (c.x, c.z) if ax == 1 else (c.x, c.y))
            uvl.data[li].uv = (uvl.data[li].uv[0]*tile, uvl.data[li].uv[1]*tile)
for o in list(SH.values()) + [body, handL, handR, handRB] + list(gear.values()): box_uv(o)
# ---------------- materials + maps
exec(open(CB_SRC + "/player_mats.py").read())
ASSIGN = {"Body_Skin": "skin", "Head": "face", "Eyes": "eye", "Hand_L": "skin", "Hand_R": "skin", "Hand_R_Ball": "skin", "Jersey": "uniform_jersey", "Undershirt": "uniform_undershirt",
          "Pants": "uniform_pants", "Socks": "uniform_socks", "Cleats": "cleats", "Gear_Cap": "cap", "Gear_Helmet": "helmet", "Gear_Hair": "hair", "Gear_Glove": "glove",
          "Gear_CatcherMask": "catcher_gear", "Gear_ChestProtector": "catcher_gear", "Gear_ShinGuard_L": "catcher_gear", "Gear_ShinGuard_R": "catcher_gear",
          "Gear_Belt": "belt", "Gear_Collar": "uniform_undershirt"}
allobjs = {**SH, "Body_Skin": body, "Head": head, "Eyes": eyeobj, "Hand_L": handL, "Hand_R": handR, "Hand_R_Ball": handRB, **gear}
for n, mname in ASSIGN.items():
    o = allobjs[n]; o.data.materials.clear(); o.data.materials.append(MATS[mname])
    if n == "Head":                                        # ears use the skin material slot too? keep single face material (plain uv region)
        pass
    rig(o, arm)
# jersey numbers
digits = bpy.data.images.load(ROOT+"/players/number_digits.png"); digits.pack()
M_NUM = bpy.data.materials.new("jersey_number"); M_NUM.use_nodes = True; nb = M_NUM.node_tree.nodes["Principled BSDF"]
tx = M_NUM.node_tree.nodes.new("ShaderNodeTexImage"); tx.image = digits; tx.extension = 'CLIP'
M_NUM.node_tree.links.new(tx.outputs["Color"], nb.inputs["Base Color"]); M_NUM.node_tree.links.new(tx.outputs["Alpha"], nb.inputs["Alpha"]); nb.inputs["Roughness"].default_value = 0.8
M_NUM.surface_render_method = 'BLENDED'
def number_quad(name, cx, digit):
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); w, zb, zt, y = .05, 1.205, 1.355, .178
    vs = [bm.verts.new((cx+w, y, zb)), bm.verts.new((cx-w, y, zb)), bm.verts.new((cx-w, y, zt)), bm.verts.new((cx+w, y, zt))]
    f = bm.faces.new(vs); u0, u1 = digit/10.0, (digit+1)/10.0
    for lp, uv in zip(f.loops, ((u0, 0), (u1, 0), (u1, 1), (u0, 1))): lp[uvl].uv = uv
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.materials.append(M_NUM)
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); set_weight(o, arm, "Spine1"); rig(o, arm); gear[name] = o
number_quad("Gear_Number_Tens", .055, 2); number_quad("Gear_Number_Ones", -.055, 7)
ACTS = bake_clips(arm)
result = {"objs": {n: len(o.data.polygons) for n, o in {**allobjs, **{k: gear[k] for k in ('Gear_Number_Tens',)}}.items()}}

# ---------------- grip empties (interface for the engine): Bat_Grip / Ball_Grip on RightHand, Glove_Pocket on LeftHand
def grip_empty(name, bone, world_m):
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'ARROWS'; e.empty_display_size = .05; bpy.context.collection.objects.link(e)
    bb = arm.data.bones[PFX+bone]
    e.parent = arm; e.parent_type = 'BONE'; e.parent_bone = PFX+bone
    parent_rest = arm.matrix_world @ bb.matrix_local @ Matrix.Translation((0, bb.length, 0))
    e.matrix_parent_inverse = parent_rest.inverted(); e.matrix_basis = world_m; return e
def frame_matrix(pos, zaxis, xhint):
    z = Vector(zaxis).normalized(); x = (Vector(xhint) - z*Vector(xhint).dot(z)).normalized(); y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4(); m.translation = pos; return m
xr, yr, zr = hand_frame("Right"); wrR = JOINTS["RightHand"][1]
gripR = wrR + zr*.06 + xr*.03; knob = gripR - yr*.135
E_bat = grip_empty("Bat_Grip", "RightHand", frame_matrix(knob, yr, xr))                 # local +Z(blender)=+Y(glTF)=barrel direction; origin = knob
ball_pos = wrR + xr*BALL_C[0] + yr*BALL_C[1] + zr*BALL_C[2]
E_ball = grip_empty("Ball_Grip", "RightHand", frame_matrix(ball_pos, yr, xr))                    # 4-seam: ball symmetry axis (glTF +Y of ball.glb) along the thumb side of the hand
E_ball2 = grip_empty("Ball_Grip_2Seam", "RightHand", frame_matrix(ball_pos, zr, xr))            # 2-seam: ball turned 90 deg (symmetry axis along the fingers)
xl, yl, zl = hand_frame("Left"); wrL = JOINTS["LeftHand"][1]
E_pocket = grip_empty("Glove_Pocket", "LeftHand", frame_matrix(wrL + xl*.05 + zl*.10, Vector((0, 0, 1)), Vector((1, 0, 0))))
GRIPS = (E_bat, E_ball, E_ball2, E_pocket)

def preview_clip(name, frames, path_prefix, cams=((2.6, -2.6, 1.3), (0, -3.6, 1.3), (-3.6, 0, 1.3)), tgt=(0, -.2, 1.0), hide=(), props=True, res=(420, 480)):
    exec(open(CB_SRC + "/render_check.py").read(), globals())
    for n in hide: bpy.data.objects[n].hide_render = True
    if props and "PrevBat" not in bpy.data.objects:
        bpy.ops.import_scene.gltf(filepath=ROOT+"/bat.glb"); bat_o = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]; bat_o.name = "PrevBat"
        bat_o.parent = E_bat; bat_o.matrix_parent_inverse = Matrix(); bat_o.location = (0, 0, 0); bat_o.rotation_euler = (0, 0, 0)
        bpy.ops.import_scene.gltf(filepath=ROOT+"/ball.glb"); ball_o = [o for o in bpy.context.selected_objects if o.type == 'MESH'][0]; ball_o.name = "PrevBall"
        ball_o.parent = E_ball; ball_o.matrix_parent_inverse = Matrix(); ball_o.location = (0, 0, 0)
    arm.animation_data.action = ACTS[name]
    try: arm.animation_data.action_slot = arm.animation_data.action_suitable_slots[0]
    except Exception: pass
    out = []
    for f in frames:
        bpy.context.scene.frame_set(f)
        for ci, c in enumerate(cams):
            p = f"{path_prefix}_{name}_{f:02d}_{ci}.png"; snap(p, c, tgt, lens=40, res=res, sun=3); out.append(p)
    return out

# ---------------- variants + export
def setc(name, col):
    b = MATS[name].node_tree.nodes["Principled BSDF"]
    mix = [n for n in MATS[name].node_tree.nodes if n.type == 'MIX']
    if mix: mix[0].inputs[7].default_value = col
    else: b.inputs["Base Color"].default_value = col
CORE = ["Body_Skin", "Head", "Eyes", "Hand_L", "Hand_R", "Hand_R_Ball", "Jersey", "Undershirt", "Pants", "Socks", "Cleats", "Gear_Belt", "Gear_Collar", "Gear_Hair", "Bat_Grip", "Ball_Grip", "Ball_Grip_2Seam", "Glove_Pocket"]
NUM = ["Gear_Number_Tens", "Gear_Number_Ones"]
HOME = dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), uniform_undershirt=(.05, .08, .3, 1), cap=(.05, .08, .3, 1), helmet=(.05, .08, .3, 1), belt=(.02, .02, .02, 1))
VARIANTS = {
 "player_base": (HOME, ["Gear_Cap", "Gear_Helmet", "Gear_Glove", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R"] + NUM),
 "player_home": (HOME, ["Gear_Cap", "Gear_Glove"] + NUM),
 "player_away": (dict(HOME, uniform_jersey=(.30, .33, .38, 1), uniform_pants=(.35, .37, .40, 1), uniform_socks=(.5, .03, .03, 1), uniform_undershirt=(.5, .03, .03, 1), cap=(.5, .03, .03, 1)), ["Gear_Cap", "Gear_Glove"] + NUM),
 "player_batter": (HOME, ["Gear_Helmet"] + NUM),
 "player_catcher": (HOME, ["Gear_Helmet", "Gear_Glove", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R"] + NUM),
 "player_umpire": (dict(HOME, uniform_jersey=(.03, .03, .035, 1), uniform_pants=(.22, .23, .25, 1), uniform_socks=(.02, .02, .02, 1), uniform_undershirt=(.03, .03, .035, 1), cap=(.02, .02, .02, 1), helmet=(.02, .02, .02, 1)), ["Gear_Cap", "Gear_CatcherMask", "Gear_ChestProtector"]),
}
os.makedirs(ROOT+"/players", exist_ok=True); info = {}
arm.animation_data.action = ACTS["idle"]
allnodes = {**allobjs, **gear, "Bat_Grip": E_bat, "Ball_Grip": E_ball, "Ball_Grip_2Seam": E_ball2, "Glove_Pocket": E_pocket}
for vn, (cols, gl) in VARIANTS.items():
    for k, c in cols.items(): setc(k, c)
    bpy.ops.object.select_all(action='DESELECT'); sel = [arm] + [allnodes[n] for n in CORE + gl]
    for o in sel: o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=ROOT+f"/players/{vn}.glb", use_selection=True, export_format='GLB', export_yup=True, export_image_format='JPEG',
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True, export_apply=False, export_force_sampling=True, export_frame_range=False,
        export_vertex_color='NONE')
    info[vn] = os.path.getsize(ROOT+f"/players/{vn}.glb")//1024
result = {"kb": info, "tris": sum(len(o.data.polygons) for o in allobjs.values())}
