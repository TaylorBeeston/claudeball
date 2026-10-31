# Shape keys (glTF morph targets) for body / head variety. The SAME spatial function displaces every skinned mesh (skin, clothes, gear), so clothing follows the body.
# Blender axes: model faces -Y, left = +X, up = +Z, rest pose = the A-pose the meshes are built in. Requires numpy/bpy.
#   body : build_lean, build_stocky, build_muscular, build_heavy
#   head : head_narrow, head_wide (all head-attached meshes),  jaw_square, nose_large, ears_large (Head + beards only)
import bpy, numpy as np
from mathutils import Vector

def _sm(a, b, x): t = np.clip((x-a)/(b-a), 0, 1); return t*t*(3-2*t)
def _g(x, c, s): return np.exp(-((x-c)/s)**2)
_D = np.array(ARM_D[:]); _SH = np.array(ARM_SH[:])
HEAD_C = np.array([0, -.004, 1.725])

def body_morph(P, kind):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]; ax = np.abs(x); sx = np.where(x >= 0, 1.0, -1.0); out = P.copy()
    torso = _sm(.90, 1.00, z)*(1-_sm(1.54, 1.62, z))      # hips -> shoulders (arms handled separately below)
    q = np.stack([ax-_SH[0], y-_SH[1], z-_SH[2]], 1); t = q@_D; perp = q - t[:, None]*_D[None, :]; rho = np.linalg.norm(perp, axis=1)
    arm = _sm(-.02, .06, t)*(1-_sm(.58, .68, t))*(1-_sm(.10, .16, rho))*(z < 1.62)
    leg = (1-_sm(.92, 1.04, z))*_sm(.10, .26, z)*_sm(.02, .06, ax)
    neck = _sm(1.52, 1.58, z)*(1-_sm(1.66, 1.70, z))*(ax < .09)
    if kind == "build_lean":    kt = (.90, .92); karm = .88; kleg = .90; kneck = .92; dsh = -.012; belly = 0; waist = .95
    elif kind == "build_stocky": kt = (1.13, 1.16); karm = 1.10; kleg = 1.10; kneck = 1.14; dsh = .012; belly = .11; waist = 1.10
    elif kind == "build_heavy":  kt = (1.15, 1.20); karm = 1.15; kleg = 1.14; kneck = 1.20; dsh = .004; belly = .30; waist = 1.20      # soft and heavy: belly, love handles, seat, thick neck
    else:                        kt = (1.03, 1.05); karm = 1.14; kleg = 1.09; kneck = 1.15; dsh = .016; belly = -.02; waist = .98
    # torso: horizontal scale about the trunk axis, with a chest/waist profile
    if kind == "build_muscular": kx = 1 + .11*_g(z, 1.38, .12) - .03*_g(z, 1.10, .10) + .02*_g(z, 1.25, .1)     # V taper: broad chest, narrow waist
    else: kx = 1 + (kt[0]-1)*torso + (waist-1)*_g(z, 1.10, .09)*.6
    front = (y < -.005) if kind != "build_heavy" else _sm(.01, -.05, y)          # (a smooth front weight for the heavy belly: no crease at the side)
    ky = 1 + (kt[1]-1)*torso + belly*_g(z, 1.10, .10 if kind != "build_heavy" else .13)*front
    if kind == "build_heavy": ky = ky + .14*_g(z, .94, .07)*_sm(-.01, .05, y) + .05*_g(z, 1.34, .07)*_sm(.0, -.06, y)   # the seat behind, a soft chest in front
    keep = 1 - arm*.85                                                         # arm points move with the arm scaling below instead
    out[:, 0] = x + x*(kx-1)*torso*keep
    out[:, 1] = y + (y+.005)*(ky-1)*keep
    # shoulders widen / narrow, arms follow
    sh = _sm(1.30, 1.44, z)*(1-_sm(1.58, 1.66, z))*_sm(.08, .18, ax)
    out[:, 0] += sx*dsh*sh
    # arms: radial scale about the arm axis (thicker at biceps/forearm for the muscular build)
    kar = (1 + (karm-1)*(1 + (.4*_g(t, .30, .16) if kind == "build_muscular" else 0)))*np.ones_like(t)
    add = perp*(kar-1)[:, None]*arm[:, None]; out[:, 0] += sx*add[:, 0]; out[:, 1] += add[:, 1]; out[:, 2] += add[:, 2]
    # legs: radial scale about the leg axis (thighs / calves)
    lk = (1 + (kleg-1)*(1 + (.5*_g(z, .72, .22) + .3*_g(z, .38, .12) if kind == "build_muscular" else 0)))*np.ones_like(z)
    out[:, 0] += (x - sx*.09)*(lk-1)*leg; out[:, 1] += (y + .005)*(lk-1)*leg
    # neck
    out[:, 0] += x*(kneck-1)*neck; out[:, 1] += (y+.006)*(kneck-1)*neck
    # nothing moves at the Head / Body_Skin cut (seam vertices z 1.576-1.593, the split is by face centre at 1.585): Head carries no body keys,
    # so a displaced neck ring opened cracks at the seam
    fade = 1 - _sm(1.545, 1.575, z)*(1 - _sm(.11, .14, ax))
    return P + (out - P)*fade[:, None]

def head_morph(P, kind):
    q = P - HEAD_C; x, y, z = q[:, 0], q[:, 1], q[:, 2]; out = P.copy(); above = _sm(-.10, .03, z)
    if kind == "head_narrow": out[:, 0] += x*(-.08); out[:, 1] += y*.03
    elif kind == "head_wide": out[:, 0] += x*.08; out[:, 1] += y*(-.03)
    elif kind == "jaw_square":
        m = (1-_sm(-.085, -.035, z))*(y < .02); out[:, 0] += x*.12*m; out[:, 1] -= .004*m*(y < -.03)
    elif kind == "nose_large":
        m = _g(x, 0, .020)*_g(z, -.012, .034)*(y < -.06); out[:, 1] -= .010*m; out[:, 2] -= .003*m
    elif kind == "ears_large":
        m = (np.abs(x) > .068)*_g(z, -.003, .03)*_g(y, .006, .030); c = np.array([0, .006, HEAD_C[2]-.003])
        out[:, 0] += np.sign(x)*.005*m; out[:, 1] += (y-.006)*.32*m; out[:, 2] += (z+.003)*.32*m
    elif kind == "brow_heavy":
        m = _g(x, 0, .045)*_g(z, .045, .018)*(y < -.06); out[:, 1] -= .008*m; out[:, 2] -= .002*m
    elif kind == "chin_strong":
        m = _g(x, 0, .030)*_g(z, -.098, .026)*(y < -.04); out[:, 1] -= .011*m; out[:, 2] -= .005*m; out[:, 0] += x*.10*m
    elif kind == "cheeks_full":
        m = (np.abs(x) > .035)*_g(z, -.035, .034)*_g(y, -.045, .045); out[:, 0] += np.sign(x)*.007*m
    elif kind == "nose_narrow":
        m = _g(x, 0, .026)*_g(z, -.015, .036)*(y < -.06); out[:, 0] -= x*.28*m; out[:, 1] += .002*m
    elif kind == "eyes_deep":
        m = (np.abs(np.abs(x) - .033) < .028)*_g(z, .012, .020)*(y < -.06); out[:, 1] += .0035*m
    return out

BODY_KEYS = ("build_lean", "build_stocky", "build_muscular", "build_heavy")
def arm_frame(obj, P):
    """Per vertex on a forearm (by its weight on that side's ForeArm + Hand, as the engine picks it): (indices, t along the forearm: elbow 0, wrist 1,
    unit elbow -> wrist axis per vertex)."""
    names = {g.index: g.name for g in obj.vertex_groups}; sides = []
    for s in ("Left", "Right"):
        E = np.array(JOINTS[s+"ForeArm"][1][:]); W = np.array(JOINTS[s+"Hand"][1][:]); ax = W - E; L = np.linalg.norm(ax); sides.append(((PFX + s + "ForeArm", PFX + s + "Hand"), E, ax/L, L))
    idx, ts, axs = [], [], []
    for v in obj.data.vertices:
        best, bw = None, .01
        for sd in sides:
            w = sum(g.weight for g in v.groups if names[g.group] in sd[0])
            if w > bw: best, bw = sd, w
        if best is None: continue
        _, E, ax, L = best; t = float((P[v.index] - E)@ax)/L
        if t > 0: idx.append(v.index); ts.append(t); axs.append(ax)
    return np.array(idx, int), np.array(ts), np.array(axs).reshape(-1, 3)
def arm_fade(frame, D):
    """Build deltas D (n,3) faded on the forearms so the skin meets the hand on every build (t-0037): the hands, gloves and batting gloves carry no build
    keys and the bones do not move, but the arm's radial scaling slid the forearm skin ALONG the arm (heavy +50 mm into the hand at the wrist, lean
    -25 mm: a gap). Along the forearm the axial share fades out from the elbow to the wrist, the whole delta over the last 20 %, nothing past the
    wrist: the rule of the engine's runtime patch (src/engine/armMorphs.ts, fadeArmDelta), which this makes a no-op."""
    idx, t, ax = frame; out = D.copy()
    if not len(idx): return out
    d = D[idx]; a = (d*ax).sum(1)*_sm(0, 1, t); keep = 1 - _sm(.8, 1.0, t)
    out[idx] = (d - a[:, None]*ax)*keep[:, None]; return out
def add_keys(obj, fn, names):
    """fn(P, name) -> displaced positions; adds Basis + one shape key per name (value 0, range 0..1). Build keys are faded on the forearms (arm_fade)."""
    me = obj.data; n = len(me.vertices)
    P = np.empty(n*3, np.float32); me.vertices.foreach_get("co", P); P = P.reshape(-1, 3).astype(np.float64)
    if me.shape_keys is None: obj.shape_key_add(name="Basis", from_mix=False)
    frame = arm_frame(obj, P) if any(nm in BODY_KEYS for nm in names) and len(obj.vertex_groups) else None
    for nm in names:
        sk = obj.shape_key_add(name=nm, from_mix=False); sk.slider_min = 0.0; sk.slider_max = 1.0; sk.value = 0.0
        Q = fn(P, nm)
        if frame is not None and nm in BODY_KEYS: Q = P + arm_fade(frame, Q - P)
        sk.data.foreach_set("co", Q.astype(np.float32).ravel())
