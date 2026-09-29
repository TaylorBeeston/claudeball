# Pitching deliveries (right-handed; the engine mirrors lefties). Requires player_clips.py exec'd (CLIPS, FRAME0).
# Blender axes: the pitcher faces -Y = toward the plate, left = +X (glove side), up = +Z; hips y is root motion (negative = stride toward the plate).
# Conventions
#  * Frame 0 of every clip is the clip's start pose: windup clips start from `pitcher_rock`'s pose, stretch clips from `pitcher_set`'s pose (seamless cross-fade).
#  * Root = the ground plane of the *rubber top* (mound top, 0.254 m): planted feet have their ankle target at 0.085 m (sole on the ground). The mound falls
#    1 in per foot beginning 6 in in front of the rubber's front edge (0.23 m ahead of the rubber centre), so a foot planted `dy` metres ahead of the pivot foot
#    stands lower: ankle z = 0.085 - 0.0833 * (dy - 0.23).  The stride foot / landing foot targets follow that (see `ank`), so nothing floats or sinks.
#  * Release timing: windup clips release at 0.583 s (frame 14) [sidearm 13], stretch clips at 0.375 s (frame 9), all at 24 fps.
import math
MOUND_SLOPE = 1*0.0254/0.3048; RUBBER_TO_SLOPE = 0.23
def ank(dy): return .085 - MOUND_SLOPE*max(0.0, dy-RUBBER_TO_SLOPE)
def Sx(**k): return k

def _windup_stages():
    LF = (.17, -1.11, ank(1.11))
    return {
     "start": Sx(hips=(0, 0, -.03), lean=4, head_pitch=-4, yaw=-6, hyaw=-4, lfoot=(.15, -.02, .085), rfoot=(-.15, .04, .085), lhand=(.10, -.33, 1.24), rhand=(-.06, -.30, 1.22), lpole=(.7, .1, -.7), rpole=(-.7, .1, -.7)),
     "rock":  Sx(hips=(-.01, .06, -.05), lean=-2, yaw=-14, hyaw=-10, lfoot=(.14, -.06, .16), lknee=(.2, -1, .2), rfoot=(-.15, .04, .085), lhand=(.06, -.32, 1.26), rhand=(-.04, -.30, 1.24), lpole=(.7, .1, -.7), rpole=(-.7, .1, -.7)),
     "lift":  Sx(hips=(-.02, .05, -.02), lean=-4, yaw=-32, hyaw=-26, lfoot=(.10, -.34, .56), lknee=(.3, -1, .3), rfoot=(-.15, .05, .085), rfoot_o=(-8, 0), lhand=(.02, -.30, 1.32), rhand=(-.04, -.28, 1.30), lpole=(.7, 0, -.6), rpole=(-.7, 0, -.6)),
     "break": Sx(hips=(0, -.16, -.10), lean=2, yaw=-34, hyaw=-10, lfoot=(.16, -.72, .32), lknee=(.2, -1, .1), rfoot=(-.15, .05, .085), rfoot_o=(-14, 0), lhand=(.34, -.62, 1.40), rhand=(-.24, -.10, 1.00), lpole=(.5, .2, .4), rpole=(-.6, .5, -.5)),
     "stride": Sx(hips=(0, -.40, -.26), lean=5, yaw=-30, hyaw=6, lfoot=(.17, -.96, ank(.96)+.04), rfoot=(-.15, .05, .10), rfoot_o=(-20, 0), lhand=(.40, -.76, 1.34), rhand_rel=(-.34, .10, .14), lpole=(.5, .2, .4), rpole=(-1, .2, .4)),
     "plant": Sx(hips=(0, -.50, -.33), lean=12, yaw=-20, hyaw=20, lfoot=LF, rfoot=(-.15, .04, .11), rfoot_o=(-24, 0), lhand=(.34, -.86, 1.30), rhand_rel=(-.30, .06, .34), lpole=(.5, .2, .4), rpole=(-1, .2, .6)),
     "accel": Sx(hips=(0, -.53, -.34), lean=32, yaw=6, hyaw=30, lfoot=LF, rfoot=(-.15, .03, .12), rfoot_o=(-26, 0), lhand=(.24, -.60, 1.14), rhand_rel=(-.20, -.20, .50), lpole=(.5, .3, .2), rpole=(-.8, .1, .6)),
     "release": Sx(hips=(0, -.56, -.33), lean=50, side=6, yaw=26, hyaw=34, lfoot=LF, rfoot=(-.16, .0, .16), rfoot_o=(-28, 0), lhand=(.26, -.35, .90), rhand_rel=(-.10, -.38, .44), lpole=(.6, .3, -.3), rpole=(-.4, .5, .6)),
     "follow1": Sx(hips=(0, -.62, -.30), lean=62, side=4, yaw=38, hyaw=40, lfoot=LF, rfoot=(-.20, -.46, .30), lhand=(.34, -.25, .85), rhand_rel=(.20, -.30, -.42), lpole=(.7, .3, -.3), rpole=(0, .6, .3)),
     "follow2": Sx(hips=(0, -.65, -.27), lean=50, yaw=20, hyaw=22, lfoot=LF, rfoot=(-.19, -.85, ank(.85)), lhand=(.28, -.55, 1.00), rhand_rel=(.02, -.25, -.50), lpole=(.6, .3, -.3), rpole=(-.6, .3, -.3)),
     "field": Sx(hips=(0, -.66, -.26), lean=42, yaw=4, hyaw=6, lfoot=LF, rfoot=(-.20, -.85, ank(.85)), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), lhand=(.30, -.78, .95), rhand=(-.22, -.62, .92), lpole=(.6, .3, -.3), rpole=(-.6, .3, -.3)),
    }

def _stretch_stages():
    W = _windup_stages(); LF = (.17, -1.03, ank(1.03))
    S = dict(W)
    S["start"] = Sx(hips=(0, .01, -.06), lean=8, head_pitch=-6, yaw=-60, hyaw=-56, lfoot=(.17, -.36, .085), rfoot=(-.12, .06, .085), rfoot_o=(-80, 0), lknee=(.2, -1, 0),
                    lhand=(-.02, -.20, 1.16), rhand=(-.14, -.12, 1.16), lpole=(.4, .2, -.9), rpole=(-.6, .3, -.7))
    S["lift"] = Sx(hips=(-.01, .04, -.06), lean=4, yaw=-58, hyaw=-50, lfoot=(.12, -.24, .46), lknee=(.3, -1, .3), rfoot=(-.12, .06, .085), rfoot_o=(-70, 0),
                   lhand=(-.02, -.22, 1.20), rhand=(-.12, -.14, 1.20), lpole=(.4, .2, -.9), rpole=(-.6, .3, -.7))
    S["break"] = Sx(hips=(0, -.20, -.14), lean=4, yaw=-52, hyaw=-24, lfoot=(.16, -.72, .18), lknee=(.2, -1, .1), rfoot=(-.14, .05, .085), rfoot_o=(-50, 0),
                    lhand=(.34, -.62, 1.36), rhand=(-.26, -.08, 1.02), lpole=(.5, .2, .4), rpole=(-.6, .5, -.5))
    S["stride"] = Sx(hips=(0, -.36, -.26), lean=6, yaw=-34, hyaw=8, lfoot=(.17, -.92, ank(.92)+.03), rfoot=(-.15, .05, .10), rfoot_o=(-30, 0),
                     lhand=(.40, -.76, 1.34), rhand_rel=(-.34, .10, .14), lpole=(.5, .2, .4), rpole=(-1, .2, .4))
    for k in ("plant", "accel", "release", "follow1", "follow2", "field"):
        d = dict(W[k]); d["lfoot"] = LF
        if k == "plant": d["hips"] = (0, -.46, -.32)
        if k == "accel": d["hips"] = (0, -.49, -.33)
        if k == "release": d["hips"] = (0, -.52, -.32)
        S[k] = d
    return S

# per arm slot overrides applied on top of the overhand stages (arm path relative to the shoulder, trunk tilt / lean, hip height)
def _slot(slot, kind):
    if slot == "overhand": return {}
    if slot == "three_quarter":
        return {"stride": Sx(rhand_rel=(-.42, .10, .05)), "plant": Sx(rhand_rel=(-.44, .05, .18), side=6), "accel": Sx(rhand_rel=(-.40, -.22, .30), side=12),
                "release": Sx(rhand_rel=(-.34, -.40, .20), side=20, lean=50, yaw=24), "follow1": Sx(rhand_rel=(.10, -.40, -.30), side=10), "follow2": Sx(side=4)}
    if slot == "sidearm":
        return {"stride": Sx(rhand_rel=(-.46, .10, -.05), rpole=(-1, .1, -.1)), "plant": Sx(rhand_rel=(-.52, .05, -.02), side=14, rpole=(-1, .1, -.1)),
                "accel": Sx(rhand_rel=(-.50, -.22, -.05), side=30, lean=34, rpole=(-1, 0, -.2)),
                "release": Sx(rhand_rel=(-.44, -.36, -.10), side=42, lean=42, yaw=30, rpole=(-1, 0, -.2)),
                "follow1": Sx(rhand_rel=(.10, -.45, -.15), side=26, lean=52), "follow2": Sx(side=10, lean=48)}
    if slot == "submarine":
        return {"stride": Sx(rhand_rel=(-.30, .20, -.42), hips=(0, -.40, -.30), rpole=(-.5, .5, -1)),
                "plant": Sx(rhand_rel=(-.30, .25, -.40), side=20, lean=28, hips=(0, -.50, -.40), rpole=(-.5, .5, -1)),
                "accel": Sx(rhand_rel=(-.25, -.05, -.52), side=36, lean=50, hips=(0, -.53, -.42), rpole=(-.5, .5, -1)),
                "release": Sx(rhand_rel=(-.15, -.28, -.48), side=50, lean=64, yaw=32, hips=(0, -.56, -.42), rpole=(-.4, .5, -1)),
                "follow1": Sx(rhand_rel=(.10, -.35, -.35), side=40, lean=64, hips=(0, -.62, -.36)), "follow2": Sx(side=18, lean=52, hips=(0, -.65, -.30))}

WIND_T = {"start": 0, "rock": 3, "lift": 6, "break": 8, "stride": 10, "plant": 11, "accel": 12, "release": 14, "follow1": 17, "follow2": 22, "field": 32}
STRE_T = {"start": 0, "lift": 3, "break": 5, "stride": 6, "plant": 7, "accel": 8, "release": 9, "follow1": 12, "follow2": 16, "field": 26}
SLOTS = ("overhand", "three_quarter", "sidearm", "submarine")
def delivery(slot, kind):
    stages = _windup_stages() if kind == "windup" else _stretch_stages(); T = dict(WIND_T if kind == "windup" else STRE_T)
    if kind == "windup" and slot == "sidearm": T.update({"accel": 11, "release": 13})
    ov = _slot(slot, kind); keys = []
    for name, f in T.items():
        sp = dict(stages[name]); sp.update(ov.get(name, {}))
        if 'head_pitch' not in sp: sp['head_pitch'] = -.55*sp.get('lean', 0)
        sp.setdefault('head_yaw', 0)
        keys.append((f, sp))
    return T["field"], keys

def pitcher_set_clip():
    st = _stretch_stages()["start"]; keys = []
    for f, dz, dy, hd in ((0, 0, 0, 0), (12, .004, .004, 2), (24, .0, .0, 0), (36, .004, .004, -2), (48, 0, 0, 0)):
        sp = dict(st); h = list(sp["hips"]); h[2] += dz; h[1] += dy*.5; sp["hips"] = tuple(h); sp["head_yaw"] = hd; sp["head_pitch"] = -6
        keys.append((f, sp))
    return keys
def pitcher_rock_clip():
    st = _windup_stages()["start"]; keys = []
    for f, dz, dx, yw, hd in ((0, 0, 0, 0, 0), (18, .012, .008, 1.5, 1), (36, .0, 0, 0, 0), (54, .010, -.008, -1.5, -1), (72, 0, 0, 0, 0)):
        sp = dict(st); h = list(sp["hips"]); h[2] += dz; h[0] += dx; sp["hips"] = tuple(h); sp["yaw"] = st["yaw"]+yw; sp["head_yaw"] = hd; sp["head_pitch"] = -4
        keys.append((f, sp))
    return keys

# event frames (24 fps): glove/ball phases -> ball in the glove (`Glove_Pocket`) from frame 0 until `break`, in the throwing hand (`Ball_Grip`) from `break` to `release`
PITCH_EVENTS = {}
for _kind in ("windup", "stretch"):
    for _slot_ in SLOTS:
        _len, _keys = delivery(_slot_, _kind); _T = dict(WIND_T if _kind == "windup" else STRE_T)
        if _kind == "windup" and _slot_ == "sidearm": _T.update({"accel": 11, "release": 13})
        _name = f"pitch_{_slot_}_{_kind}"; CLIPS[_name] = (_len, _keys); FRAME0[_name] = 0
        PITCH_EVENTS[_name] = dict(length=_len, plant=_T["plant"], release=_T["release"], hand_break=_T["break"])
CLIPS["pitcher_set"] = (48, pitcher_set_clip()); CLIPS["pitcher_rock"] = (72, pitcher_rock_clip()); FRAME0["pitcher_set"] = 0; FRAME0["pitcher_rock"] = 0
