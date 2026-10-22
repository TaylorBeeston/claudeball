# The stylized face (t-0025, docs/faces.md, style "B: stylized sculpt"): plain tables, no bpy, read by mpfb_face_extract.py (which units to store) and
# player_mpfb.py (the build). Units are MPFB2 targets (CC0) fitted into our space: shaping targets by their MPFB name with '-' -> '_', expression units
# with the prefix x_ (data/targets/expression/units). MPFB's "left" units move +X = the model's left, so *_L keys are the model's left side.

# one smooth reshaping of the shared head: bigger eyes with a relaxed upper lid, a simpler nose, fuller lips, smaller ears, broader cheek bones
FACE_STYLE = {
    "l_eye_scale_incr": 2.6, "r_eye_scale_incr": 2.6, "l_eye_height2_incr": .9, "r_eye_height2_incr": .9, "l_eye_height1_incr": .5, "r_eye_height1_incr": .5,
    "l_eye_bag_decr": 1.0, "r_eye_bag_decr": 1.0, "l_ear_scale_decr": .7, "r_ear_scale_decr": .7, "l_ear_flap_decr": .5, "r_ear_flap_decr": .5,
    "l_cheek_bones_incr": .7, "r_cheek_bones_incr": .7, "chin_width_incr": .3, "head_age_decr": 1.0,
    "x_eye_left_closure": .28, "x_eye_right_closure": .28,                    # the upper lid covers the top of the (bigger) iris: calm, not startled (.2 still read wide in game)
    "nose_scale_horiz_decr": .4, "nose_volume_decr": .7, "nose_point_up": .5, "nose_hump_decr": 1.0, "nose_flaring_decr": .6, "nose_scale_depth_decr": .3,
    "mouth_upperlip_volume_incr": .8, "mouth_lowerlip_volume_incr": .7, "mouth_cupidsbow_incr": .6, "mouth_laugh_lines_in": .5,
    "chin_prominent_incr": .6, "eyebrows_trans_forward": .4,
}
EYE_S = 1.12                                                                 # eyeball radius scale (the bigger lid opening of the style)
IRIS = (37.0, 12.5, .75)                                                     # iris / pupil angular radius (deg) and how much of the flat graphic iris is blended in

# the expression keys (glTF morph targets on Head and its followers): weight 1 = the full stylized expression.
# key: (((unit, weight), ...), amplitude, side) - side 'L' / 'R' keeps only that half of a symmetric unit (2 cm blend across the midline), None = as is
FACE_KEYS = {}
for _s, _side in (("L", "left"), ("R", "right")):
    FACE_KEYS[f"blink_{_s}"] = (((f"x_eye_{_side}_closure", 1.0),), 1.0, None)
    FACE_KEYS[f"squint_{_s}"] = (((f"x_eye_{_side}_slit", 1.0), (f"x_eye_{_side}_closure", .3)), 2.0, None)
    FACE_KEYS[f"wide_{_s}"] = (((f"x_eye_{_side}_opened_up", 1.0),), 2.0, None)
    FACE_KEYS[f"brow_up_{_s}"] = (((f"x_eyebrows_{_side}_up", 1.0), (f"x_eyebrows_{_side}_extern_up", .4)), 2.6, None)
    FACE_KEYS[f"brow_down_{_s}"] = (((f"x_eyebrows_{_side}_down", 1.0),), 2.6, None)
    FACE_KEYS[f"brow_inner_up_{_s}"] = (((f"x_eyebrows_{_side}_inner_up", 1.0),), 2.6, None)
    FACE_KEYS[f"smile_{_s}"] = ((("x_mouth_corner_puller", 1.0), ("x_mouth_elevation", .4)), 1.8, _s)
FACE_KEYS.update({
    "jaw_open": ((("x_mouth_open", .75),), 1.0, None),                       # 75 % of MPFB's opening: the mouth interior (dark island + mouth bag) holds up to there
    "frown": ((("x_mouth_depression", 1.0), ("x_mouth_depression_retraction", .3)), 1.8, None),
    "lip_press": ((("x_mouth_compression", 1.0),), 1.8, None),
    "sneer": ((("x_mouth_upward_retraction", 1.0), ("x_nose_left_elevation", .6), ("x_nose_right_elevation", .6)), 1.8, None),
    "pucker": ((("x_mouth_pursing", 1.0),), 1.5, None),
    "cheek_puff": ((("x_mouth_compression", .5), ("l_cheek_volume_incr", 2.0), ("r_cheek_volume_incr", 2.0)), 1.0, None),
})
EXPR_KEYS = tuple(FACE_KEYS)
# which expression keys the parts that ride on the face carry (the head shape keys they follow are listed in player_build)
FOLLOW = {
    "Gear_Eyelashes": tuple(k for k in EXPR_KEYS if k.startswith(("blink", "squint", "wide", "brow_up"))),
    "Gear_Eyebrows": tuple(k for k in EXPR_KEYS if k.startswith(("brow", "blink", "squint"))),
    "Gear_EyeBlack": tuple(k for k in EXPR_KEYS if k.startswith(("squint", "smile"))),
    "beard": ("jaw_open", "smile_L", "smile_R", "frown", "lip_press", "sneer", "pucker", "cheek_puff"),
    "teeth": ("jaw_open",),
}
FACE_UNITS = sorted(set(FACE_STYLE) | {u for units, _a, _s in FACE_KEYS.values() for u, _w in units})
