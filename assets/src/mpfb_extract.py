# ONE-TIME extraction of the player base mesh from MPFB2 (MakeHuman for Blender; assets CC0, output unrestricted, see assets/CREDITS.md).
# Run inside Blender 5.x with the MPFB2 extension + the MakeHuman system asset packs installed (assets/README.md "Ninth pass").
# It creates a male MPFB human, fits it by linear-blend skinning to OUR 22-bone rest pose (player_rig.JOINTS), maps the MPFB `mixamo` skin weights onto our 22 bones (finger / toe-end weights
# merged into Hand / ToeBase) and writes everything the player build needs to assets/src/mpfb/base_body.npz, so the normal build runs without MPFB installed:
#   P        (n,3)  fitted rest positions in our coordinates (+Y back, -Y forward, +X = model left, +Z up)
#   quads    (m,4)  face vertex indices (all quads / tris padded with -1 in col 3)
#   uv       (m*4,2) per-face-corner UV (MPFB UVMap)
#   W_idx / W_w (n,4) top-4 bone indices (into player_rig.ORDER) and weights
#   D_<name> (n,3)  morph deltas (fitted space) for the head / face morph targets
#   plus landmark vertex indices (lm_*).
import bpy, bmesh, numpy as np, importlib, math, os, json
from mathutils import Vector, Matrix
ROOT = os.environ.get("CB_ASSETS", "")
exec(open(CB_SRC + "/common.py").read()); exec(open(CB_SRC + "/player_rig.py").read())
B = "bl_ext.user_default.mpfb."
HS = importlib.import_module(B + "services.humanservice").HumanService
TS = importlib.import_module(B + "services.targetservice").TargetService
OUT = CB_SRC + "/mpfb"; os.makedirs(OUT, exist_ok=True)

def make_human(extra_targets=(), macro=None):
    for n in [o.name for o in bpy.data.objects if o.name.startswith("Human")]: bpy.data.objects.remove(bpy.data.objects[n])
    mac = TS.get_default_macro_info_dict(); mac.update(gender=1.0, age=.5, muscle=.7, weight=.5, proportions=.5, height=.5, race=dict(asian=0.0, caucasian=1.0, african=0.0)); mac.update(macro or {})
    bm = HS.create_human(mask_helpers=False, detailed_helpers=False, extra_vertex_groups=False, feet_on_ground=True, scale=0.1, macro_detail_dict=mac)
    for t, v in extra_targets: TS.set_target_value(bm, t, v)
    return bm
def evaluated(bm):
    dg = bpy.context.evaluated_depsgraph_get(); ev = bm.evaluated_get(dg); me = ev.to_mesh(); P = np.array([v.co[:] for v in me.vertices], np.float64); ev.to_mesh_clear(); return P

# ---- base human + mixamo weights
bm = make_human()
rig = HS.add_builtin_rig(bm, "mixamo", import_weights=True)
P0 = evaluated(bm); nv = len(P0)
gnames = {g.index: g.name for g in bm.vertex_groups}
Wm = {}                                                                       # MPFB group name -> (nv,) weights
for g in bm.vertex_groups: Wm[g.name] = np.zeros(nv)
for v in bm.data.vertices:
    for g in v.groups: Wm[gnames[g.group]][v.index] = g.weight
hv = np.zeros(nv, bool)
for nm in ("HelperGeometry", "JointCubes"):
    if nm in Wm: hv |= Wm[nm] > .01
keep = np.where(~hv)[0]; remap = -np.ones(nv, int); remap[keep] = np.arange(len(keep))
mb = {b.name.replace("mixamorig:", ""): (np.array(b.head_local), np.array(b.tail_local)) for b in rig.data.bones}
# ---- our bone weights
OUR = ORDER; oidx = {n: i for i, n in enumerate(OUR)}
Wo = np.zeros((nv, len(OUR)))
for g, w in Wm.items():
    if not g.startswith("mixamorig:"): continue
    n = g[len("mixamorig:"):]
    if n.startswith("LeftHand"): n = "LeftHand"
    elif n.startswith("RightHand"): n = "RightHand"
    if n in oidx: Wo[:, oidx[n]] += w
# ---- joint estimates in mesh space for our bones (head, tail)
def cen(n, th=.6):
    w = Wo[:, oidx[n]]; m = w > th; return P0[m].mean(0)
Jm = {}
for n in ("Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"): Jm[n] = (mb[n][0], mb[n][1])
for sd in ("Left", "Right"):
    for n in ("UpLeg", "Leg", "Foot", "ToeBase"): Jm[sd + n] = mb[sd + n]
    sh_h, sh_t = mb[sd + "Shoulder"]; Jm[sd + "Shoulder"] = (sh_h, sh_t)
    a0 = sh_t; c = cen(sd + "Arm"); el = 2*c - a0; Jm[sd + "Arm"] = (a0, el)
    c = cen(sd + "ForeArm"); wr = 2*c - el; Jm[sd + "ForeArm"] = (el, wr)
    c = cen(sd + "Hand", .5); hd = 2*c - wr; Jm[sd + "Hand"] = (wr, hd)
# ---- fit onto our rig: (1) arms: rotate/stretch the mesh arms about their own joints into our rest direction (shoulder stays), (2) global uniform scale + smooth (PCHIP) vertical warp
#      so that legs (hip .94 / knee .52 / ankle .085) and the crown (1.85) match the rig; (3) joints.json = the rig joints measured on the fitted mesh (player_rig reads it).
from scipy.interpolate import PchipInterpolator
DARM = np.array([.766, 0, -.643]); LA = (.31, .27, .19)
def seg_matrix(hm, tm, hr, tr):
    dm = np.array(tm) - hm; dr = np.array(tr) - hr; lm, lr = np.linalg.norm(dm), np.linalg.norm(dr); s = lr/lm
    a = Vector(dm/lm); b = Vector(dr/lr); R = a.rotation_difference(b).to_matrix()
    M = Matrix.Translation(Vector(hr)) @ R.to_4x4() @ Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation(-Vector(hm)); return np.array(M)
Mx = {n: np.eye(4) for n in OUR}; arm_chain = {}
for sd, sx in (("Left", 1), ("Right", -1)):
    d = DARM*np.array([sx, 1, 1]); a0 = Jm[sd + "Arm"][0]; chain = [a0]
    for ln in LA: chain.append(chain[-1] + d*ln)
    for i, n in enumerate((sd + "Arm", sd + "ForeArm", sd + "Hand")): Mx[n] = seg_matrix(Jm[n][0], Jm[n][1], chain[i], chain[i + 1])
    arm_chain[sd] = chain
# legs: the MPFB mesh stands with the legs splayed (~6.5 deg each); straighten them (vertical thigh / shin, feet translated inward and kept flat) so that our straight-leg joints are the real pivots
leg_c = {}
for sd, sx in (("Left", 1), ("Right", -1)):
    wl = Wo[:, oidx[sd + "UpLeg"]] + Wo[:, oidx[sd + "Leg"]] + Wo[:, oidx[sd + "Foot"]] + Wo[:, oidx[sd + "ToeBase"]]
    def sect(z): m = (wl > .5) & (np.abs(P0[:, 2] - z) < .014) & (P0[:, 0]*sx > 0); return P0[m].mean(0)
    Ch, Ck, Ca = sect(.91), sect(.488), sect(.068); Th = np.array([Ch[0], Ch[1], Ch[2]]); Tk = np.array([Ch[0], Ck[1], Ck[2]]); Ta = np.array([Ch[0], Ca[1], Ca[2]])
    Mx[sd + "UpLeg"] = seg_matrix(Ch, Ck, Th, Tk); Mx[sd + "Leg"] = seg_matrix(Ck, Ca, Tk, Ta)
    T = np.eye(4); T[:3, 3] = Ta - Ca; Mx[sd + "Foot"] = T; Mx[sd + "ToeBase"] = T
    leg_c[sd] = (Ch, Ck, Ca, Th, Tk, Ta)
def lbs(P):
    H = np.concatenate([P, np.ones((len(P), 1))], 1); out = np.zeros_like(P); wsum = Wo.sum(1)
    for n in OUR: out += Wo[:, oidx[n]][:, None]*(H @ Mx[n].T)[:, :3]
    out /= np.maximum(wsum, 1e-6)[:, None]; return out
Z_M = np.array([float(P0[keep, 2].min()), .068, .488, .910, 1.403, float(P0[keep, 2].max())]); Z_O = np.array([0.0, .085, .52, .94, 1.476, 1.85])
SC = 1.052
gz = PchipInterpolator(Z_M, Z_O, extrapolate=True)
def glob(P): out = P.copy(); out[:, 0] *= SC; out[:, 1] *= SC; out[:, 2] = gz(P[:, 2]); return out
def fit(P): return glob(lbs(P))
Pfit = fit(P0)
G = lambda p: glob(np.array(p, float)[None])[0]
J = {}
for sd, sx in (("Left", 1), ("Right", -1)):
    Ch_, Ck_, Ca_, Th_, Tk_, Ta_ = leg_c[sd]; sh = Ta_ - Ca_
    J[sd + "UpLeg"] = (G(Th_), G(Tk_)); J[sd + "Leg"] = (G(Tk_), G(Ta_)); J[sd + "Foot"] = (G(Ta_), G(mb[sd + "Foot"][1] + sh)); J[sd + "ToeBase"] = (G(mb[sd + "ToeBase"][0] + sh), G(mb[sd + "ToeBase"][1] + sh))
    ch = [G(c) for c in arm_chain[sd]]
    sh0, sh1 = G(mb[sd + "Shoulder"][0]), G(mb[sd + "Shoulder"][1]); J[sd + "Shoulder"] = (sh0, ch[0]); J[sd + "Arm"] = (ch[0], ch[1]); J[sd + "ForeArm"] = (ch[1], ch[2]); J[sd + "Hand"] = (ch[2], ch[3])
nk = G(mb["Neck"][0]); hd = G(mb["Head"][0]); J["Hips"] = (np.array([0, 0, .96]), np.array([0, 0, 1.03]))
zs = np.linspace(1.03, nk[2], 4)
J["Spine"] = (np.array([0, 0, zs[0]]), np.array([0, 0, zs[1]])); J["Spine1"] = (np.array([0, 0, zs[1]]), np.array([0, 0, zs[2]])); J["Spine2"] = (np.array([0, 0, zs[2]]), np.array([0, 0, zs[3]]))
J["Neck"] = (np.array([0, nk[1], nk[2]]), np.array([0, hd[1], hd[2]])); J["Head"] = (np.array([0, hd[1], hd[2]]), np.array([0, hd[1], 1.85]))
for sd in ("Left", "Right"): J[sd + "Shoulder"] = (np.array([.03*(1 if sd == "Left" else -1), 0, zs[3] - .005]), J[sd + "Shoulder"][1])
json.dump({n: [np.round(J[n][0], 4).tolist(), np.round(J[n][1], 4).tolist()] for n in OUR}, open(OUT + "/joints.json", "w"), indent=1)
info = dict(height=float(Pfit[keep, 2].max()), minz=float(Pfit[keep, 2].min()), xmax=float(Pfit[keep, 0].max()), joints={n: np.round(J[n][0], 3).tolist() for n in ("Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "LeftUpLeg", "LeftLeg", "LeftFoot")})
# ---- topology (full mesh faces; helper faces dropped)
faces = [[remap[v] for v in p.vertices] for p in bm.data.polygons if all(remap[v] >= 0 for v in p.vertices)]
fl = [p for p in bm.data.polygons if all(remap[v] >= 0 for v in p.vertices)]
uvl = bm.data.uv_layers[0].data; uv = []
for p in fl:
    for li in p.loop_indices: uv.append(uvl[li].uv[:])
quads = np.full((len(faces), 4), -1, int)
for i, f in enumerate(faces): quads[i, :len(f)] = f
nq = np.array([len(f) for f in faces])
uvs = np.array(uv)
# ---- top-4 weights on our bones
Wk = Wo[keep]; top = np.argsort(-Wk, axis=1)[:, :4]; tw = np.take_along_axis(Wk, top, 1); tw /= np.maximum(tw.sum(1, keepdims=True), 1e-9)
# ---- morph deltas: MPFB targets (value 1) -> deltas in fitted space
MORPHS = {   # our key name : [(mpfb target, value), ...]
 "head_narrow": [("head/head-scale-horiz-decr", 1.0)], "head_wide": [("head/head-scale-horiz-incr", 1.0)],
 "jaw_square": [("head/head-square", 1.0), ("chin/chin-width-incr", .4)], "nose_large": [("nose/nose-scale-vert-incr", .7), ("nose/nose-scale-horiz-incr", .6), ("nose/nose-scale-depth-incr", .8)],
 "ears_large": [("ears/l-ear-scale-incr", 1.0), ("ears/r-ear-scale-incr", 1.0), ("ears/l-ear-wing-incr", .5), ("ears/r-ear-wing-incr", .5)],
 "brow_heavy": [("forehead/forehead-nubian-incr", 1.0), ("forehead/forehead-temple-incr", .4)], "chin_strong": [("chin/chin-prominent-incr", 1.0), ("chin/chin-width-incr", .5), ("chin/chin-bones-incr", .6)],
 "cheeks_full": [("cheek/l-cheek-volume-incr", 1.0), ("cheek/r-cheek-volume-incr", 1.0), ("cheek/l-cheek-inner-incr", .5), ("cheek/r-cheek-inner-incr", .5)],
 "nose_narrow": [("nose/nose-width1-decr", 1.0), ("nose/nose-width2-decr", .8), ("nose/nose-point-width-decr", .8)],
 "eyes_deep": [("eyes/l-eye-push1-in", 1.0), ("eyes/r-eye-push1-in", 1.0), ("eyes/l-eye-bag-incr", .5), ("eyes/r-eye-bag-incr", .5)],
 "eyes_blink": [("EXPR:eye-left-closure", 1.0), ("EXPR:eye-right-closure", 1.0)], "mouth_open": [("EXPR:mouth-open", 1.0)],
 "smile": [("EXPR:mouth-corner-puller", 1.0), ("EXPR:mouth-elevation", .4)], "brow_raise": [("EXPR:eyebrows-left-up", 1.0), ("EXPR:eyebrows-right-up", 1.0)],
 "brow_furrow": [("EXPR:eyebrows-left-down", 1.0), ("EXPR:eyebrows-right-down", 1.0), ("EXPR:eyebrows-left-inner-up", -0.0)], "mouth_pucker": [("EXPR:mouth-pursing", 1.0)],
}
import bl_ext.user_default.mpfb as _mp
EXPR_DIR = os.path.join(os.path.dirname(_mp.__file__), "data", "targets", "expression", "units", "caucasian")
D = {}; report = {}
for k, ts in MORPHS.items():
    ts = [t for t in ts if abs(t[1]) > 1e-6]
    if not ts: continue
    b2 = make_human(); okt = []
    for t, v in ts:                                                              # MPFB target base names (group/name -> name.target.gz)
        try:
            full = os.path.join(EXPR_DIR, t[5:] + ".target.gz") if t.startswith("EXPR:") else TS.target_full_path(t.split("/")[-1]); TS.load_target(b2, full, weight=v); okt.append(t)
        except Exception as e: report[k + ":" + t] = repr(e)[:120]
    Pv = evaluated(b2)
    if len(Pv) == nv:
        d = fit(Pv) - Pfit; D[k] = d[keep]; report[k] = (okt, float(np.abs(d).max()))
    for n in [o.name for o in bpy.data.objects if o.name.startswith("Human")]: bpy.data.objects.remove(bpy.data.objects[n])
# ---- fingers: per-hand finger weights + joint chains (fitted space) so the build can pose fist / claw / open / fingers_n hand variants (no finger bones in the rig)
FING = ("Thumb", "Index", "Middle", "Ring", "Pinky"); hand_out = {}
disp = Pfit - P0                                                                    # (nv,3) fit displacement per mesh vertex
def fitted_point(p):
    d = np.linalg.norm(P0 - p, axis=1); idx = np.argsort(d)[:6]; w = 1/(d[idx] + 1e-4); return p + (disp[idx]*w[:, None]).sum(0)/w.sum()
for sd in ("Left", "Right"):
    cols = []; chains = []
    for f in FING:
        ws = [Wm.get(f"mixamorig:{sd}Hand{f}{k}", np.zeros(nv)) for k in (1, 2, 3)]; cols += ws
        cs = [P0[w > .5].mean(0) for w in ws]
        j1 = (cs[0] + cs[1])/2; j2 = (cs[1] + cs[2])/2; base = 2*cs[0] - j1; tip = 2*cs[2] - j2; chains.append([fitted_point(p) for p in (base, j1, j2, tip)])
    hand_out["FW_" + sd] = np.stack(cols, 1)[keep].astype(np.float32); hand_out["CH_" + sd] = np.array(chains)
    ph = P0[Wo[:, oidx[sd + "Hand"]] > .5]; u, sv, vt = np.linalg.svd(ph - ph.mean(0), full_matrices=False); hand_out["NP_" + sd] = vt[2]      # palm normal (smallest variance axis), sign fixed by the build
# ---- bundled assets fitted to the same human (eyes, brows, lashes, teeth, tongue, hair): vertices in OUR space + UV + material info
DATA = "/home/taylor/.config/blender/5.2/extensions/.user/user_default/mpfb/data"
ASSETS = [("eyes/high-poly/high-poly.mhclo", "Eyes", "eyes"), ("eyebrows/eyebrow001/eyebrow001.mhclo", "Eyebrows", "eyebrow001"), ("eyebrows/eyebrow004/eyebrow004.mhclo", "Eyebrows", "eyebrow004"),
          ("eyebrows/eyebrow006/eyebrow006.mhclo", "Eyebrows", "eyebrow006"), ("eyebrows/eyebrow010/eyebrow010.mhclo", "Eyebrows", "eyebrow010"),
          ("eyelashes/eyelashes02/eyelashes02.mhclo", "Eyelashes", "eyelashes02"), ("eyelashes/eyelashes04/eyelashes04.mhclo", "Eyelashes", "eyelashes04"),
          ("teeth/teeth_base/teeth_base.mhclo", "Teeth", "teeth_base"), ("tongue/tongue01/tongue01.mhclo", "Tongue", "tongue01")] + \
         [(f"hair/{h}/{h}.mhclo", "Hair", h) for h in ("short01", "short02", "short03", "short04", "bob01", "bob02", "afro01", "braid01", "long01", "ponytail01")]
os.makedirs(OUT + "/assets", exist_ok=True); asset_info = {}
for rel, typ, nm in ASSETS:
    try:
        b3 = make_human()
        ob = HS.add_mhclo_asset(os.path.join(DATA, rel), b3, asset_type=typ, material_type="MAKESKIN")
        dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh(); M = np.array(ev.matrix_world)
        Pa = np.array([v.co[:] for v in me.vertices]); Pa = (np.c_[Pa, np.ones(len(Pa))] @ M.T)[:, :3]; ev.to_mesh_clear()
        Pa = glob(Pa); fa = [list(p.vertices) for p in ob.data.polygons]; qa = np.full((len(fa), 4), -1, int)
        for i, f in enumerate(fa): qa[i, :len(f)] = f[:4]
        ua = []
        if ob.data.uv_layers:
            for p in ob.data.polygons:
                for li in p.loop_indices: ua.append(ob.data.uv_layers[0].data[li].uv[:])
        mats = []
        for m in ob.data.materials:
            mats.append(m.name)
        np.savez_compressed(f"{OUT}/assets/{nm}.npz", P=Pa, quads=qa, nq=np.array([len(f) for f in fa]), uv=np.array(ua) if ua else np.zeros((0, 2)))
        asset_info[nm] = dict(verts=len(Pa), faces=len(fa), mats=mats, dim=np.ptp(Pa, 0).round(3).tolist())
    except Exception as e: asset_info[nm] = repr(e)[:200]
    for n in [o.name for o in bpy.data.objects if o.name.startswith("Human")]: bpy.data.objects.remove(bpy.data.objects[n])
np.savez_compressed(OUT + "/base_body.npz", **hand_out, P=Pfit[keep], quads=quads, nq=nq, uv=uvs, W_idx=top, W_w=tw, **{"D_" + k: v for k, v in D.items()}, order=np.array(OUR))
result = dict(info=info, n=len(keep), faces=len(faces), report={k: v for k, v in report.items() if ':' in k or True}, assets=asset_info)
