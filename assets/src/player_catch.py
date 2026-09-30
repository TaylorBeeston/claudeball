# Catching, fielding, tagging, sliding and throwing clips (right-handed fielder, glove on the LEFT hand; the engine mirrors lefties).
# Blender axes: the model faces -Y (the direction of the ball / the slide), left = +X, up = +Z; hips y is baked root motion.
# The glove hand of every catch clip is only a plausible default: the engine can move the wrist by IK so that `Glove_Pocket` meets the ball anywhere within an
# arm's reach; the clips supply the body (reach, lean, footwork, give). `lhand_face` = direction the pocket faces. Requires player_clips/pitch/motion exec'd.
import math

CATCH_EVENTS = {}          # name -> dict(frame markers) for the manifest; `catch` = glove at its extreme reach, ball in the pocket
def _spec(base, **kw):
    d = dict(base); d.update(kw); return d
def _keys(base, rows): return [(f, _spec(base, **kw)) for f, kw in rows]
def _mirror(sp):
    """Left-right mirror of a pose spec (x -> -x, yaws negated, l <-> r)."""
    out = {}
    def mx(v): return (-v[0], v[1], v[2])
    for k, v in sp.items():
        if k in ("hips",): out[k] = mx(v)
        elif k in ("yaw", "hyaw", "side", "head_yaw", "neck_yaw"): out[k] = None if v is None else -v
        elif k[0] in "lr" and k[1:] in ("foot", "knee", "pole", "hand", "hand_rel", "hand_face", "hand_dir"):
            o = ("r" if k[0] == "l" else "l") + k[1:]; out[o] = None if v is None else mx(v)
        elif k[0] in "lr" and k[1:] == "foot_o": out[("r" if k[0] == "l" else "l") + "foot_o"] = (-v[0], v[1])
        else: out[k] = v
    return out
def _reg(name, frames, keys, events=None, loop=False, f0=0):
    CLIPS[name] = (frames, keys); FRAME0[name] = f0
    if events is not None: CATCH_EVENTS[name] = dict(events, frames=frames)

POLE_L = (.15, .35, -1); POLE_R = (-.15, .35, -1)
UPRIGHT = dict(hips=(0, 0, -.16), lean=24, lfoot=(.28, -.06, .085), rfoot=(-.24, .08, .085), lfoot_o=(8, 0), rfoot_o=(-8, 0), lknee=(.2, -1, 0), rknee=(-.2, -1, 0),
          head_yaw=0, head_pitch=-14, lpole=POLE_L, rpole=POLE_R, lhand_face=(0, -1, .1), lhand_rel=(.09, -.26, -.36), rhand_rel=(-.10, -.24, -.34))
INF = dict(UPRIGHT, hips=(0, -.06, -.36), lean=54, lfoot=(.32, 0, .085), rfoot=(-.32, 0, .085), lfoot_o=(12, 0), rfoot_o=(-12, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_pitch=-32,
           lhand_rel=(.08, -.30, -.54), rhand_rel=(-.10, -.28, -.54))
CHEST = dict(lhand_rel=(.07, -.28, -.14), rhand_rel=(-.05, -.26, -.14))

# ---------------------------------------------------------------- receiving a throw (fielders)
_reg("catch_throw", 14, _keys(UPRIGHT, [
    (0, {}), (4, dict(lean=26, hips=(0, -.03, -.16), lhand_rel=(.10, -.42, -.06), rhand_rel=(-.14, -.28, -.18))),
    (6, dict(lean=28, hips=(0, -.05, -.17), head_pitch=-16, lhand_rel=(.10, -.46, -.04), rhand_rel=(-.12, -.30, -.10))),
    (8, dict(lean=27, hips=(0, -.02, -.17), lhand_rel=(.09, -.34, -.10), rhand_rel=(-.06, -.30, -.10))),
    (11, dict(lean=25, **CHEST)), (14, dict())]), events=dict(catch=6, give=8))
_reg("catch_throw_high", 16, _keys(UPRIGHT, [
    (0, {}), (4, dict(hips=(0, -.02, -.10), lean=18, lhand_rel=(.06, -.22, .30), rhand_rel=(-.12, -.22, -.04))),
    (6, dict(hips=(0, -.03, -.05), lean=14, head_pitch=-24, lfoot=(.28, -.06, .11), rfoot=(-.24, .08, .085), lhand_rel=(.05, -.22, .46), lhand_face=(0, -1, -.3), rhand_rel=(-.12, -.20, .12))),
    (9, dict(hips=(0, -.02, -.10), lean=20, lhand_rel=(.08, -.30, -.02), rhand_rel=(-.06, -.28, -.06))),
    (12, dict(lean=24, **CHEST)), (16, dict())]), events=dict(catch=6, give=9))
_reg("catch_throw_low", 16, _keys(INF, [
    (0, dict(UPRIGHT, lean=24, hips=(0, 0, -.16), lfoot=(.28, -.06, .085), rfoot=(-.24, .08, .085), lknee=(.2, -1, 0), rknee=(-.2, -1, 0), head_pitch=-14)),
    (4, dict(hips=(0, -.10, -.32), lean=48, lhand_rel=(.06, -.34, -.40), rhand_rel=(-.10, -.30, -.42))),
    (7, dict(hips=(0, -.16, -.38), lean=58, lhand_rel=(.05, -.32, -.52), lhand_face=(0, -1, .45), rhand_rel=(-.10, -.28, -.48))),
    (10, dict(hips=(0, -.14, -.34), lean=50, lhand_rel=(.06, -.28, -.34), rhand_rel=(-.06, -.26, -.30))),
    (13, dict(hips=(0, -.08, -.22), lean=34, **CHEST)), (16, dict(UPRIGHT, hips=(0, -.04, -.16), lean=24, **CHEST))]), events=dict(catch=7, scoop_up=10))
FB_BAG = dict(UPRIGHT, hips=(0, 0, -.20), lean=22, lfoot=(.20, -.05, .085), rfoot=(-.14, .06, .085), lfoot_o=(8, 0), rfoot_o=(-20, 0))
_reg("catch_stretch", 22, _keys(FB_BAG, [
    (0, {}), (4, dict(hips=(0, -.22, -.26), lean=20, lfoot=(.24, -.62, .085), lhand_rel=(.05, -.42, -.02), rhand_rel=(-.30, -.10, -.06))),
    (8, dict(hips=(0, -.44, -.32), lean=22, lfoot=(.24, -.98, .085), lhand_rel=(.04, -.52, .06), lhand_face=(0, -1, .1), rhand_rel=(-.42, -.06, -.10))),
    (12, dict(hips=(0, -.42, -.32), lean=20, lfoot=(.24, -.98, .085), lhand_rel=(.05, -.44, .02), rhand_rel=(-.36, -.08, -.10))),
    (16, dict(hips=(0, -.20, -.26), lean=22, lfoot=(.24, -.60, .085), lhand_rel=(.07, -.32, -.10), rhand_rel=(-.10, -.26, -.14))),
    (22, dict(hips=(0, -.04, -.20), lean=22, lfoot=(.22, -.10, .085), **CHEST))]), events=dict(catch=8, hold=12))

# ---------------------------------------------------------------- fly balls, line drives, backhands
_reg("catch_fly", 24, _keys(UPRIGHT, [
    (0, dict(lean=20, hips=(0, 0, -.14))),
    (6, dict(lean=6, hips=(0, 0, -.10), head_pitch=-30, lhand_rel=(.04, -.24, .34), lhand_face=(0, -.2, 1), rhand_rel=(-.10, -.24, .16))),
    (10, dict(lean=-2, hips=(0, .02, -.03), head_pitch=-34, lfoot=(.26, -.04, .12), rfoot=(-.24, .06, .12), lhand_rel=(.02, -.28, .46), lhand_face=(0, -.2, 1), rhand_rel=(-.10, -.22, .26))),
    (13, dict(lean=6, hips=(0, 0, -.08), head_pitch=-26, lhand_rel=(.06, -.30, .16), rhand_rel=(-.06, -.28, .12))),
    (18, dict(lean=18, hips=(0, 0, -.14), lhand_rel=(.07, -.28, -.14), rhand_rel=(-.05, -.26, -.14))), (24, dict(UPRIGHT))]), events=dict(catch=10, give=13))
_reg("catch_line_drive", 12, _keys(UPRIGHT, [
    (0, {}), (3, dict(lean=20, hips=(0, .02, -.10), head_pitch=-22, lhand_rel=(.04, -.34, .30), rhand_rel=(-.14, -.24, .05))),
    (5, dict(lean=18, hips=(0, .02, -.08), head_pitch=-22, lhand_rel=(.04, -.40, .36), lhand_face=(0, -1, 0), rhand_rel=(-.12, -.28, .12))),
    (8, dict(lean=22, hips=(0, 0, -.12), lhand_rel=(.06, -.32, .02), rhand_rel=(-.06, -.28, -.04))), (12, dict(UPRIGHT))]), events=dict(catch=5, give=8))
_reg("catch_backhand", 20, _keys(UPRIGHT, [
    (0, {}), (4, dict(hips=(0, -.08, -.26), lean=34, yaw=-14, hyaw=-8, lhand_rel=(-.16, -.40, -.16), rhand_rel=(-.20, -.24, -.20))),
    (8, dict(hips=(0, -.12, -.30), lean=36, yaw=-24, hyaw=-14, head_pitch=-22, lhand_rel=(-.26, -.42, -.14), lhand_face=(-.3, -1, .1), rhand_rel=(-.30, -.20, -.22))),
    (11, dict(hips=(0, -.10, -.28), lean=34, yaw=-16, hyaw=-8, lhand_rel=(-.10, -.34, -.14), rhand_rel=(-.10, -.26, -.18))),
    (15, dict(hips=(0, -.06, -.22), lean=28, yaw=-4, hyaw=-2, **CHEST)), (20, dict(UPRIGHT))]), events=dict(catch=8, give=11))

# running catch: legs from the run cycle, glove arm reaches out ahead
def _catch_fly_run():
    run = dict(CLIPS["run"][1]); keys = []
    def w(f): return 0.0 if f < 3 else (f-3)/6 if f < 9 else 1.0 if f <= 15 else max(0.0, 1 - (f-15)/7)
    for f in range(25):
        sp = dict(run[f % CLIPS['run'][0]]); wf = w(f); lr = sp['lhand_rel']; reach = (.05, -.52, .10)
        sp['lhand_rel'] = tuple(lr[i]*(1-wf) + reach[i]*wf for i in range(3)); sp['lhand_face'] = (0, -.6, .8); sp['head_pitch'] = -.5*sp.get('lean', 20) - 10*wf
        keys.append((f, sp))
    return keys
_reg("catch_fly_run", 24, _catch_fly_run(), events=dict(catch=12, give=16))

# ---------------------------------------------------------------- ground balls
_reg("field_grounder", 30, _keys(INF, [
    (0, {}), (5, dict(hips=(0, -.14, -.40), lean=62, lfoot=(.30, -.42, .085), rfoot=(-.26, .10, .085), lhand_rel=(.06, -.36, -.56), rhand_rel=(-.12, -.32, -.50))),
    (9, dict(hips=(0, -.22, -.44), lean=66, lfoot=(.30, -.42, .085), rfoot=(-.26, .10, .085), lhand_rel=(.05, -.34, -.57), lhand_face=(0, -1, .5), rhand_rel=(-.12, -.30, -.52))),
    (11, dict(hips=(0, -.22, -.44), lean=66, lfoot=(.30, -.42, .085), rfoot=(-.26, .10, .085), lhand_rel=(.05, -.34, -.57), lhand_face=(0, -1, .5), rhand_rel=(-.10, -.30, -.54))),
    (14, dict(hips=(0, -.22, -.40), lean=60, lfoot=(.30, -.42, .085), rfoot=(-.26, .10, .085), lhand_rel=(.06, -.30, -.40), rhand_rel=(-.05, -.28, -.38))),
    (19, dict(hips=(0, -.26, -.30), lean=44, lfoot=(.30, -.42, .085), rfoot=(-.24, -.05, .085), lhand_rel=(.06, -.26, -.25), rhand_rel=(-.05, -.24, -.24))),
    (24, dict(hips=(0, -.30, -.20), lean=30, lfoot=(.30, -.42, .085), rfoot=(-.22, -.10, .085), **CHEST)),
    (30, dict(hips=(0, -.30, -.18), lean=28, lfoot=(.30, -.42, .085), rfoot=(-.22, -.10, .085), **CHEST))]), events=dict(catch=11, funnel=14, throw_ready=24))
_reg("field_grounder_backhand", 30, _keys(INF, [
    (0, {}), (5, dict(hips=(0, -.14, -.40), lean=62, yaw=-18, hyaw=-10, lfoot=(.30, -.30, .085), rfoot=(-.26, .10, .085), lhand_rel=(-.14, -.38, -.52), rhand_rel=(-.22, -.30, -.46))),
    (9, dict(hips=(0, -.20, -.44), lean=66, yaw=-30, hyaw=-16, lfoot=(.30, -.30, .085), rfoot=(-.26, .10, .085), lhand_rel=(-.26, -.38, -.54), lhand_face=(-.2, -1, .5), rhand_rel=(-.30, -.28, -.50))),
    (11, dict(hips=(0, -.20, -.44), lean=66, yaw=-30, hyaw=-16, lfoot=(.30, -.30, .085), rfoot=(-.26, .10, .085), lhand_rel=(-.26, -.38, -.54), lhand_face=(-.2, -1, .5), rhand_rel=(-.30, -.28, -.50))),
    (14, dict(hips=(0, -.20, -.40), lean=60, yaw=-20, hyaw=-10, lfoot=(.30, -.30, .085), rfoot=(-.26, .10, .085), lhand_rel=(-.10, -.32, -.40), rhand_rel=(-.10, -.28, -.36))),
    (19, dict(hips=(0, -.26, -.30), lean=44, yaw=-8, hyaw=-4, lfoot=(.30, -.30, .085), rfoot=(-.24, -.05, .085), lhand_rel=(.04, -.26, -.25), rhand_rel=(-.05, -.24, -.24))),
    (24, dict(hips=(0, -.30, -.20), lean=30, lfoot=(.30, -.30, .085), rfoot=(-.22, -.10, .085), **CHEST)),
    (30, dict(hips=(0, -.30, -.18), lean=28, lfoot=(.30, -.30, .085), rfoot=(-.22, -.10, .085), **CHEST))]), events=dict(catch=11, funnel=14, throw_ready=24))

# ---------------------------------------------------------------- pitcher reactions
def _comebacker():
    F = _windup_stages()["field"]; base = dict(F, head_yaw=0, lpole=POLE_L, rpole=POLE_R, lhand_face=(0, -1, 0))
    return _keys(base, [
        (0, {}), (3, dict(hips=(0, -.66, -.22), lean=30, head_pitch=-20, lhand_rel=(.02, -.30, .20), rhand_rel=(-.10, -.24, .06))),
        (7, dict(hips=(0, -.64, -.20), lean=26, yaw=6, hyaw=4, head_pitch=-16, lhand_rel=(.00, -.42, .10), rhand_rel=(-.10, -.30, .04))),
        (10, dict(hips=(0, -.64, -.22), lean=30, lhand_rel=(.05, -.28, -.05), rhand_rel=(-.05, -.26, -.05))), (16, dict(lean=34, **CHEST))])
_reg("catch_comebacker", 16, _comebacker(), events=dict(catch=7, give=10))
_reg("pitcher_catch_toss", 18, _keys(dict(UPRIGHT, hips=(0, 0, -.06), lean=8, head_pitch=-6), [
    (0, {}), (5, dict(lhand_rel=(.10, -.30, -.12), rhand_rel=(-.10, -.22, -.24))),
    (8, dict(lhand_rel=(.10, -.36, -.14), lhand_face=(0, -1, .1), rhand_rel=(-.08, -.26, -.20))),
    (11, dict(lhand_rel=(.08, -.28, -.18), rhand_rel=(-.06, -.26, -.18))), (18, dict())]), events=dict(catch=8, give=11))

# ---------------------------------------------------------------- throws that are not in the second pass: relaxed toss and the pickoff
_reg("throw_casual", 28, _keys(dict(UPRIGHT, hips=(0, 0, -.08), lean=12, head_pitch=-8, lhand_rel=(.10, -.26, -.24), rhand_rel=(-.10, -.24, -.26)), [
    (0, {}), (5, dict(yaw=-16, hyaw=-8, rhand_rel=(-.32, .04, .16), lhand_rel=(.30, -.34, -.12))),
    (8, dict(hips=(0, -.06, -.12), yaw=-6, hyaw=8, lfoot=(.26, -.30, .085), rhand_rel=(-.22, -.10, .34), lhand_rel=(.26, -.34, -.10))),
    (10, dict(hips=(0, -.10, -.12), lean=18, yaw=10, hyaw=18, lfoot=(.26, -.30, .085), rhand_rel=(-.12, -.36, .28), lhand_rel=(.20, -.24, -.14))),
    (15, dict(hips=(0, -.14, -.12), lean=24, yaw=22, hyaw=22, lfoot=(.26, -.30, .085), rhand_rel=(.12, -.30, -.20), lhand_rel=(.14, -.20, -.20))),
    (21, dict(hips=(0, -.12, -.10), lean=16, yaw=8, hyaw=8, lfoot=(.26, -.30, .085), rhand_rel=(.00, -.26, -.30), lhand_rel=(.10, -.24, -.24))),
    (28, dict(hips=(0, -.10, -.08), lean=12, lfoot=(.26, -.30, .085)))]), events=dict(release=10))
def _pickoff():
    S = _stretch_stages()["start"]; base = dict(S, head_yaw=0)
    return _keys(base, [
        (0, {}), (3, dict(hips=(0, .02, -.08), yaw=-40, hyaw=-20, lfoot=(.30, -.18, .16), rhand_rel=(-.22, .02, .16), lhand_rel=(.10, -.22, -.10))),
        (6, dict(hips=(0, -.04, -.14), yaw=15, hyaw=38, lfoot=(.70, -.24, .085), rfoot=(-.12, .06, .085), rfoot_o=(30, 0), lean=14, rhand_rel=(-.30, .04, .26), lhand_rel=(.26, -.24, -.10))),
        (9, dict(hips=(0, -.08, -.16), yaw=44, hyaw=48, lfoot=(.70, -.24, .085), rfoot=(-.12, .06, .085), rfoot_o=(40, 0), lean=24, rhand_rel=(.20, -.30, .28), lhand_rel=(.20, -.16, -.16))),
        (14, dict(hips=(0, -.08, -.16), yaw=40, hyaw=44, lfoot=(.70, -.24, .085), rfoot=(-.12, .06, .085), rfoot_o=(40, 0), lean=24, rhand_rel=(.10, -.26, -.30), lhand_rel=(.16, -.16, -.20))),
        (20, dict(hips=(0, -.06, -.12), yaw=30, hyaw=34, lfoot=(.70, -.24, .085), rfoot=(-.12, .06, .085), rfoot_o=(40, 0), lean=16, **CHEST))])
_reg("pickoff", 20, _pickoff(), events=dict(release=9))

# ---------------------------------------------------------------- tags
TAGB = dict(UPRIGHT, hips=(0, 0, -.22), lean=30, head_pitch=-20, lhand_rel=(.08, -.30, -.12), rhand_rel=(-.06, -.28, -.12))
_reg("tag_glove", 14, _keys(TAGB, [
    (0, {}), (4, dict(hips=(0, -.20, -.30), lean=40, lfoot=(.26, -.50, .085), lhand_rel=(.06, -.40, -.30), rhand_rel=(-.10, -.30, -.14))),
    (8, dict(hips=(0, -.26, -.34), lean=46, lfoot=(.26, -.52, .085), lhand_rel=(.05, -.44, -.40), lhand_face=(0, -1, -.6), rhand_rel=(-.12, -.30, -.16))),
    (10, dict(hips=(0, -.26, -.34), lean=46, lfoot=(.26, -.52, .085), lhand_rel=(-.10, -.42, -.38), lhand_face=(0, -1, -.6), rhand_rel=(-.12, -.28, -.14))),
    (14, dict(hips=(0, -.16, -.24), lean=32, lfoot=(.26, -.40, .085), lhand_rel=(.06, -.30, -.14), rhand_rel=(-.06, -.26, -.14)))]), events=dict(contact=8, sweep_end=10))
_reg("tag_hand", 14, _keys(dict(TAGB, lhand_rel=(.26, -.10, -.30), rhand_face=(0, -1, -.6)), [
    (0, dict(rhand_rel=(-.06, -.28, -.10))), (4, dict(hips=(0, -.20, -.30), lean=40, lfoot=(.26, -.50, .085), rhand_rel=(-.08, -.40, -.28))),
    (8, dict(hips=(0, -.26, -.34), lean=46, lfoot=(.26, -.52, .085), rhand_rel=(-.06, -.44, -.40))),
    (10, dict(hips=(0, -.26, -.34), lean=46, lfoot=(.26, -.52, .085), rhand_rel=(.10, -.42, -.38))),
    (14, dict(hips=(0, -.16, -.24), lean=32, lfoot=(.26, -.40, .085), rhand_rel=(-.06, -.26, -.14)))]), events=dict(contact=8, sweep_end=10))
def _catcher_block():
    C = dict(CLIPS["catcher_crouch"][1][0][1]); C.update(lpole=POLE_L, rpole=POLE_R, head_yaw=0)
    KNEE = dict(hips=(0, .10, -.64), lean=54, lfoot=(.38, .06, .085), rfoot=(-.38, .06, .085), lfoot_o=(62, 0), rfoot_o=(-62, 0), lknee=(1, -.3, 0), rknee=(-1, -.3, 0), head_pitch=-24)
    return _keys(C, [
        (0, {}), (5, dict(KNEE, lhand_rel=(.10, -.26, -.44), rhand_rel=(-.10, -.26, -.44), lhand_face=(0, -1, .2))),
        (9, dict(KNEE, lean=60, lhand_rel=(.06, -.32, -.52), rhand_rel=(-.06, -.32, -.52), lhand_face=(0, -1, .3))),
        (16, dict(KNEE, lean=60, lhand_rel=(.06, -.32, -.52), rhand_rel=(-.06, -.32, -.52), lhand_face=(0, -1, .3))),
        (21, dict(KNEE, lean=52, yaw=18, hyaw=10, lhand_rel=(.16, -.34, -.48), rhand_rel=(-.02, -.30, -.44))),
        (26, dict(KNEE, lean=50, yaw=30, hyaw=16, lhand_rel=(.34, -.30, -.44), lhand_face=(.4, -.5, -.8), rhand_rel=(.10, -.30, -.40))),
        (30, dict(KNEE, lean=50, yaw=30, hyaw=16, lhand_rel=(.34, -.30, -.44), lhand_face=(.4, -.5, -.8), rhand_rel=(.10, -.30, -.40))),
        (36, dict(C))])
_reg("catcher_block", 36, _catcher_block(), events=dict(block=9, tag_contact=26))

# ---------------------------------------------------------------- catcher receiving a pitch (start / end in `catcher_crouch`, mitt on the LEFT hand, throwing hand tucked behind the mitt-side leg)
def _catch_pitch(dy, mz, mx=.14, catch=7, lean=28, hips_z=-.48, tilt=(0, -1, .1), n=18):
    C = dict(CLIPS["catcher_crouch"][1][0][1]); C.update(lpole=(.6, .5, -.2), rpole=(-.6, .5, -.2), lhand_face=(0, -1, .1))
    BODY = dict(hips=(0, .05, hips_z), lean=lean, head_pitch=-28)
    return _keys(C, [
        (0, {}), (catch - 3, dict(BODY, lhand=(mx, -.74, mz), lhand_face=(0, -1, .05))),
        (catch, dict(BODY, lhand=(mx, dy, mz), lhand_face=tilt)),                                    # ball in the pocket, arm at full reach
        (catch + 3, dict(BODY, lhand=(mx, dy + .13, mz + .01), lhand_face=(0, -1, .2))),             # give: the mitt absorbs the pitch and draws back
        (catch + 6, dict(BODY, lhand=(mx + .05, dy + .10, mz + .03), lhand_face=(.1, -1, .2))),      # small framing pull toward the zone
        (n, dict(C))])
_reg("catch_pitch", 18, _catch_pitch(-.86, .62), events=dict(catch=7, give=10, frame=13))
_reg("catch_pitch_low", 18, _catch_pitch(-.82, .26, catch=7, lean=38, hips_z=-.52, tilt=(0, -.6, .8)), events=dict(catch=7, give=10, frame=13))
_reg("catch_pitch_high", 18, _catch_pitch(-.76, 1.02, catch=7, lean=20, hips_z=-.40, tilt=(0, -1, -.3)), events=dict(catch=7, give=10, frame=13))

# ---------------------------------------------------------------- slides (root motion baked: the hips travel toward -Y)
def _slide_pose(hy, hz, lean, lf, rf, hand_l, hand_r, **kw):
    sp = dict(hips=(0, hy, hz), lean=lean, lfoot=(.12, hy + lf[0], lf[1]), rfoot=(-.12, hy + rf[0], rf[1]), lhand_rel=hand_l, rhand_rel=hand_r, head_yaw=0, lpole=POLE_L, rpole=POLE_R,
              lknee=(.2, -1, .4), rknee=(-.6, -.4, 1))
    sp.update(kw); return sp
RUNP = dict(CLIPS["run"][1][2][1])      # a mid-stride run pose to start from
def _slides():
    keys = [
        (0, dict(RUNP)),
        (4, dict(RUNP, hips=(0, -.22, -.24), lean=10, lfoot=(.10, -.75, .30), rfoot=(-.10, .10, .085), lhand_rel=(.20, .10, -.20), rhand_rel=(-.20, .10, -.20))),
        (8, _slide_pose(-.42, -.52, -32, (-.62, .30), (-.02, .12), (.26, .14, -.06), (-.26, .14, -.06))),
        (12, _slide_pose(-.80, -.72, -56, (-.75, .24), (-.05, .20), (.30, .12, .04), (-.30, .12, .04))),
        (18, _slide_pose(-1.24, -.78, -68, (-.72, .24), (-.06, .20), (.28, .14, -.04), (-.28, .14, -.04))),
        (24, _slide_pose(-1.52, -.80, -74, (-.68, .22), (-.10, .18), (.20, .26, -.14), (-.20, .26, -.14))),
        (29, _slide_pose(-1.62, -.82, -78, (-.66, .22), (-.12, .18), (.18, .30, -.16), (-.18, .30, -.16)))]
    _reg("slide_feet", 29, keys, events=dict(slide_start=6, rest=24))
    # hook slides: legs swing to one side, the trunk twists and leans away, the trailing leg bends under
    def hook(sp):
        s = dict(sp); h = s['hips']; s['hyaw'] = 38*min(1, max(0, (-h[1]-.2)/.5)); s['yaw'] = -22*min(1, max(0, (-h[1]-.2)/.5)); s['side'] = -20*min(1, max(0, (-h[1]-.2)/.5))
        if h[1] < -.3:
            k = min(1, (-h[1]-.3)/.5); dx = math.sin(math.radians(38))*k
            s['lfoot'] = (s['lfoot'][0] + .55*dx*1.3, s['lfoot'][1] + .10*k, s['lfoot'][2]); s['rfoot'] = (s['rfoot'][0] + .30*dx, s['rfoot'][1], s['rfoot'][2])
        return s
    hk = [(f, hook(sp)) for f, sp in keys]
    _reg("slide_hook_left", 29, hk, events=dict(slide_start=6, rest=24))
    _reg("slide_hook_right", 29, [(f, _mirror(sp)) for f, sp in hk], events=dict(slide_start=6, rest=24))
    # head-first dive
    def dive(hy, hz, lean, legs, hands, **kw):
        sp = dict(hips=(0, hy, hz), lean=lean, lfoot=(.10, hy + legs[0], legs[1]), rfoot=(-.10, hy + legs[0]*.95, legs[1]), lhand_rel=(.10, hands[0], hands[1]), rhand_rel=(-.10, hands[0], hands[1]),
                  head_yaw=0, head_pitch=-40, lpole=POLE_L, rpole=POLE_R, lknee=(0, 1, 0), rknee=(0, 1, 0)); sp.update(kw); return sp
    dk = [
        (0, dict(RUNP)),
        (4, dict(RUNP, hips=(0, -.20, -.26), lean=26, lhand_rel=(.10, -.30, -.10), rhand_rel=(-.10, -.30, -.10))),
        (8, dive(-.50, -.38, 62, (.26, .30), (-.50, -.10))),
        (12, dive(-.95, -.58, 80, (.70, .28), (-.56, -.02))),
        (16, dive(-1.32, -.78, 88, (.78, .13), (-.56, -.04))),
        (22, dive(-1.62, -.80, 88, (.78, .13), (-.56, -.04))),
        (26, dive(-1.72, -.80, 88, (.78, .13), (-.54, -.06)))]
    _reg("slide_head", 26, dk, events=dict(dive_start=6, land=14, rest=22))
    # quick dive back to the bag on a pickoff: starts from the lead-off crouch
    LEAD = dict(hips=(0, 0, -.30), lean=30, lfoot=(.34, -.06, .085), rfoot=(-.34, .04, .085), lfoot_o=(10, 0), rfoot_o=(-10, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_pitch=-20, head_yaw=0,
                lpole=POLE_L, rpole=POLE_R, lhand_rel=(.14, -.24, -.30), rhand_rel=(-.14, -.24, -.30))
    _reg("dive_back", 18, [
        (0, dict(LEAD)), (3, dict(LEAD, hips=(0, -.18, -.30), lean=50, lhand_rel=(.10, -.40, -.06), rhand_rel=(-.10, -.40, -.06))),
        (6, dive(-.55, -.52, 78, (.70, .24), (-.56, -.02))), (10, dive(-1.05, -.78, 88, (.78, .13), (-.56, -.04))),
        (14, dive(-1.22, -.80, 88, (.78, .13), (-.54, -.06))), (18, dive(-1.26, -.80, 88, (.78, .13), (-.54, -.06)))], events=dict(dive_start=3, land=9))
    # getting up (root = where the slide ended, the hips start at y = 0)
    def lying(hz=-.82, lean=-78): return _slide_pose(0, hz, lean, (-.66, .22), (-.12, .18), (.18, .30, -.16), (-.18, .30, -.16))
    _reg("pop_up", 30, [
        (0, lying()), (6, _slide_pose(0, -.74, -46, (-.66, .22), (-.16, .16), (.20, .30, -.20), (-.20, .30, -.20))),
        (12, dict(hips=(0, -.06, -.50), lean=20, lfoot=(.24, -.42, .085), rfoot=(-.14, -.16, .085), lhand_rel=(.16, -.26, -.26), rhand_rel=(-.16, -.26, -.26), lknee=(.2, -1, 0), rknee=(-.2, -1, 0), head_yaw=0, lpole=POLE_L, rpole=POLE_R)),
        (20, dict(hips=(0, -.14, -.22), lean=22, lfoot=(.24, -.44, .085), rfoot=(-.14, -.12, .085), lhand_rel=(.10, -.26, -.30), rhand_rel=(-.10, -.26, -.30), lknee=(.2, -1, 0), rknee=(-.2, -1, 0), head_yaw=0, lpole=POLE_L, rpole=POLE_R)),
        (30, dict(hips=(0, -.16, -.10), lean=14, lfoot=(.20, -.30, .085), rfoot=(-.20, -.06, .085), lhand_rel=(.10, -.20, -.44), rhand_rel=(-.10, -.20, -.44), lknee=(.1, -1, 0), rknee=(-.1, -1, 0), head_yaw=0, lpole=POLE_L, rpole=POLE_R))], events=dict(sit_up=6, stand=20))
    _reg("pop_up_head", 30, [
        (0, dive(0, -.80, 88, (.78, .13), (-.54, -.06))),
        (8, dict(hips=(0, -.06, -.66), lean=50, lfoot=(.30, .06, .085), rfoot=(-.30, .06, .085), lhand_rel=(.10, -.34, -.40), rhand_rel=(-.10, -.34, -.40), lknee=(.6, -1, 0), rknee=(-.6, -1, 0), head_yaw=0, lpole=POLE_L, rpole=POLE_R)),
        (16, dict(hips=(0, -.12, -.36), lean=34, lfoot=(.28, -.20, .085), rfoot=(-.24, .06, .085), lhand_rel=(.10, -.28, -.30), rhand_rel=(-.10, -.28, -.30), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_yaw=0, lpole=POLE_L, rpole=POLE_R)),
        (30, dict(hips=(0, -.14, -.10), lean=14, lfoot=(.20, -.30, .085), rfoot=(-.20, -.06, .085), lhand_rel=(.10, -.20, -.44), rhand_rel=(-.10, -.20, -.44), lknee=(.1, -1, 0), rknee=(-.1, -1, 0), head_yaw=0, lpole=POLE_L, rpole=POLE_R))], events=dict(push_up=8, stand=16))
_slides()
