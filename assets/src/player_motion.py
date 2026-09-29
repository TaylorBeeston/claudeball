# Realism pass on the everyday clips (same names / lengths / event frames): run, run_turn, throw, field_ready (+ 3 ready-position variants), idle.
# Requires player_clips.py + player_pitch.py exec'd (CLIPS, FRAME0). Blender axes: model faces -Y, left = +X, up = +Z.
# Principles: contact/flight foot paths that reach (no clamped legs), arms swing opposite to the legs with ~90 deg elbows, hips and shoulders counter-rotate,
# the head stays level (absolute head yaw), weight transfers over the planted foot, throws separate hips from shoulders and finish across the body.
import math

def _cyc(p): return math.cos(2*math.pi*p)
def run_v2(n=24, duty=.40, half=.32, lean=26, bank=0, dx=0.0, yaw0=0, hyaw0=0, head_yaw=0, foot_o=((0, 0), (0, 0)), amp=(1.0, 1.0), hand_dx=0.0, rot=(7, 9)):
    """One running cycle (left foot contact at frame 0): stance foot slides back at constant speed, swing foot heel-kicks up and reaches forward,
    hips are lowest at mid-stance and highest in the flight phase."""
    fwd = (-.04, -.30, -.12); back = (.10, .20, -.40); out = []
    def foot(p):
        p %= 1.0
        if p < duty: return (-half + 2*half*p/duty, .085)
        q = (p-duty)/(1-duty); e = q*q*(3-2*q)
        return (half - 2*half*e, .085 + .40*math.sin(math.pi*q)**1.15)
    for f in range(n+1):
        p = (f % n)/n; ly, lz = foot(p); ry, rz = foot(p+.5)
        bob = -.14 + .08*(1 - math.cos(4*math.pi*(p - duty/2)))/2
        sl = (1 - _cyc(p))/2; sr = (1 + _cyc(p))/2                    # left arm forward when the right foot is forward
        lh = tuple((back[i]*(1-sl) + fwd[i]*sl) for i in range(3)); rh = tuple((back[i]*(1-sr) + fwd[i]*sr) for i in range(3))
        lh = (lh[0]*amp[0] + .02, lh[1]*amp[0], lh[2]*amp[0] + (1-amp[0])*(-.1)); rh = (rh[0]*amp[1] + .02, rh[1]*amp[1], rh[2]*amp[1] + (1-amp[1])*(-.1))
        spec = dict(hips=(0, 0, bob), lean=lean, yaw=yaw0 + rot[0]*_cyc(p), hyaw=hyaw0 - rot[1]*_cyc(p), head_yaw=head_yaw, head_pitch=-.5*lean,
                    lfoot=(.10+dx, ly, lz), rfoot=(-.10+dx, ry, rz), lhand_rel=(lh[0]+hand_dx, lh[1], lh[2]), rhand_rel=(-rh[0] - abs(hand_dx)*.6, rh[1], rh[2]),
                    lpole=(.15, .35, -1), rpole=(-.15, .35, -1), lfoot_o=foot_o[0], rfoot_o=foot_o[1])
        if bank: spec['side'] = bank
        out.append((f, spec))
    return out
def run_turn_v2(): return run_v2(lean=28, bank=18, dx=-.15, yaw0=8, hyaw0=12, head_yaw=34, foot_o=((10, 0), (16, 0)), amp=(.8, 1.0), hand_dx=.03)

# ---------------------------------------------------------------- throw (release frame 12, 30 frames, root motion .3 m)
def throw_v2():
    K = dict(head_yaw=0)
    return [
     (0,  dict(K, hips=(0, 0, -.10), lean=16, lfoot=(.16, 0, .085), rfoot=(-.16, 0, .085), lhand=(.06, -.30, 1.22), rhand=(-.06, -.28, 1.22), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7), head_pitch=-8)),
     (5,  dict(K, hips=(0, -.05, -.12), lean=12, yaw=-34, hyaw=-18, lfoot=(.16, -.34, .16), lknee=(.2, -1, .2), rfoot=(-.18, .03, .085), rfoot_o=(-20, 0),
               lhand=(.38, -.55, 1.25), rhand_rel=(-.30, .10, .08), lpole=(.5, .3, .4), rpole=(-1, .3, .2), head_pitch=-8)),
     (8,  dict(K, hips=(0, -.13, -.18), lean=14, yaw=-30, hyaw=14, lfoot=(.16, -.70, .085), rfoot=(-.20, .03, .10), rfoot_o=(-26, 0),
               lhand=(.36, -.66, 1.20), rhand_rel=(-.30, .06, .30), lpole=(.5, .3, .4), rpole=(-1, .2, .5), head_pitch=-10)),
     (10, dict(K, hips=(0, -.18, -.18), lean=30, yaw=4, hyaw=26, lfoot=(.16, -.70, .085), rfoot=(-.20, .02, .12), rfoot_o=(-28, 0),
               lhand=(.26, -.45, 1.05), rhand_rel=(-.20, -.20, .48), lpole=(.5, .3, .1), rpole=(-.8, .1, .6), head_pitch=-16)),
     (12, dict(K, hips=(0, -.22, -.18), lean=44, side=5, yaw=22, hyaw=32, lfoot=(.16, -.70, .085), rfoot=(-.20, -.04, .14), rfoot_o=(-30, 0),
               lhand=(.26, -.30, .95), rhand_rel=(-.12, -.36, .44), lpole=(.6, .3, -.3), rpole=(-.4, .5, .6), head_pitch=-22)),
     (16, dict(K, hips=(0, -.27, -.16), lean=56, side=4, yaw=38, hyaw=36, lfoot=(.16, -.70, .085), rfoot=(-.22, -.34, .28), lhand=(.34, -.22, .88), rhand_rel=(.18, -.32, -.40),
               lpole=(.7, .3, -.3), rpole=(0, .6, .3), head_pitch=-26)),
     (22, dict(K, hips=(0, -.30, -.14), lean=40, yaw=14, hyaw=18, lfoot=(.16, -.70, .085), rfoot=(-.20, -.55, .085), lhand=(.30, -.30, .95), rhand_rel=(.02, -.24, -.46),
               lpole=(.6, .3, -.3), rpole=(-.6, .3, -.3), head_pitch=-20)),
     (30, dict(K, hips=(0, -.30, -.10), lean=24, yaw=2, hyaw=2, lfoot=(.16, -.70, .085), rfoot=(-.18, -.52, .085), lhand=(.08, -.34, 1.20), rhand=(-.08, -.32, 1.18), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7), head_pitch=-12)),
    ]

# ---------------------------------------------------------------- ready positions (loops) with micro movement
def _ready(base, n=40, sway=.02, bounce=.012):
    keys = []
    for f, a, b in ((0, 0, 0), (10, 1, .6), (20, 0, 1), (30, -1, .3), (40, 0, 0)):
        sp = dict(base); h = list(sp['hips']); h[0] += sway*a; h[2] += bounce*(b-.5) if f else 0; sp['hips'] = tuple(h); sp['head_yaw'] = 0
        kk = 'lhand_rel' if 'lhand_rel' in sp else 'lhand'; hd = list(sp[kk]); hd[0] += .01*a; sp[kk] = tuple(hd)
        keys.append((f, sp))
    return keys
READY_INFIELD = dict(hips=(0, -.06, -.36), lean=54, lfoot=(.34, 0, .085), rfoot=(-.34, 0, .085), lfoot_o=(14, 0), rfoot_o=(-14, 0), lknee=(.4, -1, 0), rknee=(-.4, -1, 0),
                     lhand_rel=(.08, -.30, -.54), rhand_rel=(-.10, -.28, -.54), lpole=(.6, .6, -.2), rpole=(-.6, .6, -.2), head_pitch=-32)
READY_OUTFIELD = dict(hips=(0, -.02, -.15), lean=28, lfoot=(.28, 0, .085), rfoot=(-.28, 0, .085), lfoot_o=(8, 0), rfoot_o=(-8, 0), lknee=(.2, -1, 0), rknee=(-.2, -1, 0),
                      lhand_rel=(.10, -.12, -.46), rhand_rel=(-.10, -.10, -.48), lpole=(.7, .3, -.4), rpole=(-.7, .3, -.4), head_pitch=-14)
READY_KNEES = dict(hips=(0, .04, -.24), lean=66, lfoot=(.26, 0, .085), rfoot=(-.26, 0, .085), lfoot_o=(10, 0), rfoot_o=(-10, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
                   lhand=(.22, -.24, .58), rhand=(-.22, -.24, .58), lpole=(.6, .3, -.4), rpole=(-.6, .3, -.4), head_pitch=-40)

CLIPS["run"] = (24, run_v2()); FRAME0["run"] = 0
CLIPS["run_turn"] = (24, run_turn_v2()); FRAME0["run_turn"] = 0
CLIPS["throw"] = (30, throw_v2())
CLIPS["field_ready"] = (40, _ready(dict(hips=(0, -.06, -.34), lean=42, lfoot=(.32, 0, .085), rfoot=(-.32, 0, .085), lfoot_o=(12, 0), rfoot_o=(-12, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
                        lhand_rel=(.08, -.30, -.52), rhand_rel=(-.10, -.28, -.52), lpole=(.6, .6, -.2), rpole=(-.6, .6, -.2), head_pitch=-30)))
CLIPS["field_ready_infield"] = (40, _ready(READY_INFIELD)); CLIPS["field_ready_outfield"] = (40, _ready(READY_OUTFIELD, sway=.03, bounce=.02)); CLIPS["field_ready_hands_knees"] = (40, _ready(READY_KNEES, sway=.012, bounce=.008))
for _n in ("field_ready", "field_ready_infield", "field_ready_outfield", "field_ready_hands_knees"): FRAME0[_n] = 0

# ---------------------------------------------------------------- densify: re-solve the IK on every frame so planted feet stay on the ground between sparse keys
def _lerp(a, b, t):
    if isinstance(a, (tuple, list)) and isinstance(b, (tuple, list)): return tuple(_lerp(x, y, t) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)): return a + (b-a)*t
    return a if t < .5 else b
_DEF = dict(lfoot_o=(0, 0), rfoot_o=(0, 0), side=0, yaw=0, hyaw=0, lean=0, head_pitch=0, hips=(0, 0, 0), lknee=(0, -1, 0), rknee=(0, -1, 0))
def densify(keys):
    out = []
    for (fa, sa), (fb, sb) in zip(keys, keys[1:]):
        out.append((fa, sa))
        for f in range(fa+1, fb):
            t = (f-fa)/(fb-fa); e = t*t*(3-2*t); sp = {}
            for k in set(sa) | set(sb):
                a_, b_ = sa.get(k, _DEF.get(k, sb.get(k))), sb.get(k, _DEF.get(k, sa.get(k))); sp[k] = _lerp(a_, b_, e)
            out.append((f, sp))
    out.append(keys[-1]); return out
for _n in ("pitch", "windup", "slide", "field_catch", "catch_jump"): CLIPS[_n] = (CLIPS[_n][0], densify(CLIPS[_n][1]))       # the old delivery clips: same key poses/event frames, no more sinking between keys

# swing: the rear foot pivots onto its toes, so its ankle has to rise with the toe pitch (it used to push the toes through the ground)
_lift = {17: .135, 20: .195, 22: .22, 27: .235, 32: .235}
CLIPS["swing"] = (CLIPS["swing"][0], [(f, (dict(sp, rfoot=(sp['rfoot'][0], sp['rfoot'][1], _lift[f])) if f in _lift else sp)) for f, sp in CLIPS["swing"][1]])
CLIPS["swing"] = (CLIPS["swing"][0], densify(CLIPS["swing"][1]))       # per-frame IK so the pivoting rear foot follows its toe pitch

# ---------------------------------------------------------------- walk (1.44 m/s, 20 frames = 0.833 s per cycle) and relaxed arms for the trot
def walk_v2(n=20, duty=.60, half=.36, lean=6):
    """Relaxed walk: stance foot slides back at exactly the walking speed (2 * half * ... / (duty * n / 24) = 1.44 m/s), toe-clearance swing, hips highest at
    mid-stance and lowest at double support, small lateral sway and pelvis/shoulder counter-rotation; arms hang with ~25 deg elbow flexion, forearms swing opposite to the legs."""
    fwd = (.08, -.17, -.50); back = (.08, .15, -.52); out = []
    def foot(p):
        p %= 1.0
        if p < duty: return (-half + 2*half*p/duty, .085)
        q = (p-duty)/(1-duty); e = q*q*(3-2*q)
        return (half - 2*half*e, .085 + .11*math.sin(math.pi*q)**1.3)
    for f in range(n+1):
        p = (f % n)/n; ly, lz = foot(p); ry, rz = foot(p+.5); c = _cyc(p)
        bob = -.145 + .075*(1 + math.cos(4*math.pi*(p - duty/2)))/2
        sl = (1 - c)/2; sr = (1 + c)/2
        lh = tuple(back[i]*(1-sl) + fwd[i]*sl for i in range(3)); rh = tuple(back[i]*(1-sr) + fwd[i]*sr for i in range(3))
        out.append((f, dict(hips=(.02*math.sin(2*math.pi*p), 0, bob), lean=lean, yaw=4*c, hyaw=-4*c, head_yaw=0, head_pitch=-3,
                            lfoot=(.09, ly, lz), rfoot=(-.09, ry, rz), lhand_rel=lh, rhand_rel=(-rh[0], rh[1], rh[2]), lpole=(.12, .3, -1), rpole=(-.12, .3, -1))))
    return out
CLIPS["walk"] = (20, walk_v2()); FRAME0["walk"] = 0

def _trot_arms():
    keys = []
    for f, sp in CLIPS["trot"][1]:
        p = (f % 18)/18; c = _cyc(p); sl = (1 - c)/2; sr = (1 + c)/2
        fwd = (.0, -.22, -.16); back = (.10, .14, -.40)
        lh = tuple(back[i]*(1-sl) + fwd[i]*sl for i in range(3)); rh = tuple(back[i]*(1-sr) + fwd[i]*sr for i in range(3))
        sp = dict(sp); sp.pop('lhand', None); sp.pop('rhand', None); sp.update(lhand_rel=lh, rhand_rel=(-rh[0], rh[1], rh[2]), lpole=(.15, .35, -1), rpole=(-.15, .35, -1)); keys.append((f, sp))
    return keys
CLIPS["trot"] = (18, _trot_arms())

# idle: relaxed arms hanging a little away from the body (they used to hang with the elbows pressed into the torso)
def _idle_arms():
    keys = []
    for f, sp in CLIPS["idle"][1]:
        sp = dict(sp); sp.pop('lhand', None); sp.pop('rhand', None); y = -.03 if f in (0, 60) else -.06
        sp.update(lhand_rel=(.125, y, -.55), rhand_rel=(-.125, y, -.55), lpole=(.15, .35, -1), rpole=(-.15, .35, -1)); keys.append((f, sp))
    return keys
CLIPS["idle"] = (60, _idle_arms())
