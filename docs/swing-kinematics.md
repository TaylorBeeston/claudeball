# The sim's swing: bat path vs what two hands can hold

Thread t-0024 (sim). Step 1: what the sim's bat does today (main d34d6b9), measured, before any change.

## How it is measured

`tools/swing/run.ts` plays the `npm run sim -- 200 7` game set (same teams and game seeds as scripts/simulate.ts, sharded over the
cores; its league line equals simulate.ts's exactly) and replays every swing from its plan (`BatSwing` draws no random numbers, so the
copy changes nothing). Each swing is sampled at 60 Hz (the game's frames) and at fixed instants. For holdability (`tools/swing/hold.ts`)
the batter's body is the `swing` clip at the clip time the engine shows (gltfCharacter.ts `batterTiming`: launch 0.583 s, contact at the
manifest's 0.917 s, finish 1.167 s), placed as the engine places it (box, stance yaw incl. STANCE_OPEN, height scale, lefty mirror), and
both fists are solved onto the sim's actual knob and bat line with the game's arm solver **the way the engine runs it**: the grip taken at
swivel 0 / roll 0 and tracked frame to frame (armIK.ts track mode). strict = both fists < 2 cm off the handle and <= 5 deg past the
pronation / wrist range; relaxed = <= 35 deg (the envelope's '#' / '+').

Note: envelope.ts labels frame 21 (0.875 s) "contact"; the engine lays the sim's contact on the manifest's 0.917 s (its "extension (22)").
The clip's own bat at 0.917 s is az -32 / el 17 in the shoulder frame, 38 deg of azimuth from the "contact (21)" row.

## Main (200 games, seed 7): the bat in world space

| instant | elevation p5 / p50 / p95 | min..max | barrel tip height p5 / p50 |
|---|---|---|---|
| swing start | 54 / 54 / 54 | | 2.08 m |
| tauC / 2 | -49 / -21 / 2 | -89..30 | 0.43 / 0.83 m |
| 60 ms before contact | -65 / -36 / -11 | -90..24 | 0.24 / 0.57 m |
| contact | -53 / -33 / -10 | -77..29 | 0.36 / 0.63 m |
| 1.5 tauC | -40 / -16 / 6 | | |
| 2.1 tauC (end) | -38 / -12 / 12 | | |

At the planned contact instant, by pitch height (p5 / p50 / p95):

| | all | pitch < 0.6 m | 0.6-0.9 m | > 0.9 m |
|---|---|---|---|---|
| bat elevation (barrel vs hands) | -53 / -33 / -10 | -59 / -44 / -32 | -46 / -31 / -17 | -22 / -13 / 1 |
| attack angle | 0 / 8 / 16 | 0 / 8 / 16 | 0 / 9 / 16 | 0 / 9 / 16 |
| swing plane tilt | 14 / 35 / 54 | 33 / 46 / 61 | 20 / 33 / 47 | 7 / 16 / 25 |
| sweet spot speed (m/s) | 28.4 / 31.1 / 33.9 | | | |
| knob speed (m/s) | 11.9 / 13.1 / 14.3 | | | |
| knob height (m) | 1.0 / 1.1 / 1.2 | 1.0 / 1.0 / 1.1 | 1.0 / 1.1 / 1.2 | 1.1 / 1.1 / 1.2 |

Why: at contact the bat lies on the line from a fixed virtual pivot (1.15 m up, 0.48 m behind the knob) to the ball, so its elevation
is the ball's seen from there (about -45 deg for a mid pitch, nearly vertical for a low one: the hands never come down). Before
contact the elevation is `epsC - tan(alpha) * (thetaC - theta)`: going back along the arc makes the bat steeper still (the "chop", -80
to -90 deg 60 ms out). The knob moves at 13 m/s at contact because the bat turns about a point 0.48 m behind it (real hands: ~6-8 m/s).

## Main: can two hands hold it (the engine's tracked solve, 649k swing frames)

| phase | frames | strict | relaxed | world el p5 / p50 / p95 | knob off the clip's own (cm) p50 / p95 | past range p50 / p95 (deg) | miss p95 |
|---|---:|---:|---:|---|---|---|---|
| launch (< 0.4 tauC) | 99840 | 0.0 % | 0.0 % | 21 / 51 / 54 | 14 / 28 | 68 / 88 | 16 cm |
| mid (< 0.85) | 99840 | 0.0 % | 0.5 % | -61 / -29 / 6 | 33 / 44 | 85 / 192 | 15 cm |
| contact (0.85-1.15) | 74880 | 0.0 % | 2.4 % | -56 / -34 / -10 | 22 / 33 | 75 / 141 | 8 cm |
| follow (to 2.1 tauC) | 224640 | 0.0 % | 1.9 % | -40 / -17 / 8 | 33 / 46 | 78 / 183 | 8 cm |
| finish (held) | 149760 | 0.1 % | 8.5 % | -38 / -12 / 12 | 31 / 45 | 63 / 163 | 7 cm |
| all | 648960 | 0.0 % | 3.0 % | | | | |

No stance, height or pitch-height split is better than 8.5 % relaxed (tall batters and high pitches are the least bad). This agrees with
the IK thread's last game sweep (b2final): in the sim's swing the fists were off the handle on 145 % of frames (both hands counted) and
turned against it on 122 %.

**The clip's own bat is not holdable either.** Fed the swing clip's own knob and bat (so the fists' targets are exactly where the clip
has them), the tracked solver needs 36-150 deg past the top hand's range on every frame from launch to finish: the clip's top (rear) hand
sits at the solver's supination limit (-88 deg) and still needs 60-150 deg more. So "follow the clip's bat" is not a fix: the sim has to
put the knob and the bat where this body's arms can hold them, which is not where the clip has them.

## Main: league line (200 games, seed 7; scripts/simulate.ts)

R/G 4.29, AVG .245, OBP .322, SLG .418, K 23.5 %, BB 9.1 %, HR/PA 2.9 %, HR/FB 14.5 %, BABIP .299, EV 80.7 mph (p10 / p50 / p90
58.3 / 82.5 / 100.7), LA mean 11.1 (p10 / p50 / p90 -35.6 / 12.2 / 56.4), GB 48.0 %, LD 14.3 %, FB 23.3 %, PU 14.5 %;
whiff 28.9 % and foul 30.8 % per swing.

## The redesign (src/sim/batting.ts `BatSwing`, `SWING`)

- **The early swing is the clip's own.** From the swing's start the bat follows the swing clip's bat (the frames the engine lays on the
  sim's swing, `CLIP_SWING`, scaled by the batter's height), so while the engine still blends the arms in from the clip's (its ikW
  spring, ~0.1 s) and eases the bat out of the hands (70 ms), the fists and the bat agree. The bat is then turned off the clip's path
  (`via`) toward where this body's top hand can hold it: the clip's own top-hand grip needs 60-150 deg more supination than the solver
  allows on every frame.
- **Then a real swing plane.** Between 0.45 and 0.75 tauC (since t-0030: the knob from 0.20, the bat's direction from 0.30, both in the
  plane at 0.80; see the last section) the bat drops into a plane that holds the bat at contact and the sweet spot's
  heading (rising at the attack angle). On it the barrel lies back toward the catcher a little below the hands, comes round under them
  through the zone and rises into the follow-through, which wraps toward the clip's finish over the lead shoulder. The hitting zone
  (0.75-1.3 tauC; since t-0030 0.80-1.3) is pure plane.
- **The hands come to the pitch.** The bat's elevation at contact follows the pitch height (-13 deg mid-zone, -26 low, -3 high); the knob
  is S_AIM back along the bat from the aim point, horizontally toward the hands' reference (reaching out up to 15 cm for a pitch off the
  plate), within reach (0.64 m) of each fist's own shoulder on the drawn body at contact. Every body length scales with the batter's
  height like the drawn model (0.88-1.14).
- **Physics.** The bat turns about a point 0.12 m behind the knob (hands ~4.7 m/s at impact, sweet spot at the planned bat speed); its
  velocity is the true rate of change of the drawn pose (central difference), so the collision sees the hands' travel too. The random
  draws in buildSwing are the same in number and order as before.
- **Calibration** (each with its reason): `attackAdd` +7 deg (the plane rising to meet the pitch's descent; league attack ~15 deg at
  contact, a gap hitter's drawn toward 11) and `timeErr` x1.15 (a swing on plane forgives timing in height, so the same whiff rate
  needs a slightly wider timing spread).

Bat angle: the brief asked for the barrel above the hands at contact for most pitch heights; real hitters' barrels are below the hands
(Statcast vertical bat angle about -25 to -35 mid-zone) and the clip's contact frame (+13 deg) is a letter-high swing. Measured: a level
bat holds best on this body (the tuner pushed v0 to -10..-14), a Statcast-like -21 to -25 bat narrows the launch-angle spread and centres
the spray but the top fist turns off the bat more often (game sweep: fist axis 58 % at -21 vs 36 % at -13). Chosen: -13 mid-zone.

## After (200 games, seed 7; same game set as main)

| | main | after |
|---|---|---|
| R/G | 4.29 | 4.28 |
| AVG / OBP / SLG | .245 / .322 / .418 | .243 / .320 / .416 |
| K % / BB % | 23.5 / 9.1 | 23.3 / 8.9 |
| HR/PA, HR/FB (fair 20-50 deg) | 2.9 %, 14.5 % | 3.2 %, 19.9 % |
| BABIP | .299 | .293 |
| whiff / foul per swing | 28.9 / 30.8 % | 28.2 / 30.9 % |
| EV mean, p10 / p50 / p90 (mph) | 80.7, 58.3 / 82.5 / 100.7 | 80.8, 59.7 / 82.4 / 100.1 |
| LA mean, p10 / p50 / p90 (deg) | 11.1, -35.6 / 12.2 / 56.4 | 8.6, -45.4 / 10.1 / 60.6 |
| GB / LD / FB / PU | 48.0 / 14.3 / 23.3 / 14.5 % | 49.9 / 12.7 / 20.2 / 17.2 % |
| hard hit (>= 95 mph) | 22.0 % | 20.7 % |

The bat in world space (elevation p5 / p50 / p95, min..max):

| instant | main | after |
|---|---|---|
| tauC / 2 | -49 / -21 / 2 (-89..30) | 34 / 35 / 37 (33..38) |
| 60 ms before contact | -65 / -36 / -11 (-90..24) | 4 / 10 / 16 (-3..24) |
| contact | -53 / -33 / -10 (-77..29) | -29 / -16 / -4 (-41..0) |

At the planned contact instant (p5 / p50 / p95): attack angle 7 / 15 / 23 deg (main 0 / 8 / 16); swing plane tilt 13 / 23 / 35 deg
(main 14 / 35 / 54); hands 4.3 / 4.7 / 5.1 m/s (main 11.9 / 13.1 / 14.3); knob 0.8 / 0.9 / 1.1 m up (main 1.0 / 1.1 / 1.2).

### Can two hands hold it

The real game (tools/jank game sweep, seeds 1-3, 9 innings, before = main d34d6b9, after = d66644d; share of the swing hint's frames,
both hands counted, so 200 % = both hands every frame):

| | before | after |
|---|---|---|
| fists off the handle (bat:grip) | 144.5 % | 97.0 % |
| fist turned against the bat (bat:hand-axis) | 125.7 % | 36.0 % |
| wrong hand at the knob | 3.8 % | 0.1 % |
| barrel through the body | 0.2 % | 1.7 % |
| swing:finish grip / axis | 33.7 / 26.8 % | 0 / 0 % |

Traced swings (seed 1, 100-400 s): a fist off the handle by a median 6 cm past the 3 cm tolerance before (worst 26 cm), 2 cm after (worst
10 cm); a fist axis a median 33 deg past 25 before (worst 143), 9 deg after (worst 41).

The proxy (tools/swing, every swing of the 200 games, the engine's tracked solve, its arm blend-in and bat ease): held (neither fist off
nor turned) 10.6 % -> 52.3 % of the swing hint's frames; by phase launch 51, mid 1, contact 37, follow 81 %, finish 100 %. The envelope's
literal metric (the bat's direction alone in envelope.ts's relaxed grid at the nearest phase, the knob held at the clip's own) is not a
good guide once the knob moves: it reads lower after (launch 0 %, mid 22, contact 22, follow 2 %) than before (10 / 60 / 20 / 37 %) while
the game's own grip and axis counts fall.

**What the sim cannot reach.** The rest is the engine's (proxy, 24 games, the final path): held 52 %; with the top hand's supination
limit widened from 88 to 130 deg (armIK.ts ARM_LIMITS.sup) 65 % (fist axes 32 -> 10 %); with that and the grip taken at once instead of
the ~0.1 s arm blend-in (gltfCharacter.ts ikW), 90 % (fists off the handle 41 -> 0.1 %). Fists still 2 cm past the
tolerance in the game where the proxy has them on (the body's lean / neck passes and the blend-in move the shoulders after the sim chose
the knob) need the engine to read the sim's knob as a target to blend toward, not a place the clip's arms start from.

## The engine's half (thread t-0026)

What t-0024 left to the engine: the top hand's twist range, the arms' ~0.1 s blend into the grip, and the bat's 70 ms ease. Changed
(engine only; the sim and the player files untouched):

- **Top-hand supination 130 deg** (`armIK.ts` `ARM_LIMITS.supTop`, passed as the grip's own `goal.sup` by gltfCharacter.ts for the
  top hand only; every other reach and the constraint layer keep 88). A forearm turns ~85-90 deg past neutral; a hitter's palm-up top
  hand gets the rest from the shoulder's external rotation, which this solver cannot express (the upper arm's twist is fixed by the
  elbow's hinge plane), so the extra is drawn as forearm twist, still shared half and half by forearm and hand (wrist.split 0, no wrist
  snap). The validator's forearm range (+-100) still counts it: that is the price, shown below.
- **The grip taken at once** (`ikW = 1` from the swing's first frame; the release is unchanged). Only the hand's own turn onto the
  handle is spread over the grip's first three frames (35 / 70 / 100 %): the swing clip's bottom fist does not lie along its own bat, and
  turned in one frame it was a 20-35 deg hand flip on the grip's first frame.
- **The bat's ease kept, without feedback.** Taking the grip at once exposed that the ease blended toward the hand's grip every frame
  while the hand followed the drawn bat: the bat stood still for three frames and then turned ~60 deg in one (the hands flipped with it).
  The ease now captures where the hands hold the bat on the swing's first frame and closes that gap over 70 ms on top of the sim's own
  motion (players.ts `BatView.update`). The ease is needed: on the first frame the sim's knob is 13-18 cm behind the clip's hands
  (it runs ~2 frames behind them), which without it is a visible hitch.

Measured in the real game (tools/jank game sweep, seeds 1-3, 9 innings, before = main 7f3286b, after = this branch; share of the
sim swing's frames, both hands counted, so 200 % = both hands every frame; frame counts over the swing's ~4700 frames):

| | before | after | also bottom hand 130 (not shipped, swept without the hand ease) |
|---|---|---|---|
| fists off the handle (bat:grip) | 103.1 % | 9.0 % | 9.7 % |
| fist turned against the bat (bat:hand-axis) | 38.2 % | 29.5 % | 19.6 % |
| wrong hand at the knob | 0.2 % | 0.0 % | 0.0 % |
| held (neither fist off nor turned; trace, seed 1, 100-400 s) | 25 % | 69 % | |
| top forearm past +-100 (frames) | 2772 | 4351 | 4338 |
| bottom forearm past +-100 (frames) | 1515 | 404 | 4060 |
| hand / forearm flips (frames; bottom hand 89 -> 3) | 340 | 338 | |
| hand / forearm speed spikes (frames; top hand 561 -> 885) | 696 | 1032 | |

(Sweep noise: the same code swept twice, t-0024's after and this before, read 97.0 / 36.0 % and 103.1 / 38.2 %.) Whole-game severity
-0 %. No other clip's bat counts moved (stride, finish, stance, practice and on-deck swings), and the other roles' violation rates are
unchanged (per frame: pitcher 1.045 -> 1.045, catcher 0.215 -> 0.211, runner 0.308 -> 0.308, first base 1.392 -> 1.395, shortstop
1.379 -> 1.384, center 0.231 -> 0.234, on deck 1.359 -> 1.357). `jank:check` (static clips and blends) is unchanged: it has no batter IK.

The top hand's speed spikes are the price of a hand that now follows the bat through the zone (the bat turns ~30 deg a frame there).

What is left:
- **The fist axis (29.5 %).** The tools/swing proxy predicted ~10 %; about half the game's misses are on each hand. The bottom hand needs
  supination past 88 too (widening it: 19.6 %), which for a lead hand points at the swing clip's bottom-hand pose / grip rather than
  anatomy: measure after t-0025's stance re-key first.
- **The top hand's 70-90 deg turn ~6 frames in** (present before: the bat turns ~30 deg a frame there and the top fist runs out of
  range, then rolls on the handle): flip:RightHand 145 -> 202.
- The sim's first swing frames run ~2 frames behind the clip's hands (a sim thread could start CLIP_SWING where the engine shows it).

## Re-measured after t-0024 / t-0026 / t-0025 (thread t-0029)

Real-game sweep (tools/jank game sweep, seeds 1-3, **5 innings**, on main 35f7db0 + the per-hand fist-axis kind), each condition swept twice
from detached worktrees. Share of the sim swing's frames (`swing` clip), both hands counted for the grip:

| | main, run a | main, run b | bottom hand 130, run a | bottom hand 130, run b | t-0026 after (9 inn.) |
|---|---|---|---|---|---|
| swing frames | 2506 | 2501 | 2504 | 2501 | 4708 |
| fists off the handle (L / R) | 8.9 % (8.6 / 0.3) | 8.7 % (8.4 / 0.2) | 9.3 % (9.1 / 0.3) | 9.3 % (9.1 / 0.2) | 9.0 % |
| fist turned against the bat, frames (bottom L / top R) | 639 (401 / 238) | 602 (384 / 218) | 279 (60 / 219) | 277 (57 / 220) | |
| fist turned against the bat | 25.5 % | 24.1 % | 11.1 % | 11.1 % | 29.5 % |
| wrong hand at the knob | 0.0 % | 0.0 % | 0.0 % | 0.0 % | 0.0 % |
| top forearm past +-100 | 2333 (93.1 %) | 2343 (93.7 %) | 2334 (93.2 %) | 2344 (93.7 %) | 4351 (92.4 %) |
| bottom forearm past +-100 | 219 (8.7 %) | 218 (8.7 %) | 2223 (88.8 %) | 2215 (88.6 %) | 404 (8.6 %) |
| hand / forearm flips (LH / RH / LF / RF) | 183 (0/123/26/34) | 200 (0/138/26/36) | 238 (1/122/75/40) | 258 (2/137/83/36) | 338 (3/202/53/80) |
| speed spikes | 606 | 641 | 630 | 653 | 1032 |
| wrist split | 1 | 0 | 0 | 0 | 0 |
| elbow in the trunk | 27 | 26 | 25 | 21 | 55 |

Noise (same code twice): about +-0.7 points on the fist axis, +-0.1 on the grip, +-10 % on flips and spikes. Against t-0026 the fist axis
went 29.5 -> 24.8 % (the t-0025 stance re-key), flips 7.2 -> 7.7 % of frames (within noise), everything else flat.

**Bottom hand to 130 deg supination: not shipped.** It cuts the bottom fist's axis misses 390 -> 59 (the total 24.8 -> 11.1 %), but only by
over-twisting the forearm: bottom forearm past +-100 deg goes 8.7 -> 88.7 % of swing frames and its flips 26 -> 79. The lead forearm would
be past anatomy on nearly every swing frame; the miss belongs to the swing clip's bottom-hand pose (an asset fix), not the arm's range.
Whole game otherwise unchanged (severity 19320 -> 19323).

### What needs a sim change: the knob jump ~6 frames in

The top hand's 70-90 deg turn ~6 frames into the swing (flip:RightHand, spike:RightHand at s+5..s+8, top hand local turn p50 67 deg at s+6)
is the IK following the drawn bat, and the drawn bat follows the sim: the swing clip's own arm turns are <= 14 deg a frame there.
Measured on the sim alone (762 swings, `npm run sim` seed 7, games 0-5, 60 Hz frames), knob travel per frame, p50 at frames 1-11:
6, 12, 13, 8.5, 10, **23.5** (p90 28), 11, 5.6, 7, 7.5, 6.7 cm; bat turn 7, 15, 16, 11, 14, **37** (p90 41), 21, 27, 33, 37, 33 deg.
Frame 6 is u = tau / tauC ~ 0.65 (tauC p50 155 ms).

Cause: `BatSwing.at` blends the knob from `early(u)` (the clip path turned by `SWING.via`) to the plane path with a smoothstep over
u = `SWING.inStart` 0.45 -> `blendIn` 0.75, ~2.8 frames, and the two paths are 49 cm apart there (p50; 35-58). The blend's own speed
lands on top of the swing's. Widening the window (tried in memory, src/sim untouched):

| inStart / blendIn | knob p50 per frame, frames 1-11 (cm) | knob peak p90 | bat turn peak p90 |
|---|---|---|---|
| 0.45 / 0.75 (now) | 6 12 13 9 10 24 11 6 7 8 7 | 28 cm | 42 deg |
| 0.30 / 0.80 | 6 12 13 11 14 14 8 5 7 8 7 | 17 cm | 39 deg (frame 6: 22) |
| 0.35 / 0.85 | | 18 cm | |
| 0.20 / 0.85 | | 15 cm | |

A sim thread should take 0.30 / 0.80 (or bring the two paths closer before u 0.45), then re-check the league line and the contact plane:
blendIn > 0.75 eats into the pure-plane stretch before contact. The sim's first swing frames also run ~2 frames behind the clip's hands
(the engine eases the bat over 70 ms to hide it); starting CLIP_SWING where the engine shows it would remove that ease.

### The swing -> stance blend

The +2 frame regressions (elbow in the trunk, fist axis) are the game's crossfade from the swing finish to the stance (`jank:check`
fades --constrain: crossfade fist axis 15 / elbow 26 frames across bodies; forced inertialization 14 / 20 but foot slide 6 -> 13 and grip 2 -> 5).
Neither is a clear win; left as is (a per-transition switch for two frames is not worth it).

## The knob's blend into the plane, smoothed (thread t-0030)

The jump t-0029 found ~6 frames in is gone. `BatSwing.at` no longer lerps the knob from the early path to the plane path over a 2.8-frame
smoothstep. The knob now leaves the early path at u = `SWING.inStart` **0.20** on a cubic (Hermite) that starts at the early path's knob
with its velocity and ends at the plane's knob at `blendIn` **0.80** with the plane's velocity. Its speed has no step at either end and the
~50 cm between the two paths is spread over ~5.6 frames at an even pace. The bat's direction keeps its slerp but from `turnStart`
**0.30** to 0.80. The plan is untouched (`buildSwing` draws the same random numbers in the same order), the pose's velocity is still its
central difference (contact is the collision of the bat as drawn), and the hitting zone is pure plane from 0.80 (0.06 % of contacts come
before u 0.80, 0.34 % before 0.85). `tools/swing/steps.ts` measures it; `batbody.test.ts` holds it (knob speed step < 12 cm, travel
< 20 cm, turn over the plane's own < 15 deg per frame before contact, worst of 60 swings; main's windows fail it: a 20 cm speed step).

### Frame to frame (the sim alone, 762 swings, seed 7 games 0-5, 60 Hz; p50 / p95)

| frame (u) | knob speed step cm, main | after | knob travel cm, main | after | bat turn deg, main | after | turn over the plane's own, main | after |
|---|---|---|---|---|---|---|---|---|
| 4 (0.43) | 4.7 / 5.1 | 6.7 / 8.0 | 8.5 / 9.1 | 11.5 / 14.0 | 10.8 / 10.8 | 9.1 / 11.5 | 2.8 / 3.5 | 1.1 / 3.9 |
| 5 (0.54) | 12.0 / 14.3 | 3.2 / 3.7 | 10.2 / 12.7 | 12.3 / 15.5 | 13.9 / 15.9 | 21.6 / 25.0 | 2.0 / 4.1 | 9.8 / 12.9 |
| **6 (0.65)** | **14.0 / 17.9** | **1.7 / 2.0** | **23.5 / 29.9** | **10.7 / 13.6** | **36.8 / 42.9** | **22.3 / 26.7** | **20.4 / 26.3** | **5.8 / 9.9** |
| 7 (0.75) | 12.7 / 15.7 | 4.7 / 6.0 | 11.0 / 14.6 | 6.6 / 8.4 | 20.6 / 25.2 | 18.4 / 22.1 | -0.8 / 3.5 | -2.9 / 0.5 |
| 8 (0.86) | 13.4 / 17.1 | 6.6 / 8.4 | 5.6 / 6.0 | 5.3 / 5.8 | 26.9 / 29.2 | 25.5 / 27.6 | 0 / 0 | -1.5 / -0.8 |
| peak before contact, per swing | 14.0 / 17.9 | 6.9 / 8.4 | 23.5 / 29.9 | 12.6 / 15.5 | 36.8 / 42.9 | 25.6 / 28.0 | 20.4 / 26.3 | 12.7 / 13.0 |

Against the brief's targets (p95, 60 Hz, in swings):
- **Knob: no jump** (its speed step 17.9 -> 8.4 cm). Its travel per frame is 15.5 cm at most, above the ~12 asked: that is the hands
  moving steadily at up to ~9 m/s over frames 3-6, not a jump. The two paths are ~50 cm apart and contact needs the knob on the plane by
  0.80; a slower pace would need the knob to leave the clip's path earlier, and earlier than 0.20 costs the top hand its range at
  frames 2-3 (below).
- **Bat turn: 26.7 deg** at frame 6 (was 42.9), at the ~25 asked. From frame 8 on the bat turns 27-40 deg a frame on any path: that is
  the pure plane at the planned bat speed (omegaC ~38 rad/s at contact), the bat's real speed, not a jump. Its turn on top of the plane's
  own peaks at 13 deg (frames 2-3 and 5: the clip's own turn early, then the slerp).

### Which window: the top hand's range

The game's top hand (armIK, tracked) runs out of range wherever the bat's direction leaves what it can hold, and there the IK rolls it on
the handle (flip / spike:RightHand). The proxy per frame (`tools/swing/perframe.ts`, the engine as it is since t-0026; top fist past its
range, p50 / p90 deg):

| | k 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| main | 10/10 | 0/0 | 0/0 | 0/0 | 16/28 | 36/51 | 10/17 |
| knob 0.10, turn 0.30 (first try) | 15/16 | 12/19 | 0/2 | 8/37 | 32/57 | 37/52 | 10/20 |
| knob 0.20, turn 0.30 (shipped) | 10/10 | 0/1 | 0/0 | 0/5 | 26/45 | 32/50 | 7/20 |
| knob 0.20, turn 0.40 | 10/10 | 0/1 | 0/0 | 0/0 | 34/50 | 48/63 | 20/31 |

Leaving the clip's path at 0.10 smoothed the knob most (speed step 6.2 cm p95) but pushed the top hand out of range at frames 3-5: in the
game its flips and spikes moved to s+3..s+5 and rose (hand / forearm flips 196 -> 155, but arm flips 60 -> 125, spikes 587 -> 725). A
later turn (0.40, 0.45) brings the frame-6 turn back (32-35 deg p95). Frames 6-7 are out of the top hand's range on every path tried,
main included: that is this body's arm on these bat directions (an engine / asset limit), not something the blend can remove.

### The real game (tools/jank game sweep, seeds 1-3, 5 innings, two runs each from detached worktrees; share of the sim swing's frames)

| | main a | main b | after a | after b | first try (knob 0.10) a | t-0026 merge f81cc42 |
|---|---|---|---|---|---|---|
| swing frames | 2489 | 2492 | 2506 | 2504 | 2501 | 2506 |
| fists off the handle (L / R) | 8.5 % (8.3 / 0.2) | 8.5 % (8.3 / 0.2) | 8.7 % (8.4 / 0.3) | 8.6 % (8.3 / 0.4) | 9.7 % (8.4 / 1.3) | 9.6 % |
| fist turned against the bat, frames (bottom L / top R) | 611 (392 / 219) | 623 (405 / 218) | 309 (131 / 178) | 312 (142 / 170) | 346 (115 / 231) | |
| fist turned against the bat | 24.5 % | 25.0 % | **12.3 %** | **12.5 %** | 13.8 % | |
| wrong hand at the knob | 0.0 % | 0.0 % | 0.0 % | 0.0 % | 0.0 % | 0.0 % |
| top forearm past +-100 | 93.4 % | 92.9 % | 92.6 % | 92.9 % | 93.2 % | 92.8 % |
| bottom forearm past +-100 | 8.8 % | 8.8 % | 9.7 % | 9.7 % | 10.2 % | 8.4 % |
| hand / forearm flips (LH / RH / LF / RF) | 206 (0/131/35/40) | 187 (0/114/29/44) | **89 (0/82/3/4)** | **89 (0/79/4/6)** | 155 (1/150/1/3) | 170 (1/107/22/40) |
| upper-arm flips | 61 | 60 | **32** | **26** | 127 | 47 |
| speed spikes | 598 | 576 | 601 | 611 | 725 | 587 |
| wrist split | 1 | 1 | 7 | 5 | 8 | 0 |
| elbow in the trunk | 26 | 29 | 25 | 28 | 31 | 33 |
| barrel in the body | 42 | 39 | 41 | 38 | 42 | 39 |

Whole game: severity 19235 -> 19269 (0 %); no other role or clip moved. Where the top hand's trouble sits (a batter trace, seed 1,
100-1300 s, 35 swings each; frames from the swing hint's first):

| | flip:RightHand | flip:RightArm | flip:Fore (L+R) | spike:RightHand | spike:RightArm |
|---|---|---|---|---|---|
| main | 23 (s+5..s+8) | 10 | 12 | 91 (s+4..s+8) | 12 |
| first try | 31 (s+4..s+5) | 27 (s+4, s+5) | 6 | 86 (s+3..s+8) | 31 (s+3, s+4) |
| shipped | 13 (s+4..s+7) | 5 | 3 | 89 (s+3..s+8) | 11 |

The flips at s+5..s+8 halve; the top hand's speed spikes stay (~90 in 35 swings, s+3..s+8): through those frames the bat turns ~20-30 deg a
frame against the drawn body's shoulders and the hand follows it, faster than the validator's cap for a wrist, on every path. Wrist split (a forearm /
hand twist not shared) rose 1 -> 6 frames, bottom forearm range frames 8.8 -> 9.7 %: small, left.

**The speed spikes since t-0026 (21.9 -> 24.9 %): game length, not a regression.** The t-0026 merge swept like main (5 innings) reads
587 spikes in 2506 swing frames, 23.4 %; main reads 24.0 and 23.1 %. t-0026's 21.9 % was a 9-inning sweep (other innings, other
batters); t-0029 compared it with 5-inning runs.

### The league line (200 games, seed 7; tools/swing/run.ts)

R/G 4.28 -> 4.28, AVG / OBP / SLG .243 / .320 / .416 -> .243 / .320 / .415, K 23.3 -> 23.3 %, BB 8.9 -> 8.9 %, HR/PA 3.16 -> 3.14 %
(482 -> 479 HR in 15276 PA), HR/FB 19.9 -> 19.8 %, BABIP .293 -> .293, whiff / foul per swing 28.2 / 30.9 -> 28.3 / 30.8 %. EV mean
80.80 -> 80.82 (p10 / p50 / p90 59.7 / 82.4 / 100.1 both), LA mean 8.6 -> 8.6 (p10 / p50 / p90 -45.4 / 10.1 / 60.6 -> 60.7), GB / LD /
FB / PU 49.9 / 12.7 / 20.2 / 17.2 % both. The first 60 games of the set play out identically for every variant tried; the rest drift only where a
late swing's contact (u < 0.80) changed. At the planned contact instant everything is identical: attack angle 7.0 / 15.0 / 23.2, bat elevation -28.9 / -16.5
/ -4.4, plane tilt 13.3 / 23.4 / 34.7, hands 4.3 / 4.7 / 5.1 m/s. No calibration knob needed a nudge. No seed-pinned test moved.

### Seeing it

`tools/swing/film.ts` films a swing in the real build: seed 24, broadcast tempo, fixed 1/480 s steps (16x slow at 30 fps), a fixed bench
camera, replays off (harness knobs). One engine frame per picture and one view per run: the engine's per-frame logic (the arms' tracked
solve, the grip's three-frame turn) counts frames, so a second render of the same instant is not a still. Before / after frames are
matched by the drawn instant (the sim's last step plus the driver's accumulator).
