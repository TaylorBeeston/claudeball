# Umpire gesture clips (shared rig; used by player_umpire.glb = plate umpire with mask / chest protector / shin guards, and player_umpire_base.glb = base umpire).
# Blender axes: model faces -Y, left = +X. All clips start and end in the crouched ready pose so they cross-fade with `ump_ready` / `ump_set_base`.
import math
from math import sin, cos, pi

def _sp(base, **kw):
    d = dict(base); d.update(kw); return d
def _rows(base, rows): return [(f, _sp(base, **kw)) for f, kw in rows]
POLE_L = (.15, .35, -1); POLE_R = (-.15, .35, -1)
SLOT = dict(hips=(0, .04, -.34), lean=30, lfoot=(.28, -.06, .085), rfoot=(-.22, .10, .085), lfoot_o=(8, 0), rfoot_o=(-8, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0),
            head_yaw=0, head_pitch=-30, lpole=POLE_L, rpole=POLE_R, lhand_rel=(.12, -.12, -.46), rhand_rel=(-.12, -.12, -.46), lhand_face=(0, -1, 0), rhand_face=(0, -1, 0))
SETB = dict(SLOT, hips=(0, 0, -.24), lean=36, lfoot=(.30, 0, .085), rfoot=(-.30, 0, .085), lfoot_o=(10, 0), rfoot_o=(-10, 0), head_pitch=-26, lhand_rel=(.14, -.22, -.52), rhand_rel=(-.14, -.22, -.52))
RISE = dict(hips=(0, .02, -.12), lean=12, lfoot=(.24, -.04, .085), rfoot=(-.22, .06, .085), lknee=(.15, -1, 0), rknee=(-.15, -1, 0), head_pitch=-8)     # stands up out of the crouch for a call
LHIP = dict(lhand_rel=(.10, -.06, -.50))

def _breath(base, n, amp=.008):
    return [(f, _sp(base, hips=(base['hips'][0] + .006*sin(2*pi*f/n), base['hips'][1], base['hips'][2] + amp*sin(2*pi*f/n)), head_pitch=base['head_pitch'] + 1.5*sin(2*pi*f/n + 1))) for f in range(n+1)]
CLIPS["ump_ready"] = (60, _breath(SLOT, 60)); FRAME0["ump_ready"] = 0
CLIPS["ump_set_base"] = (48, _breath(SETB, 48, .01)); FRAME0["ump_set_base"] = 0

UMP_EVENTS = {}
def _reg(name, n, rows, base=SLOT, **ev):
    CLIPS[name] = (n, _rows(base, rows)); FRAME0[name] = 0; UMP_EVENTS[name] = dict(ev, frames=n)

# called strike: fist cocked at the shoulder, then a hammer punch forward-down
_reg("ump_strike", 19, [(0, {}), (3, dict(RISE, rhand_rel=(-.20, -.12, .28), lhand_rel=(.10, -.06, -.46))), (6, dict(RISE, rhand_rel=(-.22, -.08, .36), lhand_rel=(.10, -.06, -.46))),
    (8, dict(RISE, yaw=10, hyaw=4, lean=16, rhand_rel=(-.26, -.42, .08), lhand_rel=(.10, -.06, -.46))), (11, dict(RISE, yaw=8, hyaw=3, lean=15, rhand_rel=(-.26, -.40, .06), lhand_rel=(.10, -.06, -.46))),
    (15, dict(RISE, rhand_rel=(-.16, -.16, -.24), lhand_rel=(.10, -.10, -.46))), (19, {})], strike=8)
_reg("ump_strike_swinging", 22, [(0, {}), (3, dict(RISE, rhand_rel=(-.16, -.10, .38))), (6, dict(RISE, yaw=-12, hyaw=-6, rhand_rel=(-.10, -.02, .54), lhand_rel=(.10, -.06, -.46))),
    (9, dict(RISE, yaw=16, hyaw=8, lean=20, rhand_rel=(-.30, -.44, -.04), lhand_rel=(.10, -.06, -.46))), (13, dict(RISE, yaw=14, hyaw=6, lean=20, rhand_rel=(-.30, -.42, -.06))),
    (18, dict(RISE, rhand_rel=(-.16, -.16, -.24))), (22, {})], strike=9)
_reg("ump_ball", 14, [(0, {}), (3, dict(RISE, lean=16, head_yaw=-12, lhand_rel=(.24, -.24, -.34))), (6, dict(RISE, lean=16, head_yaw=10, lhand_rel=(.30, -.28, -.30))),
    (9, dict(RISE, lean=16, head_yaw=-6, lhand_rel=(.26, -.22, -.34))), (14, {})], gesture=6)
_reg("ump_safe", 24, [(0, {}), (4, dict(RISE, rhand_rel=(-.02, -.30, -.30), lhand_rel=(.02, -.30, -.30), lean=14)),
    (9, dict(RISE, hips=(0, .02, -.08), lean=8, rhand_rel=(-.56, -.06, -.02), lhand_rel=(.56, -.06, -.02), lhand_face=(0, 0, -1), rhand_face=(0, 0, -1))),
    (15, dict(RISE, hips=(0, .02, -.08), lean=8, rhand_rel=(-.56, -.06, -.04), lhand_rel=(.56, -.06, -.04), lhand_face=(0, 0, -1), rhand_face=(0, 0, -1))),
    (21, dict(RISE, rhand_rel=(-.20, -.20, -.30), lhand_rel=(.20, -.20, -.30))), (24, {})], sweep_peak=9)
_reg("ump_out", 20, [(0, {}), (5, dict(RISE, rhand_rel=(-.14, -.10, .52), lhand_rel=(.10, -.06, -.46))), (9, dict(RISE, lean=16, rhand_rel=(-.24, -.32, -.10), lhand_rel=(.10, -.06, -.46))),
    (12, dict(RISE, lean=16, rhand_rel=(-.24, -.32, -.08))), (16, dict(RISE, rhand_rel=(-.14, -.16, -.26))), (20, {})], hammer=9)
_reg("ump_out_strikeout", 22, [(0, {}), (5, dict(RISE, yaw=-16, hyaw=-8, rhand_rel=(-.18, -.10, .42), lhand_rel=(.10, -.06, -.46))),
    (9, dict(RISE, yaw=26, hyaw=12, lean=18, rhand_rel=(.16, -.46, .10), lhand_rel=(.10, -.06, -.46))), (13, dict(RISE, yaw=24, hyaw=10, lean=18, rhand_rel=(.16, -.44, .08))),
    (18, dict(RISE, rhand_rel=(-.14, -.16, -.26))), (22, {})], punch=9)
_reg("ump_foul", 20, [(0, {}), (4, dict(RISE, rhand_rel=(-.16, -.10, .30), lhand_rel=(.16, -.10, .30))),
    (7, dict(RISE, hips=(0, .02, -.06), lean=6, rhand_rel=(-.14, -.02, .56), lhand_rel=(.14, -.02, .56))), (13, dict(RISE, hips=(0, .02, -.06), lean=6, rhand_rel=(-.14, -.02, .56), lhand_rel=(.14, -.02, .56))),
    (17, dict(RISE, rhand_rel=(-.16, -.16, -.20), lhand_rel=(.16, -.16, -.20))), (20, {})], peak=7)
_reg("ump_fair", 16, [(0, {}), (3, dict(RISE, yaw=-8, hyaw=-4, rhand_rel=(-.26, -.16, -.10), lhand_rel=(.10, -.06, -.46))),
    (6, dict(RISE, yaw=-16, hyaw=-8, lean=16, rhand_rel=(-.40, -.26, -.28), rhand_face=(0, -1, 0), lhand_rel=(.10, -.06, -.46))),
    (11, dict(RISE, yaw=-16, hyaw=-8, lean=16, rhand_rel=(-.40, -.26, -.28), lhand_rel=(.10, -.06, -.46))), (16, {})], point=6)
def _homerun():
    rows = [(0, {}), (4, dict(RISE, rhand_rel=(-.14, -.06, .34), lhand_rel=(.10, -.06, -.46)))]
    for f in range(6, 27):
        ph = 2*pi*(f-6)/7.0                                                       # ~3 turns between frames 6 and 26
        rows.append((f, dict(RISE, hips=(0, .02, -.08), lean=8, rhand_rel=(-.12 + .07*cos(ph), -.04 + .07*sin(ph), .50), lhand_rel=(.10, -.06, -.46))))
    rows += [(29, dict(RISE, rhand_rel=(-.14, -.10, .20), lhand_rel=(.10, -.06, -.46))), (32, {})]
    return rows
_reg("ump_homerun", 32, _homerun(), twirl_start=6, twirl_end=26)
_reg("ump_time", 18, [(0, {}), (3, dict(RISE, rhand_rel=(-.20, -.10, .30), lhand_rel=(.20, -.10, .30))),
    (6, dict(RISE, hips=(0, .02, -.06), lean=6, rhand_rel=(-.24, -.12, .46), lhand_rel=(.24, -.12, .46), lhand_face=(0, -1, 0), rhand_face=(0, -1, 0))),
    (12, dict(RISE, hips=(0, .02, -.06), lean=6, rhand_rel=(-.24, -.12, .46), lhand_rel=(.24, -.12, .46), lhand_face=(0, -1, 0), rhand_face=(0, -1, 0))),
    (15, dict(RISE, rhand_rel=(-.16, -.14, -.10), lhand_rel=(.16, -.14, -.10))), (18, {})], peak=6)
