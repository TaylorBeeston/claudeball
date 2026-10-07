# Jank log (t-0014, from 2026-10-07)

The user watched the live game and listed what looks wrong; this is the running list: what, the evidence, the root cause, the fix and its commit.
How it was looked at: production build in headed Chrome 150 on the RTX 4090 Laptop (`ANGLE (NVIDIA ... RTX 4090 Laptop GPU, OpenGL ES 3.2)`),
seed 15, `tempo=standard`, the game stepped at a fixed 1/60 s and paused at chosen game times:

- `npx tsx tools/visual/jank.ts --at 3,16,24 --dump --cams body:ump-1b,body:batboy-away,...` dumps every puppet's sim hint vs the clip it plays and frames
  players' whole bodies (`body:<id|role>[:dist[:yawDeg]]`), faces, hands, or any fixed camera; `--until "<js>"` stops on a condition, `--dist DIR` serves an old build;
- `npx tsx tools/visual/look.ts --mode play` for the broadcast as a viewer sees it.

Before / after contact sheets are in the thread's library folder (`.herdr-project/claudeball-t-0014/library/`, not committed).

| # | issue | evidence | root cause | fix | commit |
|---|---|---|---|---|---|
| 1a | Umpires crouched in a claw-handed "ready" stance the whole game, also between pitches and innings | pitch cam t24: three umpires crouched on the infield dirt; dump: every umpire's hint `ump_ready` at every time | `snapshot.ts` sent `ump_ready` whenever an umpire was not gesturing; the engine only turned `idle` into a base-umpire set, and `idle` never came | the sim sends `ump_ready` only while a pitch is coming (windup, pitch, pickoff), `idle` otherwise (`umpStance`); the plate umpire crouches in the slot then, base umpires stay upright (`ump_set_base` holds its hands out in a stiff claw) | batch 1 |
| 1b | Field umpires stood in the middle of the infield (between the plate and the mound) during every break | dump t16-t24: (-3.2, 5.5), (0, 6.7), (3.2, 5.5) | `breaks.ts` sent them to "gather toward the plate" at fair-territory spots | before the first pitch the crew stands at its plate meeting in foul ground beside home (they start there), then takes the field; between innings they stay at their posts; the first pitch waits until the crew is in place | batch 1 |
| 1c | Umpires sprinted (4.5 m/s, `run` clip) to every spot | dump t8 | one speed for everything | run only for a live play; walk 1.4 m/s, jog 3.2 m/s for long ways; they face where they walk, then the ball / what they were told to face | batch 1 |
| 1d | The plate brush played the base umpire's set crouch, 2.4 m behind the plate | dump t24: hint `umpire_brush_plate`, clip `ump_set_base` | the hint name does not match the GLB clip `ump_brush_plate`; the umpire brushed from behind the catcher | mapped to `ump_brush_plate` (whisk broom shown), he walks round the catcher (`detour`) to the front of the plate and brushes it facing the backstop (break and pitching change) | batch 1 |
| 1e | `facing` of umpires accumulated (-6.28, -3.69) | dump | never wrapped | wrapped to (-pi, pi] | batch 1 |
| 2a | "A guy sitting in air outside of the benches": the bat boy | dugout B-roll t6; dump: bat boy hint `ballkid_idle`, clip `ballkid_sit`, y = 0 | no `ballkid_idle` clip, and its fallback chain went to the seated `ballkid_sit` | standing hints never fall back to a seated clip (`ballkid_idle` -> `idle`); a guard test checks every hint x role against the manifest | batch 1 |
| 2b | Ball kids sat on thin air down the lines | close-up of `ballkid-1b` | no chair anywhere (not in field.glb / stadium.glb, no engine prop) | a folding chair is placed where each kid sits (`kidChairs.ts`, seat top 0.33 m = the measured seat of `ballkid_sit`), one draw call each; the sim sends `ballkid_sit` only on the chair (he used to sit 3 m away after backing off from a ball in play) | batch 1 |
| 2c | Bench players sank ~10 cm into the bench | measured on the live puppets: seat of the pants 0.39-0.41 m above the root, bench top 0.50 m (`field.py`) | three disagreeing heights: clip convention 0.45 m, bench 0.50 m, the clip's real seat ~0.40 m | the sim lifts the `bench_sit` root by bench top - 0.45 (`BENCH_SIT_LIFT`); the remaining ~4 cm (the clip sits lower than its own 0.45 m convention) waits for the Blender clip pass | batch 1 (part) |

## Queue (not yet done)
3 catcher fingers, 4 batter body horror, 5 faces, 6 general sweep, and the user's second list: 7 underhand tosses / rolls, 8 jersey text orientation,
9 run cycle hand IK, 10 helmets (exposed ear), 11 body types and clothing fit.
