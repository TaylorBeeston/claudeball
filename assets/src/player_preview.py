exec(open(CB_SRC+"/player_build.py").read())
CLAMPS.clear(); ACTS = bake_clips(arm)
paths = preview_clip(PREV_CLIP, PREV_FRAMES, "/tmp/claude-1000/pv", hide=("Gear_Helmet","Gear_CatcherMask","Gear_ChestProtector","Gear_ShinGuard_L","Gear_ShinGuard_R") if not PREV_ALL else ())
result = {"paths": len(paths), "clamps": sorted(set(CLAMPS))[-6:]}
