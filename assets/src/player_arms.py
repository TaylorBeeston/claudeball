# Elbow pole optimiser: chooses the elbow pole vector of every frame so that the elbows/forearms stay outside the torso volume (also at the stocky / muscular
# build extremes) and, for locomotion and ready poses, stay close to the ribs and below the shoulders (no chicken wing).
# Requires player_anim.py (solve, DEFAULT), player_motion.py (densify) exec'd. Blender axes; everything in armature (rest) space.
import math
import numpy as np
from mathutils import Vector

def _fib(n):
    out = []; ga = math.pi*(3 - math.sqrt(5))
    for i in range(n):
        z = 1 - 2*(i+.5)/n; r = math.sqrt(max(0, 1 - z*z)); out.append(Vector((r*math.cos(ga*i), r*math.sin(ga*i), z)))
    return out
CAND = _fib(200)
_ZR = [.94, 1.00, 1.13, 1.27, 1.39, 1.49, 1.56]
_HX = [.213, .213, .179, .213, .237, .13, .06]; _HY = [.146, .146, .125, .151, .151, .106, .07]     # skin radii x 1.12 (body_skin) at those heights
BUILDS = ((1, 1), (1.13, 1.16), (1.11, 1.05), (.9, .92))                                               # (kx, ky): rest, build_stocky, build_muscular chest, build_lean
BONUS = (0.0, .035, .02, 0.0); BONUS_SCALE = [1.0]                                                                          # the wide builds may press the arm a little into the body (their clearance requirement is eased by this much)
def torso_dims(zr, b): return (np.interp(zr, _ZR, _HX) + .017)*b[0], (np.interp(zr, _ZR, _HY) + .017)*b[1]      # + jersey offset and folds

def arm_metrics(M, side):
    """(cc, dz, abd): cc = smallest distance of the arm's centre line samples outside the (build-inflated) torso surface, over all builds; dz = elbow height
    relative to the shoulder in the torso frame (negative = below); abd = how far the elbow is out from the shoulder's lateral position."""
    S = M['Spine1'].inverted(); sh = M[side+'Arm'].translation; el = M[side+'ForeArm'].translation; wr = M[side+'Hand'].translation
    pts = [el, el + (wr-el)*.5, el + (wr-el)*.8, sh + (el-sh)*.85]; cc = 9.0          # (the upper arm near the shoulder merges with the torso by design)
    for p in pts:
        lp = S @ p; zr = 1.17 + lp.y
        if .94 <= zr <= 1.56:
            for b, bonus in zip(BUILDS, BONUS):
                hx, hy = torso_dims(zr, b); cc = min(cc, (math.hypot(lp.x/hx, lp.z/hy) - 1)*min(hx, hy) + bonus*BONUS_SCALE[0])
    le, ls = S @ el, S @ sh
    return cc, le.y - ls.y, abs(le.x) - abs(ls.x)

def _ang(a, b): return math.acos(max(-1.0, min(1.0, a.normalized().dot(b.normalized()))))
def optimise(keys, cfg, cyclic=False, init=None):
    """keys: [(frame, spec)] with `lpole` / `rpole` (base poles). Returns keys with per-frame optimised poles. cfg: cc_min, cc_cap, dz_max, abd_max, w_base, w_prev."""
    BONUS_SCALE[0] = cfg.get('bonus', 1.0); laps = 2 if cyclic else 1; out = {}; prev = {'l': Vector(init['l']) if init else None, 'r': Vector(init['r']) if init else None}
    for lap in range(laps):
        for f, sp in keys:
            new = dict(sp)
            for side, k in (('Left', 'l'), ('Right', 'r')):
                base = Vector(sp.get(k+'pole', DEFAULT[k+'pole'])); cands = [base] + ([prev[k]] if prev[k] is not None else []) + CAND; best = None
                for c in cands:
                    M, _ = solve(dict(sp, **{k+'pole': tuple(c)})); cc, dz, abd = arm_metrics(M, side)
                    J = 1e4*max(0.0, cfg['cc_min'] - cc)
                    if cfg.get('cc_cap') is not None: J += 25*max(0.0, cc - cfg['cc_cap'])
                    if cfg.get('dz_max') is not None: J += 300*max(0.0, dz - cfg['dz_max'])
                    if cfg.get('abd_max') is not None: J += 200*max(0.0, abd - cfg['abd_max'])
                    J += cfg.get('w_base', .2)*_ang(c, base) + (cfg.get('w_prev', 1.0)*_ang(c, prev[k]) if prev[k] is not None else 0.0)
                    if best is None or J < best[0]: best = (J, c, cc, dz, abd)
                prev[k] = best[1].copy(); new[k+'pole'] = tuple(best[1]); new['_m_'+k] = (round(best[2], 3), round(best[3], 3), round(best[4], 3), round(best[0], 3))
            if lap == laps-1: out[f] = new
    res = [(f, out[f]) for f, _ in keys]
    if cyclic: res[-1] = (res[-1][0], dict(res[-1][1], lpole=res[0][1]['lpole'], rpole=res[0][1]['rpole']))      # close the loop exactly
    return res

def _strip(keys): return [(f, {k: v for k, v in sp.items() if not k.startswith('_m_')}) for f, sp in keys]
SIDE = lambda s: s
# --- which clips get optimised, and how
LOCO = dict(cc_min=.03, cc_cap=.10, dz_max=-.14, abd_max=.13, w_base=.15, w_prev=.9)
READY = dict(cc_min=.03, cc_cap=.14, dz_max=-.08, abd_max=.14, w_base=.15, w_prev=.9)
BAT = dict(cc_min=.03, w_base=.35, w_prev=1.2, bonus=0.0)
OPT_CLIPS = {"run": (LOCO, True), "run_turn": (dict(LOCO, abd_max=.16, dz_max=-.12), True), "trot": (LOCO, True), "walk": (LOCO, True),
             "field_ready": (READY, True), "field_ready_infield": (READY, True), "field_ready_outfield": (READY, True), "field_ready_hands_knees": (dict(READY, abd_max=.18, cc_cap=.2), True),
             "idle": (READY, True), "ump_ready": (READY, True), "ump_set_base": (READY, True), "catcher_crouch": (dict(READY, dz_max=-.02, cc_cap=.2, abd_max=.2), True), "batting_stance": (BAT, True), "swing": (BAT, False)}
CATCHCFG = dict(cc_min=.03, w_base=.15, w_prev=.9)
for _n in ("catch_throw", "catch_throw_high", "catch_throw_low", "catch_stretch", "catch_fly", "catch_fly_run", "catch_line_drive", "catch_backhand", "field_grounder", "field_grounder_backhand",
           "catch_pitch", "catch_pitch_low", "catch_pitch_high", "catch_comebacker", "pitcher_catch_toss", "throw_casual", "pickoff", "tag_glove", "tag_hand", "catcher_block", "slide_feet", "slide_hook_left", "slide_hook_right", "slide_head", "dive_back",
           "pop_up", "pop_up_head", "ump_strike", "ump_strike_swinging", "ump_ball", "ump_safe", "ump_out", "ump_out_strikeout", "ump_foul", "ump_fair", "ump_homerun", "ump_time"):
    OPT_CLIPS[_n] = (CATCHCFG, False)
ARM_REPORT = {}
def run_optimiser():
    init = None
    for nm, (cfg, cyc) in OPT_CLIPS.items():
        if nm not in CLIPS: continue
        length, keys = CLIPS[nm]
        if len(keys) < length*.9: keys = densify(keys)                                   # per-frame IK for sparse clips
        keys = optimise(keys, cfg, cyc, init if nm == "swing" else None)
        if nm == "batting_stance": init = {'l': keys[0][1]['lpole'], 'r': keys[0][1]['rpole']}
        if nm == "swing": keys[0] = (keys[0][0], dict(keys[0][1], lpole=init['l'], rpole=init['r']))    # swing frame 0 == stance frame 0 (same poles too)
        ms = [sp['_m_l'][:3] for f, sp in keys] + [sp['_m_r'][:3] for f, sp in keys]
        ARM_REPORT[nm] = dict(min_cc=round(min(m[0] for m in ms), 3), max_dz=round(max(m[1] for m in ms), 3), max_abd=round(max(m[2] for m in ms), 3))
        CLIPS[nm] = (length, _strip(keys))
# run_optimiser() is called by player_build.py once the armature exists (solve() reads its rest pose)
