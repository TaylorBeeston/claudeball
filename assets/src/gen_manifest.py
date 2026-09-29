"""Writes players/player_manifest.json (clips, event frames, morph targets, optional node groups, files, palettes) and prints the README clip tables.
Plain python (no Blender): python3 src/gen_manifest.py assets/"""
import json, math, os, sys
ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
here = os.path.dirname(os.path.abspath(__file__)); ns = {}
for f in ("player_clips.py", "player_pitch.py", "player_motion.py", "player_catch.py", "player_ump.py"): exec(open(os.path.join(here, f)).read(), ns)
CLIPS, FRAME0, EV, CEV, UEV = ns["CLIPS"], ns["FRAME0"], ns["PITCH_EVENTS"], ns["CATCH_EVENTS"], ns["UMP_EVENTS"]
FPS = 24
LOOPS = {"idle", "run", "walk", "field_ready", "celebrate", "catcher_crouch", "batting_stance", "trot", "run_turn", "pitcher_set", "pitcher_rock", "field_ready_infield", "field_ready_outfield",
         "field_ready_hands_knees", "ump_ready", "ump_set_base"}
OLD_EVENTS = {"pitch": {"release": 20}, "swing": {"contact": 21}, "throw": {"release": 12}, "catch_jump": {"take_off": 8, "apex": 14, "touch_down": 20}, "windup": {}, "field_catch": {}, "slide": {}}
clips = {}
for nm, (length, keys) in CLIPS.items():
    f0 = FRAME0.get(nm, 1); dur = (length + f0)/FPS            # the first key sits at t = f0/24 s (f0 = 1 for the original clips, 0 for the newer ones)
    new = nm in EV or nm in CEV or nm in UEV
    if nm in EV: ev = {"foot_plant": EV[nm]["plant"], "release": EV[nm]["release"], "hand_break": EV[nm]["hand_break"]}
    elif nm in CEV: ev = {k: v for k, v in CEV[nm].items() if k != "frames"}
    elif nm in UEV: ev = {k: v for k, v in UEV[nm].items() if k != "frames"}
    else: ev = dict(OLD_EVENTS.get(nm, {}))
    e = {"frames": length, "first_key_frame": f0, "duration_s": round(dur, 4), "loop": nm in LOOPS}
    if ev:
        e["events_frame"] = ev; e["events_s"] = {k: round((v + (0 if new or f0 == 0 else f0))/FPS, 4) for k, v in ev.items()}
    if nm in CEV and "catch" in CEV[nm]:
        c = CEV[nm]["catch"]; hold = min(length, (CEV[nm].get("give", CEV[nm].get("funnel", c + 4)) + 1))
        e["glove_closed_keys"] = [[max(0, c - 3), 0.0], [c, 1.0], [hold, 1.0], [min(length, hold + 5), 0.0]]     # (frame, morph weight) for the `glove_closed` morph of the glove and its laces
    clips[nm] = e
def lin(c): return c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4
def hexlin(h): h = h.lstrip("#"); return [round(lin(int(h[i:i+2], 16)/255), 4) for i in (0, 2, 4)] + [1]
SKIN = ["#f4d2b8", "#e8bb98", "#d8a276", "#c48858", "#a96c44", "#8c5836", "#6f4229", "#573220", "#f0c8ad", "#dcaa84"]
HAIR = {"black": "#0b0908", "dark_brown": "#2a1a10", "brown": "#4a2f1c", "chestnut": "#6b3f22", "auburn": "#7a3a1e", "blond": "#b58b4a", "light_blond": "#d6b877", "gray": "#8a8784", "white": "#d8d5d0", "red": "#8f3a1a"}
man = {"version": 4, "fps": FPS, "clips": clips,
       "files": {"player_base": "everything (all optional nodes, all four gloves, both hands per side)", "player_home / player_away": "fielder, infield glove", "player_home_of / player_away_of": "outfielder, larger outfield glove",
                 "player_home_1b / player_away_1b": "first baseman, long 1B mitt", "player_catcher": "catcher, big round mitt + gear", "player_batter": "batter (helmet, batting gloves, fist hands)",
                 "player_umpire": "plate umpire (navy, mask, chest protector, shin guards)", "player_umpire_base": "base umpire (navy uniform and cap only)",
                 "note": "in the glove files the node `Gear_Glove` is that role's glove, `Glove_Pocket` its pocket, `Hand_L` the open hand that lives inside it and `Hand_R` the ball-ready claw hand; each lod1/optimized/plain variant of a file has the same content"},
       "morph_targets": {"body": ["build_lean", "build_stocky", "build_muscular"], "head": ["head_narrow", "head_wide"], "head_only": ["jaw_square", "nose_large", "ears_large"], "hair_only": ["hair_under_cap"],
                         "glove": ["glove_open", "glove_closed"],
                         "note": "influence 0..1; body keys on every skinned body/clothing mesh, head_narrow/head_wide on head-attached meshes, glove_open/glove_closed on the glove, its laces and the hand inside; hair_under_cap squashes hair under a cap"},
       "grips": {"Bat_Grip": "RightHand, origin = knob, +Y = barrel", "Ball_Grip": "RightHand, 4-seam (ball symmetry axis toward the thumb side); show the claw hand", "Ball_Grip_2Seam": "RightHand, ball turned 90 deg",
                 "Glove_Pocket": "LeftHand, origin = pocket centre (where the ball sits, 5-8 mm clearance from the leather), glTF +Y = pocket opening normal, +X along the fingers; Glove_Pocket_Outfield / _FirstBase / _Catcher in player_base"},
       "node_groups": {"jersey": ["Jersey (default, elbow sleeves)", "Jersey_ShortSleeve", "Jersey_Sleeveless"], "pants": ["Pants (default, knee)", "Pants_Long"],
                       "hair": ["Gear_Hair (default short)", "Gear_Hair_Buzz", "Gear_Hair_Curly", "Gear_Hair_Long"], "facial_hair": ["Gear_Beard_Stubble", "Gear_Beard_Full", "Gear_Mustache", "Gear_Goatee"],
                       "headwear": ["Gear_Cap", "Gear_Helmet"], "accessory": ["Gear_EyeBlack", "Gear_BattingGlove_L/R", "Gear_Wristband_L/R", "Gear_ArmSleeve_L/R", "Gear_Glove(+_Outfield/_FirstBase/_Catcher) and *_Laces"],
                       "trim": ["Gear_Piping", "Gear_Buttons"], "belt": ["Gear_Belt", "Gear_BeltBuckle"], "shoe": ["Cleats", "Gear_Soles", "Gear_Laces"], "hand": ["Hand_R (firm grip, bat)", "Hand_R_Ball (claw, ball)", "Hand_L (fist)", "Hand_L_Open (inside the glove)"],
                       "note": "every node carries glTF extras {cb_group, cb_default}; cb_default = 1 means visible in that file's pre-configured look. Optional variants exist only in player_base.glb"},
       "skin_tones_baseColorFactor_linear": {h: hexlin(h) for h in SKIN}, "hair_colors_baseColorFactor_linear": {k: hexlin(v) for k, v in HAIR.items()},
       "materials_recolor": ["skin", "face", "hair", "stubble", "uniform_jersey", "uniform_undershirt", "uniform_pants", "uniform_socks", "piping", "cap", "helmet", "glove", "glove_laces", "batting_glove", "wristband", "arm_sleeve", "belt", "buckle",
                             "cleats", "laces", "sole", "eyeblack", "button", "catcher_gear"]}
os.makedirs(os.path.join(ROOT, "players"), exist_ok=True)
json.dump(man, open(os.path.join(ROOT, "players", "player_manifest.json"), "w"), indent=1)
def row(nm, cols):
    c = clips[nm]; e = c.get("events_frame", {}); s = c.get("events_s", {})
    ev = ", ".join(f"{k} f{v} ({s[k]:.3f} s)" for k, v in e.items()) or "-"
    return f"| `{nm}` | {c['frames']} | {c['duration_s']:.3f} s | {'loop' if c['loop'] else 'one-shot'} | {ev} |"
print("### pitching"); print("| clip | frames | duration | loop | foot plant | hand break (ball leaves glove) | release |"); print("|---|---|---|---|---|---|---|")
for nm in sorted(clips, key=lambda n: (not n.startswith("pitch"), n)):
    if not nm.startswith("pitch"): continue
    c = clips[nm]; e = c.get("events_frame", {})
    if nm in EV: print(f"| `{nm}` | {c['frames']} | {c['duration_s']:.3f} s | {'yes' if c['loop'] else 'no'} | f{e['foot_plant']} ({e['foot_plant']/FPS:.3f} s) | f{e['hand_break']} ({e['hand_break']/FPS:.3f} s) | f{e['release']} ({e['release']/FPS:.3f} s) |")
    else: print(f"| `{nm}` | {c['frames']} | {c['duration_s']:.3f} s | {'yes' if c['loop'] else 'no'} | - | - | - |")
for title, names in (("catching / fielding / throws", [n for n in CEV if n.startswith(("catch_", "field_grounder", "pitcher_catch", "throw_casual", "pickoff"))]),
                     ("tags, blocks, slides", [n for n in CEV if n.startswith(("tag_", "catcher_block", "slide_", "dive_back", "pop_up"))]), ("umpire", list(UEV))):
    print(f"### {title}"); print("| clip | frames | duration | loop | event frames |"); print("|---|---|---|---|---|")
    for nm in names: print(row(nm, None))
