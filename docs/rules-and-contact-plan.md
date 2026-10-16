# Rules and contact (realism pass, phase A): plan

Thread t-0021. Two problems the user saw: a runner passed first base with no foot on it, and fielders and runners pass
through each other. Everything below is simulated state (positions, feet, bodies) and rules applied to it: no outcome
is chosen anywhere.

## 1. Touch every base

**What is wrong today.** The sim counts a base as touched when the runner's body centre comes within 0.9 m of the bag's
centre (`tagging.touchesBag`). The bag is 0.38 m square, so a runner can "touch" it with his body 0.9 m away and both
feet off it. The engine plays the run cycle at a speed-matched rate, but its foot plants fall wherever the cycle happens
to be, so nothing puts a foot on the bag either.

**Sim (`src/sim/stride.ts`, new; `running.ts`, `tagging.ts`):**
- Every player on the field gets a stride state: which foot lands next, the phase through the current step, and the
  step length. The natural step length comes from his ground speed and matches the shipped gait clips (walk 0.53 m,
  trot 0.83, jog 1.31, run 1.67, sprint 1.90; from `player_manifest.json` `distance_per_cycle_m / 2`).
- Each footstrike has a position: the body centre plus the foot's forward and side offset at touchdown.
- **Touches are footstrikes on the bag.** A base counts as touched when a footstrike lands on it (the bag square plus the
  shoe's half-width; home plate is its pentagon), or when a slide's leading foot or hand reaches it. The body centre
  passing near the bag no longer counts.
- **Runners aim their feet.** A runner who has to touch a bag (to stop on it, to run through first, to round it) plans
  his last steps the way real runners do: from about four steps out he stretches or shortens his steps, within 0.8x to
  1.2x of his natural length, so a footstrike lands on the touch point. The touch point is the bag's front edge when
  running through first, the inside corner when rounding (the runner's left foot side), and the middle when stopping.
  Rounding paths aim at the inside corner instead of the bag's centre.
- **Missed bags.** A runner who goes past a bag with no footstrike on it has missed it. Whether he feels it is
  perception (how far off his foot was, and his baserunning rating). If he knows, he goes back for it (his target is
  still that bag). If he does not, he carries on, his base advances, and the base is flagged missed on the runner.
- **Appeals.** A fielder near the bag who was watching may see the miss (distance, facing, `iq`). The defense decides
  whether to appeal through the decision provider (`appeal`, AI by default). After the play the ball goes to the
  baseman, who steps on the bag, and that base's umpire calls the runner out (`appeal` event, an `out` with outType
  `appeal`, booth line, caption, ticker). Runs follow rule 5.08(a): a run by the runner who missed is taken off; if the
  appeal is the third out, runs by the runners behind him on that play come off too, and all runs come off when he was
  forced (batter-runner missing first). A miss nobody appeals stays safe.
- **Placement snaps.** The batter set into the box and runners set onto bags at the end of a play (6 to 35 cm in one
  tick today) walk there with the stride model. Nobody is teleported while the game is rendered (`pace > 0`).

- **Slides.** Measured from the shipped clips (`tools/contact/clipfeet.ts`): the slide clips carry root motion (the
  hips travel 1.6 m forward, the leading toe ends 2.4 m ahead of the root) on top of the sim moving the runner, and the
  sim's limb lengths do not match them (head-first hands 0.86 m ahead of the hips, not 1.25; hook foot 0.72, not 0.95).
  The sim takes the limb reach from the clips, slides the body with dirt friction so it stops with the leading foot or
  hand on the bag, and touches only when that limb reaches the bag.

**Engine (`gltfCharacter.ts`, `realSimAdapter.ts`), one small module:**
- The snapshot carries each player's stride (`foot`, `phase`). Locomotion clips are phase-locked to it: their contact
  frames, measured from each clip at load (like `stanceFootSpeed`), are put on the sim's footstrikes. The foot you see
  on the bag is the footstrike the sim counted. Phase B2 (stride warping, foot locking) supersedes this.
- Slide and dive clips play without their forward root motion (the sim moves the body).

**Validator (`tools/contact/bases.ts`, also a unit test over fewer games):** over N seeded games it lists every time a
runner's body passes over a bag with no footstrike on it, every `baseTouch` without a foot (or slide limb) on the bag,
and the distance from the foot to the bag at each touch. Run before and after.

## 2. Bodies and collisions

**Sim (`src/sim/bodies.ts`, new):**
- Every person on the field is a body: fielders, the batter, runners, umpires, base coaches and ball kids. Upright, a
  vertical capsule (radius about 0.25 m, from the player's build); sliding, a capsule from the hips to the leading
  foot or hand.
- **Steering.** A mover looks ahead along his path; when someone will be in the way within about a second he steers
  around them. Who gives way follows baseball: umpires and coaches always do; a fielder going to cover, back up or
  return gives way to a runner; a runner gives way to a fielder fielding a batted ball; a fielder chasing the ball
  or taking a throw does not give way.
- **Separation.** After everyone has moved, overlapping bodies are pushed apart by mass, and the speed with which they
  close on each other is taken out (an inelastic contact). A hard contact is a `collision` event.
- **Covering a bag.** A fielder taking a throw at a bag stands at its side with a foot on it, out of the runner's lane:
  inside of first, the throw side of second and third, in front of the plate in fair ground for the catcher. Only the
  fielder whose base it is covers it (seed 3: the 2B and the SS both went to second on a steal and stood inside each
  other).

**Rules:**
- **Obstruction** (6.01(h)): a fielder without the ball and not fielding it who blocks or slows a runner. If a play
  is being made on that runner, the ball is dead and he gets one base past his last; otherwise play goes on and after
  it he is given the base he was running to (an out made on him short of it is taken back).
- **Runner interference** (6.01(a)(10)): a runner who runs into a fielder fielding a batted ball is out, the ball is
  dead, the batter gets first and the other runners go back.
- **Out of the baseline** (5.09(b)(1)): a runner more than 3 ft off his line to the base while avoiding a tag is out.
- **Blocking the bag / plate** (6.01(i)): a fielder without the ball blocking the runner's way to the bag is
  obstruction; with the ball he may block. The tag is made with the bodies in contact (the tagger is never inside the
  runner).
- Each call comes with an umpire signal and an event the booth, ticker and captions use.

**Engine:** puppets follow the sim's positions, so they stop overlapping with it. Umpires and coaches already follow
their sim positions. There are no brace, dodge or stumble clips, so no new hints in this branch (the IK thread adds
the contact response).

## 3. Measuring (before any sim change, then after)

`tools/contact/overlaps.ts` plays 100+ seeded games headless and counts, per pair type (fielder/fielder,
fielder/runner, runner/umpire...), the ticks and distinct episodes with two bodies closer than 20, 35 and 50 cm. Before
and after are in the report, with the league stats (baseline about 4.55 R/G, .239 AVG, K 23.2%, BB 9.0%).

Regression: seed 3 (broadcast, 9 innings), the steal of second at 1225.5 s: the runner's slide reaches the bag and no
two bodies overlap there.

## Results (t-0021, merged tree a79beed)

- Base touches (100 games, `tools/contact/bases.ts`): touches without a foot or slide limb on the bag 0.1% (before: 13% where no foot
  could reach the bag; home plate credited 46-97 cm away). Missed bags 0.22 a game (near misses of 7-16 cm), a fifth of them seen and appealable.
- In the game (cbv, seed 2 and seed 3 steals): at the frame the sim counts the touch the drawn toe is 0-1 cm from the bag (upright) and on it
  (hook slide); the drawn ankle lands a median 2-3 cm from the sim's footstrike.
- Bodies (100 games, `tools/contact/overlaps.ts`): pairs under 35 cm, 1,162 episodes per 100 games (before 32,593), under 20 cm 549 (before 20,710).
- Rules (60 games): obstruction ~0.17 a game, runner interference ~0, out of the baseline ~0.02.
- Stats (200 games): 4.30 R/G (baseline 4.58), .242 AVG, K 23.8%, BB 9.0%, SB 0.34 / CS 0.07 per team-game. The batting line holds; runs
  are lower from baserunning: a foot has to reach the bag, covering fielders set beside it get the lead runner more often (forces at third
  and home doubled). The runner AI's reads were recalibrated to keep the bias it was tuned with.
