# The 11 required clips. Each clip = list of (frame, pose-spec) — see player_anim.solve for the spec keys.
# Coordinates: Blender axes (character faces -Y, left = +X). Right-handed pitcher/thrower/batter; glove on the left hand.
import math
S = lambda **k: k
STAND = dict()
def run_clip(lean=14, side=0, dx=0.0, yaw0=0, hyaw0=0, head_yaw=None, foot_o=((0, 0), (0, 0)), lamp=.38, ramp=.38, hand_dx=0.0):
    out = []
    for f in range(0, 25, 2):
        ph = 2*math.pi*f/24
        lf_y = -0.55*math.cos(ph); rf_y = -0.55*math.cos(ph+math.pi)
        lf_z = .08 + 0.30*max(0.0, -math.sin(ph)); rf_z = .08 + 0.30*max(0.0, -math.sin(ph+math.pi))
        # arms swing opposite to legs; elbows ~90 deg
        lh = (.22+hand_dx, -.10+lamp*math.cos(ph), 1.12 + .12*max(0, -math.sin(ph))*0); rh = (-.22+hand_dx, -.10-ramp*math.cos(ph), 1.12)
        spec = dict(lean=lean, hips=(0, 0, -.06+.03*math.cos(2*ph)), yaw=yaw0+7*math.sin(ph), hyaw=hyaw0-7*math.sin(ph),
                    lfoot=(.11+dx, lf_y, lf_z), rfoot=(-.11+dx, rf_y, rf_z), lhand=lh, rhand=rh, lpole=(.6, .3, -.6), rpole=(-.6, .3, -.6),
                    lfoot_o=foot_o[0], rfoot_o=foot_o[1])
        if side: spec['side'] = side
        if head_yaw is not None: spec['head_yaw'] = head_yaw
        out.append((f, spec))
    return out
# `run_turn`: same 24-frame cadence/phase as `run` (so the two blend cleanly), running a left-hand turn: body banked to the left (+X), pelvis and
# shoulders turned into the turn, head leading, feet landing to the right of the pelvis (so the whole body leans in), outside (right) arm swings wider.
def run_turn_clip():
    return run_clip(lean=17, side=20, dx=-.17, yaw0=7, hyaw0=12, head_yaw=34, foot_o=((10, 0), (16, 0)), lamp=.30, ramp=.44, hand_dx=.10)

# `trot`: relaxed home-run jog, 18 frames = 0.75 s per cycle (two steps). Stance foot slides back at exactly 2.2 m/s so it does not skate:
# stance 0.42 of the cycle = 0.315 s -> 0.69 m of foot travel (+-0.345 m about the hip).  In place (the engine supplies the ground speed).
TROT_SPEED = 2.2
def trot_clip(n=18, duty=.42):
    travel = TROT_SPEED*duty*n/24.0; half = travel/2; out = []
    def foot(p):
        p %= 1.0
        if p < duty: return (-half+travel*p/duty, .085)
        q = (p-duty)/(1-duty); e = q*q*(3-2*q)
        return (half-travel*e, .085 + .27*math.sin(math.pi*q))
    for f in range(0, n+1):
        p = (f % n)/n; ly, lz = foot(p); ry, rz = foot(p+.5); c = math.cos(2*math.pi*p)
        bob = .03*(1-math.cos(4*math.pi*(p-duty/2)))/2
        out.append((f, dict(hips=(0, 0, -.10+bob), lean=4, yaw=7*c, hyaw=-6*c, head_yaw=0, head_pitch=-6,
                            lfoot=(.10, ly, lz), rfoot=(-.10, ry, rz),
                            lhand=(.24, -.14+.18*c, .94+.04*max(0, c)), rhand=(-.24, -.14-.18*c, .94+.04*max(0, -c)),
                            lpole=(.45, .7, -.6), rpole=(-.45, .7, -.6), lknee=(0, -1, 0), rknee=(0, -1, 0))))
    return out

def celebrate_clip():
    out = []
    for f in range(0, 41, 5):
        ph = 2*math.pi*f/40; up = max(0.0, math.sin(2*ph))
        out.append((f, dict(hips=(0, 0, .12*up-.03), lean=-6, lfoot=(.16, 0, .08+.12*up), rfoot=(-.16, 0, .08+.12*up),
                            lhand=(.30, -.10+.08*math.sin(ph), 2.12), rhand=(-.30, -.10-.08*math.sin(ph), 2.12), lpole=(.9, .2, 0), rpole=(-.9, .2, 0),
                            head_pitch=-12, yaw=8*math.sin(ph))))
    return out

# Batting stance (right-handed; the engine mirrors lefties). Body faces model-forward, which the engine turns to face the plate: chest/shoulders square to the
# plate = perpendicular to the mound line, head turned ~78 deg over the front (left) shoulder to the pitcher (neck 39, head 78), knees flexed and out,
# weight on the back foot, hands back by the rear shoulder, bat cocked over it.  The `swing` clip starts from exactly this pose (frame 0).
STANCE0 = dict(hips=(-.03, .02, -.12), lean=14, yaw=-7, hyaw=-4, head_yaw=78, head_pitch=-14, lfoot=(.30, 0, .085), rfoot=(-.30, .02, .085),
               lknee=(.30, -1, 0), rknee=(-.30, -1, 0), bat=((-.17, -.20, 1.36), (-.30, .12, .94)), lpole=(.2, .3, -.9), rpole=(-.5, .8, -.3))
def S0(**k): d = dict(STANCE0); d.update(k); return d
def stance_clip():
    return [(0, S0()),
            (12, S0(hips=(-.06, .03, -.115), yaw=-10, hyaw=-6, bat=((-.19, -.17, 1.38), (-.33, .17, .93)))),
            (24, S0(hips=(-.01, .015, -.135), yaw=-5, hyaw=-2, head_pitch=-16, bat=((-.15, -.23, 1.35), (-.27, .05, .96)))),
            (36, S0(hips=(-.045, .025, -.11), yaw=-8, hyaw=-4, bat=((-.18, -.19, 1.37), (-.31, .14, .94)))),
            (48, S0())]

# `catch_jump`: outfielder leaping at the wall, 29 frames = 1.21 s (plant 0-4, load 4, take-off 8, apex 14 = glove highest, hang 11-17, touch-down 20, absorb 23, settle 29).
# Glove arm (model Left; `Glove_Pocket`) reaches up and over the fence; the hip rise is baked in (root motion in z, plus 0.2 m toward the wall).
def catch_jump_clip():
    K = dict(lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_yaw=0)
    def air(h, ly, ry):                      # feet tucked while airborne, follow the hips up
        z = .085+h+.03+.14; return dict(lfoot=(.20, ly, z), rfoot=(-.20, ry, z-.10))
    return [
     (0,  dict(K, hips=(0, .05, -.14), lean=16, lfoot=(.22, -.12, .085), rfoot=(-.20, .10, .085), lhand=(.28, -.25, .95), rhand=(-.26, -.18, .95), head_pitch=-14, lpole=(.6, .3, -.6), rpole=(-.6, .3, -.6))),
     (4,  dict(K, hips=(0, .10, -.32), lean=25, lfoot=(.22, -.12, .085), rfoot=(-.20, .10, .085), lhand=(.30, .08, .70), rhand=(-.30, .10, .70), head_pitch=-24, lpole=(.6, .3, -.6), rpole=(-.6, .3, -.6))),
     (8,  dict(K, hips=(0, -.06, -.03), lean=7, lfoot=(.22, -.14, .085), rfoot=(-.20, .08, .085), lhand=(.24, -.40, 1.78), rhand=(-.28, -.25, 1.40), head_pitch=-28, lpole=(.5, .5, .3), rpole=(-.7, .4, -.3))),
     (11, dict(K, hips=(0, -.16, .18), lean=3, side=4, lhand=(.22, -.52, 2.16), rhand=(-.42, -.15, 1.62), head_pitch=-30, lpole=(.5, .5, .4), rpole=(-.9, .3, .0), **air(.18, -.32, -.02))),
     (14, dict(K, hips=(0, -.22, .30), lean=0, side=6, lhand=(.22, -.56, 2.30), rhand=(-.46, -.10, 1.78), head_pitch=-32, lpole=(.5, .5, .4), rpole=(-.9, .3, .0), **air(.30, -.42, -.05))),
     (17, dict(K, hips=(0, -.20, .19), lean=4, side=4, lhand=(.22, -.52, 2.14), rhand=(-.40, -.16, 1.62), head_pitch=-26, lpole=(.5, .5, .4), rpole=(-.9, .3, .0), **air(.19, -.36, -.08))),
     (20, dict(K, hips=(0, -.17, -.03), lean=12, lfoot=(.24, -.22, .085), rfoot=(-.22, -.06, .085), lhand=(.18, -.42, 1.70), rhand=(-.26, -.30, 1.45), head_pitch=-18, lpole=(.6, .4, .0), rpole=(-.6, .4, -.3))),
     (23, dict(K, hips=(0, -.14, -.28), lean=28, lfoot=(.26, -.22, .085), rfoot=(-.24, -.08, .085), lhand=(.14, -.45, 1.22), rhand=(-.12, -.38, 1.15), head_pitch=-16, lpole=(.6, .4, -.3), rpole=(-.6, .4, -.3))),
     (29, dict(K, hips=(0, -.10, -.20), lean=22, lfoot=(.26, -.22, .085), rfoot=(-.24, -.08, .085), lhand=(.15, -.40, 1.10), rhand=(-.13, -.34, 1.05), head_pitch=-14, lpole=(.6, .4, -.3), rpole=(-.6, .4, -.3)))]

CLIPS = {
 "idle": (60, [
    (0, dict(lfoot=(.15, 0, .08), rfoot=(-.15, 0, .08), lfoot_o=(8, 0), rfoot_o=(-8, 0))),
    (30, dict(hips=(0.01, 0, -.006), lean=2, lfoot=(.15, 0, .08), rfoot=(-.15, 0, .08), lfoot_o=(8, 0), rfoot_o=(-8, 0), lhand=(.28, -.08, .92), rhand=(-.28, -.08, .92), head_pitch=2)),
    (60, dict(lfoot=(.15, 0, .08), rfoot=(-.15, 0, .08), lfoot_o=(8, 0), rfoot_o=(-8, 0)))]),
 "windup": (40, [
    (0, dict(lhand=(.05, -.30, 1.20), rhand=(-.05, -.30, 1.20), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7), lfoot=(.13, 0, .08), rfoot=(-.13, 0, .08))),
    (14, dict(lean=-8, hips=(0, .04, 0), lhand=(.06, -.05, 1.98), rhand=(-.06, -.05, 1.98), lpole=(.8, 0, -.3), rpole=(-.8, 0, -.3), head_pitch=-10, lfoot=(.13, 0, .08), rfoot=(-.13, 0, .08))),
    (28, dict(lean=-6, hips=(0, .04, -.03), lhand=(.06, -.30, 1.25), rhand=(-.06, -.30, 1.25), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7),
              lfoot=(.13, -.10, .70), lknee=(0, -1, .1), rfoot=(-.13, .02, .08), yaw=-15)),
    (40, dict(lean=-6, hips=(0, .04, -.03), lhand=(.06, -.30, 1.25), rhand=(-.06, -.30, 1.25), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7),
              lfoot=(.13, -.10, .72), lknee=(0, -1, .1), rfoot=(-.13, .02, .08), yaw=-15))]),
 "pitch": (36, [
    (0, dict(lean=-6, hips=(0, .04, -.03), lhand=(.06, -.30, 1.25), rhand=(-.06, -.30, 1.25), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7),
             lfoot=(.13, -.10, .72), lknee=(0, -1, .1), rfoot=(-.13, .02, .08), yaw=-15)),
    (9, dict(lean=6, hips=(0, -.35, -.12), yaw=-35, hyaw=-10, lfoot=(.16, -.90, .08), rfoot=(-.14, .05, .08), rfoot_o=(-10, 0),
             lhand=(.28, -.62, 1.55), rhand=(-.62, .38, 1.55), lpole=(.4, .3, .5), rpole=(-.4, .3, -.6), head_yaw=0)),
    (15, dict(lean=14, hips=(0, -.50, -.14), yaw=-8, hyaw=15, lfoot=(.17, -.90, .08), rfoot=(-.14, .05, .08), lhand=(.30, -.55, 1.35), rhand=(-.45, .30, 1.85),
              lpole=(.3, .2, .6), rpole=(-.3, .9, .3), head_yaw=0)),
    (20, dict(lean=32, hips=(0, -.58, -.16), yaw=24, hyaw=30, lfoot=(.17, -.90, .08), rfoot=(-.15, -.05, .12), lhand=(.22, -.25, 1.30), rhand=(-.18, -.82, 1.72),
              lpole=(.5, .5, .2), rpole=(-.3, .6, .6), head_yaw=0)),
    (27, dict(lean=52, hips=(0, -.66, -.14), yaw=36, hyaw=38, lfoot=(.17, -.90, .08), rfoot=(-.20, -.42, .30), lhand=(.35, -.25, .90), rhand=(.25, -.55, 1.00),
              lpole=(.7, .3, -.3), rpole=(0, .3, .8), head_yaw=0)),
    (36, dict(lean=38, hips=(0, -.70, -.10), yaw=20, hyaw=20, lfoot=(.17, -.90, .08), rfoot=(-.20, -.62, .08), lhand=(.30, -.30, .85), rhand=(.10, -.45, .85), head_yaw=0))]),
 "swing": (32, [
    (0, STANCE0),
    (8, dict(hips=(-.05, .02, -.10), lean=14, yaw=-24, hyaw=-12, head_yaw=90, lfoot=(.30, 0, .18), rfoot=(-.30, .02, .085),
             bat=((-.30, -.10, 1.40), (-.55, .18, .81)), lpole=(.2, .3, -.9), rpole=(-.5, .8, -.3))),
    (13, dict(hips=(.10, .0, -.13), lean=14, yaw=-26, hyaw=-12, head_yaw=90, lfoot=(.64, 0, .085), rfoot=(-.30, .02, .085),
              bat=((-.30, -.10, 1.40), (-.55, .20, .80)), lpole=(.2, .3, -.9), rpole=(-.5, .8, -.3))),
    (17, dict(hips=(.12, -.02, -.14), lean=15, yaw=-8, hyaw=25, head_yaw=90, lfoot=(.64, 0, .085), rfoot=(-.30, .02, .085), rfoot_o=(0, 14),
              bat=((-.17, -.28, 1.32), (-.72, -.30, .55)), lpole=(.3, .4, -.8), rpole=(-.5, .8, -.3))),
    (20, dict(hips=(.14, -.04, -.14), lean=13, yaw=32, hyaw=52, head_yaw=90, lfoot=(.64, 0, .085), rfoot=(-.30, .02, .085), rfoot_o=(0, 30),
              bat=((.0, -.40, 1.16), (-.35, -.85, .30)), lpole=(.5, .4, -.7), rpole=(-.4, .7, -.5))),
    (22, dict(hips=(.15, -.05, -.13), lean=12, yaw=62, hyaw=68, head_yaw=90, lfoot=(.64, 0, .085), rfoot=(-.30, .02, .085), rfoot_o=(0, 40),
              bat=((.16, -.44, 1.13), (.75, -.62, .05)), lpole=(.6, .3, -.6), rpole=(-.2, .6, -.7))),
    (27, dict(hips=(.15, -.04, -.11), lean=10, yaw=95, hyaw=82, head_yaw=105, lfoot=(.64, 0, .085), rfoot=(-.30, .02, .085), rfoot_o=(0, 45),
              bat=((.20, -.05, 1.55), (-.10, .85, .50)), lpole=(.6, .4, .2), rpole=(0, .8, .3))),
    (32, dict(hips=(.15, -.04, -.10), lean=8, yaw=92, hyaw=80, head_yaw=105, lfoot=(.64, 0, .085), rfoot=(-.30, .02, .085), rfoot_o=(0, 45),
              bat=((.20, -.03, 1.52), (-.15, .85, .45)), lpole=(.6, .4, .2), rpole=(0, .8, .3)))]),
 "run": (24, run_clip()),
 "field_ready": (40, [
    (0, dict(hips=(0, -.06, -.34), lean=42, lfoot=(.32, 0, .08), rfoot=(-.32, 0, .08), lfoot_o=(12, 0), rfoot_o=(-12, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
             lhand=(.20, -.62, .38), rhand=(-.18, -.58, .40), lpole=(.6, .6, -.2), rpole=(-.6, .6, -.2), head_pitch=-30)),
    (20, dict(hips=(0, -.06, -.31), lean=40, lfoot=(.32, 0, .08), rfoot=(-.32, 0, .08), lfoot_o=(12, 0), rfoot_o=(-12, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
              lhand=(.20, -.60, .42), rhand=(-.18, -.56, .43), lpole=(.6, .6, -.2), rpole=(-.6, .6, -.2), head_pitch=-30)),
    (40, dict(hips=(0, -.06, -.34), lean=42, lfoot=(.32, 0, .08), rfoot=(-.32, 0, .08), lfoot_o=(12, 0), rfoot_o=(-12, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
              lhand=(.20, -.62, .38), rhand=(-.18, -.58, .40), lpole=(.6, .6, -.2), rpole=(-.6, .6, -.2), head_pitch=-30))]),
 "field_catch": (24, [
    (0, dict(hips=(0, -.06, -.34), lean=42, lfoot=(.32, 0, .08), rfoot=(-.32, 0, .08), lfoot_o=(12, 0), rfoot_o=(-12, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
             lhand=(.20, -.62, .38), rhand=(-.18, -.58, .40), lpole=(.6, .6, -.2), rpole=(-.6, .6, -.2), head_pitch=-30)),
    (8, dict(hips=(0, -.02, -.06), lean=8, lfoot=(.28, -.12, .08), rfoot=(-.22, .05, .08), lhand=(.34, -.72, 1.95), rhand=(-.22, -.30, 1.30),
             lpole=(.6, .4, .3), rpole=(-.6, .4, -.3), head_pitch=-20)),
    (13, dict(hips=(0, -.02, -.10), lean=14, lfoot=(.28, -.12, .08), rfoot=(-.22, .05, .08), lhand=(.10, -.42, 1.28), rhand=(-.06, -.38, 1.24),
              lpole=(.6, .4, -.3), rpole=(-.6, .4, -.3), head_pitch=-10)),
    (24, dict(hips=(0, -.06, -.20), lean=30, lfoot=(.30, 0, .08), rfoot=(-.30, 0, .08), lknee=(.2, -1, 0), rknee=(-.2, -1, 0),
              lhand=(.12, -.40, 1.05), rhand=(-.08, -.36, 1.02), lpole=(.6, .4, -.3), rpole=(-.6, .4, -.3), head_pitch=-15))]),
 "throw": (30, [
    (0, dict(hips=(0, 0, -.06), lean=10, lfoot=(.16, 0, .08), rfoot=(-.16, 0, .08), lhand=(.06, -.30, 1.25), rhand=(-.06, -.28, 1.25), lpole=(.7, 0, -.7), rpole=(-.7, 0, -.7))),
    (7, dict(hips=(0, -.12, -.10), lean=6, yaw=-40, hyaw=-10, lfoot=(.15, -.60, .08), rfoot=(-.20, .05, .08), rfoot_o=(-30, 0),
             lhand=(.26, -.62, 1.52), rhand=(-.52, .38, 1.62), lpole=(.4, .3, .5), rpole=(-.4, .5, -.4), head_yaw=0)),
    (12, dict(hips=(0, -.20, -.14), lean=26, yaw=16, hyaw=26, lfoot=(.15, -.65, .08), rfoot=(-.22, .02, .08), rfoot_o=(-30, 0),
              lhand=(.24, -.28, 1.28), rhand=(-.16, -.80, 1.70), lpole=(.5, .5, .2), rpole=(-.3, .6, .6), head_yaw=0)),
    (19, dict(hips=(0, -.28, -.12), lean=46, yaw=28, hyaw=32, lfoot=(.15, -.65, .08), rfoot=(-.22, -.30, .22),
              lhand=(.34, -.22, .95), rhand=(.20, -.45, 1.00), lpole=(.7, .3, -.3), rpole=(0, .4, .8), head_yaw=0)),
    (30, dict(hips=(0, -.30, -.10), lean=30, yaw=10, hyaw=10, lfoot=(.15, -.65, .08), rfoot=(-.20, -.42, .08),
              lhand=(.30, -.25, .90), rhand=(.06, -.40, .92), head_yaw=0))]),
 "slide": (34, [
    (0, dict(lean=14, hips=(0, 0, -.06), lfoot=(.11, -.30, .10), rfoot=(-.11, .40, .08), lhand=(.22, -.35, 1.12), rhand=(-.22, .25, 1.12), lpole=(.6, .3, -.6), rpole=(-.6, .3, -.6))),
    (8, dict(lean=-5, hips=(0, -.35, -.25), lfoot=(.14, -.75, .40), rfoot=(-.16, .05, .06), rknee=(-.3, 0, 1), rhand=(-.32, .28, .62), lhand=(.34, .28, .80),
             lpole=(.8, .4, 0), rpole=(-.8, .4, 0))),
    (16, dict(lean=-48, hips=(0, -.90, -.62), lfoot=(.15, -1.55, .28), rfoot=(-.20, -.85, .12), rknee=(-.4, -.4, 1), lknee=(.2, -1, .2),
              lhand=(.45, .35, .55), rhand=(-.45, .35, .55), lpole=(.9, .3, 0), rpole=(-.9, .3, 0), head_pitch=25)),
    (26, dict(lean=-55, hips=(0, -1.45, -.68), lfoot=(.15, -2.10, .30), rfoot=(-.20, -1.40, .10), rknee=(-.4, -.4, 1), lknee=(.2, -1, .2),
              lhand=(.50, -.30, .30), rhand=(-.50, -.30, .30), lpole=(.9, .3, 0), rpole=(-.9, .3, 0), head_pitch=25)),
    (34, dict(lean=-55, hips=(0, -1.60, -.68), lfoot=(.15, -2.25, .30), rfoot=(-.20, -1.55, .10), rknee=(-.4, -.4, 1), lknee=(.2, -1, .2),
              lhand=(.50, -.35, .30), rhand=(-.50, -.35, .30), lpole=(.9, .3, 0), rpole=(-.9, .3, 0), head_pitch=25))]),
 "celebrate": (40, celebrate_clip()),
 "catcher_crouch": (40, [
    (0, dict(hips=(0, .05, -.48), lean=28, lfoot=(.30, -.05, .08), rfoot=(-.30, -.05, .08), lfoot_o=(40, 0), rfoot_o=(-40, 0), lknee=(.6, -1, 0), rknee=(-.6, -1, 0),
             lhand=(.16, -.72, .62), rhand=(-.12, -.32, .55), lpole=(.6, .5, -.2), rpole=(-.6, .5, -.2), head_pitch=-28)),
    (20, dict(hips=(0, .05, -.46), lean=27, lfoot=(.30, -.05, .08), rfoot=(-.30, -.05, .08), lfoot_o=(40, 0), rfoot_o=(-40, 0), lknee=(.6, -1, 0), rknee=(-.6, -1, 0),
              lhand=(.16, -.70, .66), rhand=(-.12, -.32, .55), lpole=(.6, .5, -.2), rpole=(-.6, .5, -.2), head_pitch=-28)),
    (40, dict(hips=(0, .05, -.48), lean=28, lfoot=(.30, -.05, .08), rfoot=(-.30, -.05, .08), lfoot_o=(40, 0), rfoot_o=(-40, 0), lknee=(.6, -1, 0), rknee=(-.6, -1, 0),
              lhand=(.16, -.72, .62), rhand=(-.12, -.32, .55), lpole=(.6, .5, -.2), rpole=(-.6, .5, -.2), head_pitch=-28))]),
 "batting_stance": (48, stance_clip()),
 "trot": (18, trot_clip()),
 "run_turn": (24, run_turn_clip()),
 "catch_jump": (29, catch_jump_clip()),
}
# The 11 original clips are keyed from frame 1 (their first key sits at t = 1/24 s); the loopable/new clips start at frame 0 so t = 0 .. length/24 exactly.
FRAME0 = {"batting_stance": 0, "trot": 0, "run_turn": 0, "catch_jump": 0}
def bake_clips(arm, names=None, frame0=1):
    bpy.context.view_layer.objects.active = arm; bpy.ops.object.mode_set(mode='POSE')
    acts = {}
    for nm, (length, keys) in CLIPS.items():
        if names and nm not in names: continue
        act = new_action(arm, nm)
        for f, spec in keys: key_pose(arm, spec, FRAME0.get(nm, frame0)+f)
        acts[nm] = act
    bpy.ops.object.mode_set(mode='OBJECT')
    return acts
