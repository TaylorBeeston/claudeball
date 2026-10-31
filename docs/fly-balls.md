# Fly balls: calling for it, and routine catches that are not jumps

Taylor (2026-10): "I'd like to see players call for a fly ball before they catch it, they always seem to jump up to catch even routine fly balls."

## Why every catch was a hop

The sim takes a ball in the air the first tick it falls inside a fielder's reach column: `fieldingAttempts` fires once the ball is within
1.15 m across the ground and below `reachV` (2.45 m, 2.75 m on the run); `computeIntercept` and `meetPoint` likewise pick the first sample
under 2.55-2.7 m. So every air catch the sim reports is at the top of what a man can reach standing:

| catch (sim, seeds 1-4, tempo quick) | n | glove height p10 / p50 / p90 (m) |
|---|---|---|
| fly ball, `catch_fly` | 41 | 2.42 / 2.47 / 2.49 |
| line drive, `catch_line_drive` | 13 | 2.46 / 2.49 / 2.50 |

(`npx tsx tools/fly/catches.ts 4 n quick`). The engine's reach IK put the pocket there, and `reachStep` lifts the whole body when the glove
point is above the arm's reach ("a hop", capped at 0.45 m): every routine fly was caught with the body 0.45 m off the ground for ~0.5 s.

## The fix (engine only for the catch)

Moving the sim's attempt lower would move every catch by a few ticks, shift tag-ups and could change who takes a ball two men converge on.
Instead the engine draws the catch where a settled fielder really takes it (`src/engine/flyCatch.ts`):

- `routineGlove`: the sim's glove point moved down the ball's own line (its velocity at the arrival) to `comfortGloveY` (the pocket in front of
  the forehead: 0.818 x height + 0.36 m), at most 0.75 m down and 0.45 m sideways. A fly ball falls 0.3-0.5 m per frame at the end, so this
  is the same catch a frame later to the eye; the held ball settles into the pocket from the sim's ball position (`updateHeldBall`).
  A ball coming in flat (a line drive) cannot move down its line without passing him: it stays where the sim caught it, a stretch or a leap.
- The point is latched for the last 0.12 s: in its last ticks the sim's target is the ball's next position timed by the gap across the
  ground, which a ball dropping straight onto him has already closed, so the target jumps to the ball a metre over his head.
- `reachStep` only hops for a fly ball whose glove point is still more than 0.25 m above the comfortable height (a high liner); throws
  and tags keep the old rule.
- A leap comes down once the ball is in the glove (no hop in the held phase): it used to hang 0.45 m up for another 0.5 s.
- Wall leaps (`catch_jump`, `F.leap`) are untouched.
- The broadcast tracer ends at the ball in the glove (`BallView.caught` / `holding`): its last point follows the held ball into the pocket
  instead of stopping where the sim met the ball, up to 0.75 m above the glove now.

## Calling for it

- Sim, observer only: `callForBall` (fielding.ts, from `defenseAI`) emits `callForBall { fielderId, pos, eta }` once a play, when the same
  primary has been taking the ball for 0.25 s, his intercept is in the air with 0.6 s to spare, the ball is 1-2.5 s from his glove, and it
  is not a line drive or a wall play (`CALL_FOR`). `play.called` is read by nothing in the play; the snapshot reports `calling` (seconds
  since the call). `tools/fly/digest.ts` hashes every other event of a seeded game: identical before and after on seeds 1-4.
- Engine: `callWave` raises the throwing arm over the head and waves it for ~1 s after the call (arm IK, the existing solver), down before
  the catch clip starts; from 1.3 s before the catch the glove comes up toward the catch point ("settle"). The settle is the arm alone (no
  lunge, no hop: the body used to slide up to 0.58 m on planted feet) and the glove stays in front of his face when the ball comes down
  behind him (a pitcher still facing the plate reached back over his shoulder). A calling fielder is a key puppet for the wave's 1.5 s
  (the simplified far-LOD path skips IK).
- Director: `call_for_ball` (engine event) cuts from the follow shot to the fielder shot as he calls, and the catch keeps that shot (no
  re-cut): in the wide follow shot a centre fielder is a few pixels tall and the call could not be seen. Played through at 1x (seed 2,
  tempo quick): call 960.92, cut to the fielder 960.93, catch 963.36, wide 965.59.
- Audio: `fielder_call`, a synthesized three-syllable shout (synth.ts, the `choir` formant voice), played at the fielder like any field
  sound (cues.ts). The booth says nothing about it (`SILENT_EVENTS`).
- Non-primary fielders already peel off in the sim (cover / backup / back to position as soon as another man is the primary).

## Measured (same seed, sim time and camera; the prod build stepped at 1/60 s, a fixed side camera following the fielder)

| catch | before: peak lift / time off the ground | after | pocket at the catch (after) |
|---|---|---|---|
| CF, LF, RF routine flies | 0.45 m / 0.78 s | 0 / 0 | 1.79-1.97 m |
| P, C, 1B pop-ups | 0.45 m / 0.78-1.40 s | 0 / 0 | 1.83-1.94 m |
| RF high liner on the run (2.68 m) | 0.45 m / 0.50 s | 0.44 m / 0.28 s | 2.36 m |
| 2B flare on the run (2.6 m) | 0.45 m / 1.08 s | 0.45 m / 0.55 s | 2.22 m |
| LF wall leap | 0.45 m / 0.58 s | unchanged | 2.19 m |

Head roll (jank trace, +-1 s around the catch): max 25.2 / 21.9 / 25.1 / 25.1 deg -> 10.3 / 7.4 / 7.6 / 2.5 deg (CF, LF, 1B pop-up, P pop-up),
frames over 20 deg 3 / 1 / 6 / 19 -> 0; `foot:float` 39-84 frames -> 0 on all four. Calls (seeds 1-4): 41, every caller made the catch;
3 air catches had none (two on the run, one wall leap).

Left over then, both older than this and only visible once the feet stayed down: right after a catch the body yaw swung 0.9-1.7 rad out
and back in 0.3 s, and the catch clip's lunge slid the body up to 0.5 m. Both are fixed below (t-0039).

## Turning on the feet: after the catch, the reach, the pivot into the throw (t-0039)

Engine only; the sim's event stream is unchanged (`tools/fly/digest.ts --seeds 1-4`: the same four hashes before and after).

- **The spin after the catch** was the sim's facing: it turns a player toward his velocity whenever he moves faster than 0.8 m/s
  (movement.ts), and the last adjustment under a ball is a 0.9-1.4 m/s shuffle for a tenth of a second. The facing swung toward it at 14 rad/s
  and back toward the ball at 9 rad/s, and the body followed at its 9.4 rad/s cap. `catchYaw.ts`: while he takes or holds a ball (a catch or
  fielding clip, the transfer, settled under a fly he has called; not a catcher taking pitches), the body keeps its heading and takes the
  sim's facing only once it has settled (turning under 1.5 rad/s for 0.1 s) and never in the 0.8-2 m/s shuffle speeds; it turns there at 5 rad/s.
- **The lunge** fed itself: `reachStep` measured the shoulder on the unshifted body (the root is put back on the sim's position every frame
  before it runs) and took this frame's shift off it once more, so every lunge ran to its cap (0.8 m toward a ball 0.1 m from him) and every
  hop to 0.45 m. Fixed; the horizontal shift moves at 2.4 m/s (a tag's dive 4.5 m/s), not 5-16 m/s; no lunge or hop once the ball is in the
  glove; a catcher's lunge for a pitch is at most 0.12 m. A grounder or comebacker taken above the shoulders (a high hop at 2.5 m) uses the
  reach-up clip (`catch_throw_high`), not the ground scoop that put it 0.7 m out of reach.
- **Turning on the feet** (`pose/footLock.ts`): a planted foot keeps its own heading while the body turns quickly over it (it gives way at
  1 rad/s, so slow turns turn it with the shin as before; only on a fairly straight leg, never for umpires or catchers), up to `maxTurn` (15 deg);
  past that, with the other foot in its step and the body not travelling, it pivots on its ball (heel up 4.5 cm, ball kept) instead of being
  dragged round. A step the body forces (it turned or carried the foot away) leaves from where the foot stood, lifts first and sets down last,
  at least 5 cm clear on a straight leg. A foot still in the body's own frame counts as landing while the body turns on the spot (it never
  locked in a turn before: the turning body carried both feet round at ~2 m/s).
- **The throw** after a catch: the sim snaps the facing to the receiver at the decision and releases 0.07-0.13 s later (`throwWindup`), so the
  turn itself is fast and the feet do the work above. The clip used to stop 3-4 frames into the throw: at the release the sim's hint moves on
  (for an infielder often to a catch it arms on his own throw on its way out of his hand, the ball passing within his reach) and a static
  ready pose slid along at 1-3 m/s. The throw's follow-through now plays out; a catch hint with no ball coming while he travels over 1.6 m/s
  is a gait.
- **Gait flicker**: a fielder creeping under a fly ball moves 0.15 -> 0.5 -> 0.15 m/s every 0.1 s, and his clip flipped walk <-> ready every
  few frames (6-9 m/s foot slides before every routine catch). A gait (and the creep's walk) lets go only when the ~0.1 s average has dropped.

Measured (`tools/fly/plays.sh`: seed 2, tempo quick, the prod build stepped at 1/60 s with the jank probe on the fielder; windows from the play's
own events; full tables in the t-0039 library):

| play | skate frames: reach / after the catch / pivot | out-and-back yaw after the catch (rad) | peak body yaw rate after the catch (rad/s) | lunge max (m) / its speed (m/s) |
|---|---|---|---|---|
| cf | 2 / 5 / 1 -> 4 / 0 / 1 | 0.34 -> 0.00 | 9.0 -> 0.7 | 0.07 / 1.3 -> 0.05 / 0.7 |
| lf | 9 / 11 / 2 -> 4 / 0 / 0 | 0.47 -> 0.00 | 9.4 -> 1.4 | 0.56 / 5.9 -> 0.22 / 2.5 |
| rf | 5 / 2 / 8 -> 4 / 0 / 2 | 0.04 -> 0.03 | 9.0 -> 9.0 | 0.07 / 1.0 -> 0.06 / 1.1 |
| pop-1b | 13 / 8 / 1 -> 4 / 0 / 1 | 0.45 -> 0.00 | 9.0 -> 3.2 | 0.45 / 5.7 -> 0.11 / 1.9 |
| pop-p | 2 / 17 / - -> 2 / 4 / - | 0.09 -> 0.03 | 9.4 -> 9.4 | 0.08 / 1.5 -> 0.04 / 0.1 |
| gb-3b-set | 0 / 6 / 15 -> 0 / 0 / 8 | 0.96 -> 0.00 | 9.0 -> 9.4 | 0.80 / 9.9 -> 0.26 / 2.3 |
| gb-ss-run | 30 / 24 / 6 -> 30 / 5 / 0 | 0.09 -> 0.09 | 1.8 -> 1.8 | 0.88 / 5.6 -> 0.87 / 2.5 |
| gb-3b-run | 6 / 17 / 11 -> 6 / 10 / 0 | 0.16 -> 0.00 | 9.4 -> 9.4 | 0.89 / 5.4 -> 0.81 / 2.5 |
| gb-p | 0 / 1 / 18 -> 0 / 14 / 3 | 1.06 -> 0.12 | 9.4 -> 9.4 | 0.79 / 15.9 -> 0.77 / 2.4 |
| liner-cf-throw | 4 / 21 / 2 -> 0 / 0 / 6 | 0.02 -> 0.02 | 9.0 -> 5.0 | 0.49 / 9.7 -> 0.08 / 2.5 |

(Peak yaw rates of 9 rad/s after the catch left on RF, the pop-ups and the grounders are a walk or run off after it, a gait turning with the
runner. Worse: `gb-p`, the pitcher's comebacker, 1 -> 14 skate frames after the catch (he turns from the ready-for-the-ball heading as he
moves off). `gb-ss-run` keeps 30 in the reach: fielding on the run, below. t-0035's leaps still leap: wall leap 0.45 m (unchanged), 2B flare
on the run 0.45 -> 0.43 m, RF high liner 0.44 -> 0.26 m: the hop is now the ball's real height over his reach, not the old cap.)

Game sweep (`tools/jank/run.ts game --seeds 2 --tempo quick --innings 4`, before vs after, per 1000 on-screen puppet frames): `foot:skate` 70 ->
39 (-44 %), `foot:slide` 110 -> 95 (-14 %), `foot:float` 3.0 -> 1.9, total severity -14 %. Up: `joint:ankle.swing` 61 -> 66 (+9 %), nearly
all a catcher's right ankle in his crouch (3.9k -> 7.1k frames, mostly 5-15 deg over); not from the heading hold, the pivot, the pitch lunge or
the catchYaw hold (each switched off in turn): open.

## Tools

```
npx tsx tools/fly/catches.ts 4 n quick [--rows]          # air catches: height, clip, speed; calls vs catches
npx tsx tools/fly/digest.ts --seeds 1-4                    # event-stream hashes (the call event left out): must not change
npx tsx tools/fly/film.ts --seed 2 --at 963.37 --id DUL-away-b7 --name cf --out tools/fly/out/x [--view director]   # a catch on film + lift per frame
tools/fly/plays.sh tools/fly/out/<dir>                     # t-0039's ten plays: feet and body yaw around the catch, the turn and the throw (turn.ts)
npx tsx tools/fly/turn.ts --analyze tools/fly/out/<dir>    # the table again from a saved run
npx tsx tools/fly/rows.ts tools/fly/out/<dir>/lf.json -0.6 1.6   # one play frame by frame (clip, facing, yaw, speed, lunge, locks, glove, violations)
npx tsx tools/fly/grounders.ts 1 n quick 2                 # ground balls fielded and the throw after (sim only)
```

## Not done

- No diving catch: there is no dive clip (asset batch). No dedicated "call" clip either: the wave is procedural.
- Fielding a grounder on the run (7-8 m/s) plays the standing scoop clip while the body travels: its feet skate (30 frames in the reach of
  `gb-ss-run`). Needs a running fielding clip (asset batch) or a gait blend under it.
- The thrower's own throw arms a catch for him in the sim (`updateGloveTargets`: the ball is within reach as it leaves his hand); the engine
  ignores it now, the sim still sets the hint (a sim thread could skip the thrower for a few ticks; check the digest).
