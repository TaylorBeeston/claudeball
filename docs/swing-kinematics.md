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
