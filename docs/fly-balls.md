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
- Wall leaps (`catch_jump`, `F.leap`) are untouched.

## Calling for it

- Sim, observer only: `callForBall` (fielding.ts, from `defenseAI`) emits `callForBall { fielderId, pos, eta }` once a play, when the same
  primary has been taking the ball for 0.25 s, his intercept is in the air with 0.6 s to spare, the ball is 1-2.5 s from his glove, and it
  is not a line drive or a wall play (`CALL_FOR`). `play.called` is read by nothing in the play; the snapshot reports `calling` (seconds
  since the call). `tools/fly/digest.ts` hashes every other event of a seeded game: identical before and after on seeds 1-4.
- Engine: `callWave` raises the throwing arm over the head and waves it for ~1 s after the call (arm IK, the existing solver), down before
  the catch clip starts; from 1.3 s before the catch the glove comes up toward the catch point ("settle").
- Audio: `fielder_call`, a synthesized three-syllable shout (synth.ts, the `choir` formant voice), played at the fielder like any field
  sound (cues.ts). The booth says nothing about it (`SILENT_EVENTS`).
- Non-primary fielders already peel off in the sim (cover / backup / back to position as soon as another man is the primary).

## Tools

```
npx tsx tools/fly/catches.ts 4 n quick [--rows]          # air catches: height, clip, speed; calls vs catches
npx tsx tools/fly/digest.ts --seeds 1-4                    # event-stream hashes (the call event left out): must not change
npx tsx tools/fly/film.ts --seed 2 --at 963.37 --id DUL-away-b7 --name cf --out tools/fly/out/x   # a catch on film + lift per frame
```

## Not done

- No diving catch: there is no dive clip (asset batch). No dedicated "call" clip either: the wave is procedural.
