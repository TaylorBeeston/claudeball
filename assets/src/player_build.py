for f in ("common", "player_rig", "player_anim", "player_clips", "player_pitch", "player_body", "player_cloth", "player_extra", "player_morph"): exec(open(CB_SRC + f"/{f}.py").read())
import os
reset_scene()
arm = build_armature()
body = body_skin(2)
skin_to_armature(body, arm)
bpy.context.view_layer.objects.active = body; bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.vertex_group_limit_total(limit=4); bpy.ops.object.vertex_group_normalize_all(lock_active=False)
body.data.validate()
# ---------------- clothing shells: cut along smooth fields (no stepped edges), copy the body's vertex weights
SH = {}
SH["Jersey"] = make_shell_cut(body, "Jersey", f_jersey(.31), "jersey", .012)                       # elbow-length sleeves
SH["Jersey_ShortSleeve"] = make_shell_cut(body, "Jersey_ShortSleeve", f_jersey(.17), "jersey", .012)
SH["Jersey_Sleeveless"] = make_shell_cut(body, "Jersey_Sleeveless", f_jersey(-.02), "jersey", .012)
SH["Undershirt"] = make_shell_cut(body, "Undershirt", f_undershirt, "undershirt", .0055)            # torso + full arms to the wrist
SH["Pants"] = make_shell_cut(body, "Pants", f_pants(.50), "pants", .0125, taper_top=.0085)                           # knee length (stirrup socks show)
SH["Pants_Long"] = make_shell_cut(body, "Pants_Long", f_pants(.135), "pants", .0135, taper_top=.0095)                # long pants over the shoes
SH["Socks"] = make_shell_cut(body, "Socks", f_socks, "socks", .005)
SH["Cleats"] = make_shell_cut(body, "Cleats", f_cleats, "cleats", .011)
for side, sx in (("L", 1), ("R", -1)): SH["Gear_ArmSleeve_"+side] = make_shell_cut(body, "Gear_ArmSleeve_"+side, f_armsleeve(sx), "undershirt", .0085)   # compression sleeve over the undershirt
cut_object(body, f_skin_neck); body.name = "Body_Skin"
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
def cap_v2(bm): cap(bm); cap_eyelets(bm)
G("Gear_Cap", "Head", cap_v2); G("Gear_Helmet", "Head", helmet_v2); G("Gear_Hair", "Head", hair_short); G("Gear_Glove", "LeftHand", glove)
G("Gear_Hair_Buzz", "Head", hair_buzz); G("Gear_Hair_Curly", "Head", hair_curly); G("Gear_Hair_Long", "Head", hair_long)
G("Gear_CatcherMask", "Head", cage_mask); G("Gear_ChestProtector", "Spine1", chest_prot)
G("Gear_ShinGuard_L", "LeftLeg", lambda bm: shin_guard(bm, 1)); G("Gear_ShinGuard_R", "RightLeg", lambda bm: shin_guard(bm, -1))
G("Gear_Belt", "Hips", belt); G("Gear_Collar", "Spine2", neck_collar)
set_weight(head, arm, "Head"); set_weight(eyeobj, arm, "Head"); set_weight(handL, arm, "LeftHand"); set_weight(handR, arm, "RightHand"); set_weight(handRB, arm, "RightHand")
# ---------------- extras: facial hair, trim, accessories, shoes (built from the surfaces above, weights transferred / assigned)
extra = {}
for fn_ in (beard_full, beard_stubble, mustache, goatee, eye_black): o = fn_(head); set_weight(o, arm, "Head"); extra[o.name] = o
extra["Gear_Piping"] = piping(SH["Jersey"], SH["Pants"], SH["Socks"]); copy_weights(extra["Gear_Piping"], [SH["Jersey"], SH["Pants"], SH["Socks"]])
extra["Gear_Buttons"] = buttons(SH["Jersey"]); copy_weights(extra["Gear_Buttons"], [SH["Jersey"]])
for side in ("Left", "Right"):
    h = handL if side == "Left" else handR
    o = batting_glove(h, side); set_weight(o, arm, side+"Hand"); extra[o.name] = o
    o = wristband(side); set_weight(o, arm, side+"ForeArm"); extra[o.name] = o
extra["Gear_Soles"] = soles(SH["Cleats"])
def _sole_w(co):
    sd = "Left" if co.x >= 0 else "Right"; t = max(0.0, min(1.0, (-.10 - co.y)/.05)); return {sd+"Foot": 1-t, sd+"ToeBase": t}
weights_by(extra["Gear_Soles"], _sole_w)
extra["Gear_Laces"] = laces(SH["Cleats"]); weights_by(extra["Gear_Laces"], lambda co: {("Left" if co.x >= 0 else "Right")+"Foot": 1.0})
gear.update(extra)
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
          "Jersey_ShortSleeve": "uniform_jersey", "Jersey_Sleeveless": "uniform_jersey", "Pants_Long": "uniform_pants", "Pants": "uniform_pants", "Socks": "uniform_socks", "Cleats": "cleats", "Gear_Cap": "cap", "Gear_Helmet": "helmet", "Gear_Hair": "hair", "Gear_Glove": "glove",
          "Gear_CatcherMask": "catcher_gear", "Gear_ChestProtector": "catcher_gear", "Gear_ShinGuard_L": "catcher_gear", "Gear_ShinGuard_R": "catcher_gear",
          "Gear_Belt": "belt", "Gear_Collar": "uniform_undershirt",
          "Gear_Hair_Buzz": "hair", "Gear_Hair_Curly": "hair", "Gear_Hair_Long": "hair", "Gear_Beard_Full": "hair", "Gear_Mustache": "hair", "Gear_Goatee": "hair", "Gear_Beard_Stubble": "stubble",
          "Gear_EyeBlack": "eyeblack", "Gear_Piping": "piping", "Gear_Buttons": "button", "Gear_BattingGlove_L": "batting_glove", "Gear_BattingGlove_R": "batting_glove",
          "Gear_Wristband_L": "wristband", "Gear_Wristband_R": "wristband", "Gear_ArmSleeve_L": "arm_sleeve", "Gear_ArmSleeve_R": "arm_sleeve", "Gear_Soles": "sole", "Gear_Laces": "laces"}
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
# ---------------- morph targets (shape keys -> glTF morph targets) + node metadata (glTF extras)
BODY_MORPH_OBJS = [body] + [SH[n] for n in SH if n not in ("Cleats",)] + [gear[n] for n in ("Gear_Belt", "Gear_Collar", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R",
                   "Gear_Piping", "Gear_Buttons", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_Number_Tens", "Gear_Number_Ones")]
for o in BODY_MORPH_OBJS: add_keys(o, body_morph, BODY_KEYS)
HEAD_ONLY = ("head_narrow", "head_wide", "jaw_square", "nose_large", "ears_large")
add_keys(head, head_morph, HEAD_ONLY)
for n in ("Gear_Cap", "Gear_Helmet", "Gear_Hair", "Gear_Hair_Buzz", "Gear_Hair_Curly", "Gear_Hair_Long", "Gear_CatcherMask", "Gear_EyeBlack"): add_keys(gear[n], head_morph, ("head_narrow", "head_wide"))
add_keys(eyeobj, head_morph, ("head_narrow", "head_wide"))
for n in ("Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee"): add_keys(gear[n], head_morph, ("head_narrow", "head_wide", "jaw_square"))
GROUPS = {"jersey": ("Jersey", "Jersey_ShortSleeve", "Jersey_Sleeveless"), "pants": ("Pants", "Pants_Long"), "hair": ("Gear_Hair", "Gear_Hair_Buzz", "Gear_Hair_Curly", "Gear_Hair_Long"),
          "facial_hair": ("Gear_Beard_Stubble", "Gear_Beard_Full", "Gear_Mustache", "Gear_Goatee"), "headwear": ("Gear_Cap", "Gear_Helmet"),
          "accessory": ("Gear_EyeBlack", "Gear_BattingGlove_L", "Gear_BattingGlove_R", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_ArmSleeve_L", "Gear_ArmSleeve_R", "Gear_Glove"),
          "trim": ("Gear_Piping", "Gear_Buttons"), "shoe": ("Cleats", "Gear_Soles", "Gear_Laces"), "hand": ("Hand_R", "Hand_R_Ball"), "protective": ("Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R")}
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
CORE = ["Body_Skin", "Head", "Eyes", "Hand_L", "Hand_R", "Hand_R_Ball", "Jersey", "Undershirt", "Pants", "Socks", "Cleats", "Gear_Belt", "Gear_Collar", "Gear_Hair", "Gear_Piping", "Gear_Buttons", "Gear_Soles", "Gear_Laces", "Bat_Grip", "Ball_Grip", "Ball_Grip_2Seam", "Glove_Pocket"]
NUM = ["Gear_Number_Tens", "Gear_Number_Ones"]
OPT = ["Jersey_ShortSleeve", "Jersey_Sleeveless", "Pants_Long", "Gear_Hair_Buzz", "Gear_Hair_Curly", "Gear_Hair_Long", "Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee",
       "Gear_EyeBlack", "Gear_BattingGlove_L", "Gear_BattingGlove_R", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_ArmSleeve_L", "Gear_ArmSleeve_R"]                               # optional variants: only in player_base.glb
HOME = dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), uniform_undershirt=(.05, .08, .3, 1), cap=(.05, .08, .3, 1), helmet=(.05, .08, .3, 1), belt=(.02, .02, .02, 1))
VARIANTS = {
 "player_base": (HOME, ["Gear_Cap", "Gear_Helmet", "Gear_Glove", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R"] + NUM + OPT),
 "player_home": (HOME, ["Gear_Cap", "Gear_Glove"] + NUM),
 "player_away": (dict(HOME, uniform_jersey=(.30, .33, .38, 1), uniform_pants=(.35, .37, .40, 1), uniform_socks=(.5, .03, .03, 1), uniform_undershirt=(.5, .03, .03, 1), cap=(.5, .03, .03, 1)), ["Gear_Cap", "Gear_Glove"] + NUM),
 "player_batter": (HOME, ["Gear_Helmet", "Gear_BattingGlove_L", "Gear_BattingGlove_R"] + NUM),
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
    dflt = set(CORE + gl) - set(OPT) if vn != "player_base" else set(CORE + ["Gear_Cap", "Gear_Glove"] + NUM)
    if vn == "player_batter": dflt |= {"Gear_BattingGlove_L", "Gear_BattingGlove_R"}
    for nm_, o in allnodes.items():
        grp = next((g for g, names in GROUPS.items() if nm_ in names), "body"); o["cb_group"] = grp; o["cb_default"] = int(nm_ in dflt)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=ROOT+f"/players/{vn}.glb", use_selection=True, export_format='GLB', export_yup=True, export_image_format='JPEG',
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True, export_apply=False, export_force_sampling=True, export_frame_range=False,
        export_vertex_color='NONE', export_extras=True, export_morph=True)
    info[vn] = os.path.getsize(ROOT+f"/players/{vn}.glb")//1024
result = {"kb": info, "tris": sum(len(o.data.polygons) for o in allobjs.values())}
