# Pace-of-play ritual clips: batter routine, catcher signs, pitcher routine, mound conference, manager, umpire chores, warm-up throws.
# Blender axes: the model faces -Y, left = +X, up = +Z; hips = offset from (0, 0, .95), y is baked root motion; all clips 24 fps, start at t = 0.
# Requires player_clips (STANCE0, S0, CLIPS, FRAME0), player_pitch (_windup_stages, _stretch_stages, delivery), player_motion (densify, _lerp), player_catch (POLE_L/POLE_R),
# player_crew (_cp, OND, STAND, SIT, CREW_EVENTS), player_ump (SLOT, RISE) exec'd.
import math
from math import sin, cos, pi

RIT_EVENTS = {}              # name -> dict(frame markers); `finger_keys` = [(frame, n)] hand shown with n fingers extended (morph fingers_n, 0 = fist)
def _rreg(name, n, rows, events=None, dense=True):
    keys = []
    for f, base, kw in rows:
        kw = dict(kw)
        for k in 'lr':
            if k+'hand' in kw and k+'hand_rel' not in kw: kw[k+'hand_rel'] = None          # an absolute hand target replaces a shoulder-relative one from the base pose
        keys.append((f, _cp(base, **kw)))
    CLIPS[name] = (n, densify(keys) if dense else keys); FRAME0[name] = 0
    RIT_EVENTS[name] = dict(events or {}, frames=n)
def _rev(rows, n):            # the same clip played backwards (rows given as (frame, base, kw))
    return sorted([(n - f, b, kw) for f, b, kw in rows], key=lambda r: r[0])
def _soft(sp, k=.82): return dict(sp, lfoot=(sp['lfoot'][0]*(.55 + .45*k), sp['lfoot'][1], sp['lfoot'][2]))
S0_ = dict(STANCE0)
SW = dict(CLIPS["swing"][1])

# ---------------------------------------------------------------- batter routine (right-handed; the bat is driven by `bat`, both hands follow)
BOUT = dict(STAND, lean=6, hips=(0, 0, -.05), head_pitch=-6, head_yaw=40, lfoot=(.22, .22, .085), rfoot=(-.20, .10, .085), bat=((-.14, -.37, 1.02), (-.30, .22, .93)), lpole=(.5, .4, -.7), rpole=(-.5, .4, -.7))
BOUT.pop('lhand_rel'); BOUT.pop('rhand_rel')
def _tap(k): return dict(bat=((-.10, -.40, .80 + .12*k), (-.05, -.50, -.86)))
def _step_in():
    D = lambda f, y, o: (f, BOUT, dict(rfoot=(-.30, y, .085), rfoot_o=(-o, 0), lfoot=(.30, 0, .085), hips=(-.02, .01, -.10), lean=10, head_yaw=70, bat=((-.14, -.37, 1.02), (-.30, .22, .93))))
    rows = [(0, BOUT, {}), (5, BOUT, dict(lfoot=(.30, .02, .085), rfoot=(-.24, .10, .085), head_yaw=60, hips=(-.01, 0, -.08), lean=9)),
            D(8, .06, 8), D(10, -.04, 14), D(12, .07, 8), D(14, -.03, 14), D(16, .03, 0),
            (18, BOUT, dict(_tap(0), lfoot=(.30, 0, .085), rfoot=(-.30, .02, .085), hips=(-.03, .02, -.11), lean=12, head_yaw=75)), (20, BOUT, dict(_tap(1), lfoot=(.30, 0, .085), rfoot=(-.30, .02, .085), hips=(-.03, .02, -.11), lean=12, head_yaw=75)),
            (22, BOUT, dict(_tap(0), lfoot=(.30, 0, .085), rfoot=(-.30, .02, .085), hips=(-.03, .02, -.11), lean=12, head_yaw=75)),
            (28, S0_, dict(bat=((-.17, -.19, 1.36), (-.30, .12, .94)), hips=(-.04, .02, -.115), yaw=-8, hyaw=-5)), (38, S0_, {})]
    return rows
_rreg("batter_step_in", 38, _step_in(), events=dict(dig_start=8, dig_end=16, tap_1=18, tap_2=22, settled=38))
def _practice():
    carry = dict(OND, hips=(.02, -.01, -.09), lean=14, head_yaw=75, lfoot=(.26, 0, .085), bat=((.06, -.30, 1.16), (-.12, -.45, -.88))); carry.pop('lhand_rel', None)
    via = dict(carry, lean=12, hips=(.03, -.01, -.08), head_yaw=85, bat=((.28, -.42, 1.28), (-.45, .10, -.88)))
    rows = [(0, S0_, {}), (4, S0_, _soft(SW[8])), (7, S0_, _soft(SW[13])), (10, S0_, _soft(SW[17])), (12, S0_, _soft(SW[20])), (14, S0_, _soft(SW[22])), (17, S0_, _soft(SW[27])), (20, S0_, _soft(SW[32])),
            (23, S0_, via), (26, S0_, carry), (31, S0_, dict(bat=((-.17, -.19, 1.36), (-.30, .12, .94))))]
    return rows
_rreg("batter_practice_swing", 31, _practice(), events=dict(load=7, contact=14, finish=20, back_in_stance=31))
def _adjust():
    R = dict(BOUT); R.pop('bat'); R.update(rhand=(-.31, -.14, .90), head_yaw=30, lfoot=(.18, 0, .085), rfoot=(-.18, 0, .085), lean=6)
    rows = [(0, R, dict(lhand=(.26, -.10, .86)))]
    for f, x in ((6, 0), (10, 1), (14, 0), (18, 1)): rows.append((f, R, dict(lhand=(-.20, -.34 - .02*x, 1.02 + .02*x), head_pitch=-14, lean=9)))                       # tug the right batting glove strap twice
    rows += [(24, R, dict(lhand=(.10, -.14, 1.56), head_pitch=-4, head_yaw=20)), (28, R, dict(lhand=(.10, -.06, 1.84), head_pitch=-4)), (32, R, dict(lhand=(.12, -.08, 1.86), head_pitch=-6)),
             (36, R, dict(lhand=(.10, -.06, 1.84), head_pitch=-4)), (42, R, dict(lhand=(.14, -.14, 1.30), head_pitch=-8)), (48, R, dict(lhand=(.26, -.10, .86), head_pitch=-6, head_yaw=40))]
    return rows
_rreg("batter_adjust", 48, _adjust(), events=dict(strap_tug=[10, 18], helmet_touch=[28, 32, 36]))
def _step_out():
    carry = dict(BOUT, lfoot=(.20, .26, .085), rfoot=(-.20, .12, .085), lean=6, head_yaw=-30, head_pitch=-8)
    cl = dict(carry, bat=((-.14, -.34, .80), (-.10, .44, -.89)))
    rows = [(0, S0_, {}), (4, S0_, dict(hips=(0, .02, -.11), lean=10, bat=((-.17, -.20, 1.28), (-.30, .12, .96)), head_yaw=60)),
            (9, BOUT, dict(lfoot=(.22, .30, .22), lean=8, head_yaw=40, hips=(0, .06, -.08), rfoot=(-.28, .04, .085), bat=((-.14, -.26, 1.06), (-.30, .20, .94)))),
            (13, BOUT, dict(lfoot=(.22, .30, .085), rfoot=(-.24, .06, .085), lean=7, head_yaw=10, hips=(0, .10, -.07))), (17, BOUT, dict(carry, head_yaw=-35)),
            (21, cl, dict(rfoot=(-.20, .12, .085))), (23, cl, dict(bat=((-.14, -.34, .90), (-.10, .30, -.95)))), (25, cl, {}), (27, cl, dict(bat=((-.14, -.34, .90), (-.10, .30, -.95)))), (29, cl, {}),
            (34, BOUT, dict(carry, bat=((-.14, -.37, 1.02), (-.30, .22, .93))))]
    return rows
_rreg("batter_step_out", 34, _step_out(), events=dict(foot_out=13, tap_cleats=[21, 25, 29]))

# ---------------------------------------------------------------- catcher: signs, signal, bullpen crouch (glove hand = left, flashing hand = right)
CROUCH = dict(CLIPS["catcher_crouch"][1][0][1]); CROUCH.update(lpole=(.6, .5, -.2), rpole=(-.6, .5, -.2), head_yaw=0)
SIGN = dict(CROUCH, lhand=(.34, -.40, .64), rhand=(-.02, -.30, .40), lpole=(.7, .4, -.3), rpole=(-.3, .3, -.9), head_pitch=-22, lhand_face=(0, -1, 0))
def _signs(seq, n, wiggle=False, cover=False):
    rows = [(0, CROUCH, {}), (5, SIGN, dict(rhand=(-.05, -.26, .32)))]; fk = []
    f = 8
    for k in seq:
        rows += [(f, SIGN, dict(rhand=(-.02, -.34, .42))), (f + 2, SIGN, dict(rhand=(-.02, -.36, .46 + (.02 if wiggle else 0)))), (f + 7, SIGN, dict(rhand=(-.03 if wiggle else -.02, -.36, .44))), (f + 9, SIGN, dict(rhand=(-.05, -.28, .36)))]
        fk += [(f, 0), (f + 1, k), (f + 8, k), (f + 9, 0)]; f += 11
    if cover: rows += [(f, SIGN, dict(lhand=(.18, -.44, .70), rhand=(-.05, -.28, .36)))]
    rows += [(n - 6, SIGN, dict(rhand=(-.12, -.32, .55), lhand=(.20, -.60, .62))), (n, CROUCH, {})]
    return rows, fk
_r, _fk = _signs((1, 2), 53); _rreg("catcher_signs", 53, _r, events=dict(finger_keys=_fk, flash=[9, 20]))
_r, _fk = _signs((1, 3, 2, 1), 60, wiggle=True, cover=True); _rreg("catcher_signs_runner_on", 60, _r, events=dict(finger_keys=_fk, flash=[9, 20, 31, 42]))
def _signal():
    UP = dict(CROUCH, hips=(0, .02, -.26), lean=22, head_pitch=-12, lfoot=(.30, -.05, .085), rfoot=(-.30, -.05, .085), lknee=(.6, -1, 0), rknee=(-.6, -1, 0))
    rows = [(0, CROUCH, {}), (7, UP, dict(lhand=(.26, -.46, .86), rhand=(-.12, -.28, .60))), (12, UP, dict(lhand=(.32, -.52, 1.04), rhand=(-.20, -.34, 1.08), head_yaw=-10)),
            (16, UP, dict(lhand=(.32, -.52, 1.04), rhand=(-.20, -.36, 1.10), head_yaw=-10)), (20, UP, dict(lhand=(.50, -.46, .98), rhand=(-.20, -.36, 1.10), head_yaw=10)), (24, UP, dict(lhand=(.18, -.56, 1.02), rhand=(-.18, -.34, 1.06), head_yaw=-5)),
            (29, UP, dict(lhand=(.26, -.46, .86), rhand=(-.12, -.28, .60))), (36, CROUCH, {})]
    return rows
_rreg("catcher_signal_infield", 36, _signal(), events=dict(finger_keys=[(0, 0), (11, 0), (12, 2), (20, 2), (21, 1), (25, 1), (26, 0)], gesture=[12, 20, 24]))
def _bullpen_catcher():
    A = dict(CROUCH, hips=(0, .06, -.52), lean=30, lhand=(.14, -.74, .70), rhand=(-.24, .02, .62), rpole=(-.8, .3, -.5), head_pitch=-26)
    return [(0, A, {}), (12, A, dict(hips=(0, .06, -.50), lhand=(.18, -.72, .66), head_yaw=3)), (24, A, dict(hips=(0, .05, -.53), lhand=(.14, -.76, .72), head_yaw=-3)), (36, A, dict(hips=(0, .06, -.50), lhand=(.12, -.73, .68))), (48, A, {})]
_rreg("bullpen_catcher_ready", 48, [(f, A_, kw) for f, A_, kw in _bullpen_catcher()], dense=False)

# ---------------------------------------------------------------- pitcher routine (pitcher_set / pitcher_rock poses; right-handed)
PS = _stretch_stages()["start"]; PS = dict(PS, head_yaw=0, head_pitch=-6)
PR = _windup_stages()["start"]; PR = dict(PR, head_yaw=0, head_pitch=-4)
def _shake():
    sh = [(0, 0, 0, 0), (4, 20, -.02, -8), (8, -16, .02, -6), (12, 18, -.015, -8), (16, -12, .015, -6), (20, 6, 0, -6), (24, 0, 0, -6)]
    return [(f, PS, dict(head_yaw=hy, head_pitch=hp, lhand=(PS['lhand'][0] + dx, PS['lhand'][1], PS['lhand'][2]), hips=(PS['hips'][0] + dx*.5, PS['hips'][1], PS['hips'][2]))) for f, hy, dx, hp in sh]
_rreg("pitcher_shake_off", 24, [(f, PS, kw) for f, _, kw in _shake()], events=dict(shake=[4, 8, 12, 16]))
_rreg("pitcher_nod", 19, [(0, PS, {}), (4, PS, dict(head_pitch=-24)), (8, PS, dict(head_pitch=-6)), (12, PS, dict(head_pitch=-20)), (19, PS, {})], events=dict(nod=[4, 12]))
def _step_off():
    return [(0, PS, {}), (6, PS, dict(hips=(0, .06, -.07), rfoot=(-.14, .22, .20), rfoot_o=(-60, 0), lean=6, head_yaw=10, yaw=-50)), (12, PS, dict(hips=(0, .16, -.07), rfoot=(-.16, .48, .085), rfoot_o=(-40, 0), lean=6, head_yaw=20, yaw=-30, lfoot=(.17, -.28, .085))),
            (18, PS, dict(hips=(0, .26, -.05), rfoot=(-.16, .48, .085), rfoot_o=(-20, 0), yaw=-8, hyaw=-4, lfoot=(.15, .06, .20), lknee=(.2, -1, .2), head_yaw=15, lhand=(.10, -.32, 1.20), rhand=(-.06, -.30, 1.18))),
            (26, PS, dict(hips=(0, .36, -.04), rfoot=(-.16, .50, .085), rfoot_o=(-8, 0), yaw=8, hyaw=4, lfoot=(.15, .28, .085), lean=2, head_yaw=10, head_pitch=-6, lhand=(.10, -.34, 1.18), rhand=(-.08, -.30, 1.16))),
            (36, PS, dict(hips=(0, .36, -.04), rfoot=(-.16, .50, .085), rfoot_o=(-8, 0), yaw=8, hyaw=4, lfoot=(.15, .28, .085), lean=2, head_yaw=0, head_pitch=-6, lhand=(.10, -.34, 1.18), rhand=(-.08, -.30, 1.16)))]
_ro = _step_off()
_rreg("pitcher_step_off", 36, _ro, events=dict(back_foot_off=8, stepped_off=26))
_rreg("pitcher_step_on", 36, _rev(_ro, 36), events=dict(stepping_on=10, on_rubber=36))
def _rosin():
    R = dict(PR); rows = [(0, PR, {})]
    rows += [(5, PR, dict(rhand=(-.30, .12, .74), lean=6, head_pitch=-14)), (9, PR, dict(rhand=(-.32, .14, .64), lean=10, head_pitch=-16)), (12, PR, dict(rhand=(-.30, .12, .74), lean=6)),
             (16, PR, dict(rhand=(-.32, .14, .64), lean=10)), (20, PR, dict(rhand=(-.12, -.28, 1.10), lhand=(.12, -.28, 1.10), lean=2, head_pitch=-6)), (23, PR, dict(rhand=(-.02, -.30, 1.12), lhand=(.02, -.30, 1.12))),
             (26, PR, dict(rhand=(-.14, -.28, 1.10), lhand=(.14, -.28, 1.10))), (29, PR, dict(rhand=(-.02, -.30, 1.12), lhand=(.02, -.30, 1.12))), (36, PR, dict(rhand=(-.12, -.28, 1.12), lhand=(.10, -.30, 1.16))), (43, PR, {})]
    return rows
_rreg("pitcher_rosin", 43, _rosin(), events=dict(rosin_touch=[9, 16], clap=[23, 29]))
def _padjust():
    c = lambda f, dy: (f, PR, dict(rhand=(-.10, -.12, 1.80 + dy), head_pitch=-10, rpole=(-.9, .3, -.3)))
    rows = [(0, PR, {}), (5, PR, dict(rhand=(-.10, -.12, 1.74), head_pitch=-8, rpole=(-.9, .3, -.3))), c(8, .02), c(10, 0), c(12, .02), (16, PR, dict(rhand=(-.12, -.22, 1.20), head_pitch=-12)),
            (20, PR, dict(rhand=(-.04, -.24, 1.14), lhand=(.06, -.32, 1.24), head_pitch=-22, lean=4)), (23, PR, dict(rhand=(.00, -.24, 1.14), lhand=(.06, -.32, 1.24), head_pitch=-22)), (26, PR, dict(rhand=(-.04, -.26, 1.16), head_pitch=-22)),
            (29, PR, dict(rhand=(.00, -.24, 1.14), head_pitch=-22)), (33, PR, dict(rhand=(-.05, -.28, 1.18), head_pitch=-10)), (38, PR, {})]
    return rows
_rreg("pitcher_adjust", 38, _padjust(), events=dict(cap_touch=[8, 12], rub_ball=[20, 26]))
def _look():
    return [(0, PS, {}), (4, PS, dict(head_yaw=40, head_pitch=-8)), (8, PS, dict(head_yaw=78, head_pitch=-6, yaw=-52)), (15, PS, dict(head_yaw=80, head_pitch=-6, yaw=-52)), (20, PS, dict(head_yaw=25)), (24, PS, {})]
_rreg("pitcher_look_runner", 24, _look(), events=dict(look_peak=8, look_end=15))
def _handoff():
    return [(0, PR, {}), (6, PR, dict(rhand_rel=(-.10, -.34, -.10), lean=6, head_pitch=-10, head_yaw=-5)), (11, PR, dict(rhand_rel=(-.06, -.52, -.04), lean=8, head_pitch=-8, head_yaw=-8, lhand=(.22, -.20, .94))),
            (15, PR, dict(rhand_rel=(-.06, -.52, -.04), lean=8, head_pitch=-8, head_yaw=-8, lhand=(.22, -.20, .94))), (20, PR, dict(rhand_rel=(-.10, -.30, -.30), head_pitch=-22, lean=4)), (30, PR, dict(rhand=(-.16, -.30, .90), lhand=(.16, -.30, .90), head_pitch=-26, lean=4))]
_rreg("pitcher_handoff", 30, [(f, b, kw) for f, b, kw in _handoff()], events=dict(handoff=13))

# ---------------------------------------------------------------- warm-up pitch and bullpen throw
def _warmup():
    _len, keys = delivery("three_quarter", "windup"); T = {}
    out = []
    for f, sp in keys:
        nf = int(round(f*29.0/_len)); out.append((nf, dict(sp, lean=sp.get('lean', 0)*.9)))
    return out
CLIPS["warmup_pitch"] = (29, _warmup()); FRAME0["warmup_pitch"] = 0; RIT_EVENTS["warmup_pitch"] = dict(hand_break=7, plant=10, release=13, frames=29, pairs_with="catch_pitch (catch f7 = ball arrival ~0.4 s after release)")
def _bullpen():
    base = dict(CLIPS["throw"][1]); keys = []; k = 34.0/30
    ov = {8: dict(rhand_rel=(-.34, .04, .20)), 10: dict(rhand_rel=(-.32, -.12, .34), lean=24), 12: dict(rhand_rel=(-.30, -.30, .30), lean=34, side=10), 16: dict(lean=44, side=8)}
    for f, sp in CLIPS["throw"][1]:
        sp = dict(sp, **ov.get(f, {})); keys.append((int(round(f*k)), sp))
    return keys
CLIPS["bullpen_throw"] = (34, _bullpen()); FRAME0["bullpen_throw"] = 0; RIT_EVENTS["bullpen_throw"] = dict(release=14, frames=34)

# ---------------------------------------------------------------- mound conference (loops, three variants), manager
MT = dict(PR, hips=(0, 0, -.04), yaw=0, hyaw=0, lean=6, head_pitch=-8, head_yaw=0, lfoot=(.16, 0, .085), rfoot=(-.16, 0, .085), lhand=(.10, -.26, 1.10), rhand=(-.12, -.22, 1.04), lpole=(.7, .3, -.6), rpole=(-.7, .3, -.6))
def _mt_loop(n, rows): return [(f, MT, kw) for f, kw in rows] + [(n, MT, rows[0][1])]
_rreg("mound_talk", 72, _mt_loop(72, [(0, dict()), (10, dict(rhand=(-.22, -.32, 1.22), head_yaw=8, hips=(.01, 0, -.04))), (20, dict(rhand=(-.32, -.30, 1.14), head_yaw=-4, head_pitch=-4)), (30, dict(rhand=(-.16, -.28, 1.06), head_yaw=6, hips=(-.01, 0, -.045))),
                                      (40, dict(rhand=(-.26, -.34, 1.26), head_yaw=10, head_pitch=-4)), (52, dict(rhand=(-.14, -.26, 1.04), head_yaw=-3, lean=8)), (62, dict(rhand=(-.24, -.30, 1.16), head_yaw=5))]), dense=False)
_rreg("mound_talk_listen", 72, _mt_loop(72, [(0, dict(rhand=(-.30, -.06, 1.02), lhand=(.12, -.22, 1.04))), (14, dict(head_pitch=-14, head_yaw=5)), (26, dict(head_pitch=-8, head_yaw=-3, hips=(-.012, 0, -.045))), (38, dict(head_pitch=-16, head_yaw=4)),
                                      (52, dict(head_pitch=-6, head_yaw=-2, hips=(.01, 0, -.04))), (64, dict(head_pitch=-14, head_yaw=4))]), dense=False)
_rreg("mound_talk_cover", 60, _mt_loop(60, [(0, dict(lhand=(.10, -.14, 1.58), lhand_face=(0, -1, .1), head_yaw=18, head_pitch=-6)), (12, dict(lhand=(.10, -.15, 1.60), rhand=(-.22, -.30, 1.14), head_yaw=22, head_pitch=-8)),
                                      (26, dict(lhand=(.10, -.14, 1.58), rhand=(-.16, -.26, 1.04), head_yaw=16)), (40, dict(lhand=(.10, -.15, 1.60), rhand=(-.28, -.30, 1.20), head_yaw=22, head_pitch=-4)), (50, dict(lhand=(.10, -.14, 1.58), rhand=(-.14, -.24, 1.04), head_yaw=18))]), dense=False)
def _mgr_gait(n=20, duty=.62, half=.31):
    out = []
    def foot(p):
        p %= 1.0
        if p < duty: return (-half + 2*half*p/duty, .085)
        q = (p - duty)/(1 - duty); e = q*q*(3 - 2*q); return (half - 2*half*e, .085 + .085*sin(pi*q)**1.3)
    for f in range(n + 1):
        p = (f % n)/n; ly, lz = foot(p); ry, rz = foot(p + .5); c = cos(2*pi*p)
        bob = -.06 + .02*(1 + cos(4*pi*(p - duty/2)))/2
        out.append((f, dict(hips=(.015*sin(2*pi*p), 0, bob), lean=9, yaw=3*c, hyaw=-3*c, head_yaw=0, head_pitch=-8, lfoot=(.11, ly, lz), rfoot=(-.11, ry, rz), lfoot_o=(10, 0), rfoot_o=(-10, 0),
                            lhand_rel=(-.01, -.06, -.55), rhand_rel=(.01, -.06, -.55), lpole=(.8, .3, -.6), rpole=(-.8, .3, -.6))))
    return out
CLIPS["manager_walk"] = (20, _mgr_gait()); FRAME0["manager_walk"] = 0; RIT_EVENTS["manager_walk"] = dict(frames=20, footSpeed_design=1.2)
MG = dict(STAND, hips=(0, 0, -.04), lean=8, head_pitch=-8, lhand_rel=(.03, -.09, -.54), rhand_rel=(-.03, -.09, -.54), lpole=(.8, .3, -.6), rpole=(-.8, .3, -.6))
def _mgr_signal():
    up = dict(rhand=(-.22, -.06, 1.98), rpole=(-1, .1, -.3), head_yaw=-20, lean=2, hips=(0, 0, -.02))
    pt = dict(rhand=(-.66, -.30, 1.50), rpole=(-.4, .3, -1), head_yaw=-45, lean=2, yaw=-12)
    return [(0, MG, {}), (6, MG, dict(rhand=(-.24, -.10, 1.60), rpole=(-1, .1, -.3), head_yaw=-10)), (11, MG, up), (15, MG, dict(up, rhand=(-.24, -.06, 2.00))), (20, MG, dict(pt, rhand=(-.40, -.20, 1.70))), (24, MG, pt), (32, MG, pt),
            (38, MG, dict(rhand=(-.24, -.12, .94), head_yaw=-10)), (43, MG, {})]
_rreg("manager_signal", 43, _mgr_signal(), events=dict(arm_up=11, point_start=20, point_hold=[24, 32]))
def _mgr_challenge():
    tap = lambda f, d: (f, MG, dict(rhand=(-.12 + d, -.08, 1.86), rpole=(-1, .1, -.2), head_pitch=-6, head_yaw=10))
    return [(0, MG, {}), (6, MG, dict(rhand=(-.12, -.06, 1.70), rpole=(-1, .1, -.2), head_yaw=10)), tap(9, 0), tap(11, .04), tap(13, 0), tap(15, .04), tap(17, 0), (24, MG, dict(rhand=(-.22, -.14, 1.20))), (29, MG, {})]
_rreg("manager_challenge", 29, _mgr_challenge(), events=dict(tap=[9, 13, 17]))

# ---------------------------------------------------------------- umpire chores (shared rig, same bases as the gestures)
BEND = dict(SLOT, hips=(0, -.08, -.42), lean=62, lfoot=(.26, -.04, .085), rfoot=(-.22, .04, .085), lknee=(.3, -1, 0), rknee=(-.3, -1, 0), head_pitch=-34, lhand=(.22, -.34, .56), rhand=(-.12, -.52, .30), rpole=(-.6, .4, -.5), lpole=(.7, .4, -.4))
for _k in ('lhand_rel', 'rhand_rel'): BEND.pop(_k, None)
def _brush():
    rows = [(0, SLOT, {}), (8, SLOT, dict(BEND, rhand=(-.12, -.50, .36)))]
    for f, x in ((12, -.20), (16, .12), (20, -.20), (24, .12), (28, -.20), (32, .12), (36, -.20), (40, .12), (44, -.06)): rows.append((f, SLOT, dict(BEND, rhand=(x, -.52, .30), hips=(x*.1, -.08, -.42))))
    rows += [(50, SLOT, dict(RISE, rhand=(-.16, -.20, .62), lean=24)), (60, SLOT, {})]
    return rows
_rreg("ump_brush_plate", 60, _brush(), events=dict(bend_done=8, strokes=[16, 24, 32, 40], upright=50), dense=False)
def _new_ball():
    R = dict(RISE, hips=(0, .02, -.08), lean=10)
    return [(0, SLOT, {}), (5, SLOT, dict(RISE)), (9, SLOT, dict(R, rhand=(-.24, -.02, .94), lhand=(.14, -.10, .90))), (13, SLOT, dict(R, rhand=(-.28, -.04, .92), lhand=(.14, -.10, .90))),
            (17, SLOT, dict(R, rhand_rel=(-.12, -.30, -.14), lhand=(.14, -.10, .90))), (21, SLOT, dict(R, rhand_rel=(-.10, -.50, -.40), lean=14, lhand=(.14, -.10, .90))), (24, SLOT, dict(R, rhand_rel=(-.08, -.58, -.10), lean=14, lhand=(.14, -.10, .90))),
            (30, SLOT, dict(R, rhand_rel=(-.12, -.40, -.30), lhand=(.14, -.10, .90))), (36, SLOT, {})]
_rreg("ump_new_ball", 36, _new_ball(), events=dict(ball_taken=13, release=21, tossed=24), dense=False)
HUD = dict(RISE, hips=(0, .02, -.10), lean=18, head_pitch=-18, lhand_rel=(.28, -.30, .05), rhand_rel=(-.28, -.30, .05), lpole=(.5, .4, -.6), rpole=(-.5, .4, -.6), lfoot=(.20, 0, .085), rfoot=(-.20, 0, .085))
_rreg("ump_huddle", 72, [(0, HUD, {}), (14, HUD, dict(head_yaw=18, head_pitch=-14)), (26, HUD, dict(head_yaw=-12, hips=(.012, .02, -.10))), (38, HUD, dict(head_yaw=10, head_pitch=-20, lean=20)), (52, HUD, dict(head_yaw=-16, hips=(-.012, .02, -.10))), (64, HUD, dict(head_yaw=8)), (72, HUD, {})], dense=False)
