# Stage-1 face lab (scratch, no repo binaries): imports the plain player_base.glb, applies a candidate face style (MPFB shaping deltas from
# face_targets.npz, eye globe / iris, skin treatment, brows, toon), adds expression keys from the MPFB expression units, and renders head crops at the
# director's real framings (batterFace 0.95 m, pitcherFace 2.0 m, onDeck 4.6 m frame height at 1080p), day and night.
#   GLB=... SRC=<repo assets/src> FT=face_targets.npz OUT=dir CAND=C0|A|B|C blender -b --factory-startup --python facelab.py
import bpy, bmesh, os, math, re, json, time, numpy as np
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree
from scipy.ndimage import gaussian_filter
E = os.environ; OUT = E["OUT"]; CAND = E.get("CAND", "C0"); SRC = E["SRC"]; os.makedirs(OUT, exist_ok=True)
ONLY = E.get("ONLY", "")                                          # comma list of render tags to limit (debug)
src = open(SRC + "/player_mpfb.py").read()
a, b = src.index("EYE_COLORS = dict("), src.index("def build_eyes():")
from PIL import Image
exec(src[a:b].replace("ir, pr = 29.0, 9.5", "ir, pr = IRIS"))      # _noise2 + eye_equirect with the iris / pupil size as a parameter

# ------------------------------------------------------------------------------------------------ candidates
LR0 = lambda k, v: {k.replace("SIDE", "left"): v, k.replace("SIDE", "right"): v}
SYM = lambda d: {**{("l_" + k): v for k, v in d.items()}, **{("r_" + k): v for k, v in d.items()}}
CANDS = {
 "C0": dict(label="current (control)", style={}, eye_s=1.0, iris=(29.0, 9.5), blur=0, nrm=1.0, brow=0.0, lash=0.0, gain=1.0, paint=0.0, toon=False, iris_flat=0.0),
 "A": dict(label="A: clean broadcast", eye_s=1.06, iris=(33.0, 10.5), blur=5, nrm=0.35, brow=0.5, lash=0.4, gain=1.3, paint=0.35, toon=False, iris_flat=0.3,
           style={**SYM(dict(eye_scale_incr=1.3, eye_height2_incr=.5, eye_bag_decr=.8, ear_scale_decr=.3)), "head_age_decr": .6, "nose_volume_decr": .3, **LR0("x_eye_SIDE_closure", .10),
                  "mouth_upperlip_volume_incr": .4, "mouth_lowerlip_volume_incr": .3}),
 "B": dict(label="B: stylized sculpt", eye_s=1.12, iris=(37.0, 12.5), blur=16, nrm=0.12, brow=1.3, lash=1.2, gain=1.8, paint=1.0, toon=False, iris_flat=0.75,
           style={**SYM(dict(eye_scale_incr=2.6, eye_height2_incr=.9, eye_height1_incr=.5, eye_bag_decr=1.0, ear_scale_decr=.7, ear_flap_decr=.5, cheek_bones_incr=.7)), "chin_width_incr": .3,
                  "head_age_decr": 1.0, **LR0("x_eye_SIDE_closure", .2), "nose_scale_horiz_decr": .4, "nose_volume_decr": .7, "nose_point_up": .5, "nose_hump_decr": 1.0, "nose_flaring_decr": .6,
                  "mouth_upperlip_volume_incr": .8, "mouth_lowerlip_volume_incr": .7, "mouth_cupidsbow_incr": .6, "chin_prominent_incr": .6, "nose_scale_depth_decr": .3, "mouth_laugh_lines_in": .5,
                  "eyebrows_trans_forward": .4}),
 "C": dict(label="C: graphic toon", eye_s=1.24, iris=(40.0, 14.0), blur=24, nrm=0.0, brow=1.6, lash=1.4, gain=2.0, paint=1.0, toon=True, iris_flat=1.0,
           style={**SYM(dict(eye_scale_incr=3.8, eye_height2_incr=1.4, eye_height1_incr=.8, eye_bag_decr=1.0, ear_scale_decr=.8, ear_flap_decr=.6, cheek_bones_incr=.8)),
                  "head_age_decr": 1.0, **LR0("x_eye_SIDE_closure", .26), "nose_scale_horiz_decr": .6, "nose_scale_vert_decr": .4, "nose_volume_decr": 1.0, "nose_point_up": .7, "nose_hump_decr": 1.0, "nose_flaring_decr": .8,
                  "mouth_upperlip_volume_incr": .6, "mouth_lowerlip_volume_incr": .9, "chin_prominent_incr": .7, "head_round": .3, "eyebrows_trans_forward": .5}),
}
CFG = CANDS[CAND]
# the six faces: skin tone, eye colour, hair node / colour, facial hair, headwear, head shape keys
FACES = [
 dict(id="F1", tone="#f4d2b8", eye="blue", hair="Gear_Hair", hc="#5a3a22", fh=None, wear="cap", keys=dict(head_narrow=.4)),
 dict(id="F2", tone="#6f4229", eye="brown", hair="Gear_Hair_Buzz", hc="#141110", fh=None, wear="helmet", keys=dict(head_wide=.3, jaw_square=.6)),
 dict(id="F3", tone="#c48858", eye="brown", hair="Gear_Hair_Curly", hc="#1b1612", fh="Gear_Beard_Full", wear="cap", keys=dict(nose_large=.5, cheeks_full=.3)),
 dict(id="F4", tone="#d8a276", eye="hazel", hair=None, hc="#2a1d14", fh="Gear_Goatee", wear="catcher", keys=dict(chin_strong=.5)),
 dict(id="F5", tone="#e8bb98", eye="gray", hair="Gear_Hair_Receding", hc="#a7a39c", fh="Gear_Mustache", wear=None, keys=dict(brow_heavy=.5, ears_large=.4)),
 dict(id="F6", tone="#a96c44", eye="hazel", hair="Gear_Hair_SidePart", hc="#2b1b10", fh="Gear_Beard_Stubble", wear="cap", keys=dict(jaw_square=.3, nose_narrow=.4), eyeblack=True),
]
# expressions as weights on the MPFB expression units (x_*) and the file's own keys; L/R units listed once per side
def LR(k, v): return {k.replace("SIDE", "left"): v, k.replace("SIDE", "right"): v}
EXPR = {
 "neutral": {},
 "joy": {**LR("x_eyebrows_SIDE_up", .35), **LR("x_eye_SIDE_slit", .45), "x_mouth_corner_puller": 1.0, "x_mouth_elevation": .4, "mouth_open": .35},
 "shout": {**LR("x_eyebrows_SIDE_down", .8), **LR("x_eye_SIDE_slit", .5), "mouth_open": 1.0, "x_mouth_upward_retraction": .6, "x_mouth_corner_puller": .4, **LR("x_nose_SIDE_elevation", .5)},
 "anger": {**LR("x_eyebrows_SIDE_down", 1.0), **LR("x_eye_SIDE_slit", .35), "x_mouth_compression": .8, **LR("x_nose_SIDE_elevation", .6), "x_mouth_depression": .3},
 "dejected": {**LR("x_eyebrows_SIDE_inner_up", 1.0), **LR("x_eye_SIDE_closure", .25), "x_mouth_depression": 1.0, "x_mouth_compression": .3},
 "shock": {**LR("x_eyebrows_SIDE_up", 1.0), **LR("x_eye_SIDE_opened_up", 1.0), "mouth_open": .7},
 "wince": {**LR("x_eyebrows_SIDE_down", .6), **LR("x_eyebrows_SIDE_inner_up", .5), **LR("x_eye_SIDE_closure", .7), "x_mouth_retraction": .8, "x_mouth_upward_retraction": .4, "mouth_open": .2},
}

# ------------------------------------------------------------------------------------------------ scene
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=E["GLB"], import_shading='NORMALS')
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE'); arm.data.pose_position = 'REST'
for o in bpy.data.objects:
    if o.type == 'MESH': o.hide_render = True; o.hide_viewport = False
OB = bpy.data.objects
base = np.load(SRC + "/mpfb/base_body.npz"); P = base["P"]
FT = dict(np.load(E["FT"]))
NECK_CUT = 1.585
qd, nq = base["quads"], base["nq"]
fc = np.array([P[qd[i, :nq[i]]].mean(0) for i in range(len(qd))])
hv = np.unique(np.concatenate([qd[i, :nq[i]] for i in np.where(fc[:, 2] >= NECK_CUT - .03)[0]]))
kd = KDTree(len(hv))
for j, v in enumerate(hv): kd.insert(Vector(P[v]), j)
kd.balance()
ring = P[np.abs(P[:, 2] - NECK_CUT) < .006]; neck_c = ring[:, :2].mean(0)
def seam_fade(X):
    r = np.hypot(X[:, 0] - neck_c[0], X[:, 1] - neck_c[1]); z = X[:, 2]
    sm = lambda a_, b_, x: (lambda t: t*t*(3 - 2*t))(np.clip((x - a_)/(b_ - a_), 0, 1))
    return 1 - (1 - sm(1.594, 1.625, z))*(1 - sm(.095, .11, r))
_nc = {}
def neigh(X, exact=False):
    key = (len(X), float(X.sum()));
    if key in _nc: return _nc[key]
    idx = np.zeros((len(X), 4), int); w = np.zeros((len(X), 4))
    for i, p in enumerate(X):
        hits = kd.find_n(Vector(p), 1 if exact else 4)
        for k, (co, j, d) in enumerate(hits): idx[i, k] = hv[j]; w[i, k] = 1.0/(d*d + 1e-9)
        w[i] /= w[i].sum()
        if not exact: w[i] *= math.exp(-(max(0.0, hits[0][2] - .008)/.06)**2)
    _nc[key] = (idx, w); return idx, w
def field(X, D, exact=False):
    idx, w = neigh(X, exact); return (D[idx]*w[:, :, None]).sum(1)*seam_fade(X)[:, None]
def keyco(o, name="Basis"):
    kb = o.data.shape_keys.key_blocks[name]; a_ = np.zeros(len(kb.data)*3, np.float32); kb.data.foreach_get("co", a_); return a_.reshape(-1, 3).astype(np.float64)
def setkey(o, name, X, val=0.0):
    if o.data.shape_keys is None: o.shape_key_add(name="Basis", from_mix=False)
    kb = o.data.shape_keys.key_blocks.get(name) or o.shape_key_add(name=name, from_mix=False)
    kb.data.foreach_set("co", X.astype(np.float32).ravel()); kb.slider_min = -1; kb.slider_max = 2; kb.value = val; return kb
def basis(o):
    if o.data.shape_keys: return keyco(o)
    return np.array([v.co[:] for v in o.data.vertices])

# style delta on the base mesh vertices
D_style = np.zeros_like(P)
for k, v in CFG["style"].items(): D_style += FT[k]*v
HEADLIKE = ["Head", "Gear_Eyebrows", "Gear_Eyelashes", "Gear_Teeth", "Gear_Tongue", "Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee", "Gear_EyeBlack",
            "Gear_Cap", "Gear_CapLogo", "Gear_Helmet", "Gear_HelmetLogo", "Gear_Helmet_Catcher", "Gear_CatcherMask"] + [o.name for o in OB if o.name.startswith("Gear_Hair")]
for n in HEADLIKE:
    o = OB.get(n)
    if not o: continue
    X = basis(o); exact = n == "Head"
    if np.abs(D_style).max() > 0:
        d = field(X, D_style, exact)
        if n == "Head": print("HEADMAP max dist", max(h[2] for h in [kd.find(Vector(p)) for p in X[::50]]))
        for kb in o.data.shape_keys.key_blocks if o.data.shape_keys else []:
            Y = keyco(o, kb.name); kb.data.foreach_set("co", (Y + d).astype(np.float32).ravel())
        if not o.data.shape_keys:
            for i, vv in enumerate(o.data.vertices): vv.co = Vector(X[i] + d[i])
# expression keys (MPFB units) on the head (exact map), brows / lashes / beards / eye black (field); gain = the candidate's exaggeration
XKEYS = sorted({k for e in EXPR.values() for k in e if k.startswith("x_")} | {"x_mouth_open"})
for n in ("Head", "Gear_Eyebrows", "Gear_Eyelashes", "Gear_Beard_Full", "Gear_Beard_Stubble", "Gear_Mustache", "Gear_Goatee", "Gear_EyeBlack"):
    o = OB.get(n)
    if not o: continue
    X = keyco(o)
    for k in XKEYS: setkey(o, k, X + field(X, FT[k], n == "Head"))
for n in ("Gear_Teeth", "Gear_Tongue"):
    o = OB.get(n); X = keyco(o); D = FT["x_mouth_open"]; xm = np.abs(P[:, 0]) < .02
    lo = D[xm & (P[:, 2] > 1.635) & (P[:, 2] < 1.652) & (P[:, 1] < -.14)].mean(0); Y = X.copy(); Y[X[:, 2] < 1.656] += lo; setkey(o, "x_mouth_open", Y)
if CAND != "C0":                                                      # stage-2 mouth bag preview: a dark cavity behind the lips
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, -.100, 1.646)); mb = bpy.context.object; mb.name = "MouthBag"; mb.scale = (.022, .030, .020)
    mm = bpy.data.materials.new("mouthbag"); mm.use_nodes = True; _b = next(n for n in mm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'); _b.inputs["Base Color"].default_value = (.08, .015, .015, 1); _b.inputs["Roughness"].default_value = .6; mb.data.materials.append(mm)
if CAND != "C0":                                                      # stage-2 preview: the MPFB inner-lip / mouth faces get the dark cavity material (they stretched into a pale sheet)
    hd = OB["Head"]; hd.data.materials.append(mm); Xh = keyco(hd); k_ = len(hd.data.materials) - 1; nin = 0; DARK = []
    Xo = keyco(hd, "x_mouth_open"); Xo = Xh + (Xo - Xh)*.75
    def area(X, vs): a_ = X[vs[1]] - X[vs[0]]; b_ = X[vs[2]] - X[vs[0]]; return np.linalg.norm(np.cross(a_, b_))
    for poly in hd.data.polygons:
        vs = list(poly.vertices); c = Xh[vs].mean(0)
        grow = area(Xo, vs)/max(area(Xh, vs), 1e-12)
        if (abs(c[0]) < .03 and 1.625 < c[2] < 1.67 and c[1] > -.147) or (grow > 2.5 and abs(c[0]) < .035 and 1.62 < c[2] < 1.675): DARK.append(poly.index); nin += 1
    print("MOUTHFACES", nin)
# eye globes: bigger about each centre (all keys)
EYE_C = {1: np.array([.032, -.138, 1.732]), -1: np.array([-.032, -.138, 1.732])}
for n in ("Eyes", "Eyes_Cornea"):
    o = OB[n]
    for kb in o.data.shape_keys.key_blocks:
        Y = keyco(o, kb.name); s = np.where(Y[:, 0] > 0, 1, -1); C = np.stack([EYE_C[int(x)] for x in s]); kb.data.foreach_set("co", (C + (Y - C)*CFG["eye_s"]).astype(np.float32).ravel())
# brows: thicker about their own centre line (vertical), lashes: thicker downward-outward
def thicken(o, k):
    if k <= 0: return
    for kb in o.data.shape_keys.key_blocks:
        Y = keyco(o, kb.name); out = Y.copy()
        for sx in (1, -1):
            m = (Y[:, 0]*sx) > 0
            if not m.any(): continue
            zc = np.polyval(np.polyfit(Y[m, 0], Y[m, 2], 2), Y[m, 0]); out[m, 2] = zc + (Y[m, 2] - zc)*(1 + k)
        kb.data.foreach_set("co", out.astype(np.float32).ravel())
thicken(OB["Gear_Eyebrows"], .45*CFG["brow"])

# ------------------------------------------------------------------------------------------------ materials
def hexrgb(h): h = h.lstrip("#"); return tuple((int(h[i:i + 2], 16)/255.0)**2.2 for i in (0, 2, 4)) + (1.0,)
def mixnode(m): return next(n for n in m.node_tree.nodes if n.type == 'MIX')
def mixB(m): return next(i for i in mixnode(m).inputs if i.name == "B" and i.type == 'RGBA')
def bsdf(m): return next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
skin_mats = [bpy.data.materials["face"], bpy.data.materials["skin"]]
alb = bpy.data.images["skin_albedo"]
if CFG["blur"]:
    w_, h_ = alb.size; px = np.zeros(w_*h_*4, np.float32); alb.pixels.foreach_get(px); px = px.reshape(h_, w_, 4)
    mean = px[..., :3].reshape(-1, 3).mean(0)
    sm = np.stack([gaussian_filter(px[..., c], CFG["blur"]) for c in range(3)], -1)
    lo = gaussian_filter(sm, 60)                                     # painted: keep the big tone zones (lips, cheeks, brows shadow), lose pores / blotches
    k = min(1.0, CFG["blur"]/16)
    newc = sm*(1 - .5*k) + lo*(.5*k)
    px[..., :3] = newc; alb2 = bpy.data.images.new("skin_albedo_style", w_, h_); alb2.pixels.foreach_set(px.ravel())
    for m in skin_mats:
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image == alb: n.image = alb2
for m in skin_mats:
    for n in m.node_tree.nodes:
        if n.type == 'NORMAL_MAP': n.inputs["Strength"].default_value = CFG["nrm"]
    bsdf(m).inputs["Specular IOR Level"].default_value = .5 - .2*CFG["paint"]
# painted warmth (stylized): vertex colours on the head: cheeks, nose tip, ears, lips warmer; upper lid darker
head = OB["Head"]
if CFG["paint"] > 0:
    X = keyco(head); col = np.ones((len(X), 3))
    def blob(c, r, rgb, s):
        d = np.linalg.norm((X - np.array(c))/np.array(r), axis=1); w = np.exp(-d*d)*s
        return w[:, None]*(np.array(rgb) - 1)
    pk = CFG["paint"]
    for sx in (1, -1):
        col += blob((sx*.045, -.125, 1.69), (.022, .02, .02), (1.0, .82, .78), .55*pk)          # cheeks
        col += blob((sx*.088, -.06, 1.725), (.012, .03, .03), (1.0, .8, .76), .5*pk)             # ears
        col += blob((sx*.032, -.135, 1.744), (.016, .02, .006), (.66, .60, .57), .7*pk)          # upper lid / lash line
    col += blob((0, -.185, 1.684), (.012, .012, .01), (1.0, .84, .8), .5*pk)                     # nose tip
    col += blob((0, -.152, 1.648), (.02, .02, .009), (.86, .64, .62), .7*pk)                     # lips
    me = head.data; ca = me.color_attributes.new("paint", 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set("color", np.c_[np.clip(col, 0, 1), np.ones(len(X))].astype(np.float32).ravel())
    m = bpy.data.materials["face"]; nt = m.node_tree; vc = nt.nodes.new("ShaderNodeVertexColor"); vc.layer_name = "paint"
    mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1.0
    mx = mixnode(m); out = mx.outputs[2]; tgt = [l.to_socket for l in out.links]
    nt.links.new(out, mul.inputs[6]); nt.links.new(vc.outputs["Color"], mul.inputs[7])
    for t in tgt: nt.links.new(mul.outputs[2], t)
# eye texture
def eye_img(color):
    global IRIS
    IRIS = CFG["iris"]; arr = eye_equirect(color)
    if CFG["iris_flat"] > 0:
        H, W = arr.shape[:2]; th = (np.arange(H) + .5)/H*180.0; ir, pr = IRIS
        dark, light = (np.array(c, np.float32) for c in EYE_COLORS[color])
        r = np.clip((th - pr)/(ir - pr), 0, 1)[:, None, None]
        flat = dark*.55 + light*.45 + (light - dark)*.35*(1 - r)                          # clean radial gradient, light toward the pupil
        flat = flat*(1 - .8*np.clip((r - .8)/.2, 0, 1)**1.2)                               # strong dark limbal ring
        flat = np.broadcast_to(flat, arr.shape)
        isir = ((th > pr) & (th < ir))[:, None, None]
        sclera = np.array([.86, .85, .82], np.float32)
        isscl = (th >= ir)[:, None, None]
        f = CFG["iris_flat"]
        arr = np.where(isir, arr*(1 - f) + flat*f, arr); arr = np.where(isscl, arr*(1 - f) + sclera*f, arr)
    H, W = arr.shape[:2]; img = bpy.data.images.new("eye_" + color, W, H); img.pixels.foreach_set(np.c_[arr[::-1].reshape(-1, 3), np.ones(H*W)].astype(np.float32).ravel()); return img
EYEIMG = {}
eye_tex = next(n for n in bpy.data.materials["eye"].node_tree.nodes if n.type == 'TEX_IMAGE')
# brows / lashes: darker, more opaque
for mn, k in (("eyebrow", CFG["brow"]), ("eyelash", CFG["lash"])):
    m = bpy.data.materials[mn]; nt = m.node_tree; b_ = bsdf(m)
    if k > 0 and b_.inputs["Alpha"].is_linked:
        src_ = b_.inputs["Alpha"].links[0].from_socket; pw = nt.nodes.new("ShaderNodeMath"); pw.operation = 'POWER'; pw.inputs[1].default_value = 1/(1 + 1.2*k)
        nt.links.new(src_, pw.inputs[0]); nt.links.new(pw.outputs[0], b_.inputs["Alpha"])
# toon (C): diffuse -> shader to rgb -> 3-band ramp x albedo -> emission; outlines with an inverted hull
if CFG["toon"]:
    for m in skin_mats + [bpy.data.materials[n] for n in ("cap", "helmet", "hair", "hair_short01", "hair_afro01", "hair_short03", "hair_beard") if n in bpy.data.materials]:
        nt = m.node_tree; b_ = bsdf(m); outn = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        col_src = b_.inputs["Base Color"].links[0].from_socket if b_.inputs["Base Color"].is_linked else None
        dif = nt.nodes.new("ShaderNodeBsdfDiffuse"); s2r = nt.nodes.new("ShaderNodeShaderToRGB"); ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.interpolation = 'CONSTANT'; els = ramp.color_ramp.elements; els[0].position = 0; els[0].color = (.55, .50, .52, 1); els[1].position = .10; els[1].color = (.80, .77, .78, 1)
        e3 = els.new(.32); e3.color = (1, 1, 1, 1)
        nt.links.new(dif.outputs[0], s2r.inputs[0]); nt.links.new(s2r.outputs[0], ramp.inputs[0])
        mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1.0
        if col_src: nt.links.new(col_src, mul.inputs[6])
        else: mul.inputs[6].default_value = b_.inputs["Base Color"].default_value
        nt.links.new(ramp.outputs[0], mul.inputs[7])
        em = nt.nodes.new("ShaderNodeEmission"); nt.links.new(mul.outputs[2], em.inputs[0]); em.inputs[1].default_value = 1.0
        if b_.inputs["Alpha"].is_linked:
            mixs = nt.nodes.new("ShaderNodeMixShader"); tr = nt.nodes.new("ShaderNodeBsdfTransparent"); nt.links.new(b_.inputs["Alpha"].links[0].from_socket, mixs.inputs[0])
            nt.links.new(tr.outputs[0], mixs.inputs[1]); nt.links.new(em.outputs[0], mixs.inputs[2]); nt.links.new(mixs.outputs[0], outn.inputs[0])
        else: nt.links.new(em.outputs[0], outn.inputs[0])
    ink = bpy.data.materials.new("ink"); ink.use_nodes = True; ink.use_backface_culling = True
    bsdf(ink).inputs["Base Color"].default_value = (.02, .015, .015, 1); bsdf(ink).inputs["Roughness"].default_value = 1
    for o in [o for o in OB if o.type == 'MESH' and (o.name in ("Head", "Gear_Cap", "Gear_Helmet", "Gear_Helmet_Catcher", "Gear_Beard_Full") or o.name.startswith("Gear_Hair"))]:
        o.data.materials.append(ink); md = o.modifiers.new("ink", 'SOLIDIFY'); md.thickness = -.0010 if o.name == "Head" else -.0014; md.use_flip_normals = True; md.material_offset = len(o.data.materials) - 1
        for m in o.data.materials[:-1]: m.use_backface_culling = True
# skin subsurface off everywhere (closer to the engine's cheap rim), eyes glossy
bsdf(bpy.data.materials["eye"]).inputs["Roughness"].default_value = .12

# ------------------------------------------------------------------------------------------------ cap fit preview: lower, bill flatter (stage-2 build does it properly)
cap = OB.get("Gear_Cap"); logo = OB.get("Gear_CapLogo")
HC = np.array([0, -.065, 1.735])
for o in ([cap, logo] if CAND != "C0" else []):
    if o:
        for kb in o.data.shape_keys.key_blocks:
            Y = keyco(o, kb.name); zt = 1.867
            t = np.clip((zt - Y[:, 2])/(zt - 1.74), 0, 1); t = t*t*(3 - 2*t)
            bill = Y[:, 1] < -.150                                                    # the bill (in front of the forehead)
            out = Y.copy(); out[:, 2] -= .012*t
            r = Y[:, :2] - HC[:2]; out[:, :2] = HC[:2] + r*(1 + .03*t)[:, None]
            if bill.any():                                                            # flatter bill: rotate about its root line 4 deg down
                y0 = -.150; z0 = out[bill, 2].max(); ang = math.radians(4); dy = out[bill, 1] - y0; dz = out[bill, 2] - z0
                out[bill, 1] = y0 + dy*math.cos(ang) - dz*math.sin(ang); out[bill, 2] = z0 + dy*math.sin(ang) + dz*math.cos(ang)
            kb.data.foreach_set("co", out.astype(np.float32).ravel())
if CAND != "C0":                                                      # the lowered cap needs the hair under it pressed further in
    for o in OB:
        if o.name.startswith("Gear_Hair") and o.data.shape_keys and "hair_under_cap" in o.data.shape_keys.key_blocks:
            Y = keyco(o, "hair_under_cap"); d = Y - HC; r = np.linalg.norm(d, axis=1); t = np.clip((Y[:, 2] - 1.74)/.05, 0, 1); t = t*t*(3 - 2*t)
            Y = HC + d*((r - .016*t)/np.maximum(r, 1e-6))[:, None]; o.data.shape_keys.key_blocks["hair_under_cap"].data.foreach_set("co", Y.astype(np.float32).ravel())
# ------------------------------------------------------------------------------------------------ render setup
sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE'; sc.eevee.taa_render_samples = 48
try: sc.view_settings.view_transform = 'Filmic'; sc.view_settings.look = 'Medium High Contrast'
except Exception: pass
sc.render.film_transparent = False
world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True; wn = world.node_tree
env = wn.nodes.new("ShaderNodeTexEnvironment"); bg = wn.nodes["Background"]; wn.links.new(env.outputs[0], bg.inputs[0])
HDR = {"day": E["HDRI_DAY"], "night": E["HDRI_DUSK"]}
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN')); sc.collection.objects.link(sun)
fill = bpy.data.objects.new("fill", bpy.data.lights.new("fill", 'SUN')); sc.collection.objects.link(fill)
back = bpy.data.objects.new("back", bpy.data.lights.new("back", 'SUN')); sc.collection.objects.link(back)
def aim(o, az, el):
    d = Vector((math.sin(math.radians(az))*math.cos(math.radians(el)), -math.cos(math.radians(az))*math.cos(math.radians(el)), math.sin(math.radians(el))))
    o.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
def lighting(kind):
    env.image = bpy.data.images.load(HDR[kind], check_existing=True)
    if kind == "day":
        bg.inputs[1].default_value = .9; sun.data.energy = 3.2; sun.data.color = (1, .96, .9); aim(sun, -35, 52); sun.data.angle = math.radians(1.5)
        fill.data.energy = 0; back.data.energy = 0
    else:                                                                                  # two banks of tower lights, dark sky
        bg.inputs[1].default_value = .06; sun.data.energy = 2.6; sun.data.color = (1, .98, .95); aim(sun, -40, 30); sun.data.angle = math.radians(4)
        fill.data.energy = 1.2; fill.data.color = (.95, .97, 1); aim(fill, 55, 28); fill.data.angle = math.radians(4)
        back.data.energy = 1.0; aim(back, 160, 35)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0)); gp = bpy.context.object; gm = bpy.data.materials.new("grass"); gm.use_nodes = True
bsdf(gm).inputs["Base Color"].default_value = (.10, .20, .06, 1); bsdf(gm).inputs["Roughness"].default_value = .95; gp.data.materials.append(gm)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
FACE_C = Vector((0, -.09, 1.735)); WIN = .42
SPANS = {"close": .95, "mid": 2.0, "bcast": 4.6}
def frame(dist_kind, yaw=22, pitch=4):
    d = 8.0; span = SPANS[dist_kind]; px = int(round(WIN*1080/span))
    sc.render.resolution_x = sc.render.resolution_y = px; sc.render.resolution_percentage = 100
    v = Vector((math.sin(math.radians(yaw))*math.cos(math.radians(pitch)), -math.cos(math.radians(yaw))*math.cos(math.radians(pitch)), math.sin(math.radians(pitch))))
    cam.location = FACE_C + v*d; cam.rotation_euler = (-v).to_track_quat('-Z', 'Y').to_euler()
    cam.data.sensor_fit = 'VERTICAL'; cam.data.angle = 2*math.atan(WIN/2/d)
WEAR = {"cap": ["Gear_Cap", "Gear_CapLogo"], "helmet": ["Gear_Helmet", "Gear_HelmetLogo"], "catcher": ["Gear_Helmet_Catcher", "Gear_CatcherMask"], None: []}
CONTEXT = ["Body_Skin", "Jersey", "Undershirt", "Head", "Eyes", "Gear_Eyebrows", "Gear_Eyelashes", "Gear_Teeth", "Gear_Tongue", "MouthBag", "Plane"]
def set_keys(o, vals):
    if not o or not o.data.shape_keys: return
    for kb in o.data.shape_keys.key_blocks[1:]: kb.value = vals.get(kb.name, 0.0)
DARK = globals().get("DARK", [])
def dress(F, expr):
    for o in OB:
        if o.type == 'MESH': o.hide_render = True
    show = CONTEXT + WEAR[F["wear"]] + ([F["hair"]] if F["hair"] else []) + ([F["fh"]] if F["fh"] else []) + (["Gear_EyeBlack"] if F.get("eyeblack") else [])
    for n in show:
        if n in OB: OB[n].hide_render = False
    g = CFG["gain"]; gb = 1 + (g - 1)*2.0; ge = 1 + (g - 1)*1.3
    e = {k: v*(gb if k.startswith("x_eyebrows") else ge if k.startswith("x_eye_") else g) for k, v in EXPR[expr].items()}
    if CAND != "C0" and "mouth_open" in e: e["x_mouth_open"] = min(.75, .5*e.pop("mouth_open"))      # full MPFB opening (needs the stage-2 mouth bag)
    if "mouth_open" in e: e["mouth_open"] = min(1.0, e["mouth_open"])
    keys = {**F["keys"], **e, "eyes_look_left": .45}
    for n in show + ["Eyes", "Eyes_Cornea"]: set_keys(OB.get(n), {**keys, "hair_under_cap": 1.0 if F["wear"] else 0.0})
    if DARK:                                                            # the mouth cavity material only while the jaw is open (a preview of the stage-2 mouth interior)
        mi = np.zeros(len(OB["Head"].data.polygons), np.int32)
        if e.get("x_mouth_open", 0) > 0: mi[DARK] = len(OB["Head"].data.materials) - 1
        OB["Head"].data.polygons.foreach_set("material_index", mi)
    for m in skin_mats: mixB(m).default_value = hexrgb(F["tone"])
    for o in OB:
        if o.type == 'MESH' and not o.hide_render:
            for m in o.data.materials:
                if m and (m.name.startswith("hair") and m.name != "hair_beard" or m.name in ("hair_beard", "eyebrow")):
                    try: mixB(m).default_value = hexrgb(F["hc"])
                    except StopIteration: pass
    bsdf(bpy.data.materials["stubble"]).inputs["Base Color"].default_value = hexrgb(F["hc"])
    c = F["eye"]
    if c not in EYEIMG: EYEIMG[c] = eye_img(c)
    eye_tex.image = EYEIMG[c]
    mc = bpy.data.materials.get("cap")
    if mc: mixB(mc).default_value = hexrgb("#1b2a4a")
    bsdf(bpy.data.materials["helmet"]).inputs["Base Color"].default_value = hexrgb("#1b2a4a")
def shoot(tag):
    if ONLY and not any(t in tag for t in ONLY.split(",")): return
    sc.render.filepath = os.path.join(OUT, tag + ".png"); bpy.ops.render.render(write_still=True)
t0 = time.time(); n = 0
for light in ("day", "night"):
    lighting(light)
    for F in FACES:
        dress(F, "neutral")
        for dk in SPANS:
            frame(dk); shoot(f"{CAND}_{F['id']}_{dk}_{light}"); n += 1
lighting("day")
for F in (FACES[0], FACES[1], FACES[2]):
    for ex in EXPR:
        dress(F, ex)
        for dk in ("close", "mid"):
            frame(dk, yaw=12); shoot(f"{CAND}_X_{F['id']}_{ex}_{dk}"); n += 1
print("LABDONE", CAND, n, round(time.time() - t0, 1))
