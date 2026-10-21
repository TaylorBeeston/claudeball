# MPFB2 expression units + face shaping targets -> deltas in OUR fitted space (the same fit as mpfb_extract.py, checked against base_body.npz),
# written to $FACE_OUT (stage 2: assets/src/mpfb/face_targets.npz). Needs the MPFB2 extension installed; does not rewrite joints.json.
#   CB_SRC=<copy of assets/src> CB_ASSETS=<dir> FACE_OUT=face_targets.npz blender -b --python mpfb_face_extract.py   (~2 min)
import os, sys, numpy as np, bpy, addon_utils
print("ENABLE", addon_utils.enable("bl_ext.user_default.mpfb", default_set=True, persistent=False))
CB_SRC = os.environ["CB_SRC"]
src = open(CB_SRC + "/mpfb_extract.py").read()
cut = src.index("# ---- topology")
src = src[:cut].replace('json.dump(', 'None and json.dump(')          # never rewrite joints.json
exec(src)
base = np.load(CB_SRC + "/mpfb/base_body.npz")
err = float(np.abs(Pfit[keep] - base["P"]).max())
print("FITCHECK max |Pfit - base P| =", err)
import bl_ext.user_default.mpfb as _mp
EXPR = os.path.join(os.path.dirname(_mp.__file__), "data", "targets", "expression", "units", "caucasian")
names = [f[:-10] for f in sorted(os.listdir(EXPR)) if f.endswith(".target.gz")]
SHAPE = ["l-eye-scale-incr", "r-eye-scale-incr", "l-eye-height2-incr", "r-eye-height2-incr", "l-eye-height1-incr", "r-eye-height1-incr", "l-eye-bag-decr", "r-eye-bag-decr",
         "l-eye-push1-out", "r-eye-push1-out", "l-eye-trans-out", "r-eye-trans-out", "l-eye-corner1-up", "r-eye-corner1-up",
         "eyebrows-trans-down", "eyebrows-trans-up", "eyebrows-trans-forward", "eyebrows-angle-up", "eyebrows-angle-down",
         "nose-scale-horiz-decr", "nose-scale-vert-decr", "nose-scale-depth-decr", "nose-volume-decr", "nose-point-up", "nose-hump-decr", "nose-flaring-decr", "nose-nostrils-width-decr",
         "mouth-scale-horiz-incr", "mouth-upperlip-volume-incr", "mouth-lowerlip-volume-incr", "mouth-cupidsbow-incr", "mouth-laugh-lines-out", "mouth-laugh-lines-in",
         "l-ear-scale-decr", "r-ear-scale-decr", "l-ear-flap-decr", "r-ear-flap-decr",
         "chin-prominent-incr", "chin-width-incr", "chin-height-decr", "l-cheek-bones-incr", "r-cheek-bones-incr", "l-cheek-volume-incr", "r-cheek-volume-incr",
         "forehead-scale-vert-decr", "head-age-decr", "head-fat-incr", "head-round", "head-oval", "head-square", "head-scale-vert-decr", "head-back-scale-depth-decr"]
D = {}; bad = {}
for nm in ["EXPR:" + n for n in names] + SHAPE:
    b2 = make_human()
    try:
        full = os.path.join(EXPR, nm[5:] + ".target.gz") if nm.startswith("EXPR:") else TS.target_full_path(nm)
        TS.load_target(b2, full, weight=1.0)
        Pv = evaluated(b2)
        if len(Pv) == nv:
            d = fit(Pv) - Pfit; D[nm.replace("EXPR:", "x_").replace("-", "_")] = d[keep].astype(np.float32)
        else: bad[nm] = "nv"
    except Exception as e: bad[nm] = repr(e)[:160]
    for n in [o.name for o in bpy.data.objects if o.name.startswith("Human")]: bpy.data.objects.remove(bpy.data.objects[n])
out = os.environ["FACE_OUT"]
np.savez_compressed(out, **D)
print("FACEDONE", len(D), "bad", bad)
for k, v in D.items(): print("  ", k, round(float(np.abs(v).max()), 4))
