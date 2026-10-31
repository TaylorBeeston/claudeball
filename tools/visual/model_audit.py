# Player model audit (t-0038): close-up renders of one plain player GLB in fixed poses / builds / gear combinations, so a before / after pair of builds
# can be compared shot for shot (gloves, batting gloves, facial hair, helmet logo, lower body), plus numeric fit checks on the posed, skinned meshes.
#   GLB=assets/players/player_base.glb OUT=dir [ONLY=gloves,bgloves,...] [TAG=before] blender -b --factory-startup --python tools/visual/model_audit.py
# Writes OUT/<set>_<shot>.png, OUT/<set>.png (a labelled sheet per set) and OUT/metrics.json.
import bpy, bmesh, os, math, json, numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from PIL import Image, ImageDraw

E = os.environ; OUT = E["OUT"]; os.makedirs(OUT, exist_ok=True); TAG = E.get("TAG", "")
ONLY = set(filter(None, E.get("ONLY", "").split(",")))
RES = int(E.get("RES", "560"))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=E["GLB"], import_shading='NORMALS')
OB = bpy.data.objects
arm = next(o for o in OB if o.type == 'ARMATURE')
MESHES = [o for o in OB if o.type == 'MESH']
PFX = next((b.name[:-4] for b in arm.data.bones if b.name.endswith("Hips")), "")

sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE'; sc.eevee.taa_render_samples = 24
try: sc.view_settings.view_transform = 'Filmic'; sc.view_settings.look = 'Medium High Contrast'
except Exception: pass
w = bpy.data.worlds.new("w"); w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (.42, .46, .52, 1); w.node_tree.nodes["Background"].inputs[1].default_value = .9; sc.world = w
sun = OB.new("sun", bpy.data.lights.new("sun", 'SUN')); sun.data.energy = 3.2; sun.rotation_euler = (.75, .15, .55); sc.collection.objects.link(sun)
fill = OB.new("fill", bpy.data.lights.new("fill", 'SUN')); fill.data.energy = .9; fill.rotation_euler = (1.2, 0, 3.6); sc.collection.objects.link(fill)
cam = OB.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam; cam.data.clip_start = .01
sc.render.resolution_x = sc.render.resolution_y = RES

# ---------------------------------------------------------------- scene state
def keys_of(o):
    sk = o.data.shape_keys if o.type == 'MESH' else None
    return sk.key_blocks if sk else {}
def set_morphs(m):
    for o in MESHES:
        kb = keys_of(o)
        for k in kb:
            if k.name == "Basis": continue
            k.value = m.get(k.name, 0.0)
def show(names):
    want = set(names)
    for o in MESHES: o.hide_render = o.name not in want
def action_for(clip):
    for a in bpy.data.actions:
        if a.name == clip or a.name.startswith(clip + "_") or a.name.split("|")[-1] == clip: return a
    raise KeyError(clip)
def pose(clip, frame):
    if not arm.animation_data: arm.animation_data_create()
    if clip is None: arm.data.pose_position = 'REST'; sc.frame_set(0); return
    arm.data.pose_position = 'POSE'; arm.animation_data.action = action_for(clip)
    try: arm.animation_data.action_slot = arm.animation_data.action_suitable_slots[0]
    except Exception: pass
    sc.frame_set(int(frame))
def bone_pos(name):
    pb = arm.pose.bones[PFX + name]; return arm.matrix_world @ pb.head
def look(target, az, el, dist, lens=85):
    """camera on a sphere round `target`: az = degrees round +Y (0 = in front of the model, which faces glTF +Z = Blender -Y), el = degrees up."""
    t = Vector(target); a, e = math.radians(az), math.radians(el)
    d = Vector((math.sin(a)*math.cos(e), -math.cos(a)*math.cos(e), math.sin(e)))
    cam.location = t + d*dist; cam.rotation_euler = (t - cam.location).to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = lens
def render(path):
    sc.render.filepath = path; bpy.ops.render.render(write_still=True); return path

SHEETS = {}
def shot(setname, name, target, az, el, dist, lens=85):
    look(target, az, el, dist, lens); p = render(os.path.join(OUT, f"{setname}_{name}.png")); SHEETS.setdefault(setname, []).append((name, p))
def sheet(setname, cols=4):
    items = SHEETS.get(setname, [])
    if not items: return
    ims = [Image.open(p).convert("RGB") for _, p in items]; w_, h_ = ims[0].size; rows = (len(ims) + cols - 1)//cols
    S = Image.new("RGB", (cols*w_, rows*(h_ + 22)), (24, 24, 28)); d = ImageDraw.Draw(S)
    for i, ((nm, _), im) in enumerate(zip(items, ims)):
        x, y = (i % cols)*w_, (i//cols)*(h_ + 22); S.paste(im, (x, y + 22)); d.text((x + 6, y + 5), f"{TAG} {setname}: {nm}", fill=(235, 235, 235))
    S.save(os.path.join(OUT, f"{setname}.png"))

# ---------------------------------------------------------------- numeric checks on the evaluated (posed, morphed) meshes
def world_verts(o):
    dg = bpy.context.evaluated_depsgraph_get(); ev = o.evaluated_get(dg); me = ev.to_mesh()
    P = np.array([(o.matrix_world @ v.co)[:] for v in me.vertices]); ev.to_mesh_clear(); return P
def bvh_world(o):
    dg = bpy.context.evaluated_depsgraph_get(); ev = o.evaluated_get(dg); me = ev.to_mesh()
    bm = bmesh.new(); bm.from_mesh(me); bm.transform(o.matrix_world); bm.normal_update(); t = BVHTree.FromBMesh(bm); bm.free(); ev.to_mesh_clear(); return t
def poke(inner, outer, near=None, band=None):
    """vertices of `inner` that lie outside the closed-ish shell `outer` while within `band` m of it (signed by outer's normal): skin poking through gear.
    Returns (count over the tested vertices, worst depth in mm). `near`: only test inner vertices within this distance of point(s) (a region)."""
    P = world_verts(OB[inner]); t = bvh_world(OB[outer]); n = 0; worst = 0.0; tested = 0
    for p in P:
        if near is not None and min((Vector(p) - Vector(c)).length for c in near[0]) > near[1]: continue
        loc, nrm, i, d = t.find_nearest(Vector(p))
        if loc is None or (band and d > band): continue
        tested += 1; s = (Vector(p) - loc).dot(nrm)
        if s > 0: n += 1; worst = max(worst, s)
    return dict(out=n, tested=tested, worst_mm=round(worst*1000, 1))
METRICS = {}
def metric(k, v): METRICS[k] = v; print("METRIC", k, v)

names = {o.name for o in MESHES}
HEAD = ["Head", "Eyes", "Gear_Eyebrows", "Gear_Eyelashes", "Body_Skin"]
BODY = ["Body_Skin", "Head", "Eyes", "Gear_Eyebrows", "Gear_Eyelashes", "Jersey", "Undershirt", "Pants", "Socks", "Cleats", "Gear_Soles", "Gear_Spikes", "Gear_Laces", "Gear_Belt", "Gear_BeltBuckle",
        "Gear_Collar", "Gear_Piping", "Gear_Buttons", "Jersey_BackNumberDecal", "Jersey_BackNameDecal", "Jersey_FrontNumberDecal", "Jersey_SleeveNumberDecal"]
BODY = [n for n in BODY if n in names]
want = lambda s: not ONLY or s in ONLY

# ---------------------------------------------------------------- batting gloves (fist on the bat; relaxed while running)
if want("bgloves") and "Gear_BattingGlove_R" in names:
    rel = "Gear_BattingGlove_R_Relaxed" in names
    for clip, fr, hands, tag in (("batting_stance", 0, ["Hand_L", "Hand_R", "Gear_BattingGlove_L", "Gear_BattingGlove_R"], "stance"),
                                 ("swing", 21, ["Hand_L", "Hand_R", "Gear_BattingGlove_L", "Gear_BattingGlove_R"], "contact"),
                                 ("swing", 30, ["Hand_L", "Hand_R", "Gear_BattingGlove_L", "Gear_BattingGlove_R"], "finish"),
                                 ("run", 4, ["Hand_L_Relaxed", "Hand_R_Relaxed"] + (["Gear_BattingGlove_L_Relaxed", "Gear_BattingGlove_R_Relaxed"] if rel else ["Gear_BattingGlove_L", "Gear_BattingGlove_R"]), "run")):
        pose(clip, fr); set_morphs({}); show(BODY + [h for h in hands if h in names] + ["Gear_Helmet"])
        for side in ("Right", "Left"):
            c = bone_pos(side + "Hand"); fa = bone_pos(side + "ForeArm"); c2 = c + (c - fa).normalized()*.05
            for az in (0, 90, 180, 270): shot("bgloves", f"{tag}_{side[0]}_{az}", c2, az + (0 if side == "Right" else 0), 15, .55, 85)
        # skin through the glove: hand vertices outside the glove; wrist skin between cuff and sleeve
        for side, s in (("Right", "R"), ("Left", "L")):
            gl = f"Gear_BattingGlove_{s}_Relaxed" if (tag == "run" and rel) else f"Gear_BattingGlove_{s}"
            hd = f"Hand_{s}_Relaxed" if tag == "run" else f"Hand_{s}"
            if gl in names and hd in names: metric(f"bglove_{tag}_{s}_hand_out", poke(hd, gl, band=.02))
    sheet("bgloves", 8)

# ---------------------------------------------------------------- fielding gloves and the catcher's mitt
GL = [(k, n) for k, n in (("infield", "Gear_Glove"), ("outfield", "Gear_Glove_Outfield"), ("firstbase", "Gear_Glove_FirstBase"), ("catcher", "Gear_Glove_Catcher")) if n in names]
if want("gloves") and GL:
    ball = None
    for kind, n in GL:
        laces = n + "_Laces"; hand = "Hand_L_Open_Catcher" if kind == "catcher" and "Hand_L_Open_Catcher" in names else "Hand_L_Open"
        for state, m in (("open", {"glove_open": 1.0}), ("neutral", {}), ("closed", {"glove_closed": 1.0})):
            pose(None, 0); set_morphs(m); show([n, laces] + (["Body_Skin", "Undershirt"] if state == "neutral" else []))
            c = bone_pos("LeftHand"); fa = bone_pos("LeftForeArm"); ax = (c - fa).normalized(); cc = c + ax*.10
            if state == "neutral":
                for az, el in ((90, 10), (30, 20), (-30, 10), (180, 10), (270, 20), (90, 70)): shot("gloves", f"{kind}_{state}_{az}_{el}", cc, az, el, .75, 85)
            else:
                for az, el in ((90, 10), (270, 20)): shot("gloves", f"{kind}_{state}_{az}_{el}", cc, az, el, .75, 85)
        set_morphs({})
        tri = len(OB[n].data.polygons); metric(f"glove_{kind}_tris", tri)
        if hand in names: pose(None, 0); metric(f"glove_{kind}_hand_out", poke(hand, n, band=.03))
    # the catcher in his crouch, the shortstop ready
    for clip, fr, kind, tag in (("catcher_crouch", 0, "catcher", "crouch"), ("field_ready_infield", 0, "infield", "ready"), ("catch_fly", 12, "outfield", "fly")):
        n = dict(GL).get(kind)
        if not n: continue
        pose(clip, fr); set_morphs({}); show(BODY + [n, n + "_Laces", "Gear_Cap", "Hand_R_Relaxed" if "Hand_R_Relaxed" in names else "Hand_R"])
        c = bone_pos("LeftHand")
        for az in (0, 60, 300): shot("gloves", f"{tag}_{az}", c, az, 15, 1.1, 70)
    sheet("gloves", 6)

# ---------------------------------------------------------------- facial hair with cap / helmet, in head-down / turned poses, mouth open
FH = [n for n in ("Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee") if n in names]
if want("facial") and FH:
    for fh in FH:
        for wear in ("Gear_Cap", "Gear_Helmet"):
            for clip, fr, m, tag in (("idle", 0, {}, "idle"), ("batting_stance", 0, {"jaw_open": 1.0}, "stance_jaw"), ("catcher_crouch", 0, {}, "crouch")):
                pose(clip, fr); set_morphs(m); show(BODY + [fh, wear] + (["Gear_CapLogo"] if wear == "Gear_Cap" else ["Gear_HelmetLogo"]))
                h = bone_pos("Head") + Vector((0, 0, .06))
                fwd = arm.matrix_world.to_3x3() @ (arm.pose.bones[PFX + "Head"].matrix.to_3x3() @ Vector((0, 0, 1)))
                for az in (20, 75, 140):
                    if wear == "Gear_Helmet" and tag == "crouch": continue
                    shot("facial", f"{fh[5:]}_{wear[5:]}_{tag}_{az}", h, az, 8, .75, 85)
        # facial hair against the jersey / collar when the chin drops: vertices of the beard inside the jersey or the collar
        pose("catcher_crouch", 0); set_morphs({"jaw_open": 1.0})
        for gear in ("Jersey", "Gear_Collar"):
            if gear in names: metric(f"{fh}_vs_{gear}_crouch", poke(fh, gear, band=.01))
    sheet("facial", 6)

# ---------------------------------------------------------------- helmet / cap logo
if want("logo"):
    pose(None, 0); set_morphs({})
    for wear, logo in (("Gear_Helmet", "Gear_HelmetLogo"), ("Gear_Cap", "Gear_CapLogo")):
        if wear not in names: continue
        show(HEAD + [wear, logo]); h = bone_pos("Head") + Vector((0, 0, .08))
        for az in (0, 35): shot("logo", f"{wear[5:]}_{az}", h, az, 10, .7, 85)
    sheet("logo", 4)

# ---------------------------------------------------------------- lower body: belt, waist, pants, socks, cleats, at every build and in the big poses
if want("lower"):
    for build in ("", "build_lean", "build_stocky", "build_muscular", "build_heavy"):
        if build and not any(build in keys_of(o) for o in MESHES): continue
        pose("idle", 0); set_morphs({build: 1.0} if build else {}); show(BODY + ["Gear_Cap", "Gear_CapLogo", "Hand_L_Relaxed", "Hand_R_Relaxed"])
        hip = bone_pos("Hips") + Vector((0, 0, -.25))
        for az in (0, 90, 180): shot("lower", f"{build or 'base'}_idle_{az}", hip, az, 5, 2.0, 70)
        w_ = bone_pos("Hips") + Vector((0, 0, -.02))
        for az in (20, 160): shot("lower", f"{build or 'base'}_waist_{az}", w_, az, 15, .9, 85)
    set_morphs({})
    for clip, fr, tag in (("batting_stance", 0, "stance"), ("run", 4, "run"), ("slide", 14, "slide"), ("catcher_crouch", 0, "crouch"), ("catch_stretch", 14, "lunge")):
        try: pose(clip, fr)
        except KeyError: continue
        show(BODY + ["Gear_Cap", "Gear_CapLogo", "Hand_L_Relaxed", "Hand_R_Relaxed"]); hip = bone_pos("Hips") + Vector((0, 0, -.2))
        for az in (30, 120, 210, 300): shot("lower", f"{tag}_{az}", hip, az, 8, 2.2, 70)
    sheet("lower", 6)

json.dump({"glb": E["GLB"], "tag": TAG, "metrics": METRICS}, open(os.path.join(OUT, "metrics.json"), "w"), indent=1)
print("AUDIT_DONE", OUT)
