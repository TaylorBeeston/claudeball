# On-deck, dugout, base-coach and ball-kid clips (same 22-bone rig as the players; the ball-kid file only differs by the armature scale).
# Blender axes: the model faces -Y, left = +X, up = +Z; hips = offset from (0, 0, .95), y is baked root motion; `bat` = (knob, direction knob->tip) drives both hands like in `swing`.
# Requires player_clips (STANCE0, S0, CLIPS, FRAME0), player_motion (densify, READY_KNEES), player_catch (POLE_L / POLE_R, _keys) exec'd.
import math
from math import sin, cos, pi

CREW_EVENTS = {}            # name -> dict(frame markers) for the manifest
def _cp(base, **kw):
    d = dict(base); d.update(kw); return d
def _creg(name, n, rows, events=None, dense=False):
    keys = [(f, _cp(base, **kw)) for f, base, kw in rows]
    CLIPS[name] = (n, densify(keys) if dense else keys); FRAME0[name] = 0
    CREW_EVENTS[name] = dict(events or {}, frames=n)

STAND = dict(hips=(0, 0, 0), lean=2, lfoot=(.15, 0, .085), rfoot=(-.15, 0, .085), lfoot_o=(8, 0), rfoot_o=(-8, 0), lknee=(.2, -1, 0), rknee=(-.2, -1, 0), head_yaw=0, head_pitch=0,
             lpole=(.15, .35, -1), rpole=(-.15, .35, -1), lhand_rel=(.125, -.03, -.55), rhand_rel=(-.125, -.03, -.55))
def _loop(base, n, rows):
    """loop clip from (frame, kwargs) rows; the last row is a copy of the first"""
    rows = list(rows) + [(n, rows[0][1])]; return [(f, base, kw) for f, kw in rows]

# ---------------------------------------------------------------- on deck (bat in hand, weighted donut on the barrel)
BAT_REST = ((-.02, -.36, .92), (0, -.10, -1.0))                  # bat held in front with the barrel end resting on the ground (leaning on it)
OND = dict(STAND, lean=8, hips=(0, -.01, -.04), head_pitch=-6, bat=BAT_REST, lpole=(.5, .4, -.7), rpole=(-.5, .4, -.7))
OND.pop('lhand_rel'); OND.pop('rhand_rel')       # the bat drives both hands
def _ondeck_ready():
    rows = [(0, dict(hips=(-.01, -.01, -.04), head_yaw=38, lean=8)), (15, dict(hips=(.02, -.01, -.06), head_yaw=30, lean=11, lfoot=(.17, -.02, .085), bat=((-.02, -.37, .93), (0, -.12, -1.0)))),
            (30, dict(hips=(.03, 0, -.05), head_yaw=44, lean=9, rfoot=(-.17, .02, .085))), (45, dict(hips=(0, -.01, -.07), head_yaw=34, lean=12, head_pitch=-10, bat=((-.02, -.35, .91), (0, -.08, -1.0)))),
            (60, dict(hips=(-.02, -.01, -.05), head_yaw=40, lean=9))]
    return [(f, OND, kw) for f, kw in rows[:-1]] + [(60, OND, rows[0][1])]
_creg("ondeck_ready", 60, _ondeck_ready(), dense=True)
def _ondeck_swing():
    sw = dict(CLIPS["swing"][1]); st = _cp(STANCE0); soft = lambda sp, k=.82: dict(sp, lfoot=(sp['lfoot'][0]*(.55 + .45*k), sp['lfoot'][1], sp['lfoot'][2]))      # a loose warm-up swing: shorter stride, smooth
    ready = _cp(OND, hips=(0, -.01, -.05), head_yaw=40)
    carry = _cp(OND, hips=(.02, -.01, -.09), lean=14, head_yaw=75, lfoot=(.26, 0, .085), bat=((.06, -.30, 1.16), (-.12, -.45, -.88)))                 # bat lowered across the front after the follow-through
    keys = [(0, ready), (3, _cp(OND, hips=(-.02, 0, -.08), lean=12, head_yaw=60, lfoot=(.24, 0, .085), bat=((-.10, -.22, 1.12), (-.20, -.02, -.97)))),
            (6, soft(st)), (9, soft(sw[8])), (11, soft(sw[13])), (14, soft(sw[17])), (16, soft(sw[20])), (18, soft(sw[22])), (21, soft(sw[27])), (24, soft(sw[32])),
            (26, _cp(carry, lean=12, hips=(.03, -.01, -.08), head_yaw=85, bat=((.28, -.42, 1.28), (-.45, .10, -.88)))), (28, carry), (32, _cp(OND, hips=(.01, -.01, -.06), head_yaw=45, lfoot=(.22, 0, .085)))]
    return [(f, {}, sp) for f, sp in keys]
_creg("ondeck_swing", 32, _ondeck_swing(), events=dict(load=9, contact=18, finish=24), dense=True)
# ondeck_stretch: bat held across the shoulders / behind the neck, trunk twists left and right (warm-up stretch), loop 3 s
def _ondeck_stretch():
    B = lambda s: ((0, -.02, 1.46), (1.0, 0, 0))                  # bat across the shoulders, knob toward the batter's left
    base = _cp(STAND, lean=0, hips=(0, 0, -.05), lfoot=(.30, 0, .085), rfoot=(-.30, 0, .085), lfoot_o=(14, 0), rfoot_o=(-14, 0), lknee=(.4, -1, 0), rknee=(-.4, -1, 0), lpole=(.7, .4, -.2), rpole=(-.7, .4, -.2))
    base.pop('lhand_rel'); base.pop('rhand_rel')
    rows = []
    for f, tw in ((0, 0), (18, 50), (36, 0), (54, -50), (72, 0)):
        rows.append((f, base, dict(yaw=tw, hyaw=tw*.3, head_yaw=tw*.8, lhand=(.58*cos(math.radians(tw)) + .0, -.58*sin(math.radians(tw))*0 - .02, 1.40), rhand=(-.58*cos(math.radians(tw)), -.02, 1.40))))
    return rows
_creg("ondeck_stretch", 72, _ondeck_stretch())

# ---------------------------------------------------------------- dugout bench: sitting (root = the ground below the seat centre; seat height 0.45 m: the seat of the pants rests at 0.45 m, hips were 4.4 cm too low)
SIT = dict(STAND, hips=(0, .02, -.326), lean=24, lfoot=(.17, -.36, .085), rfoot=(-.17, -.36, .085), lfoot_o=(8, 0), rfoot_o=(-8, 0), lknee=(.12, -1, .2), rknee=(-.12, -1, .2), head_pitch=-14, head_yaw=0,
           lhand=(.16, -.37, .66), rhand=(-.16, -.37, .66), lpole=(.7, .4, -.3), rpole=(-.7, .4, -.3))
for _k in ('lhand_rel', 'rhand_rel'): SIT.pop(_k)
def _bench_sit():
    rows = [(0, dict()), (18, dict(lean=18, head_yaw=-35, head_pitch=-8, hips=(0, .02, -.316))), (36, dict(lean=30, head_yaw=-10, head_pitch=-20, lhand=(.17, -.34, .65))),
            (54, dict(lean=21, head_yaw=30, head_pitch=-10, rfoot=(-.20, -.40, .085), hips=(.01, .03, -.326))), (72, dict())]
    return [(f, SIT, kw) for f, kw in rows]
_creg("bench_sit", 72, _bench_sit())
STAND_AT_BENCH = dict(STAND, hips=(0, -.30, 0), lean=4, lfoot=(.16, -.34, .085), rfoot=(-.16, -.34, .085), head_pitch=-4)
SAB_ABS = {k: v for k, v in STAND_AT_BENCH.items() if k not in ('lhand_rel', 'rhand_rel')}
def _bench_stand_up():
    return [(0, SIT, {}), (5, SIT, dict(hips=(0, -.06, -.296), lean=44, head_pitch=-28, lfoot=(.17, -.30, .085), rfoot=(-.17, -.30, .085), lhand=(.17, -.36, .62), rhand=(-.17, -.36, .62))),
            (10, SIT, dict(hips=(0, -.20, -.22), lean=50, head_pitch=-30, lfoot=(.17, -.32, .085), rfoot=(-.17, -.32, .085), lhand=(.19, -.45, .55), rhand=(-.19, -.45, .55))),
            (16, SAB_ABS, dict(hips=(0, -.28, -.08), lean=26, lfoot=(.16, -.33, .085), rfoot=(-.16, -.33, .085), head_pitch=-12, lhand=(.27, -.52, .86), rhand=(-.27, -.52, .86))),
            (22, SAB_ABS, dict(lean=8, lhand=(.27, -.38, .90), rhand=(-.27, -.38, .90))), (28, SAB_ABS, dict(lhand=(.27, -.33, .92), rhand=(-.27, -.33, .92)))]
_creg("bench_stand_up", 28, _bench_stand_up(), events=dict(rise_start=5, standing=22), dense=True)
def _bench_cheer():
    rows = [(0, STAND_AT_BENCH, {})]
    for i, f in enumerate(range(4, 33, 4)):
        up = i % 2 == 0
        rows.append((f, STAND_AT_BENCH, dict(hips=(0, -.30, .02 if up else -.02), lean=-2, head_pitch=6, lhand_rel=(.10 if up else .22, -.22, .62 if up else .50), rhand_rel=(-.10 if up else -.22, -.22, .62 if up else .50),
                                              lpole=(.5, .5, 0), rpole=(-.5, .5, 0), lfoot=(.16, -.34, .085 + (.03 if up else 0)), rfoot=(-.16, -.34, .085 + (.03 if up else 0)))))
    rows.append((36, STAND_AT_BENCH, {})); return rows
_creg("bench_cheer", 36, _bench_cheer(), events=dict(clap=[8, 16, 24]))

# ---------------------------------------------------------------- base coach (1B / 3B coach box)
COACH = dict(STAND, hips=(0, 0, -.12), lean=14, head_pitch=-10, lfoot=(.24, 0, .085), rfoot=(-.24, 0, .085), lfoot_o=(10, 0), rfoot_o=(-10, 0), lknee=(.25, -1, 0), rknee=(-.25, -1, 0),
             lhand=(.22, -.18, .92), rhand=(-.22, -.18, .92), lpole=(.6, .4, -.4), rpole=(-.6, .4, -.4))
for _k in ('lhand_rel', 'rhand_rel'): COACH.pop(_k)
HUNCH = dict(COACH, hips=(0, .04, -.24), lean=62, lfoot=(.26, 0, .085), rfoot=(-.26, 0, .085), lfoot_o=(10, 0), rfoot_o=(-10, 0), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_pitch=-40, head_yaw=0, lhand=(.22, -.26, .60), rhand=(-.22, -.26, .60), lpole=(.6, .3, -.4), rpole=(-.6, .3, -.4))   # hands on the knees
def _coach_ready():
    rows = [(0, dict()), (12, dict(head_yaw=40, hips=(.02, .04, -.25), head_pitch=-34)), (24, dict(head_yaw=-10, hips=(.02, .04, -.23), lhand=(.21, -.27, .62))),
            (30, dict(lean=40, hips=(0, .02, -.18), head_pitch=-26, head_yaw=-25, lhand=(.10, -.30, .98), rhand=(-.10, -.30, .98))), (33, dict(lean=40, hips=(0, .02, -.18), head_pitch=-26, lhand=(.03, -.32, 1.02), rhand=(-.03, -.32, 1.02))),
            (36, dict(lean=40, hips=(0, .02, -.18), head_pitch=-26, lhand=(.10, -.30, .98), rhand=(-.10, -.30, .98))), (39, dict(lean=40, hips=(0, .02, -.18), head_pitch=-26, lhand=(.03, -.32, 1.02), rhand=(-.03, -.32, 1.02))),
            (42, dict(lean=40, hips=(0, .02, -.18), head_pitch=-26, lhand=(.10, -.30, .98), rhand=(-.10, -.30, .98))), (50, dict(head_yaw=30, hips=(-.01, .04, -.24))), (60, dict())]
    return [(f, HUNCH, kw) for f, kw in rows]
_creg("coach_ready", 60, _coach_ready(), events=dict(clap=[33, 39]))
def _coach_stop():                                        # arms out in front of the body, palms down; hold frames 8..20
    up = dict(hips=(0, 0, -.05), lean=6, head_yaw=0, head_pitch=-4, lhand_rel=(.34, -.44, -.18), rhand_rel=(-.34, -.44, -.18), lhand_face=(0, 0, -1), rhand_face=(0, 0, -1), lpole=(.4, .4, -.9), rpole=(-.4, .4, -.9))
    return [(0, COACH, {}), (4, COACH, dict(up, lhand_rel=(.30, -.30, -.05), rhand_rel=(-.30, -.30, -.05))), (8, COACH, up), (14, COACH, dict(up, lhand_rel=(.36, -.46, -.20), rhand_rel=(-.36, -.46, -.20))),
            (20, COACH, up), (24, COACH, {})]
_creg("coach_stop", 24, _coach_stop(), events=dict(hold_start=8, hold_end=20))
def _windmill(f0, f1, rev_frames, start_phase=0.0):
    out = []
    for f in range(f0, f1 + 1):
        ph = 2*pi*(f - f0)/rev_frames + start_phase
        out.append((f, COACH, dict(hips=(0, 0, -.06 + .015*cos(2*ph)), lean=10, yaw=-10*cos(ph) + 8, hyaw=-4*cos(ph), head_yaw=34, head_pitch=-6,
                                   rhand_rel=(-.20, -.55*sin(ph), -.56*cos(ph)), rpole=(-.9, .0, -.1), lhand_rel=(.40, -.36, -.12), lpole=(.6, .4, -.5))))
    return out
def _coach_go():
    rows = [(0, COACH, {}), (4, COACH, dict(hips=(0, 0, -.07), lean=10, yaw=8, head_yaw=34, rhand_rel=(-.20, 0, -.56), lhand_rel=(.40, -.36, -.12), rpole=(-.9, 0, -.1), lpole=(.6, .4, -.5)))]
    rows += _windmill(5, 29, 12)                           # two revolutions in 1.0 s
    rows += [(33, COACH, dict(hips=(0, 0, -.07), lean=10, head_yaw=30, rhand_rel=(-.20, .0, -.56), lhand_rel=(.38, -.34, -.14))), (36, COACH, {})]
    return rows
_creg("coach_go", 36, _coach_go(), events=dict(windmill_start=5, windmill_end=29))
def _coach_go_loop():
    return _windmill(0, 12, 12)
_creg("coach_go_loop", 12, _coach_go_loop(), events=dict(revolution_frames=12))
def _coach_advance():                                     # beckoning wave toward the next base: right arm out to the side, hand sweeping inward-forward three times
    rows = [(0, COACH, {}), (5, COACH, dict(hips=(0, 0, -.07), lean=9, yaw=16, head_yaw=45, rhand_rel=(-.40, -.20, -.10), rpole=(-.8, .3, -.5), lhand=(.20, -.20, .70)))]
    for i, f in enumerate(range(8, 25, 4)):
        s = i % 2
        rows.append((f, COACH, dict(hips=(0, 0, -.07), lean=9, yaw=16, head_yaw=45, rhand_rel=(-.30 if s else -.58, -.46 if s else -.08, -.02 if s else -.10), rpole=(-.8, .3, -.5), lhand=(.20, -.20, .70))))
    rows += [(28, COACH, dict(hips=(0, 0, -.08), lean=10, yaw=10, head_yaw=40, rhand_rel=(-.34, -.32, -.20))), (32, COACH, {})]
    return rows
_creg("coach_advance", 32, _coach_advance(), events=dict(wave_start=8, wave_end=24))
def _coach_slide():                                       # both hands low in front of the thighs, pushing down (palms down) twice: "slide"
    low = dict(hips=(0, 0, -.14), lean=18, head_yaw=0, head_pitch=-10, lhand=(.20, -.42, .52), rhand=(-.20, -.42, .52), lhand_face=(0, 0, -1), rhand_face=(0, 0, -1), lpole=(.6, .4, -.6), rpole=(-.6, .4, -.6))
    hi = dict(low, hips=(0, 0, -.10), lean=14, lhand=(.22, -.40, .78), rhand=(-.22, -.40, .78))
    return [(0, COACH, {}), (4, COACH, hi), (8, COACH, low), (12, COACH, hi), (16, COACH, low), (20, COACH, dict(low, lhand=(.20, -.42, .56), rhand=(-.20, -.42, .56))), (24, COACH, {})]
_creg("coach_slide", 24, _coach_slide(), events=dict(push_down=[8, 16]))
def _coach_signs():                                       # 72 frames: touches cap, belt, chest, left arm, cap again, clap; ends in the ready stance
    S = dict(COACH, hips=(0, 0, -.04), lean=4, head_pitch=-4, lhand_rel=(.14, -.06, -.52), rhand_rel=(-.14, -.06, -.52))
    for _k in ('lhand', 'rhand'): S.pop(_k)
    touch = {  # name: (right hand target relative to the right shoulder)
        'cap': (-.06, -.13, .27), 'belt': (.06, -.16, -.50), 'chest': (.20, -.22, -.08), 'arm': (.40, -.20, -.02), 'ear': (-.10, -.02, .24), 'nose': (-.02, -.20, .12)}
    seq = [(8, 'cap'), (16, 'belt'), (24, 'chest'), (32, 'arm'), (42, 'cap'), (50, 'belt'), (58, 'ear')]
    rows = [(0, S, {})]
    for f, nm in seq: rows += [(f - 3, S, dict(rhand_rel=tuple(v*.8 + w*.2 for v, w in zip(touch[nm], S['rhand_rel'])))), (f, S, dict(rhand_rel=touch[nm]))]
    rows += [(66, S, dict(rhand_rel=(-.14, -.06, -.52))), (72, S, {})]
    return rows
_creg("coach_signs", 72, _coach_signs(), events=dict(touch_cap=8, touch_belt=16, touch_chest=24, touch_arm=32, touch_cap_2=42, touch_belt_2=50, touch_ear=58))

# ---------------------------------------------------------------- ball kid (the file scales the whole armature to 1.55 m: 0.838 x the 1.85 m rig)
KSIT = dict(SIT, hips=(0, .02, -.40), lean=14, lfoot=(.15, -.30, .085), rfoot=(-.15, -.34, .085), head_pitch=-6, lhand=(.12, -.32, .70), rhand=(-.12, -.30, .70))
def _ballkid_sit():
    rows = [(0, {}), (20, dict(head_yaw=40, head_pitch=-4, lean=10)), (40, dict(head_yaw=-20, lean=17, lhand=(.14, -.30, .68), rhand=(-.14, -.28, .68))), (58, dict(head_yaw=30, lean=11, lfoot=(.17, -.28, .085))), (72, {})]
    return [(f, KSIT, kw) for f, kw in rows]
_creg("ballkid_sit", 72, _ballkid_sit())
def _ballkid_pickup():
    K = _cp(STAND, lean=8, hips=(0, 0, -.04), head_pitch=-6)
    return [(0, K, {}), (6, K, dict(hips=(0, -.06, -.22), lean=40, head_pitch=-25, lhand_rel=(.15, -.30, -.50), rhand_rel=(-.15, -.28, -.50))),
            (10, K, dict(hips=(0, -.12, -.42), lean=62, lfoot=(.20, -.05, .085), rfoot=(-.20, .05, .085), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_pitch=-30, lhand=(.20, -.55, .30), rhand=(-.14, -.56, .12))),
            (13, K, dict(hips=(0, -.12, -.44), lean=64, lfoot=(.20, -.05, .085), rfoot=(-.20, .05, .085), head_pitch=-32, lhand=(.20, -.55, .30), rhand=(-.12, -.56, .09))),            # pickup at 13
            (20, K, dict(hips=(0, -.07, -.26), lean=34, head_pitch=-14, lhand_rel=(.14, -.22, -.34), rhand_rel=(-.16, -.30, -.40))),
            (28, K, dict(hips=(0, -.02, -.08), lean=12, head_pitch=-8, lhand_rel=(.12, -.14, -.28), rhand_rel=(-.12, -.24, -.30))), (36, K, dict(lhand_rel=(.125, -.10, -.40), rhand_rel=(-.125, -.20, -.36)))]
_creg("ballkid_pickup", 36, _ballkid_pickup(), events=dict(pickup=13, standing=28), dense=True)
def _ballkid_toss():
    K = _cp(STAND, lean=6, hips=(0, 0, -.06), head_pitch=-4, lfoot=(.17, -.04, .085), rfoot=(-.17, .10, .085), lpole=(.4, .4, -.6), rpole=(-.6, .3, -.5))
    return [(0, K, dict(rhand_rel=(-.14, -.22, -.42), lhand_rel=(.12, -.14, -.40))), (6, K, dict(hips=(.0, .03, -.12), lean=14, yaw=10, rhand_rel=(-.16, .22, -.54), lhand_rel=(.20, -.30, -.20), head_pitch=-6)),
            (10, K, dict(hips=(0, -.06, -.08), lean=10, yaw=-12, hyaw=-6, rhand_rel=(-.10, -.52, -.20), lhand_rel=(.18, -.20, -.40), lfoot=(.18, -.12, .085))),          # release at 10
            (14, K, dict(hips=(0, -.07, -.05), lean=6, yaw=-8, rhand_rel=(-.08, -.46, .10), lhand_rel=(.14, -.14, -.46))),
            (24, K, dict(hips=(0, -.04, -.04), lean=4, rhand_rel=(-.125, -.10, -.50), lhand_rel=(.125, -.10, -.50)))]
_creg("ballkid_toss", 24, _ballkid_toss(), events=dict(release=10, backswing_peak=6), dense=True)
def _ballkid_wave():
    K = _cp(STAND, lean=2, hips=(0, 0, -.02), head_pitch=2, head_yaw=10)
    rows = [(0, K, {})]
    for i, f in enumerate(range(4, 33, 4)):
        rows.append((f, K, dict(rhand_rel=(-.28 + (.14 if i % 2 else 0), -.04, .54), rpole=(-.8, .2, .1), head_yaw=14)))
    rows.append((36, K, {})); return rows
_creg("ballkid_wave", 36, _ballkid_wave(), events=dict(wave_start=4, wave_end=32))

