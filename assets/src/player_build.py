for f in ("common", "player_rig", "player_anim", "player_clips", "player_pitch", "player_motion", "player_catch", "player_ump", "player_crew", "player_rituals", "player_arms", "player_body", "player_cloth", "player_extra", "player_morph", "player_mpfb", "player_headwear", "player_glove"): exec(open(CB_SRC + f"/{f}.py").read())
import os, json
reset_scene()
arm = build_armature()
FAST = bool(globals().get('CB_FAST', False))
if not FAST: run_optimiser()                                                     # per-frame elbow poles (clearance from the torso at every build, elbows close to the ribs)
body = body_full()                                                    # MPFB base mesh (CC0), fitted to our rig, weighted (source of the shells; the exported parts are cut from it further down)
body.data.validate()
# ---------------- clothing shells: cut along smooth fields (no stepped edges), copy the body's vertex weights
SH = {}
SH["Jersey"] = make_shell_cut(body, "Jersey", f_jersey(.31), "jersey", .012)                       # elbow-length sleeves
SH["Jersey_ShortSleeve"] = make_shell_cut(body, "Jersey_ShortSleeve", f_jersey(.17), "jersey", .012)
SH["Jersey_Sleeveless"] = make_shell_cut(body, "Jersey_Sleeveless", f_jersey(-.02), "jersey", .012)
SH["Undershirt"] = make_shell_cut(body, "Undershirt", f_undershirt, "undershirt", .0055)            # torso + full arms to the wrist
SH["Pants"] = make_shell_cut(body, "Pants", f_pants(.50), "pants", .0125, taper_top=.0085)                           # knee length (stirrup socks show)
SH["Pants_Long"] = make_shell_cut(body, "Pants_Long", f_pants(.135), "pants", .0135, taper_top=.0095)                # long pants over the shoes
SH["Shorts"] = make_shell_cut(body, "Shorts", f_pants(.70), "pants", .0125, taper_top=.0085)                                   # ball-kid shorts (mid thigh)
SH["Socks"] = make_shell_cut(body, "Socks", f_socks, "socks", .005)
SH["Cleats"] = make_cleats(body)
for side, sx in (("L", 1), ("R", -1)): SH["Gear_ArmSleeve_"+side] = make_shell_cut(body, "Gear_ArmSleeve_"+side, f_armsleeve(sx), "undershirt", .0085)   # compression sleeve over the undershirt
f_jacket = lambda p: min(p[2] - .80, neck_f(p), (.56 - arm_t(p)[0]) if in_arm(p, arm_t(p)[0], arm_t(p)[1]) else 1.0, 1.575 - p[2])
SH["Gear_Jacket"] = make_shell_cut(body, "Gear_Jacket", f_jacket, "jersey", .021)                         # manager: team jacket, hip length, wrist sleeves
belt_shell = make_shell_cut(body, "Gear_Belt", f_belt, "x", .0255)                               # 4 cm belt band hugging the waist, outside the tucked jersey
NORM = full_normals(); PARTS = split_parts(); bpy.data.objects.remove(body, do_unlink=True)
body, _vm = build_mesh("Body_Skin", PARTS["body"]); set_weights(body, _vm); smooth_normals(body, NORM[_vm]); body_vm = _vm
_remap, HEAD_BB = head_uv_remap(PARTS["head"]); head, head_vm = build_mesh("Head", PARTS["head"], uv_remap=_remap); set_weights(head, head_vm); smooth_normals(head, NORM[head_vm])
eyeobj, eyecornea = build_eyes()
# hands: finger-posed variants of the MPFB hand (fist = bat grip, claw = ball hold fitted to the ball, open = inside the glove, relaxed = default)
handL, handL_vm = hand_object("Hand_L", "Left", "fist", norm=NORM); handR, handR_vm = hand_object("Hand_R", "Right", "fist", norm=NORM)
CLAW = claw_ball_fit("Right"); BALL_C = ball_hand_frame_coords(CLAW[2], "Right"); HAND_SPECS["claw"] = (CLAW[0], 0.0, CLAW[1])
handRB, handRB_vm = hand_object("Hand_R_Ball", "Right", "claw", norm=NORM)
handLr, handLr_vm = hand_object("Hand_L_Relaxed", "Left", "relaxed", norm=NORM); handRr, handRr_vm = hand_object("Hand_R_Relaxed", "Right", "relaxed", norm=NORM)
for _o, _vm, _sd, _bs in ((handR, handR_vm, "Right", "fist"), (handRB, handRB_vm, "Right", "claw"), (handRr, handRr_vm, "Right", "relaxed")): add_hand_finger_keys(_o, _vm, _sd, _bs)
# ---------------- gear
gear = {}
def G(name, bone, fn):
    me = bm_from(fn); o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); set_weight(o, arm, bone); gear[name] = o; return o
handLO, handLO_vm = hand_object("Hand_L_Open", "Left", "open", norm=NORM)                       # the hand as it sits inside a glove (fingers nearly straight)
handLOC = handLO.copy(); handLOC.data = handLO.data.copy(); handLOC.name = "Hand_L_Open_Catcher"; bpy.context.collection.objects.link(handLOC)
add_glove_keys(handLO, "infield"); add_glove_keys(handLOC, "catcher")                                 # the hand inside closes with its glove (no fingertips through the leather)
GLOVE_POCKET = {}
for kind_, K_ in KINDS.items():                                                                       # four role gloves built around that hand (hand fully inside, cuff clear of the forearm)
    g_, pc_ = build_glove(kind_, "Left"); weight_glove(g_); add_glove_keys(g_, kind_)
    lc_ = glove_laces(g_, kind_); lc_.name = K_["node"] + "_Laces"; copy_weights(lc_, [g_]); add_glove_keys(lc_, kind_)
    gear[K_["node"]] = g_; gear[K_["node"] + "_Laces"] = lc_; GLOVE_POCKET[kind_] = pc_
G("Gear_CatcherMask", "Head", cage_mask); G("Gear_ChestProtector", "Spine1", chest_prot)
G("Gear_ShinGuard_L", "LeftLeg", lambda bm: shin_guard(bm, 1)); G("Gear_ShinGuard_R", "RightLeg", lambda bm: shin_guard(bm, -1))
G("Gear_Collar", "Spine2", neck_collar)
def lineup_card(bm):                                                                      # coach's lineup card: a 9 x 14 cm card in the right hand (optional node, hidden by default)
    xr, yr, zr = hand_frame("Right"); c = JOINTS["RightHand"][1] + zr*.06 + xr*.042
    g = bmesh.ops.create_cube(bm, size=2.0); M3 = Matrix((xr*.0016, yr*.045, zr*.07)).transposed(); M4 = M3.to_4x4(); M4.translation = c
    bmesh.ops.transform(bm, matrix=M4, verts=g["verts"])
G("Gear_LineupCard", "RightHand", lineup_card)
def umpire_broom(bm):                                                                      # whisk broom in the right hand (hidden by default; shown during ump_brush_plate)
    xr, yr, zr = hand_frame("Right"); c0 = JOINTS["RightHand"][1] + zr*.07 + xr*.02; R = zr.to_track_quat('Z', 'Y').to_matrix()
    h = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=.011, radius2=.011, depth=.14)
    for v in h["verts"]: v.co = R @ v.co + c0 + zr*.02
    f = bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=.020, radius2=.016, depth=.04)
    for v in f["verts"]: v.co = R @ v.co + c0 + zr*.115
    b_ = bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=.020, radius2=.046, depth=.20)
    for v in b_["verts"]: v.co = R @ Vector((v.co.x*1.0, v.co.y*.55, v.co.z)) + c0 + zr*.235
G("Umpire_Broom", "RightHand", umpire_broom)
def ball_bag(bm):                                                                          # umpire's ball bag on the right hip
    g = bmesh.ops.create_cube(bm, size=1.0)
    for v in g["verts"]: v.co = Vector((v.co.x*.05 - .232, v.co.y*.085 + .01, v.co.z*.11 + .905))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=.006, segments=2, affect='EDGES')
G("Ball_Bag", "Hips", ball_bag)
# head-fitted headwear and hair (built from the head mesh: never inside the skull, morph-aware)
cap_o, cap_inner = build_cap(head); gear["Gear_Cap"] = cap_o; set_weight(cap_o, arm, "Head")
helm_o, helm_inner = build_helmet(head); gear["Gear_Helmet"] = helm_o; set_weight(helm_o, arm, "Head")
HAIR_NAMES = []
for nm_, asset_, shr_, cut_ in HAIR_STYLES:
    o = hair_style(nm_, asset_, head, shr_, cut_); gear[nm_] = o; set_weight(o, arm, "Head"); HAIR_NAMES.append(nm_)
for nm_, asset_ in (("Gear_Eyebrows", "eyebrow004"), ("Gear_Eyelashes", "eyelashes02")):
    o = asset_object(asset_, nm_); gear[nm_] = o; set_weight(o, arm, "Head")
o = asset_object("teeth_base", "Gear_Teeth"); gear["Gear_Teeth"] = o; set_weight(o, arm, "Head")
o = asset_object("tongue01", "Gear_Tongue"); gear["Gear_Tongue"] = o; set_weight(o, arm, "Head")
belt_o, buckle_o = finish_belt(belt_shell); gear["Gear_Belt"] = belt_o; gear["Gear_BeltBuckle"] = buckle_o
copy_weights(buckle_o, [belt_o])
set_weight(eyeobj, arm, "Head"); set_weight(eyecornea, arm, "Head")
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
    if "UVMap" in me.uv_layers and (o.name in ("Head", "Eyes", "Eyes_Cornea", "Body_Skin") or o.name.startswith(("Hand_", "Gear_Hair", "Gear_Eye", "Gear_Teeth", "Gear_Tongue"))): return
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        n = p.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            c = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = ((c.y, c.z) if ax == 0 else (c.x, c.z) if ax == 1 else (c.x, c.y))
            uvl.data[li].uv = (uvl.data[li].uv[0]*tile, uvl.data[li].uv[1]*tile)
for o in list(SH.values()) + [body, handL, handR, handRB, handLr, handRr, handLO, handLOC, eyecornea] + list(gear.values()): box_uv(o)
# ---------------- materials + maps
exec(open(CB_SRC + "/player_mats.py").read())
ASSIGN = {"Body_Skin": "skin", "Head": "face", "Eyes": "eye", "Eyes_Cornea": "cornea", "Hand_L_Relaxed": "skin", "Hand_R_Relaxed": "skin", "Hand_L": "skin", "Hand_R": "skin", "Hand_R_Ball": "skin", "Hand_L_Open": "skin", "Hand_L_Open_Catcher": "skin", "Gear_Glove_Outfield": "glove", "Gear_Glove_FirstBase": "glove", "Gear_Glove_Catcher": "glove", "Gear_Glove_Laces": "glove_laces", "Gear_Glove_Outfield_Laces": "glove_laces", "Gear_Glove_FirstBase_Laces": "glove_laces", "Gear_Glove_Catcher_Laces": "glove_laces", "Jersey": "uniform_jersey", "Undershirt": "uniform_undershirt",
          "Jersey_ShortSleeve": "uniform_jersey", "Jersey_Sleeveless": "uniform_jersey", "Pants_Long": "uniform_pants", "Pants": "uniform_pants", "Socks": "uniform_socks", "Cleats": "cleats", "Gear_Cap": "cap", "Gear_Helmet": "helmet", "Gear_Hair": "hair", "Gear_Glove": "glove",
          "Gear_CatcherMask": "catcher_gear", "Gear_ChestProtector": "catcher_gear", "Gear_ShinGuard_L": "catcher_gear", "Gear_ShinGuard_R": "catcher_gear",
          "Gear_Belt": "belt", "Gear_BeltBuckle": "buckle", "Gear_Collar": "uniform_undershirt",
          "Gear_Hair_Buzz": "hair_short01", "Gear_Hair_Curly": "hair_afro01", "Gear_Hair_Long": "hair_long01", "Gear_Hair_SidePart": "hair_short03", "Gear_Hair_SlickBack": "hair_short04", "Gear_Hair_Bob": "hair_bob01", "Gear_Hair_Ponytail": "hair_ponytail01", "Gear_Hair_Receding": "hair", "Gear_Hair_Balding": "hair", "Gear_Eyebrows": "eyebrow", "Gear_Eyelashes": "eyelash", "Gear_Teeth": "teeth", "Gear_Tongue": "tongue", "Gear_Beard_Full": "hair", "Gear_Mustache": "hair", "Gear_Goatee": "hair", "Gear_Beard_Stubble": "stubble",
          "Gear_EyeBlack": "eyeblack", "Gear_Piping": "piping", "Gear_Buttons": "button", "Gear_BattingGlove_L": "batting_glove", "Gear_BattingGlove_R": "batting_glove",
          "Gear_Jacket": "jacket", "Umpire_Broom": "belt", "Ball_Bag": "belt", "Gear_Wristband_L": "wristband", "Gear_Wristband_R": "wristband", "Gear_LineupCard": "wristband", "Shorts": "uniform_pants", "Gear_ArmSleeve_L": "arm_sleeve", "Gear_ArmSleeve_R": "arm_sleeve", "Gear_Soles": "sole", "Gear_Laces": "laces"}
allobjs = {**SH, "Body_Skin": body, "Head": head, "Eyes": eyeobj, "Eyes_Cornea": eyecornea, "Hand_L": handL, "Hand_R": handR, "Hand_R_Ball": handRB, "Hand_L_Relaxed": handLr, "Hand_R_Relaxed": handRr, "Hand_L_Open": handLO, "Hand_L_Open_Catcher": handLOC, **gear}
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
HAIR_SQUASH = {}
BODY_MORPH_OBJS = [body] + [SH[n] for n in SH if n not in ("Cleats",)] + [gear[n] for n in ("Gear_Belt", "Gear_BeltBuckle", "Gear_Collar", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R",
                   "Gear_Piping", "Gear_Buttons", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_Number_Tens", "Gear_Number_Ones")]
for o in BODY_MORPH_OBJS: add_keys(o, body_morph, BODY_KEYS)
HEAD_ONLY = HEAD_KEYS
add_keys(head, head_morph, HEAD_ONLY)
for n in ["Gear_Cap", "Gear_Helmet", "Gear_CatcherMask", "Gear_EyeBlack"] + HAIR_NAMES: add_keys(gear[n], head_morph, ("head_narrow", "head_wide", "brow_heavy") + (("ears_large",) if n.startswith("Gear_Hair") else ()))
add_keys(gear["Gear_Helmet"], head_morph, ("ears_large", "jaw_square"))
for n in HAIR_NAMES: HAIR_SQUASH[n] = add_under_cap_key(gear[n], cap_inner)
add_keys(eyeobj, head_morph, ("head_narrow", "head_wide")); add_keys(eyecornea, head_morph, ("head_narrow", "head_wide"))
for n in ("Gear_Eyebrows", "Gear_Eyelashes"): add_keys(gear[n], head_morph, ("head_narrow", "head_wide", "brow_heavy", "eyes_deep", "eyes_blink", "brow_raise", "brow_furrow"))
for n in ("Gear_Teeth", "Gear_Tongue"): add_keys(gear[n], head_morph, ("head_narrow", "head_wide", "mouth_open", "smile", "mouth_pucker", "jaw_square", "chin_strong"))
for n in ("Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee"): add_keys(gear[n], head_morph, ("head_narrow", "head_wide", "jaw_square", "chin_strong", "mouth_open", "smile", "mouth_pucker"))
GROUPS = {"jersey": ("Jersey", "Jersey_ShortSleeve", "Jersey_Sleeveless", "Gear_Jacket"), "pants": ("Pants", "Pants_Long", "Shorts"), "prop": ("Umpire_Broom", "Ball_Bag"), "hair": tuple(h[0] for h in HAIR_STYLES), "face_parts": ("Gear_Eyebrows", "Gear_Eyelashes", "Gear_Teeth", "Gear_Tongue", "Eyes_Cornea"),
          "facial_hair": ("Gear_Beard_Stubble", "Gear_Beard_Full", "Gear_Mustache", "Gear_Goatee"), "headwear": ("Gear_Cap", "Gear_Helmet"),
          "accessory": ("Gear_LineupCard", "Gear_EyeBlack", "Gear_BattingGlove_L", "Gear_BattingGlove_R", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_ArmSleeve_L", "Gear_ArmSleeve_R", "Gear_Glove"),
          "trim": ("Gear_Piping", "Gear_Buttons"), "shoe": ("Cleats", "Gear_Soles", "Gear_Laces"), "hand": ("Hand_R", "Hand_R_Ball"), "protective": ("Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R")}
FIT = fit_summary(head, gear)
ACTS = {} if FAST else bake_clips(arm)
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
POCKET = {}                                                                                        # origin = pocket centre (where the ball sits), local +Z(blender)=+Y(glTF) = pocket opening normal (hand-local +x), X hint = along the fingers
for kind_, K_ in KINDS.items(): POCKET[kind_] = grip_empty(K_["pocket_node"], "LeftHand", frame_matrix(GLOVE_POCKET[kind_], xl, zl))
E_pocket = POCKET["infield"]
# elbow guides: Elbow_Pole_L/R = where each elbow sits in the batting stance (children of Spine1, so they move with the chest). The engine's hand IK can swivel the elbow toward them;
# per-frame elbow positions of `batting_stance` / `swing` (Spine1 bone-local axes) are written to players/elbow_guides.json (merged into the manifest).
def _elbow_guides():
    rest = lambda nm: arm.matrix_world @ arm.data.bones[PFX+nm].matrix_local
    Mr = rest("Spine1"); M0, _ = solve(dict(CLIPS["batting_stance"][1][0][1])); S0i = M0["Spine1"].inverted(); E = {}
    for side, tag in (("Left", "L"), ("Right", "R")):
        loc = S0i @ M0[side+"ForeArm"].translation; E[tag] = grip_empty("Elbow_Pole_"+tag, "Spine1", Matrix.Translation(Mr @ loc))
        E[tag].empty_display_type = 'SPHERE'
    guides = {}
    for nm in ("batting_stance", "swing", "ondeck_swing"):
        rows = []
        for f, sp in CLIPS[nm][1]:
            M, _ = solve(dict(sp)); Si = M["Spine1"].inverted()
            rows.append([f] + [round(v, 4) for side in ("Left", "Right") for v in (Si @ M[side+"ForeArm"].translation)] + [round(v, 4) for side in ("Left", "Right") for v in (Si @ M[side+"Hand"].translation)])
        guides[nm] = rows
    json.dump({"frame": "local axes of the Spine1 bone; per row: frame, elbow_L xyz, elbow_R xyz, wrist_L xyz, wrist_R xyz", "clips": guides}, open(ROOT+"/players/elbow_guides.json", "w"))
    return E
E_ELBOW = _elbow_guides()
GRIPS = (E_bat, E_ball, E_ball2) + tuple(POCKET.values()) + tuple(E_ELBOW.values())

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
CORE = ["Body_Skin", "Head", "Eyes", "Eyes_Cornea", "Gear_Eyebrows", "Gear_Eyelashes", "Jersey", "Undershirt", "Pants", "Socks", "Cleats", "Gear_Belt", "Gear_BeltBuckle", "Gear_Collar", "Gear_Hair", "Gear_Piping", "Gear_Buttons", "Gear_Soles", "Gear_Laces", "Bat_Grip", "Ball_Grip", "Ball_Grip_2Seam", "Elbow_Pole_L", "Elbow_Pole_R"]
NUM = ["Gear_Number_Tens", "Gear_Number_Ones"]
OPT = ["Jersey_ShortSleeve", "Jersey_Sleeveless", "Pants_Long", "Gear_Hair_Buzz", "Gear_Hair_Curly", "Gear_Hair_Long", "Gear_Hair_SidePart", "Gear_Hair_SlickBack", "Gear_Hair_Bob", "Gear_Hair_Ponytail", "Gear_Hair_Receding", "Gear_Hair_Balding", "Gear_Teeth", "Gear_Tongue",
       "Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee", "Gear_EyeBlack", "Gear_BattingGlove_L", "Gear_BattingGlove_R", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_ArmSleeve_L", "Gear_ArmSleeve_R"]                               # optional variants: only in player_base.glb
HOME = dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), uniform_undershirt=(.05, .08, .3, 1), cap=(.05, .08, .3, 1), helmet=(.05, .08, .3, 1), belt=(.02, .02, .02, 1), piping=(.05, .08, .3, 1), jacket=(.05, .08, .3, 1), hair=(.09, .06, .035, 1), stubble=(.06, .045, .035, 1))
AWAY = dict(HOME, uniform_jersey=(.30, .33, .38, 1), uniform_pants=(.35, .37, .40, 1), uniform_socks=(.5, .03, .03, 1), uniform_undershirt=(.5, .03, .03, 1), cap=(.5, .03, .03, 1), piping=(.5, .03, .03, 1))
NAVY = dict(HOME, uniform_jersey=(.015, .03, .10, 1), uniform_pants=(.02, .035, .09, 1), uniform_socks=(.01, .015, .04, 1), uniform_undershirt=(.015, .03, .10, 1), cap=(.012, .022, .07, 1), helmet=(.012, .022, .07, 1), belt=(.01, .01, .012, 1), piping=(.015, .03, .10, 1), catcher_gear=(.015, .025, .08, 1))
MGR = dict(HOME, jacket=(.05, .08, .3, 1), hair=(.56, .55, .54, 1), stubble=(.48, .47, .45, 1))
KID = dict(HOME, uniform_jersey=(.10, .45, .75, 1), uniform_pants=(.12, .13, .16, 1), uniform_socks=(.9, .9, .9, 1), uniform_undershirt=(.10, .45, .75, 1), cap=(.10, .45, .75, 1), piping=(.9, .9, .9, 1))      # ball kid: bright polo, dark shorts
CATCH = ["Gear_Helmet", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R"]
# name: (colours, extra nodes, glove kind (None / role / "ALL"), right hand (fist / claw), left hand (fist / open))
VARIANTS = {
 "player_base":     (HOME, ["Gear_Cap"] + CATCH + NUM + OPT, "ALL", "both", "both"),
 "player_home":     (HOME, ["Gear_Cap"] + NUM, "infield", "claw", "open"),
 "player_away":     (AWAY, ["Gear_Cap"] + NUM, "infield", "claw", "open"),
 "player_home_of":  (HOME, ["Gear_Cap"] + NUM, "outfield", "claw", "open"),
 "player_away_of":  (AWAY, ["Gear_Cap"] + NUM, "outfield", "claw", "open"),
 "player_home_1b":  (HOME, ["Gear_Cap"] + NUM, "firstbase", "claw", "open"),
 "player_away_1b":  (AWAY, ["Gear_Cap"] + NUM, "firstbase", "claw", "open"),
 "player_batter":   (HOME, ["Gear_Helmet", "Gear_BattingGlove_L", "Gear_BattingGlove_R"] + NUM, None, "fist", "fist"),
 "player_catcher":  (HOME, CATCH + NUM, "catcher", "claw", "open"),
 "player_umpire":   (NAVY, ["Gear_Cap", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R", "Umpire_Broom", "Ball_Bag"], None, "relaxed", "relaxed"),
 "player_umpire_base": (NAVY, ["Gear_Cap"], None, "relaxed", "relaxed"),
 "player_coach":    (HOME, ["Gear_Cap", "Gear_Helmet", "Gear_Wristband_L", "Gear_Wristband_R", "Gear_LineupCard"] + NUM, None, "relaxed", "relaxed"),
 "player_manager":  (MGR, ["Gear_Cap", "Gear_Jacket", "Gear_Beard_Stubble", "Gear_Beard_Full", "Gear_Mustache", "Gear_Hair_Buzz"] + NUM, None, "relaxed", "relaxed"),
 "player_ballkid":  (KID, ["Gear_Cap", "Jersey_ShortSleeve", "Shorts"], None, "relaxed", "relaxed"),
}
DROP = {"player_ballkid": ["Jersey", "Pants", "Gear_Piping", "Gear_Buttons", "Gear_Belt", "Gear_BeltBuckle"]}
NODEFAULT = {"player_coach": ["Gear_Cap", "Gear_LineupCard"], "player_umpire": ["Umpire_Broom"]}
EXTRA_DEF = {"player_manager": ["Gear_Jacket", "Gear_Beard_Stubble"]}
MORPH_DEF = {"player_manager": {"build_stocky": .55, "cheeks_full": .6, "brow_heavy": .5, "eyes_deep": .5, "jaw_square": .3, "nose_large": .3, "chin_strong": .2}}
def setk_all(name, val):
    for o_ in bpy.data.objects:
        sk_ = getattr(o_.data, "shape_keys", None) if o_.type == 'MESH' else None
        if sk_ and name in sk_.key_blocks: sk_.key_blocks[name].value = val
os.makedirs(ROOT+"/players", exist_ok=True); info = {}
if not FAST: arm.animation_data.action = ACTS["idle"]
allnodes = {**allobjs, **gear, "Elbow_Pole_L": E_ELBOW["L"], "Elbow_Pole_R": E_ELBOW["R"], "Bat_Grip": E_bat, "Ball_Grip": E_ball, "Ball_Grip_2Seam": E_ball2, **{K_["pocket_node"]: POCKET[k_] for k_, K_ in KINDS.items()}}
GLOVE_NODES = {k_: (gear[K_["node"]], gear[K_["node"] + "_Laces"], POCKET[k_]) for k_, K_ in KINDS.items()}
GROUPS["accessory"] = tuple(n for n in GROUPS["accessory"] if n != "Gear_Glove") + tuple(K_["node"] for K_ in KINDS.values()) + tuple(K_["node"] + "_Laces" for K_ in KINDS.values())
GROUPS["hand"] = ("Hand_L", "Hand_L_Open", "Hand_R", "Hand_R_Ball")
for vn, (cols, gl, gkind, rhand, lhand) in ({} if FAST else VARIANTS).items():
    for k, c in cols.items(): setc(k, c)
    bpy.ops.object.select_all(action='DESELECT'); sel = [arm] + [allnodes[n] for n in CORE + gl if n not in DROP.get(vn, [])]; renames = []
    def rn(o, new): renames.append((o, o.name)); o.name = new
    dflt = set(CORE + gl) - set(OPT) if vn != "player_base" else set(CORE + ["Gear_Cap"] + NUM)
    dflt |= set(EXTRA_DEF.get(vn, [])); dflt -= set(NODEFAULT.get(vn, [])); dflt |= {"Jersey_ShortSleeve", "Shorts"} if vn == "player_ballkid" else set()
    if vn == "player_batter": dflt |= {"Gear_BattingGlove_L", "Gear_BattingGlove_R"}
    # gloves: one role glove exported under the canonical names (Gear_Glove / Gear_Glove_Laces / Glove_Pocket); the base file carries all four under their own names
    if gkind == "ALL":
        for k_ in KINDS: sel += list(GLOVE_NODES[k_])
        dflt |= {"Gear_Glove", "Gear_Glove_Laces", "Glove_Pocket"}
    elif gkind:
        g_, l_, p_ = GLOVE_NODES[gkind]
        if gkind != "infield":
            rn(gear["Gear_Glove"], "Gear_Glove__tmp"); rn(gear["Gear_Glove_Laces"], "Gear_Glove_Laces__tmp"); rn(E_pocket, "Glove_Pocket__tmp")
            rn(g_, "Gear_Glove"); rn(l_, "Gear_Glove_Laces"); rn(p_, "Glove_Pocket")
        sel += [g_, l_, p_]; dflt |= {"Gear_Glove", "Gear_Glove_Laces", "Glove_Pocket"}
    # hands: Hand_R = fist (bat) / claw (ball) / relaxed - never two visible by default; Hand_L = fist / the open hand that lives inside the glove / relaxed
    if rhand in ("fist", "both"): sel.append(handR)
    if rhand == "claw": rn(handR, "Hand_R_fist_tmp"); rn(handRB, "Hand_R"); sel.append(handRB); dflt |= {"Hand_R"}
    if rhand == "both": sel.append(handRB); sel.append(handRr)
    if rhand == "relaxed": rn(handR, "Hand_R_fist_tmp"); rn(handRr, "Hand_R"); sel.append(handRr); dflt |= {"Hand_R"}
    if lhand in ("fist", "both"): sel.append(handL)
    ho = handLOC if gkind == "catcher" else handLO
    if lhand == "open": rn(handL, "Hand_L_fist_tmp"); rn(ho, "Hand_L"); sel.append(ho); dflt |= {"Hand_L"}
    if lhand == "both": sel.append(handLO); sel.append(handLr)
    if lhand == "relaxed": rn(handL, "Hand_L_fist_tmp"); rn(handLr, "Hand_L"); sel.append(handLr); dflt |= {"Hand_L"}
    dflt |= {"Hand_L", "Hand_R"} if vn == "player_base" else set()
    for o in sel:
        if o.type != 'ARMATURE': o.select_set(True)
    arm.select_set(True)
    for o in sel:
        if o is arm: continue
        grp = next((g for g, names in GROUPS.items() if o.name in names), "body"); o["cb_group"] = grp; o["cb_default"] = int(o.name in dflt)
    if rhand == "both": handRB["cb_default"] = 0; handRr["cb_default"] = 0
    if lhand == "both": handLO["cb_default"] = 0; handLr["cb_default"] = 0
    bpy.context.view_layer.objects.active = arm
    if vn == "player_ballkid":                                         # 1.55 m kid: the whole armature is scaled to 0.838 (clips scale with it), slimmer build
        arm.scale = (.838, .838, .838); arm["cb_height_m"] = 1.55; arm["cb_scale_note"] = "Armature node scale 0.838 (rig height 1.85 m -> 1.55 m)"; setk_all("build_lean", .55)
    if vn == "player_coach": arm["cb_note"] = "base coach; Gear_Helmet visible by default (1B/3B coach), Gear_Cap and Gear_LineupCard optional"
    if vn == "player_ballkid": arm["cb_note"] = "ball kid: 1.55 m (Armature node scale 0.838); polo + shorts + cap, no glove"
    bpy.ops.export_scene.gltf(filepath=ROOT+f"/players/{vn}.glb", use_selection=True, export_format='GLB', export_yup=True, export_image_format='WEBP',
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True, export_apply=False, export_force_sampling=True, export_frame_range=False,
        export_vertex_color='NONE', export_extras=True, export_morph=True)
    for o, old in reversed(renames): o.name = old
    for k_, v_ in MORPH_DEF.get(vn, {}).items(): setk_all(k_, v_)
    swap_skin(vn == "player_manager")
    if vn == "player_ballkid": arm.scale = (1, 1, 1); setk_all("build_lean", 0.0)
    for k_ in MORPH_DEF.get(vn, {}): setk_all(k_, 0.0)
    for k_ in ("cb_note", "cb_height_m", "cb_scale_note"):
        if k_ in arm: del arm[k_]
    info[vn] = os.path.getsize(ROOT+f"/players/{vn}.glb")//1024
result = {"kb": info, "tris": sum(len(o.data.polygons) for o in allobjs.values()), "fit": FIT}
