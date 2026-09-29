"""Writes players/player_manifest.json (clips, event frames, morph targets, optional node groups, palettes) and prints the README clip table.
Plain python (no Blender): python3 src/gen_manifest.py assets/"""
import json, math, os, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
here = os.path.dirname(os.path.abspath(__file__)); ns = {}
for f in ("player_clips.py", "player_pitch.py", "player_motion.py"): exec(open(os.path.join(here, f)).read(), ns)
CLIPS, FRAME0, EV = ns["CLIPS"], ns["FRAME0"], ns["PITCH_EVENTS"]
FPS = 24
LOOPS = {"idle", "run", "field_ready", "celebrate", "catcher_crouch", "batting_stance", "trot", "run_turn", "pitcher_set", "pitcher_rock", "field_ready_infield", "field_ready_outfield", "field_ready_hands_knees"}
OLD_EVENTS = {"pitch": {"release": 20}, "swing": {"contact": 21}, "throw": {"release": 12}, "catch_jump": {"take_off": 8, "apex": 14, "touch_down": 20},
              "windup": {}, "field_catch": {}, "slide": {}}
clips = {}
for nm, (length, keys) in CLIPS.items():
    f0 = FRAME0.get(nm, 1); dur = (length + f0)/FPS            # first key sits at t = f0/24 s (f0 = 1 for the original clips, 0 for the newer ones)
    ev = dict(EV.get(nm, OLD_EVENTS.get(nm, {})))
    if nm in EV: ev = {"foot_plant": EV[nm]["plant"], "release": EV[nm]["release"], "hand_break": EV[nm]["hand_break"]}
    e = {"frames": length, "first_key_frame": f0, "duration_s": round(dur, 4), "loop": nm in LOOPS}
    if ev: e["events_frame"] = ev; e["events_s"] = {k: round((v + f0 - (f0 if nm in EV else 0))/FPS, 4) for k, v in ev.items()}
    clips[nm] = e
def lin(c): return c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4
def hexlin(h): h = h.lstrip("#"); return [round(lin(int(h[i:i+2], 16)/255), 4) for i in (0, 2, 4)] + [1]
SKIN = ["#f4d2b8", "#e8bb98", "#d8a276", "#c48858", "#a96c44", "#8c5836", "#6f4229", "#573220", "#f0c8ad", "#dcaa84"]
HAIR = {"black": "#0b0908", "dark_brown": "#2a1a10", "brown": "#4a2f1c", "chestnut": "#6b3f22", "auburn": "#7a3a1e", "blond": "#b58b4a", "light_blond": "#d6b877", "gray": "#8a8784", "white": "#d8d5d0", "red": "#8f3a1a"}
man = {"version": 3, "fps": FPS, "clips": clips,
       "morph_targets": {"body": ["build_lean", "build_stocky", "build_muscular"], "head": ["head_narrow", "head_wide"], "head_only": ["jaw_square", "nose_large", "ears_large"],
                         "note": "influence 0..1; every skinned mesh carries the body keys, head-attached meshes carry head_narrow/head_wide, the Head and facial-hair meshes also jaw_square"},
       "grips": {"Bat_Grip": "RightHand, origin = knob, +Y = barrel", "Ball_Grip": "RightHand, 4-seam (ball symmetry axis toward the thumb side); show Hand_R_Ball", "Ball_Grip_2Seam": "RightHand, ball turned 90 deg",
                 "Glove_Pocket": "LeftHand, ball rests here until the hand-break frame of a pitch"},
       "node_groups": {"jersey": ["Jersey (default, elbow sleeves)", "Jersey_ShortSleeve", "Jersey_Sleeveless"], "pants": ["Pants (default, knee)", "Pants_Long"],
                       "hair": ["Gear_Hair (default short)", "Gear_Hair_Buzz", "Gear_Hair_Curly", "Gear_Hair_Long"], "facial_hair": ["Gear_Beard_Stubble", "Gear_Beard_Full", "Gear_Mustache", "Gear_Goatee"],
                       "headwear": ["Gear_Cap", "Gear_Helmet"], "accessory": ["Gear_EyeBlack", "Gear_BattingGlove_L/R", "Gear_Wristband_L/R", "Gear_ArmSleeve_L/R", "Gear_Glove"],
                       "trim": ["Gear_Piping", "Gear_Buttons"], "shoe": ["Cleats", "Gear_Soles", "Gear_Laces"], "hand": ["Hand_R (firm grip, bat)", "Hand_R_Ball (claw, ball)"],
                       "note": "every node carries glTF extras {cb_group, cb_default}; cb_default = 1 means visible in that file's pre-configured look. Optional variants exist only in player_base.glb"},
       "skin_tones_baseColorFactor_linear": {h: hexlin(h) for h in SKIN}, "hair_colors_baseColorFactor_linear": {k: hexlin(v) for k, v in HAIR.items()},
       "materials_recolor": ["skin", "face", "hair", "stubble", "uniform_jersey", "uniform_undershirt", "uniform_pants", "uniform_socks", "piping", "cap", "helmet", "glove", "batting_glove", "wristband", "arm_sleeve", "belt", "cleats", "laces", "sole", "eyeblack", "button"]}
os.makedirs(os.path.join(ROOT, "players"), exist_ok=True)
json.dump(man, open(os.path.join(ROOT, "players", "player_manifest.json"), "w"), indent=1)
print("| clip | frames | duration | loop | foot plant | hand break (ball leaves glove) | release |"); print("|---|---|---|---|---|---|---|")
for nm in sorted(clips, key=lambda n: (not n.startswith("pitch"), n)):
    if not nm.startswith("pitch"): continue
    c = clips[nm]; e = c.get("events_frame", {})
    if nm in EV: print(f"| `{nm}` | {c['frames']} | {c['duration_s']:.3f} s | {'yes' if c['loop'] else 'no'} | f{e['foot_plant']} ({e['foot_plant']/FPS:.3f} s) | f{e['hand_break']} ({e['hand_break']/FPS:.3f} s) | f{e['release']} ({e['release']/FPS:.3f} s) |")
    else: print(f"| `{nm}` | {c['frames']} | {c['duration_s']:.3f} s | {'yes' if c['loop'] else 'no'} | - | - | - |")
