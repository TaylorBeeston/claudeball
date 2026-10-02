# Runtime loader for the MPFB2-derived (CC0) player base mesh: body, head, hands, eyes, brows, lashes, teeth, hair cards (src/mpfb/*.npz, written once by mpfb_extract.py).
# Requires common.py, player_rig.py exec'd. Blender axes: model faces -Y, left = +X, up = +Z; everything is in OUR rest pose (fitted to player_rig.JOINTS).
import bpy, bmesh, numpy as np, os, math
from PIL import Image
from mathutils import Matrix
from mathutils import Vector
from mathutils.kdtree import KDTree
MP = os.path.join(globals().get("CB_SRC") or os.path.join(os.environ.get("CB_ASSETS", "."), "src"), "mpfb")
_B = None
MOUTH_OPEN_SCALE = .3; FOOT_K = .89; FOOT_ANK = .0844; FOOT_LIFT = FOOT_ANK*(1 - FOOT_K)
def base():
    global _B
    if _B is None:
        _B = dict(np.load(os.path.join(MP, "base_body.npz"), allow_pickle=False))
        P = _B["P"].copy(); lo = P[:, 2] < FOOT_ANK; P[lo, 2] = FOOT_ANK - (FOOT_ANK - P[lo, 2])*FOOT_K      # lifts the foot sole by FOOT_LIFT (skinned feet of the straightened legs sank 8-15 mm in the clips): compress the foot below the ankle joint
        _B["P"] = P
        _B["D_mouth_open"] = _B["D_mouth_open"]*MOUTH_OPEN_SCALE                                         # the MPFB mouth interior (stretched inner-lip faces) turns into jagged spikes beyond ~30 % of the original opening: weight 1 = that usable opening
    return _B
HC = Vector((0, -.065, 1.735))                                   # skull centre (replaces the procedural head's centre for headwear / hair builders)
LM = dict(eyeL=(.032, -.146, 1.732), eyeR=(-.032, -.146, 1.732), nose=(0, -.185, 1.688), mouth=(0, -.150, 1.640), crown=(0, -.069, 1.85), ear_z=1.727, ear_x=.090)
NECK_CUT = 1.585                                                 # Head / Body_Skin split height (face centres)

def _faces(sel=None):
    b = base(); q, nq = b["quads"], b["nq"]; off = np.concatenate([[0], np.cumsum(nq)])
    return q, nq, off
def build_mesh(name, sel, P=None, uv_remap=None):
    """Mesh from the faces `sel` (bool mask or index array) of the base mesh. Returns (object, vmap) where vmap[i] = base vertex index of mesh vertex i."""
    b = base(); P = b["P"] if P is None else P; q, nq, off = _faces(); fi = np.where(sel)[0] if np.asarray(sel).dtype == bool else np.asarray(sel)
    used = np.unique(np.concatenate([q[i, :nq[i]] for i in fi])); inv = -np.ones(len(P), int); inv[used] = np.arange(len(used))
    faces = [[int(inv[v]) for v in q[i, :nq[i]]] for i in fi]
    me = bpy.data.meshes.new(name); me.from_pydata(P[used].tolist(), [], faces)
    uvl = me.uv_layers.new(name="UVMap"); uvs = np.concatenate([b["uv"][off[i]:off[i] + nq[i]] for i in fi])
    if uv_remap is not None: uvs = uv_remap(uvs)
    k = 0
    for p in me.polygons:
        for li in p.loop_indices: uvl.data[li].uv = uvs[k]; k += 1
    for p in me.polygons: p.use_smooth = True
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    return o, used
def set_weights(obj, vmap, arm_names=None):
    b = base(); order = [str(n) for n in b["order"]]; vg = {}
    for i, v in enumerate(vmap):
        for k in range(4):
            w = float(b["W_w"][v, k])
            if w <= 1e-4: continue
            n = PFX + order[int(b["W_idx"][v, k])]; g = vg.get(n) or vg.setdefault(n, obj.vertex_groups.new(name=n)); g.add([i], w, 'REPLACE')
def smooth_normals(obj, normals):
    try: obj.data.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    except Exception: pass
_NORM = None
def full_normals():
    """Vertex normals of the complete base mesh (used for every part, so the neck / wrist seams between parts shade exactly like the whole)."""
    global _NORM
    if _NORM is None:
        o, vm = build_mesh("tmp_full", np.ones(len(base()["quads"]), bool)); o.data.update(); _NORM = np.array([v.normal[:] for v in o.data.vertices])
        me = o.data; bpy.data.objects.remove(o, do_unlink=True); bpy.data.meshes.remove(me)
    return _NORM
def hand_vertex_mask(side=None):
    b = base(); order = [str(n) for n in b["order"]]; hi = [order.index(n) for n in order if n.endswith("Hand") and (side is None or n.startswith(side))]
    return np.isin(b["W_idx"][:, 0], hi)
def body_full():
    """Whole base mesh, weighted (source of the clothing shells; not exported)."""
    o, vm = build_mesh("Body", np.ones(len(base()["quads"]), bool)); set_weights(o, vm); return o
def face_centres():
    b = base(); q, nq, off = _faces(); P = b["P"]; return np.array([P[q[i, :nq[i]]].mean(0) for i in range(len(q))])
def split_parts():
    """Faces for Body_Skin (below the neck cut, no hands), Head (above the cut), Hand_L / Hand_R (faces touching a hand-weighted vertex)."""
    b = base(); q, nq, off = _faces(); fc = face_centres(); hm = hand_vertex_mask()
    allhand = np.array([hm[q[i, :nq[i]]].all() for i in range(len(q))]); anyhand_L = np.array([hand_vertex_mask("Left")[q[i, :nq[i]]].any() for i in range(len(q))]); anyhand_R = np.array([hand_vertex_mask("Right")[q[i, :nq[i]]].any() for i in range(len(q))])
    return dict(body=(fc[:, 2] < NECK_CUT) & ~allhand, head=fc[:, 2] >= NECK_CUT, hand_L=anyhand_L, hand_R=anyhand_R)
def head_uv_remap(sel):
    b = base(); q, nq, off = _faces(); fi = np.where(sel)[0]; uvs = np.concatenate([b["uv"][off[i]:off[i] + nq[i]] for i in fi])
    lo, hi = uvs.min(0), uvs.max(0); pad = .004; lo -= pad; hi += pad
    return (lambda u: (u - lo)/(hi - lo)), (lo, hi)

# ---------------------------------------------------------------- morph field: head / face morph deltas, evaluated on any mesh near the head
_FIELD = {}
def head_field():
    if "kd" not in _FIELD:
        b = base(); fc = face_centres(); hv = np.unique(np.concatenate([b["quads"][i, :b["nq"][i]] for i in np.where(fc[:, 2] >= NECK_CUT - .03)[0]]))
        kd = KDTree(len(hv))
        for j, v in enumerate(hv): kd.insert(Vector(b["P"][v]), j)
        kd.balance(); _FIELD.update(kd=kd, hv=hv)
    return _FIELD
def _neigh(P):
    key = (len(P), float(P[:, 0].sum()), float(P[:, 2].sum())); c = _FIELD.setdefault("cache", {})
    if key in c: return c[key]
    f = head_field(); n = len(P); idx = np.zeros((n, 4), int); w = np.zeros((n, 4))
    for i, p in enumerate(P):
        hits = f["kd"].find_n(Vector(p), 4)
        for k, (co, j, d) in enumerate(hits): idx[i, k] = f["hv"][j]; w[i, k] = 1.0/(d*d + 1e-6)
        dmin = hits[0][2]
        w[i] = w[i]/w[i].sum()*math.exp(-(max(0.0, dmin - .008)/.06)**2)
    c[key] = (idx, w); return idx, w
HEAD_KEYS = ("head_narrow", "head_wide", "jaw_square", "nose_large", "ears_large", "brow_heavy", "chin_strong", "cheeks_full", "nose_narrow", "eyes_deep", "eyes_blink", "mouth_open", "smile", "brow_raise", "brow_furrow", "mouth_pucker")
def head_morph(P, kind):
    b = base(); idx, w = _neigh(P); D = b["D_" + kind]; return P + (D[idx]*w[:, :, None]).sum(1)
def teeth_morph(P, kind, tongue=False):
    """Morph for teeth / tongue: the nearest-surface field tears the tooth rows apart when the mouth opens (spikes), so `mouth_open` moves the upper teeth with the upper lip and the lower teeth (and tongue) rigidly with the lower lip; smile / pucker leave them alone; the head-shape keys use the normal field."""
    if kind in ("smile", "mouth_pucker"): return P.copy()
    if kind != "mouth_open": return head_morph(P, kind)
    b = base(); BP = b["P"]; D = b["D_mouth_open"]; x = np.abs(BP[:, 0]) < .02
    up = D[x & (BP[:, 2] > 1.655) & (BP[:, 2] < 1.675) & (BP[:, 1] < -.14)].mean(0); lo = D[x & (BP[:, 2] > 1.635) & (BP[:, 2] < 1.652) & (BP[:, 1] < -.14)].mean(0)
    out = P.copy(); low = P[:, 2] < 1.656
    out[low] += lo*(.75 if tongue else 1.0); out[~low] += up
    return out

# ---------------------------------------------------------------- hands: finger-posed variants of the MPFB hand (no finger bones in the rig; the clips pick a variant / morph)
FULL = ((78, 95, 62), (42, 50, 55))        # full-curl joint angles (deg): fingers MCP / PIP / DIP, thumb CMC / MCP / IP
def _rot(axis, ang, pivot):
    a = np.asarray(axis, float)/np.linalg.norm(axis); K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]]); th = math.radians(ang)
    R = np.eye(3) + math.sin(th)*K + (1 - math.cos(th))*K@K; M = np.eye(4); M[:3, :3] = R; M[:3, 3] = pivot - R@pivot; return M
def hand_normal(side):
    b = base(); n = np.asarray(b["NP_" + side], float); n /= np.linalg.norm(n); sx = 1 if side == "Left" else -1
    return n if np.dot(n, np.array([-sx, 0, -.4])) > 0 else -n        # palm side: toward the body / down
def _palm_centre(side, n):
    b = base(); P = b['P'].astype(float); hm = hand_vertex_mask(side) & (b['FW_' + side].sum(1) < .01); return P[hm].mean(0) + n*.012
def posed_hand(side, curls=(0, 0, 0, 0, 0), curl_ratio=None, thumb_adduct=0.0, spread=0.0, P=None, return_tips=False):
    """Vertex positions (n,3) of the whole base mesh with the fingers of `side` curled: curls = (thumb, index, middle, ring, pinky) in 0..1 (1 = fist). Only finger vertices move."""
    b = base(); P = b["P"].astype(float) if P is None else P.astype(float); FW = b["FW_" + side].astype(float); CH = np.asarray(b["CH_" + side], float); n = hand_normal(side)
    H = np.concatenate([P, np.ones((len(P), 1))], 1); out = np.zeros_like(P); wf = FW.sum(1); rest = np.clip(1 - wf, 0, 1); tips = []
    out += rest[:, None]*P
    for fi in range(5):                                          # 0 thumb, 1..4 index..pinky
        base_j, j1, j2, tip = CH[fi]; d = (tip - base_j)/np.linalg.norm(tip - base_j)
        axis = np.cross(d, n); axis /= np.linalg.norm(axis)
        ang = FULL[1] if fi == 0 else FULL[0]
        if fi == 0:                                              # the thumb flexes across the palm: pick the axis (turning about its own direction) that brings the tip closest to the palm centre
            pc = _palm_centre(side, n); best = None
            for al in range(0, 180, 15):
                ax2 = _rot(d, al, np.zeros(3))[:3, :3] @ axis
                for sg in (1, -1):
                    t2 = (_rot(sg*ax2, 25, base_j) @ np.append(tip, 1))[:3]; dd = np.linalg.norm(t2 - pc)
                    if best is None or dd < best[0]: best = (dd, sg*ax2)
            axis = best[1]
        test = (_rot(axis, 10, base_j) @ np.append(tip, 1))[:3] - tip
        if fi > 0 and np.dot(test, n) < 0: axis = -axis
        pivots = [base_j, j1, j2]; M = np.eye(4)
        if fi > 0 and spread: M = _rot(n, spread*(fi - 2.5), base_j)              # fan the fingers apart (abduction about the palm normal)
        if fi == 0 and thumb_adduct: M = _rot(n, thumb_adduct, base_j)
        for k in range(3):
            c = curls[fi]*(1.0 if curl_ratio is None else curl_ratio[k])
            pv = (M @ np.append(pivots[k], 1))[:3]; ax = M[:3, :3] @ axis
            M = _rot(ax, ang[k]*c, pv) @ M; out += FW[:, fi*3 + k, None]*(H @ M.T)[:, :3]
        tips.append((M @ np.append(tip, 1))[:3])
    return (out, tips) if return_tips else out
HAND_SPECS = dict(                                                # (curls thumb..pinky, thumb_adduct, spread)
    relaxed=((.20, .20, .24, .30, .36), 0.0, 0.0), open=((.04, .04, .05, .06, .07), 0.0, 3.0), fist=((.70, 1.0, 1.0, 1.0, 1.0), 0.0, 0.0), claw=((.35, .42, .46, .46, .46), 0.0, 4.0))
def hand_object(name, side, spec, vmap_sel=None, norm=None):
    """Mesh object of one hand variant (faces touching the hand's vertices of the base mesh), fingers posed by `spec` (a HAND_SPECS key or (curls, adduct, spread))."""
    cu, ad, sp = HAND_SPECS[spec] if isinstance(spec, str) else spec
    Pp = posed_hand(side, cu, thumb_adduct=ad, spread=sp)
    sel = split_parts()["hand_" + ("L" if side == "Left" else "R")]
    o, vm = build_mesh(name, sel, P=Pp); set_weights(o, vm)
    if norm is not None: smooth_normals(o, norm[vm])
    return o, vm
def add_hand_finger_keys(obj, vm, side, base_spec="fist"):
    """Morph targets fingers_1..4 (first n fingers extended straight, the rest curled like `base_spec`) on a hand variant."""
    cu0 = HAND_SPECS[base_spec][0]; obj.shape_key_add(name="Basis", from_mix=False) if obj.data.shape_keys is None else None
    for n in (1, 2, 3, 4):
        cu = list(cu0); cu[0] = max(cu[0], .6)
        for i in range(1, 5): cu[i] = 0.0 if i <= n else 1.0
        Pp = posed_hand(side, tuple(cu)); sk = obj.shape_key_add(name=f"fingers_{n}", from_mix=False); sk.slider_min = 0.0; sk.slider_max = 1.0; sk.value = 0.0
        sk.data.foreach_set("co", Pp[vm].astype(np.float32).ravel())

def _tip_of(side, fi, c, n, spread=0.0, adduct=0.0):
    """Tip point of finger fi (0 thumb) curled by c (0..1), same kinematics as posed_hand (cheap: no mesh)."""
    b = base(); CH = np.asarray(b["CH_" + side], float); base_j, j1, j2, tip = CH[fi]; d = (tip - base_j)/np.linalg.norm(tip - base_j); axis = np.cross(d, n); axis /= np.linalg.norm(axis)
    ang = FULL[1] if fi == 0 else FULL[0]
    if fi == 0:
        pc = _palm_centre(side, n); best = None
        for al in range(0, 180, 15):
            ax2 = _rot(d, al, np.zeros(3))[:3, :3] @ axis
            for sg in (1, -1):
                t2 = (_rot(sg*ax2, 25, base_j) @ np.append(tip, 1))[:3]; dd = np.linalg.norm(t2 - pc)
                if best is None or dd < best[0]: best = (dd, sg*ax2)
        axis = best[1]
    test = (_rot(axis, 10, base_j) @ np.append(tip, 1))[:3] - tip
    if fi > 0 and np.dot(test, n) < 0: axis = -axis
    pivots = [base_j, j1, j2]; M = np.eye(4)
    if fi > 0 and spread: M = _rot(n, spread*(fi - 2.5), base_j)
    if fi == 0 and adduct: M = _rot(n, adduct, base_j)
    for k in range(3):
        pv = (M @ np.append(pivots[k], 1))[:3]; ax = M[:3, :3] @ axis; M = _rot(ax, ang[k]*c, pv) @ M
    return (M @ np.append(tip, 1))[:3]
def claw_ball_fit(side="Right", r=.0369, pad=.004, ntop=600):
    """Fit the claw (ball-ready) hand: search ball centre C above the palm, a fan angle and, per finger, the FIRST curl (coming from the open hand) at which its tip pad reaches the ball surface (|tip - C| = r + pad); candidates are ranked by pad error and the best one whose whole posed hand stays outside the ball (no vertex closer than r - 3 mm) is kept. Returns (curls, spread, C)."""
    n = hand_normal(side); pc = _palm_centre(side, n); b = base(); CH = np.asarray(b["CH_" + side], float)
    d0 = (CH[2][3] - CH[2][0]); zh = d0/np.linalg.norm(d0); yh = np.cross(n, zh); yh /= np.linalg.norm(yh)
    grid = np.linspace(0, 1.25, 126); R = r + pad; cands = []
    sel = split_parts()["hand_" + ("L" if side == "Left" else "R")]; q, nq, _off = _faces(); used = np.unique(np.concatenate([q[i, :nq[i]] for i in np.where(sel)[0]]))
    for sp in (-6.0, 0.0, 6.0, 12.0):
        tipsg = np.array([[_tip_of(side, fi, c, n, spread=sp) for c in grid] for fi in range(5)])
        for h in np.arange(.032, .090, .004):
            for zo in np.arange(-.02, .09, .01):
                for yo in np.arange(-.03, .0301, .01):
                    C = pc + n*h + zh*zo + yh*yo; dist = np.linalg.norm(tipsg - C, axis=2); cu = np.zeros(5); cost = 0.0
                    for fi in range(5):
                        hit = np.where(dist[fi] <= R)[0]
                        if len(hit) and hit[0] > 0:
                            k = hit[0]; lo, hi = grid[k - 1], grid[k]; cu[fi] = hi; cost += (dist[fi][k] - R)**2
                        elif len(hit): cu[fi] = 0.0; cost += (dist[fi][0] - R)**2
                        else: k = dist[fi].argmin(); cu[fi] = grid[k]; cost += (dist[fi][k] - R)**2 + 1e-4
                    if np.linalg.norm(C - (pc - n*.012)) < r + .014: cost += 1.0
                    cands.append((cost, C.copy(), cu, sp))
    cands.sort(key=lambda t: t[0]); best = None; seen = 0
    for cost, C, cu, sp in cands[:ntop]:
        cu = cu.copy()
        for fi in range(5):                                                       # refine the first crossing by bisection
            hi = cu[fi]; lo = max(0.0, hi - (grid[1] - grid[0]))
            dl, dh = np.linalg.norm(_tip_of(side, fi, lo, n, spread=sp) - C) - R, np.linalg.norm(_tip_of(side, fi, hi, n, spread=sp) - C) - R
            if dl*dh < 0:
                for _b in range(16):
                    mid = (lo + hi)/2; dm = np.linalg.norm(_tip_of(side, fi, mid, n, spread=sp) - C) - R
                    if dm*dl > 0: lo, dl = mid, dm
                    else: hi = mid
                cu[fi] = (lo + hi)/2
        Pp = posed_hand(side, tuple(float(x) for x in cu), thumb_adduct=0.0, spread=sp); dmin = np.linalg.norm(Pp[used] - C, axis=1).min()
        seen += 1
        if best is None or dmin > best[0]: best = (dmin, C, cu, sp)
        if dmin >= r - .003: best = (dmin, C, cu, sp); break
    dmin, C, cu, sp = best
    return tuple(float(x) for x in cu), float(sp), C
def ball_hand_frame_coords(C, side="Right"):
    """Ball centre in the rig's hand frame (x palm normal, y thumb side, z along the hand) relative to the wrist joint."""
    xr, yr, zr = hand_frame(side); wr = JOINTS[side + "Hand"][1]; d = Vector(C) - wr; return (d.dot(xr), d.dot(yr), d.dot(zr))

# ---------------------------------------------------------------- eyes: eyeball sphere + cornea shell, equirect texture from the MPFB iris crops, look shape keys
EYE_R = .0123
EYE_Y = -.138                                                     # globe centre y: the globes sat 1-7 mm in front of the lid surface (startled look, blink could not cover them); moved 8 mm back
EYE_COLORS = dict(brown=((.20, .095, .035), (.43, .24, .10)), hazel=((.26, .17, .06), (.45, .36, .13)), green=((.12, .20, .09), (.30, .46, .22)), blue=((.12, .22, .38), (.38, .58, .78)), gray=((.20, .23, .26), (.52, .56, .60)))
def _noise2(w, h, scales, seed):
    rng = np.random.default_rng(seed); out = np.zeros((h, w), np.float32)
    for k, sc in enumerate(scales):
        g = rng.random((max(2, int(h/sc)), max(2, int(w/sc)))).astype(np.float32); im = Image.fromarray((g*255).astype(np.uint8)).resize((w, h), Image.BICUBIC); out += np.asarray(im, np.float32)/255.0/(k + 1)
    return out/ sum(1/(k + 1) for k in range(len(scales)))
def eye_equirect(color="brown", w=1024, h=512, seed=3):
    """Procedural equirect (u = angle around the gaze axis, v = angle from the front pole): iris with radial fibres, crypts, collarette and limbal ring, pupil, sclera with faint vessels / yellowing at the limbus."""
    dark, light = (np.array(c, np.float32) for c in EYE_COLORS[color])
    u = (np.arange(w) + .5)/w; v = (np.arange(h) + .5)/h; U, V = np.meshgrid(u, v); phi = (U - .5)*2*np.pi; th = np.degrees(V*np.pi)
    ir, pr = 29.0, 9.5                                                      # iris / pupil angular radius (deg) (iris 11.7 mm, pupil ~ 4 mm on a 24 mm globe, pupil mid-dilated)
    fib = _noise2(w, h, (3, 8), seed); fib = np.asarray(Image.fromarray((fib*255).astype(np.uint8)).resize((w, h)), np.float32)/255.0
    ang = .5 + .5*np.sin(phi*47 + 3*_noise2(w, h, (16,), seed + 1))         # radial fibres (angle dependent, long along theta)
    r = np.clip((th - pr)/(ir - pr), 0, 1)                                    # 0 at the pupil edge .. 1 at the limbus
    mix = np.clip(.25 + .55*ang*.6 + .3*fib + .35*(1 - r)**1.5, 0, 1)[..., None]; iris = dark*(1 - mix) + light*mix
    coll = np.exp(-((r - .38)/.07)**2)[..., None]; iris = iris*(1 - .25*coll) + np.array([.55, .38, .2], np.float32)*.25*coll*(1 if color in ("brown", "hazel") else .5)
    limb = np.clip((r - .78)/.22, 0, 1)[..., None]; iris = iris*(1 - .75*limb**1.3)                                  # dark limbal ring
    iris = iris*(.82 + .36*_noise2(w, h, (5, 12), seed + 2)[..., None])
    sclera = np.array([.88, .86, .82], np.float32)*np.ones((h, w, 3), np.float32)
    ves = np.clip(_noise2(w, h, (9, 30), seed + 3) - .62, 0, 1)*2.2; sclera[..., 1:] -= (ves*.10)[..., None]*np.array([1, 1.4], np.float32); sclera[..., 0] -= ves*.02
    tint = np.exp(-((th - ir)/16.0)**2)[..., None]; sclera = sclera*(1 - .08*tint) - .02*tint*np.array([0, .04, .1], np.float32)
    out = np.where((th < ir)[..., None], iris, sclera); out = np.where((th < pr)[..., None], np.array([.012, .010, .010], np.float32), out)
    edge = np.clip(1 - np.abs(th - ir)/1.2, 0, 1)[..., None]; out = out*(1 - .35*edge)                                # soft darkening exactly at the limbus
    return np.clip(out, 0, 1)
def build_eyes():
    """Both eyeballs as ONE object `Eyes` (+ `Eyes_Cornea`): front pole = -Y, equirect UV, shape keys eyes_look_left / right / up / down (both eyes rotate together)."""
    objs = []
    for nm, rad, seg, ring in (("Eyes", EYE_R, 40, 24), ("Eyes_Cornea", EYE_R*1.012, 36, 12)):
        bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); verts = {}
        for sx in (1, -1):
            c = Vector((sx*.032, EYE_Y, 1.732)); rings = []
            nr = ring if nm == "Eyes" else ring; th_max = math.pi if nm == "Eyes" else math.radians(41)
            for i in range(nr + 1):
                th = th_max*i/nr; row = []
                for k in range(seg):
                    ph = 2*math.pi*k/seg; d = Vector((math.sin(th)*math.cos(ph), -math.cos(th), math.sin(th)*math.sin(ph)))      # polar axis -Y
                    r = rad + (0.0 if nm == "Eyes" else .0009*max(0.0, 1 - (th/th_max)**2)) + (.0006*max(0.0, 1 - (th/math.radians(26))**2) if nm == "Eyes" else 0.0)
                    row.append(bm.verts.new(c + d*r))
                rings.append(row)
            for i in range(nr):
                for k in range(seg):
                    k2 = (k + 1) % seg; f = bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
                    for lp, (kk, ii) in zip(f.loops, ((k, i), (k + 1, i), (k + 1, i + 1), (k, i + 1))): lp[uvl].uv = (kk/seg, 1 - ii/nr*(th_max/math.pi))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(nm); bm.to_mesh(me); bm.free()
        for p in me.polygons: p.use_smooth = True
        o = bpy.data.objects.new(nm, me); bpy.context.collection.objects.link(o); objs.append(o)
        o.shape_key_add(name="Basis", from_mix=False)
        Pn = np.array([v.co[:] for v in me.vertices])
        for key, (axis, ang) in dict(eyes_look_left=((0, 0, 1), 22), eyes_look_right=((0, 0, 1), -22), eyes_look_up=((1, 0, 0), 18), eyes_look_down=((1, 0, 0), -18)).items():
            out = Pn.copy()
            for sx in (1, -1):
                c = np.array([sx*.032, EYE_Y, 1.732]); m = (np.sign(Pn[:, 0] - 0.0) == sx); R = np.array(Matrix.Rotation(math.radians(ang), 3, axis))
                out[m] = (Pn[m] - c) @ R.T + c
            sk = o.shape_key_add(name=key, from_mix=False); sk.slider_min = 0.0; sk.slider_max = 1.0; sk.value = 0.0; sk.data.foreach_set("co", out.astype(np.float32).ravel())
    return objs

# ---------------------------------------------------------------- bundled CC0 assets as objects (hair cards, brows, lashes, teeth)
def asset_object(npz_name, obj_name):
    e = np.load(os.path.join(MP, "assets", npz_name + ".npz")); q, nq = e["quads"], e["nq"]
    me = bpy.data.meshes.new(obj_name); me.from_pydata(e["P"].tolist(), [], [[int(v) for v in q[i, :nq[i]]] for i in range(len(q))])
    uvl = me.uv_layers.new(name="UVMap"); k = 0
    for p in me.polygons:
        for li in p.loop_indices: uvl.data[li].uv = e["uv"][k]; k += 1
    for p in me.polygons: p.use_smooth = True
    o = bpy.data.objects.new(obj_name, me); bpy.context.collection.objects.link(o); return o
def shrink_to_surface(obj, surf_obj, k):
    """Pull every vertex of `obj` toward the nearest point of `surf_obj` by the fraction k (thinner / lower hair)."""
    from mathutils.bvhtree import BVHTree
    bmh = bmesh.new(); bmh.from_mesh(surf_obj.data); bvh = BVHTree.FromBMesh(bmh); bmh.free()
    for v in obj.data.vertices:
        loc, n, i, d = bvh.find_nearest(v.co)
        if loc is not None and (v.co - loc).dot(n) > 0: v.co = loc + (v.co - loc)*(1 - k)
def hair_style(name, asset, head_obj, shrink=0.0, cut=None):
    o = asset_object(asset, name)
    if shrink: shrink_to_surface(o, head_obj, shrink)
    if cut is not None:
        bm = bmesh.new(); bm.from_mesh(o.data); cut_bm(bm, cut); bm.to_mesh(o.data); bm.free()
        for p in o.data.polygons: p.use_smooth = True
    return o
def _receding(co): return -1.0 if (co.y < -.105 and co.z > 1.77) else 1.0
def _balding(co):
    e = math.hypot(co.x/.075, (co.y + .035)/.095) - 1.0; return e if co.z > 1.79 else 1.0
HAIR_STYLES = (("Gear_Hair", "short02", 0.0, None), ("Gear_Hair_Buzz", "short01", .45, None), ("Gear_Hair_Curly", "afro01", .55, None), ("Gear_Hair_Long", "long01", 0.0, None),
               ("Gear_Hair_SidePart", "short03", 0.0, None), ("Gear_Hair_SlickBack", "short04", 0.0, None), ("Gear_Hair_Bob", "bob01", 0.0, None), ("Gear_Hair_Ponytail", "ponytail01", 0.0, None),
               ("Gear_Hair_Receding", "short02", 0.0, _receding), ("Gear_Hair_Balding", "short02", 0.0, _balding))

# ---------------------------------------------------------------- texture baking helpers (atlas = the MPFB UV layout shared by Body_Skin / Head / Hand_*)
def rasterize_uv(vals, size=2048):
    """Rasterise per-vertex attributes of the full base mesh (n, k) into UV space by barycentric interpolation (strict pass, then a 1-2 texel extension pass that only fills uncovered texels).
    Returns (image (size, size, k) float32 with row 0 = v 1, coverage (size, size) bool)."""
    b = base(); q, nq, off = _faces(); uv = b["uv"]; k = vals.shape[1]; img = np.zeros((size, size, k), np.float32); cov = np.zeros((size, size), bool)
    for tol, only_new in ((-.001, False), (-.30, True)):
        for fi in range(len(q)):
            idx = q[fi, :nq[fi]]; tris = [(0, 1, 2)] if nq[fi] == 3 else [(0, 1, 2), (0, 2, 3)]
            for a, bb, c in tris:
                ia, ib, ic = idx[a], idx[bb], idx[c]; ua, ub, uc = uv[off[fi] + a]*size, uv[off[fi] + bb]*size, uv[off[fi] + c]*size
                x0 = int(max(0, math.floor(min(ua[0], ub[0], uc[0]) - 2))); x1 = int(min(size - 1, math.ceil(max(ua[0], ub[0], uc[0]) + 2)))
                y0 = int(max(0, math.floor(min(ua[1], ub[1], uc[1]) - 2))); y1 = int(min(size - 1, math.ceil(max(ua[1], ub[1], uc[1]) + 2)))
                if x1 < x0 or y1 < y0: continue
                xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
                d = (ub[1] - uc[1])*(ua[0] - uc[0]) + (uc[0] - ub[0])*(ua[1] - uc[1])
                if abs(d) < 1e-9: continue
                w0 = ((ub[1] - uc[1])*(xs - uc[0]) + (uc[0] - ub[0])*(ys - uc[1]))/d; w1 = ((uc[1] - ua[1])*(xs - uc[0]) + (ua[0] - uc[0])*(ys - uc[1]))/d; w2 = 1 - w0 - w1
                m = (w0 >= tol) & (w1 >= tol) & (w2 >= tol)
                if only_new: m &= ~cov[y0:y1 + 1, x0:x1 + 1]
                if not m.any(): continue
                val = w0[..., None]*vals[ia] + w1[..., None]*vals[ib] + w2[..., None]*vals[ic]
                sub = img[y0:y1 + 1, x0:x1 + 1]; sub[m] = val[m]; cov[y0:y1 + 1, x0:x1 + 1] |= m
    return img[::-1].copy(), cov[::-1].copy()
def vertex_curvature_thickness():
    """Per-vertex (mean-curvature proxy, thickness) of the full base mesh: curvature = signed distance of the vertex from the mean of its neighbours along the normal, thickness = inward ray length through the mesh."""
    from mathutils.bvhtree import BVHTree
    o, vm = build_mesh("tmp_ct", np.ones(len(base()["quads"]), bool)); me = o.data; me.update()
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table(); bvh = BVHTree.FromBMesh(bm)
    curv = np.zeros(len(vm)); thick = np.zeros(len(vm))
    for v in bm.verts:
        nb = [e.other_vert(v).co for e in v.link_edges]
        if nb: m = sum(nb, Vector())/len(nb); curv[v.index] = (m - v.co).dot(v.normal)
        loc, n, i, d = bvh.ray_cast(v.co - v.normal*.0005, -v.normal, .08); thick[v.index] = d if loc is not None else .08
    bm.free(); bpy.data.objects.remove(o, do_unlink=True); bpy.data.meshes.remove(me); return curv, thick
