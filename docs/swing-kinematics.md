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
- **Then a real swing plane.** Between 0.45 and 0.75 tauC the bat drops into a plane that holds the bat at contact and the sweet spot's
  heading (rising at the attack angle). On it the barrel lies back toward the catcher a little below the hands, comes round under them
  through the zone and rises into the follow-through, which wraps toward the clip's finish over the lead shoulder. The hitting zone
  (0.75-1.3 tauC) is pure plane.
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
