# `src/sim` — baseball simulation core

Pure TypeScript, no DOM / three.js / rendering dependencies. Runs in the browser and in Node
(tests, headless season sims). Everything that happens on the field **emerges from simulated
mechanics and decisions** — there are no outcome tables and no "roll for a single":

| Layer | What is simulated |
|---|---|
| Pitch | pitcher ratings → release point, speed, spin vector → RK4 flight with gravity, drag and Magnus force → plate crossing. Command error is Gaussian noise on the release direction *after* the pitcher's internal aim solver (so a bad release really misses). Fatigue slows the pitch and widens the error. |
| Umpire | called strike/ball from the pitch's true location + umpire noise, per-game zone bias and catcher framing. |
| Batter | perceives the pitch (noisy, extrapolated from the first half of the flight), decides swing/take from count + discipline, plans a swing (timing, plane, hand extension), swings a rigid bat (rotation about the body axis with an attack angle) and collides with the ball (sphere–capsule, effective bat mass at the contact point, COR falling off the sweet spot, Coulomb friction → spin). Exit velocity, launch angle, spray angle, foul/fair, whiffs all fall out of geometry and timing. |
| Batted ball | RK4 flight (drag + Magnus), bouncing on grass/dirt with friction & spin & surface irregularity, rolling, outfield wall (configurable shape, wall ricochets, home runs, ground-rule doubles, foul territory). |
| Defense | each fielder has position, sprint speed, first-step reaction and a *trajectory-judgement error* that shrinks as the ball comes down. Fielders solve interception against the predicted ball path, one is "called" primary, others cover bases / back up / cut off. Catch, bobble and drop come from glove-position noise vs. the ball's speed and how stretched the fielder is. The man with the ball weighs runner arrival times against throw times (force, tag, relay via cut-off man, hold), waits for the base coverer, and throws with real flight time and accuracy noise. |
| Baserunning | runners lead off, steal (own time vs. pitcher/catcher estimate), tag up on likely catches, read the ball and the fielder's position to take extra bases or retreat, run through / slide. Outs are tags, force outs and appeals decided by who is at the base first. |
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
}

class Game {
  step(dtSeconds: number): void          // advance the world (fixed internal 1/240 s tick; deterministic for any dt)
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
| `players[]` | fielders, batter, runners, and 4 umpires: `id, name, team, role ('pitcher'\|'catcher'\|'fielder'\|'batter'\|'runner'\|'umpire'), position, jersey, pos, vel, facing, anim, animT, hasBall, bats, throws, height` |
| `umpire.lastCall`, `umpire.zone` | last call (`ball/strikeLooking/strikeSwinging/foul/hitByPitch/homeRun/infieldFly…`) with the pitch's plate location; strike-zone rectangle `{left,right,bottom,top}` in metres (x,y at `depthZ` = front edge of the plate) for the current batter |
| `lastPlay` | text description of the last completed play |
| `gameOver`, `winner`, `teams` | |

`anim` is a hint: `idle`, `windup` (pitcher before release), `pitch` (release/follow-through), `swing`
(`animT` = swing progress), `run`, `field` (fielding a ground ball / blocking), `catch`, `throw`, `slide`
(runner approaching a base with a play coming), `celebrate` (winners after the last out; also used at the
end). `animT` runs 0..1 over the animation's duration. Home-run trots are `run` at jog speed.

### Events (`game.on(type, cb)`)

Every event has `time` (sim seconds). Types (see `types.ts` for exact fields):

`gameStart`, `halfInningStart/End`, `batterUp`, `windup`, `pitchReleased {pitchType, mph, rpm, release, targetX/Y}`,
`pitchCrossed {x, y, inZone, mph}` (plate front plane; not emitted for pitches the batter hit),
`swing`, `contact {exitMph, launchDeg, sprayDeg (+ = toward 3B/LF), spinRpm, pos}`, `call {call: CallInfo}`,
`fielded`, `catch {fly}`, `error {kind: drop|bobble|throw}`, `throw {fromId, toId, toBase, mph}`,
`out {playerId, outType, fielders[], base}`, `safe`, `runnerAdvance`, `runScored`, `runsNullified`,
`steal`, `pickoffAttempt`, `walk`, `hitByPitch`, `wildPitch`, `passedBall`, `homeRun {distance}`,
`substitution`, `pitchingChange`, `plateAppearanceEnd {result}`, `playEnd {description}`, `gameEnd`.

Good hooks for a camera director: `pitchReleased` → pitcher cam; `contact` → follow the ball (`launchDeg`,
`exitMph`); `catch`/`fielded`/`throw` → cut to the fielder; `homeRun` → outfield cam; `runScored`/`out` → replay.

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
  invariants.
* `npm run sim -- [games=20] [seed=1] [pace=0]` — plays N games and prints R/G, AVG/OBP/SLG, K%, BB%, HR/FB,
  BABIP, pitches/PA, swing/whiff/foul rates, Z-/O-swing%, errors, steals, etc. for a realism check.
* `scripts/lab-swing.ts` — throws pitches at hitters with no fielders (contact and exit-velocity distributions).

## Known simplifications

No catcher/fielder interference, no fielder collisions, wall
climbing/robbery is limited to reach at the wall, one shared field surface model, and substitutions take
effect between batters/innings.
