# `src/sim` — baseball simulation core

Pure TypeScript, no DOM / three.js / rendering dependencies. Runs in the browser and in Node
(tests, headless season sims). Everything that happens on the field **emerges from simulated
mechanics and decisions** — there are no outcome tables and no "roll for a single":

| Layer | What is simulated |
|---|---|
| Pitch | pitcher ratings → release point, speed, spin vector → RK4 flight with gravity, drag and Magnus force → plate crossing. Command error is Gaussian noise on the release direction *after* the pitcher's internal aim solver (so a bad release really misses). Fatigue slows the pitch and widens the error. |
| Umpire | called strike/ball from the pitch's true location + umpire noise, per-game zone bias and catcher framing. |
| Batter | perceives the pitch (noisy, extrapolated from the first half of the flight), decides swing/take from count + discipline, plans a swing (timing, plane, hand extension), swings a rigid bat (rotation about the body axis with an attack angle; the hands are kept within arm's reach of the batter's shoulders, `ARM_REACH`) and collides with the ball (sphere–capsule, effective bat mass at the contact point, COR falling off the sweet spot, Coulomb friction → spin). Exit velocity, launch angle, spray angle, foul/fair, whiffs all fall out of geometry and timing. |
| Batted ball | RK4 flight (drag + Magnus), bouncing on grass/dirt with friction & spin & surface irregularity, rolling, outfield wall (configurable shape, wall ricochets, home runs, ground-rule doubles, foul territory). |
| Defense | each fielder has position, sprint speed, first-step reaction and a *trajectory-judgement error* that shrinks as the ball comes down. Fielders solve interception against the predicted ball path, one is "called" primary, others cover bases / back up / cut off. Catch, bobble and drop come from glove-position noise vs. the ball's speed and how stretched the fielder is. The man with the ball weighs runner arrival times against throw times (force, tag, relay via cut-off man, hold), waits for the base coverer, and throws with real flight time and accuracy noise. |
| Baserunning | runners lead off, steal (own time vs. pitcher/catcher estimate), tag up on likely catches, read the ball and the fielders (positions, arm strength, outs, score, runners ahead) to take extra bases or retreat. The batter-runner runs *through* first (overrun, then turns for second or jogs back to the bag), runners round bags on a curved path (`run_turn`), slide when a play is on, and can never pass or share a base. Outs are tags, force outs and appeals decided by who is at the base first; a runner put out still finishes his run and walks off. |
| Wall | the outfield fence is a solid boundary for players (they cannot run through it) and for the ball (it caroms off the straight wall segments with panel roughness the fielders' predictions don't know about). An outfielder tracking a ball that will meet the wall above his standing reach runs to the fence, plants, and may leave the ground (`catch_jump`): the glove reaches over the wall as far as his jump takes it, so a would-be home run within reach can be *robbed*, one above it is a home run. |
| Home run | the ball is dead but the play is not: the batter and every runner really trot around the bases (~22 s), touching each one (`baseTouch` events), the batter celebrates at the plate (`celebrate`), and the next batter comes up only after the last runner has scored. |
| Game | full rules (plus bunts — sacrifice and for-a-hit, decided from situation and batter and played through the same bat–ball collision with a still, soft-handed bat — intentional walks and balks): count, walks, HBP, strikeouts (incl. dropped third strike), wild pitches, passed balls, pickoffs, force vs tag, infield fly, tag-ups, third-out run nullification, walk-offs, extra innings (ghost runner), DH/no-DH, pinch hitters/runners, bullpen management. |

Randomness is *only* physical noise (release variation, swing timing, reaction jitter, bounce
irregularity, glove offset…) from a seeded PRNG (`sfc32`). **Same seed + same teams ⇒ identical
game**, independent of how the caller slices `step()` calls.

## Quick start

```ts
import { createGame } from './sim';

const game = createGame({ seed: 42 });              // teams are generated from the seed
game.on('contact', (e) => console.log(e.exitMph, e.launchDeg));
game.on('*', (e) => overlay.push(e));               // or: game.drainEvents()

function frame(dtSeconds: number, speed = 1) {
  game.step(dtSeconds * speed);                     // any dt; internally fixed 1/240 s ticks
  const s = game.getState();                        // plain JSON-able snapshot
  render(s);
}
```

Headless: `game.simulateToEnd()` plays a whole game in ~1 s. `npm run sim -- 100 1` plays 100
games and prints league stats (see below).

## Coordinate system (metres, right-handed)

* origin: **home plate apex** (the back point of the plate)
* **+Y up**, **+Z toward center field**, **+X toward THIRD base** (first base is at −X)
* from behind home plate looking toward the mound, first base is on the right and third on the left
* right-handed ⇒ it can be used **as-is in three.js** (`mesh.position.set(x, y, z)`); a camera behind
  home plate looking down +Z sees +X on its left, exactly like a real broadcast view
* ground is y = 0. Foul lines are `x = ±z`; fair ground is `z ≥ 0 && |x| ≤ z`
* bases: home (0,0), first (−19.399, 19.399), second (0, 38.799), third (+19.399, 19.399) (90 ft = 27.432 m);
  pitching rubber at (0, 18.44) (60 ft 6 in); plate is 0.4318 m wide, front edge at z = 0.4318
* `facing` angles are `atan2(x, z)`: 0 faces center field, +π/2 faces third base (+X). This equals
  three.js `object.rotation.y` for a model whose forward axis is +Z.
* angular velocities (ball `spin`, rad/s) follow the right-hand rule in these axes
  (Magnus force = ω × v)
* fence: `GameConfig.fence` is a polar polyline `{angleDeg, distance, height}[]`, angle 0 = CF, + toward
  third base, ±180 = behind home plate (backstop). Default is a generic 330/375/400/375/330 ft park with an
  8 ft wall. Exported helpers: `fenceAt`, `surfaceAt` (dirt/grass), `isFairXZ`, `BASE_POS`, ...
* left/right-handed batters: a right-handed batter stands on the third-base side (+X), a left-handed one
  on the first-base side (−X). A right-handed pitcher releases from x > 0.

## API

```ts
createGame(config: GameConfig): Game

interface GameConfig {
  seed: number | string;
  homeTeam?: Team; awayTeam?: Team;   // see generateTeam(seed, { name?, strength? })
  fence?: FenceConfig;
  dh?: boolean;                       // default true
  innings?: number;                   // default 9
  extraInningsRunner?: boolean;       // default true (runner on second from the 10th)
  wind?: { x: number; z: number };    // m/s in sim axes, default calm
  pace?: number;                      // multiplier on dead time (walk-ups, between pitches, inning breaks); 1 = broadcast-like, 0 = none
  teamSeed?: number | string;
  providers?: { home?: DecisionProvider; away?: DecisionProvider }; // see "Decision providers"
}

class Game {
  step(dtSeconds: number): void          // advance the world (fixed internal 1/240 s tick; deterministic for any dt). Does nothing while a decision is pending.
  pendingDecisions: DecisionRequest[]    // questions a provider deferred (PENDING / a promise)
  resolveDecision(id, decision): boolean // answer one (undefined = let the AI decide)
  setProvider(side, provider | null)     // plug a DecisionProvider into a side at any time
  ai: FullDecisionProvider               // the built-in AI kind by kind (delegate to it from your own provider)
  getState(): GameStateSnapshot          // fresh plain-data snapshot; never mutates the game
  on(type | '*', cb): () => void         // synchronous discrete-event listener (returns unsubscribe)
  off(type | '*', cb): void
  drainEvents(): GameEvent[]             // events queued since the last drain (capped at 20k)
  getBoxScore()                          // per-player batting/pitching lines, linescore
  getTeams(): { home: Team; away: Team } // full rosters/ratings/arsenals
  simulateToEnd(maxSeconds?): number     // headless helper
  readonly over: boolean
}
```

Listeners are called *during* `step`; do not call `step` from inside a listener. Neither listeners nor
`getState` may consume randomness (they can't — the PRNG is private), so watching never changes a game.

### `getState()` → `GameStateSnapshot`

| field | meaning |
|---|---|
| `time` | sim seconds since game start |
| `phase` | `'pregame' \| 'halfBreak' \| 'prePitch' \| 'windup' \| 'pitch' \| 'inPlay' \| 'playOver' \| 'final'` |
| `inning`, `half`, `outs`, `balls`, `strikes`, `score`, `linescore` | scoreboard |
| `runners.first/second/third` | `{playerId, name}` of the runner who last legally touched that base |
| `batter`, `pitcher` | `{ info: PlayerInfo (name, ratings, arsenal…), line: stat line }`; pitcher also `pitchCount`, `fatigue` |
| `ball` | `pos`, `vel` (m/s), `spin` (rad/s), `mode` (`held/pitched/batted/thrown/loose/dead`), `holderId` |
| `bat` | `active`, `knob` and `tip` positions (the bat is that segment), `swingT` 0..1 (−1 when not swinging). While not swinging (`active:false`) knob/tip give a ready-stance pose. |
| `pendingDecision` | (additive) `{id, decision, side}` while the sim is paused waiting for a deferred decision, else `null` — see *Decision providers* |
| `players[]` | fielders, batter, runners (including runners who are out or scored and are still walking off), and 4 umpires: `id, name, team, role ('pitcher'\|'catcher'\|'fielder'\|'batter'\|'runner'\|'umpire'), position, jersey, pos, vel, facing, anim, animT, hasBall, bats, throws, height` |
| `umpire.lastCall`, `umpire.zone` | last call (`ball/strikeLooking/strikeSwinging/foul/hitByPitch/homeRun/infieldFly…`) with the pitch's plate location; strike-zone rectangle `{left,right,bottom,top}` in metres (x,y at `depthZ` = front edge of the plate) for the current batter |
| `lastPlay` | text description of the last completed play |
| `gameOver`, `winner`, `teams` | |

`anim` is a hint: `idle`, `windup` (pitcher before release), `pitch` (release/follow-through), `swing`
(`animT` = swing progress), `run` (sprint), `run_turn` (rounding a bag: a hard curve at speed), `trot` (easy jog: home-run trots,
dead-ball running, walking off), `field` (fielding a ground ball / blocking), `catch`, `catch_jump` (leaping / climbing at the wall,
`animT` = progress through the leap; `pos.y` is the height of the feet while airborne), `throw`, `slide`
(runner approaching or diving back to a base with a play coming), `celebrate` (a home-run scorer at the plate; winners after the
last out). `animT` runs 0..1 over the animation's duration.

### Events (`game.on(type, cb)`)

Every event has `time` (sim seconds). Types (see `types.ts` for exact fields):

`gameStart`, `halfInningStart/End`, `batterUp`, `windup`, `pitchReleased {pitchType, mph, rpm, release, targetX/Y}`,
`pitchCrossed {x, y, inZone, mph}` (plate front plane; not emitted for pitches the batter hit),
`swing`, `contact {exitMph, launchDeg, sprayDeg (+ = toward 3B/LF), spinRpm, pos}`, `call {call: CallInfo}`,
`fielded`, `catch {fly}`, `error {kind: drop|bobble|throw}`, `throw {fromId, toId, toBase, mph}`,
`out {playerId, outType, fielders[], base}`, `safe`, `runnerAdvance {playerId, fromBase, toBase}`, `runScored`, `runsNullified`,
`steal`, `pickoffAttempt`, `walk`, `hitByPitch`, `wildPitch`, `passedBall`, `homeRun {distance, heightAboveWall?, pos?}`,
`substitution`, `pitchingChange`, `plateAppearanceEnd {result}`, `playEnd {description}`, `gameEnd`.

New (additive) events: `baseTouch {playerId, base, trot, pos}` each time a runner touches a base (`trot` = dead-ball running, e.g. the
home-run trot: follow the batter around with it); `wallContact {who: 'ball'|'fielder', fielderId?, pos, speed}` (the ball meets the
wall in play / a fielder runs up to it); `wallLeap {fielderId, pos, ballHeightAboveWall}` (a fielder leaves the ground at the
wall); `robbedHomeRun {fielderId, batterId, distance, heightAboveWall, pos}` (the would-be home run is caught: there is no `homeRun`
event, the batter is out); `decisionRequested` / `decisionResolved {id, decision, side}` (only for deferred decisions).

Good hooks for a camera director: `pitchReleased` → pitcher cam; `contact` → follow the ball (`launchDeg`,
`exitMph`); `catch`/`fielded`/`throw` → cut to the fielder; `homeRun` → outfield cam; `runScored`/`out` → replay.

## Decision providers (making it playable)

Every choice a player, coach or manager makes goes through a **`DecisionProvider`** (`decisions.ts`, re-exported from `./sim`). The
built-in AI (`ai.ts`) is the default provider for all of them; a human / UI / scripted / test provider can answer *any subset*,
per side, and the AI answers the rest:

```ts
import { createGame, PENDING, type DecisionProvider } from './sim';

const me: DecisionProvider = {
  // a runner decision: hold everyone at the base unless it's a sure thing
  runner: (req) => ({ want: req.base }),
  // a human answers "swing or take?" from a UI, asynchronously: the sim pauses until the promise settles
  swing: (req) => ui.askSwing(req.observed, req.count),      // Promise<SwingDecision>
  // ... or answer later by id: return PENDING now and call game.resolveDecision(req.id, answer)
  throw: (req) => (req.options.length ? undefined /* no opinion: the AI decides */ : { action: 'hold' }),
};
const game = createGame({ seed: 1, providers: { home: me } });   // or game.setProvider('home', me) at any time
```

A provider method gets a JSON-able **request** (situation, the people involved with their ratings, the numbers that matter, and a lazy
live `state` snapshot of the whole game) and returns a **decision**, `undefined` (no opinion: the AI decides), `PENDING`, or a Promise.
Requests carry `id`, `kind`, `side` (the team that must decide), `time`.

| kind | asked | who | answer |
|---|---|---|---|
| `pitch` | before every windup | fielding side | `{pitchType, targetX, targetY, careful?}` — pitch and aim point at the front of the plate. The pitcher's command error is applied *after* this. |
| `pickoff` | before the windup when a runner on 1st/2nd could be held | fielding | `{throw}` |
| `swing` | while the pitch is in flight (~0.2 s before the plate; at release for a bunt attempt), with what the batter *perceives* (noisy plate location, distance from the zone, time to plate, speed, pitch type only if recognised) | batting | `{swing, timing?, aimX?, aimY?, effort?, protect?}` — timing / aim offsets are added to his plan; his execution noise comes after |
| `bunt` | once when the batter steps in | batting | `null` or `{kind: 'sac'\|'hit', psi}` |
| `lead` | once per pitch per runner on base | batting | `{lead}` metres off the bag |
| `steal` | start of the windup, runner on 1st/2nd with the next base open | batting | `{go}` — the request has the nominal ball time (windup + pitch + catcher + throw) and runner time |
| `runner` | ball put in play, then whenever the play changes (catch, drop, fielder gets it, throw released, ball off the wall, base reached...) and after `recheckSec` if the last answer asked | batting | `{want, tagUp?, recheckSec?}` — `want` = highest base he wants (≤ his base = hold / go back); `tagUp` = wait on the bag for the catch. Request has forced / must-retouch flags, ball state, catch margin, the fielder with the ball and his arm, seconds for the defense to have the ball at each base and for the runner to get there. |
| `throw` | the fielder has the ball (and again when the play changes / after `recheckSec`) | fielding | `{action: 'hold'} \| {action: 'throw', base, viaCutoff?} \| {action: 'tag', runnerId} \| {action: 'run', base}` — options with throw / runner times and margins are in the request |
| `alignment` | every pitch | fielding | `{infieldIn?, doublePlayDepth?, outfieldDepth?, shift?, guardLines?}` |
| `wallPlay` | an outfielder is closing on the fence under a ball he may have to leap for | fielding | `{leap, timing?}` |
| `pitchingChange` | each plate appearance, bullpen non-empty | fielding | `{replaceWith: playerId \| null}` |
| `pinchHit`, `pinchRun` | each plate appearance, bench non-empty (pinch run: runners on) | batting | `{playerId \| null}` / `{base, playerId} \| null` |
| `intentionalWalk` | each plate appearance | fielding | `{walk}` |

**Pause / resume.** A decision is applied one sim tick after it is requested, identically for synchronous, `PENDING` and promise
answers — so a game played with a slow human is the *same game* as one played with the same answers given instantly. While a
deferred answer is outstanding `game.step()` does nothing (no time passes; `getState().pendingDecision` and `game.pendingDecisions`
say what is being asked; a `decisionRequested` event is emitted). Answer with the returned promise or `game.resolveDecision(id, answer)`.
`simulateToEnd()` stops when a decision is pending. Listeners and `getState()` still never consume randomness.

**The rules stay the sim's.** Providers give *intent*; legality is enforced: a forced runner must advance, a runner must retouch
after a catch, a runner cannot pass (or share a base with) the runner ahead, near the bag he is running to he cannot turn around,
the fence is solid, a steal needs the next base open (1st→2nd, 2nd→3rd). Pitches, swings, throws and glove work are still
physics with noise — a provider chooses *what to attempt*, never *what happens*.

**Randomness.** The AI's own judgement (mixed strategies for pitch choice, the intentional-walk / bunt / pickoff rates, a runner's
misjudgement of the ball) draws from its own generator `aiRng` (seeded from the game seed), separate from the physics / perception
noise generator. So swapping a provider never shifts the physics noise stream, and "same seed + same decisions ⇒ same game" (asserted in
`__tests__/decisions.test.ts`, including a test that flips one runner decision and checks the game is identical up to it and different
after it).

## What is *not* predetermined (audit)

The sim was audited for anything decided before the physics runs (`__tests__/audit.test.ts` keeps the list honest: every uniform
random draw is on an allowlist with the reason). Findings:

* **No outcome tables, no rolled results.** Walks, strikeouts, hits, outs, errors, steals, HRs and robberies all come from the
  flown pitch vs the umpire's noisy call, the bat–ball collision, the batted ball's flight and bounces, and who gets to the ball / bag first.
* **Reworked, not removed — read this one skeptically:** the *balk* used to be `rng < 0.0006` per pitch with a runner on, a dice roll that
  directly produced a rule event. It is now the pitcher's set-position timing: one Gaussian draw per pitch (wider for wilder pitchers) is
  the length of his windup — so it moves runners' jumps and the batter's timing — and a balk is called if that hesitation / rush exceeds
  0.19 s with a runner on. It is still a rare noise-threshold event (~0.03 per team-game), but it is now part of the delivery
  mechanics instead of an independent coin. The audit test only pins *uniform* draws (`next/range/int/pick`); Gaussian draws (`normal`) are
  all physical / perception noise and are not enumerated by it.
* **Kept, and what they are:** physical noise (release, swing timing/plane, glove offset, throw error, bounce/wall irregularity, umpire
  location noise); perception noise (the batter's read of the pitch, a fielder's persistent misjudgement of a fly ball's path and of the
  ball's height/timing at the wall, a runner's misjudgement of arrival times); one heavy-tail term on pitch command (`pitching.ts`, "release
  lapse": occasionally the release error is 4× larger — the *pitch* it produces is still flown by physics); and the AI's mixed strategies.
  None of these pick a result; each is drawn when the thing it perturbs happens and then the physics runs.
* **Fixed at the start of a play, not an outcome:** each fielder's judgement bias and reaction delay, each runner's misjudgement, drawn when
  the ball is put in play. They shape decisions, they do not decide the play.

## Wall play and carom

`fenceAt` gives the wall's distance and height at an angle; players are clamped inside `distance − 0.5 m` every tick, and the ball
collides with the *straight segments between the fence points* (outward normal of the polyline, not radial) with a panel roughness the
defense's prediction ignores. For a fair ball the predicted path meets the wall above his standing reach (`1.32 × height + 0.12`), the
nearest outfielder that can get there runs to the point under it (with his own position misjudgement), plants, and — if he judges
the ball reachable (his height misjudgement `biasY`), i.e. `wallPlay.leap` — leaves the ground so the glove peaks at the wall
(timing error `biasT` + the decision's `timing`). His jump is `0.58 + 0.005·(speed−50) + 0.003·(range−50)` m; the glove reaches 1.25 m
horizontally over the fence. At the tick the ball clears the fence anyone in mid-leap gets one last glove attempt through the same
glove-noise model as any catch (more stretch = more noise): a catch is `robbedHomeRun` (batter out), a miss is a home run, a deflection
back into the park keeps the ball live. Balls that hit the wall in play rebound and are chased as loose balls; `wallContact` marks the hit.

## Baserunning and the home-run trot

* the batter-runner runs through first (6.5 m past the bag), then the runner AI / provider decides turn vs return; while returning he is
  protected from a tag, and attempting to advance gives that up. A runner put out short of the bag (force / tag) still runs through it
  and then walks to his dugout; runners who are out or scored stay on screen until they reach the dugout (`pace: 0` skips the walk).
* runners round a bag on an arc (swing wide ~7 m out, cut in to touch, leave toward the next base; `run_turn` hint) and slide (`slide`)
  when the ball is near the bag they run to or dive back to.
* after a home run every runner trots (`trot` hint, ~4.3–5.6 m/s by speed) through all bases, touching each (`baseTouch`), the scorer
  celebrates at the plate for ~1.8 s, and the play finishes only when the last runner has crossed home.

## Pacing

`pace: 1` gives a broadcast-like pace (a full 9-inning game is ~45 simulated minutes because dead time is
compressed; most of it is the 3–4 s between pitches). Use the renderer's own speed multiplier via `step(dt*speed)`.
`pace: 0` removes walk-ups/inning breaks (players snap to their spots) for fast headless runs.

## Physical model notes

* ball: mass 145 g, radius 36.6 mm, ρ = 1.2 kg/m³; drag `Cd ≈ 0.36`, lift `CL = S/(2.32 S + 0.4)` (Nathan) with a
  0.82 scale; RK4 at 1/240 s (bat–ball contact substeps to 1/1920 s).
* pitches: velocity, per-pitch spin (rpm, efficiency, Magnus direction) and command; ~0.40 s to the plate at 93 mph.
* bat: 0.84 m, 0.88 kg, sweet spot 0.66 m from the knob; bat speed 26.4 + 0.098·power m/s at the sweet spot.
* fielders: sprint 6.65 + 0.031·speed m/s (50 → 8.2 m/s), acceleration ≈ 8 m/s²; throws 27 + 0.21·arm m/s.
* Tunables live at the top of `fielding.ts` (`TUNE`), in `batting.ts` (swing thresholds/noise), `pitching.ts`
  (command noise) and `roster.ts` (rating distributions). Calibrate against `npm run sim`.

## Tests & headless stats

* `npm test` — vitest: ball flight (drag/Magnus sign/bounce/wall), pitch physics, umpire zone, force outs,
  infield fly, tag-up, walk-off, third-out nullification, determinism (same seed, any step chunking), full-game
  invariants; wall (solid fence, leaps, robbed HRs, carom), baserunning (run-through, rounding, trot, no shared bases),
  decision providers (scripted providers change outcomes, sync == deferred, same decisions => same game, one flipped decision
  diverges only afterwards) and the randomness audit.
* `npm run sim -- [games=20] [seed=1] [pace=0]` — plays N games and prints R/G, AVG/OBP/SLG, K%, BB%, HR/FB,
  BABIP, pitches/PA, swing/whiff/foul rates, Z-/O-swing%, errors, steals, etc. for a realism check.
* `scripts/lab-swing.ts` — throws pitches at hitters with no fielders (contact and exit-velocity distributions).

## Known simplifications

No catcher/fielder interference, no fielder collisions, wall
climbing is a jump plus a glove reach over the fence (no scaling the wall, no bullpen/stands), one shared field surface model, and substitutions take
effect between batters/innings. Stealing home and double steals are not offered as decisions. A bunt's bat pose is outside the arm-reach limit.
