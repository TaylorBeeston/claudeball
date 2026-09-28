for f in ("common", "player_rig", "player_anim", "player_clips"): exec(open(CB_SRC + f"/{f}.py").read())
import os
import bmesh
reset_scene()
arm = build_armature(); body = build_body(); body = add_head(body)
# ---- materials
def M(name, col, rough=0.85, metal=0.0, nrm=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = col; b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if nrm is not None:
        t = m.node_tree.nodes.new("ShaderNodeTexImage"); t.image = nrm; nm = m.node_tree.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 0.5; m.node_tree.links.new(t.outputs["Color"], nm.inputs["Color"]); m.node_tree.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    return m
weave = np.zeros((256, 256), np.float32); weave[::2, :] += .5; weave[:, ::2] += .5
fabric_n = make_image("fabric_normal", height_to_normal(weave + 0.3*noise_tex(256, [32, 128], 4), 1.5), 'Non-Color', ROOT+"/tex/fabric_normal.png")
skin_n = make_image("skin_normal", height_to_normal(noise_tex(256, [64, 128, 256], 8), 0.6), 'Non-Color', ROOT+"/tex/skin_normal.png")
MATS = {n: M(n, c, r, mt, nr) for n, c, r, mt, nr in [
    ("skin", (0.55, 0.36, 0.27, 1), 0.55, 0, skin_n), ("uniform_jersey", (0.8, 0.8, 0.8, 1), 0.85, 0, fabric_n), ("uniform_pants", (0.75, 0.75, 0.75, 1), 0.85, 0, fabric_n),
    ("uniform_socks", (0.05, 0.08, 0.3, 1), 0.85, 0, fabric_n), ("cleats", (0.02, 0.02, 0.02, 1), 0.5, 0, None), ("cap", (0.05, 0.08, 0.3, 1), 0.8, 0, fabric_n),
    ("helmet", (0.05, 0.08, 0.3, 1), 0.35, 0, None), ("glove", (0.28, 0.14, 0.07, 1), 0.6, 0, None), ("catcher_gear", (0.03, 0.03, 0.04, 1), 0.5, 0.3, None)]}
ORDER_M = ["skin", "uniform_jersey", "uniform_pants", "uniform_socks", "cleats"]
for n in ORDER_M: body.data.materials.append(MATS[n])
for p in body.data.polygons:
    c = p.center; z, ax = c.z, abs(c.x)
    if z > 1.52 or (ax > .50 and z > .5) or (z < 1.0 and ax > .5): i = 0                     # head/neck, forearms, hands
    elif z < .105: i = 4
    elif z < .40: i = 3
    elif z < 1.06 and ax < .30: i = 2
    else: i = 1                                                                                # torso + sleeves
    if z > 1.0 and ax > .50: i = 0
    p.material_index = i
bpy.context.view_layer.objects.active = body; bpy.ops.object.select_all(action='DESELECT'); body.select_set(True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02); bpy.ops.object.mode_set(mode='OBJECT')
skin_to_armature(body, arm)
# ---- gear (each skinned 100% to one bone)
gear = {}
def gear_obj(name, bone, mat, build):
    bm = bmesh.new(); build(bm); me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    me.materials.append(mat); o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    vg = o.vertex_groups.new(name=PFX+bone); vg.add(list(range(len(me.vertices))), 1.0, 'REPLACE')
    o.parent = arm; md = o.modifiers.new("Armature", 'ARMATURE'); md.object = arm; gear[name] = o; return o
def xf(bm, sc=(1, 1, 1), loc=(0, 0, 0), rotx=0):
    for v in bm.verts: v.co = Vector((v.co.x*sc[0], v.co.y*sc[1], v.co.z*sc[2]))
    if rotx: bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rotx, 3, 'X'))
    bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
def sphere(bm, r=1.0): bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=14, radius=r)
def cut_below(bm, z):
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < z], context='VERTS')
HC = Vector((0, -.008, 1.725))
def cap(bm):
    sphere(bm); xf(bm, (.098, .114, .115), HC + Vector((0, .0, .03))); cut_below(bm, HC.z+.025)
    b2 = bmesh.new(); bmesh.ops.create_cube(b2, size=1.0)
    for v in b2.verts: v.co = Vector((v.co.x*.16, v.co.y*.13, v.co.z*.008)) + HC + Vector((0, -.115, .045))
    tmp = bpy.data.meshes.new("t"); b2.to_mesh(tmp); b2.free(); bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
def helmet(bm):
    sphere(bm); xf(bm, (.108, .125, .125), HC + Vector((0, .005, .02))); cut_below(bm, HC.z-.02)
    b2 = bmesh.new(); bmesh.ops.create_cube(b2, size=1.0)
    for v in b2.verts: v.co = Vector((v.co.x*.02, v.co.y*.07, v.co.z*.09)) + HC + Vector((-.106, -.01, -.06))
    tmp = bpy.data.meshes.new("t"); b2.to_mesh(tmp); b2.free(); bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
def glove(bm):
    sphere(bm); xf(bm, (.06, .11, .09), Vector((.72, -.03, 1.0)))
def mask(bm):
    sphere(bm); xf(bm, (.115, .10, .13), HC + Vector((0, -.08, -.005)))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > HC.y - .07 or v.co.z < HC.z-.09], context='VERTS')
def chest(bm):
    bmesh.ops.create_cube(bm, size=1.0); xf(bm, (.36, .06, .42), Vector((0, -.135, 1.28)))
def shin(sx):
    def f(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=.062, radius2=.075, depth=.36); xf(bm, (1, 1, 1), Vector((sx*.09, -.045, .27)))
    return f
gear_obj("Gear_Cap", "Head", MATS["cap"], cap); gear_obj("Gear_Helmet", "Head", MATS["helmet"], helmet)
gear_obj("Gear_Glove", "LeftHand", MATS["glove"], glove); gear_obj("Gear_CatcherMask", "Head", MATS["catcher_gear"], mask)
gear_obj("Gear_ChestProtector", "Spine1", MATS["catcher_gear"], chest)
gear_obj("Gear_ShinGuard_L", "LeftLeg", MATS["catcher_gear"], shin(1)); gear_obj("Gear_ShinGuard_R", "RightLeg", MATS["catcher_gear"], shin(-1))

# ---- face details, hair, jersey numbers
M_FEAT = M("face_features", (0.02, 0.015, 0.015, 1), 0.4); M_EYEW = M("eye_white", (0.9, 0.9, 0.88, 1), 0.3); M_HAIR = M("hair", (0.09, 0.06, 0.035, 1), 0.7)
def blob(bm, r, loc, seg=12):
    tmp = bmesh.new(); bmesh.ops.create_uvsphere(tmp, u_segments=seg, v_segments=8, radius=1.0)
    for v in tmp.verts: v.co = Vector((v.co.x*r[0], v.co.y*r[1], v.co.z*r[2])) + Vector(loc)
    m = bpy.data.meshes.new("t"); tmp.to_mesh(m); tmp.free(); bm.from_mesh(m); bpy.data.meshes.remove(m)
def face(bm):
    for sx in (1, -1):
        blob(bm, (.013, .008, .009), (sx*.038, -.098, 1.742)); blob(bm, (.006, .006, .006), (sx*.038, -.104, 1.742))     # eyes: white + pupil (features colour)
        blob(bm, (.020, .006, .006), (sx*.040, -.099, 1.775)); blob(bm, (.010, .022, .030), (sx*.092, -.005, 1.72))     # brows, ears
    blob(bm, (.010, .014, .020), (0, -.108, 1.715)); blob(bm, (.026, .006, .005), (0, -.097, 1.668))                        # nose, mouth
def hair(bm):
    sphere(bm); xf(bm, (.096, .113, .122), HC + Vector((0, .006, .012))); cut_below(bm, HC.z+.03)
gear_obj("Face_Details", "Head", M_FEAT, face); gear_obj("Face_Hair", "Head", M_HAIR, hair)
digits = bpy.data.images.load(ROOT+"/players/number_digits.png"); digits.pack()
M_NUM = bpy.data.materials.new("jersey_number"); M_NUM.use_nodes = True; nb = M_NUM.node_tree.nodes["Principled BSDF"]
tx = M_NUM.node_tree.nodes.new("ShaderNodeTexImage"); tx.image = digits; tx.extension = 'CLIP'
M_NUM.node_tree.links.new(tx.outputs["Color"], nb.inputs["Base Color"]); M_NUM.node_tree.links.new(tx.outputs["Alpha"], nb.inputs["Alpha"]); nb.inputs["Roughness"].default_value = 0.8
M_NUM.surface_render_method = 'BLENDED'
def number_quad(name, cx, digit):
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); w, zb, zt, y = .0375, 1.215, 1.335, .137
    vs = [bm.verts.new((cx+w, y, zb)), bm.verts.new((cx-w, y, zb)), bm.verts.new((cx-w, y, zt)), bm.verts.new((cx+w, y, zt))]
    f = bm.faces.new(vs); u0, u1 = digit/10.0, (digit+1)/10.0
    for lp, uv in zip(f.loops, ((u0, 0), (u1, 0), (u1, 1), (u0, 1))): lp[uvl].uv = uv
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.materials.append(M_NUM)
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    vg = o.vertex_groups.new(name=PFX+"Spine1"); vg.add(list(range(4)), 1.0, 'REPLACE'); o.parent = arm
    md = o.modifiers.new("Armature", 'ARMATURE'); md.object = arm; gear[name] = o
number_quad("Gear_Number_Tens", .04, 2); number_quad("Gear_Number_Ones", -.04, 7)
acts = bake_clips(arm)
arm.animation_data.action = acts["idle"]
# ---- variants
def setc(name, col): MATS[name].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = col
VARIANTS = {
 "player_base": (dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), cap=(.05, .08, .3, 1), helmet=(.05, .08, .3, 1)),
                 ["Gear_Cap", "Gear_Helmet", "Gear_Glove", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R", "Gear_Number_Tens", "Gear_Number_Ones", "Face_Details", "Face_Hair"]),
 "player_home": (dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), cap=(.05, .08, .3, 1)), ["Gear_Cap", "Gear_Glove", "Gear_Number_Tens", "Gear_Number_Ones", "Face_Details", "Face_Hair"]),
 "player_away": (dict(uniform_jersey=(.30, .33, .38, 1), uniform_pants=(.35, .37, .40, 1), uniform_socks=(.5, .03, .03, 1), cap=(.5, .03, .03, 1)), ["Gear_Cap", "Gear_Glove", "Gear_Number_Tens", "Gear_Number_Ones", "Face_Details", "Face_Hair"]),
 "player_batter": (dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), helmet=(.05, .08, .3, 1)), ["Gear_Helmet", "Gear_Number_Tens", "Gear_Number_Ones", "Face_Details", "Face_Hair"]),
 "player_catcher": (dict(uniform_jersey=(.8, .8, .8, 1), uniform_pants=(.75, .75, .75, 1), uniform_socks=(.05, .08, .3, 1), helmet=(.05, .08, .3, 1)),
                    ["Gear_Helmet", "Gear_Glove", "Gear_CatcherMask", "Gear_ChestProtector", "Gear_ShinGuard_L", "Gear_ShinGuard_R", "Face_Details", "Face_Hair"]),
 "player_umpire": (dict(uniform_jersey=(.03, .03, .035, 1), uniform_pants=(.22, .23, .25, 1), uniform_socks=(.02, .02, .02, 1), cap=(.02, .02, .02, 1), helmet=(.02, .02, .02, 1)),
                   ["Gear_Cap", "Gear_CatcherMask", "Gear_ChestProtector", "Face_Details", "Face_Hair"]),
}
os.makedirs(ROOT+"/players", exist_ok=True)
info = {}
for vn, (cols, gl) in VARIANTS.items():
    for k, c in cols.items(): setc(k, c)
    bpy.ops.object.select_all(action='DESELECT')
    sel = [arm, body] + [gear[g] for g in gl]
    for o in sel: o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=ROOT+f"/players/{vn}.glb", use_selection=True, export_format='GLB', export_yup=True, export_image_format='JPEG',
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True, export_apply=False, export_force_sampling=True, export_frame_range=False)
    info[vn] = os.path.getsize(ROOT+f"/players/{vn}.glb")//1024
result = {"kb": info, "body_tris": len(body.data.polygons)*2 if False else len(body.data.polygons)}
