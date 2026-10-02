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
| `stats` | (additive) live per-game and cumulative box-score stats for every player, see *Stats* |
| `players[]` | fielders, batter, runners (including runners who are out or scored and are still walking off), and 4 umpires: `id, name, team, role ('pitcher'\|'catcher'\|'fielder'\|'batter'\|'runner'\|'umpire'), position, jersey, pos, vel, facing, anim, animT, hasBall, bats, throws, height`; additively `ratings`, `physique`, `appearance`, `delivery {style, armSlotDeg, tempo, fromStretch}` (pitchers). `pos.y` is the ground height at his spot (the mound for the pitcher) plus wall-leap height |
| `umpire.lastCall`, `umpire.zone` | last call (`ball/strikeLooking/strikeSwinging/foul/hitByPitch/homeRun/infieldFly…`) with the pitch's plate location; strike-zone rectangle `{left,right,bottom,top}` in metres (x,y at `depthZ` = front edge of the plate) for the current batter |
| `lastPlay` | text description of the last completed play |
| `gameOver`, `winner`, `teams` | |

`anim` is a hint: `idle`, `windup` (pitcher before release), `pitch` (release/follow-through), `swing`
(`animT` = swing progress), `run` (sprint), `run_turn` (rounding a bag: a hard curve at speed), `trot` (easy jog: home-run trots,
dead-ball running, walking off), `field` (fielding a ground ball / blocking), `catch`, `catch_jump` (leaping / climbing at the wall,
`animT` = progress through the leap; `pos.y` is the height of the feet while airborne), `throw`, `slide`
(runner approaching or diving back to a base with a play coming), `celebrate` (a home-run scorer at the plate; winners after the
last out), `transfer` (a fielder moving the ball from glove to throwing hand, standing: after a catch, an out, a pitch), `tag_glove` / `tag_hand` (a tag sweep: the hint starts with `tagAttempt`, clip 0.583 s, contact frame 8 = 0.333 s), `ump_out_strikeout` (a strikeout), `slide_feet` / `slide_head` / `slide_hook_left` / `slide_hook_right` / `dive_back`, `catcher_block`, `catch_pitch` / `catch_throw` / `catch_stretch` / `catch_fly` / `catch_fly_run` (a fly ball taken on the run) / `catch_line_drive` / `catch_backhand` / `field_grounder` / `catch_comebacker` (the pitcher) (timed so the catch is at `animT` ≈ 0.5, and to start `CATCH_LEAD[hint]` before the catch), `ump_*` (umpires), `toss` (an
easy short return toss; longer casual returns use `throw`; the engine adapter plays `toss` as `throw` and `transfer` as the ready pose until clips exist). `animT` runs 0..1 over the animation's duration.

### Events (`game.on(type, cb)`)

Every event has `time` (sim seconds). Types (see `types.ts` for exact fields):

`gameStart`, `halfInningStart/End`, `batterUp`, `windup`, `pitchReleased {pitchType, mph, rpm, release, targetX/Y}`,
`pitchCrossed {x, y, inZone, mph}` (plate front plane; not emitted for pitches the batter hit),
`swing`, `contact {exitMph, launchDeg, sprayDeg (+ = toward 3B/LF), spinRpm, pos}`, `call {call: CallInfo}`,
`fielded`, `catch {fly}`, `error {kind: drop|bobble|throw}`, `throw {fromId, toId, toBase, mph}`,
`out {playerId, outType, fielders[], base}`, `safe`, `runnerAdvance {playerId, fromBase, toBase}`, `runScored`, `runsNullified`,
`steal`, `pickoffAttempt`, `walk`, `hitByPitch`, `wildPitch`, `passedBall`, `homeRun {distance, heightAboveWall?, pos?}`,
`substitution`, `pitchingChange`, `plateAppearanceEnd {result}`, `playEnd {description}`, `gameEnd`.

New (additive) events: `tagAttempt {fielderId, runnerId, base|null, hand: 'glove'|'hand', pos}`, `tag {fielderId, runnerId, pos}`, `tagAvoided {fielderId, runnerId, slide}`, `umpireCall {...}` (see *Tagging, catching and the umpires*); `out` / `safe` gained `margin` and `closePlay`; `catch` / `fielded` gained `kind`, `height`, `side`, `firm`; `ballReturn {fromId, toId, mph, casual: true}` (a fielder's easy return of the ball after a dead ball or a pitch leaves his hand: after the transfer and a look; also each leg of an around-the-horn toss); `baseTouch {playerId, base, trot, pos}` each time a runner touches a base (`trot` = dead-ball running, e.g. the
home-run trot: follow the batter around with it); `wallContact {who: 'ball'|'fielder', fielderId?, pos, speed}` (the ball meets the
wall in play / a fielder runs up to it); `wallLeap {fielderId, pos, ballHeightAboveWall}` (a fielder leaves the ground at the
wall); `robbedHomeRun {fielderId, batterId, distance, heightAboveWall, pos}` (the would-be home run is caught: there is no `homeRun`
event, the batter is out); `decisionRequested` / `decisionResolved {id, decision, side}` (only for deferred decisions).

Good hooks for a camera director: `pitchReleased` → pitcher cam; `contact` → follow the ball (`launchDeg`,
`exitMph`); `catch`/`fielded`/`throw` → cut to the fielder; `homeRun` → outfield cam; `runScored`/`out` → replay.

## Player attributes (every one feeds a mechanic)

Ratings are on the 20–80 scouting scale (50 = average, 10 points = 1 σ; `velocity` is the fastball in mph). They live in
`PlayerInfo.ratings` (also on each `PlayerSnapshot.ratings`); `attributes.ts` holds the maps from attribute to mechanic and
`__tests__/attributes.test.ts` shows each one changing the physics.

| attribute | mechanic |
|---|---|
| **contact** | barrel accuracy: aim error and swing-timing error of the swing (and bunts) |
| **power** | bat speed at the sweet spot (exit velocity) |
| **pull** | swing timing shifts earlier (pull, contact out front) / later (opposite field): spray angle moves ~1° per 3 points |
| **gap** | level, repeatable bat path: mean attack angle drawn toward ~11°, launch-angle spread shrinks |
| **eye / discipline** | perception noise of the pitch (location, speed, recognition) / the swing-or-take threshold |
| **breaking** | recognition of slider / curve / sweeper / change / splitter and how well he extrapolates their movement (a poor eye misjudges and chases) |
| **consistency** (hitter) | scale of timing / bat-path / bat-speed noise pitch to pitch, and how far his day-to-day **form** drifts (an AR(1) that moves his effective contact and power a few points) |
| **clutch** | in high-leverage spots (late, close, runners in scoring position) extra composure noise on the swing for the fragile, less for the clutch |
| **speed / acceleration** | top sprint speed (6.65 + 0.031·speed m/s) and acceleration (6.6 + 0.03·accel m/s²), as `stepPlayer` moves him |
| **baserunning** | jumps on steals, lead size, how well he reads arrival times (his misjudgement σ), the margin he wants |
| **durability** | hard running tires the legs (`legs`, 0–1 over a minute of sprinting); the speed it costs is larger for low durability; also a little extra pitch limit |
| **range** | first step (reaction time), leaps at the wall, a share of top speed, judgement of the ball's flight |
| **iq** | fielding IQ: smaller judgement error, more efficient routes (fraction of top speed that becomes progress), quicker first step |
| **glove** | catch / bobble / drop noise of the glove, and (with **release**) the glove-to-hand transfer |
| **arm / accuracy / release** | throw speed (27 + 0.21·arm m/s), throw direction noise, wind-up and transfer time |
| catcher **catching / framing / blocking / pop** | receiving the pitch, borderline strikes he gets called, balls in the dirt he keeps in front of him, exchange + transfer against a steal |
| **velocity** | fastball mph (each pitch is `velocity − its template delta`; from the stretch 0.6 mph less) |
| **movement** & each pitch's **grade** | spin rate and spin efficiency of that pitch (Magnus force ⇒ break) |
| **control** and each pitch's **command** | direction error of the release (scatter at the plate) overall and for that pitch |
| **consistency** (pitcher) | release-point repeatability (σ of the release coordinates) and the rate of release lapses; the length of his set-position hitch |
| **stamina** | pitches before he tires (fatigue costs velocity and command) |
| **composure** | his command noise under pressure and after trouble (runs / walks / hits this outing make him "rattled", decaying between batters and innings) |
| **holding** | time from the stretch to the plate and how short a leash runners get (their lead) |
| **pickoff** | how quickly the throw over leaves his hand and how long the move freezes the runner; how often the AI throws over |

**Repertoire.** Pitch types: four-seam `FF`, two-seam `FT`, sinker `SI`, cutter `FC`, slider `SL`, sweeper `SW`, curve `CU`, changeup
`CH`, splitter `FS`. Starters carry 4–5 pitches, relievers 2–4, low-slot pitchers lean sinker / two-seam / slider / sweeper. Each
`PitchSpec` has its own velocity, spin (rpm, efficiency, axis) and `grade` / `command`; the arm slot tilts the spin axis (a
sidearmer's fastball runs, his slider sweeps).

**Delivery** (`PlayerInfo.delivery = {style, armSlotDeg, tempo}`; live in `PlayerSnapshot.delivery` with `fromStretch`). `armSlotDeg` is
degrees from vertical (0 over the top, ~45 three-quarter, ~90 sidearm, 100+ submarine) and *sets the release point*: height above the
mound = `height·(0.65 + 0.27·cos slot)` (plus the mound), lateral offset `0.16 + 0.6·sin slot·height/1.9` toward the arm side.
`tempo` scales the windup and the time to the plate. The pitcher works from the **stretch** whenever a runner is on base (windup with the bases
empty): the stretch is ~0.28 s quicker (0.84 s vs 1.12 s, adjusted by tempo and `holding`), costs 0.6 mph and 4% command, and is what a
runner's steal read is measured against.

**Generation.** `generateTeam` draws attributes with MLB-like spread and correlations: power trades off against contact
(and goes with size), speed goes against weight and age, acceleration follows speed, durability falls with age, pitch quality follows
`movement`, low-slot pitchers throw a little slower, lefties are better at holding and pickoffs. Every player also has `age`,
`physique {heightM, weightKg, build: lean|athletic|stocky|heavy}` (BMI by position and size), `appearance {skin, hairColor, hairStyle,
facialHair, seed}` (palette indices for the renderer), handedness (switch hitters included) and a jersey number.
`Team.rotation` lists the five starters.

## The mound

`groundHeight(x, z)` (field.ts) is the same function as `mound_h` in `assets/src/field.py` (the rendered mound mesh): an 18 ft circle centred 59 ft from the
apex, a level rectangle 5 ft wide from 60 ft to 60 ft 34 in (0.254 m, 10 in above home plate), falling 1 in per foot in every direction from that rectangle; the height is
`max(0, min(H - 1 in/ft * d, H * smoothstep((9 ft - r) / 1.5 ft)))` (`d` = distance from the level rectangle, `r` = distance from the circle's centre), so the mound ends exactly on
its 18 ft circle (0 everywhere else). The glb is a faceted 40x96 grid, so it differs from the analytic function by a few cm between
vertices (at most ~2.5 cm on the slopes). It is used for **every player's `pos.y`** in the snapshot (the pitcher stands 0.254 m up; a wall leap adds to it),
for the ball (it bounces and rolls on the mound), for the ball in a fielder's hand, and for the release point (measured above the mound).
The engine should place a player at `pos.y` (or call `groundHeight` itself for a position it computes).

## Stats

`getState().stats = {home, away}` is a live box score for a HUD: per team `batters[]` (lineup in order, then bench players used) and
`pitchers[]` (in order of appearance), each entry `{playerId, name, jersey, position, inGame, game: {batting, pitching}, season:
{batting, pitching}}` with `batting` = PA AB H 2B 3B HR RBI R BB K HBP SB CS SF SH plus `g avg obp slg ops tb`, and `pitching` = outs BF H R ER
BB K HR HBP pitches strikes WP plus `g ip era whip`; `totals {runs, hits, errors, lob}`. `season` is `priorStats` + this game (`GameConfig.priorStats`).
`simulateSeason({seed, teams, rounds})` plays a headless round robin (rotation turns over, stats accumulate, standings and player
lines returned; ~1.5 s per game). `batterStats` / `pitcherStats` compute the derived lines.

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

## Between plays: getting set and handling the ball

**Ball handling after a dead ball or a pitch** (`handling.ts`). Whoever holds the ball when the play is dead — a first baseman after a force
out, the catcher after every caught pitch — does not fire it back:
1. **transfer** (hint `transfer`, he stands): glove to throwing hand. After an out: `0.62 s` (+0.15 s after a force out, nobody in a
   rush), quicker with a good `release` and `iq`, clamped 0.4–1.0 s. A catcher's transfer of a pitch: ~0.34 s, `pop` helps.
2. **look** at the runners / the situation: 0.2 s (+0.35 s with a runner on), 0.15 s after a pitch.
3. **easy return** (`ballReturn` event; hint `toss` under 14 m, else `throw`): 25–40 m/s by distance (`24 + 0.3·d`), never his real
   arm strength, along an arc into the pitcher's hand, while he comes to meet it and the passer goes back to his spot.
After an out with the bases empty the infield sometimes tosses it around first (a strikeout: half the time, 3B–SS–2B–1B–pitcher; other outs:
occasionally a short chain); those draw from the AI's `aiRng`. Live-ball throws (a runner still going) are urgent exactly as before. A ball nobody
has (over the fence, foul territory) is replaced by a fresh one in the pitcher's hand. `pace: 0` skips all of this: the ball is simply back
with the pitcher.

**Everybody back in place before the next pitch.** When a play ends every fielder heads back to his alignment spot (a walk when it is a few
metres, a jog further out, a run from the wall or when the game is waiting on him: speed by distance and urgency); replaced pitchers,
replaced runners and the fielders at the end of an inning jog to their dugout (`leavers`, still in `players[]` until they arrive); a
reliever jogs in from the dugout side, a pinch runner comes out to his base, the fielders run out at the start of an inning and the
batter walks in. The **pitch waits** until: the pitcher has the ball on the rubber (within 0.6 m), no return is under way, every fielder is
within 1.5 m of his spot (catcher 1 m) and not running, the batter is in the box and still, and runners are on their bases or at their leads
(umpires are stationary in the sim: they are always in place). The wait is bounded — at most 25 s of sim time (`READY_TIMEOUT`, scaled by `pace`) — and
stragglers speed up while the game is waiting. In a full game the pitch starts with everyone in place essentially always; only a genuinely
long trip (a reliever from the dugout) is waited for.

## Tagging, catching and the umpires

**Audit: what tagging was before this pass.** Honestly, there was no tagging mechanism: a runner was out when the fielder holding the ball was
within 0.95 m of him (a 2-D distance between the two centres, checked every tick), whether he was sliding or upright, and nothing else
mattered — no glove or hand, no swipe time or reach, no aim, no way for a runner to avoid it, no drop on contact; the `slide` hint was
only an animation. A force out was "the man with the ball within 0.95 m of the bag". Tag-ups (doubled off) and pickoff tags used the same
distance test. What did exist: force / tag-up logic, forcing chains, fielders chasing runners in a rundown.

**Now** (`tagging.ts`):
* **Bag tag** — a fielder holding the ball secure (0.1 s after the catch) within 1.1 m of the bag a runner is coming to (or back to, on a pickoff)
  sets his glove down on the runner's line 0.6 m up from the bag, slightly toward the side he stands on. He tracks the runner until the runner is
  `8/24` s from reaching the glove (the `tag_glove` / `tag_hand` clip's contact frame; `26/24` s for the catcher's `catcher_block`; ~2.4 m out at the latest), then commits
  (`tagAttempt` and the hint start together, `tag` fires at the contact frame, at least 0.15 s after `tagAttempt`), with aim error from `glove` / `iq`. The tag is made the moment the runner's body or
  leading foot / hand reaches the glove (within glove 0.22 m + limb thickness) — before it reaches the bag; a runner whose foot / hand touches the bag
  first is safe (a `safe` with a negative `margin`). A late throw = safe.
* **Open-field sweep** (rundowns, a batter caught off the plate) — the man with the ball starts a swipe when the runner is within 2.2 m: the hand arrives
  exactly 8/24 s later (the clip's contact frame; `tag` / `tagAvoided` fire then), aimed where the runner will be then (+ aim error growing with the closing
  speed), reach 0.95 m (glove) / 0.85 m (hand) + a 0.35 m lunge. The runner sees it and sidesteps (a sidestep of ~2 m/s away from the glove after his reaction
  time) unless he is about to reach a bag. A miss by a runner who slid or dodged is `tagAvoided`.
* **The runner** is a body: upright = a fat point (0.28 m); sliding = a thin segment (0.14 m) from his centre to the leading foot (feet-first, 1.0 m) or hands
  (head-first, 1.25 m; `dive_back` 1.2 m). A base is touched when the body centre is within 0.9 m or the foot / hand within 0.45 m of the bag.
* **Slide choice** (state driven, when he is ~3.4 m out with a play on or a steal): away from the glove — a *hook* (`slide_hook_left` / `_right`, started ~4.8 m out,
  the foot swings out around the glove and back to catch the corner of the bag) when the fielder is on his line or at the plate; head-first when he is fast and
  experienced (`slide_head`); otherwise feet-first (`slide_feet`); a `dive_back` when returning to the bag on a pickoff; never into first (he runs through it). The
  existing `slide` remains a valid fallback hint.
* **Drops** — on contact the ball can jar loose (closing-speed and glove dependent, ~1-2 %): loose ball, an error on the fielder, the runner is safe.
* **Force plays** — the fielder needs the ball secure and a foot on the bag (his centre within 0.65 m) before the runner touches it. A throw that pulls him off the
  bag (he moves more than 0.65 m from it to catch it, emergent from `receiverLogic`) is no force: he has to tag. Stretching keeps the foot on the bag while the glove
  reaches (the covering man stands 0.5 m in toward the throw).
* **Catcher** — he blocks the plate lane (`catcher_block`, standing a step up the line) **only when he has the ball**; otherwise he gives the lane up (so there is no
  obstruction in the sim; the rule is honoured by construction).
* `out` events carry `margin` (seconds by which the fielder beat the runner: the runner's projected arrival) and `closePlay` (|margin| < 0.10 s); `safe` events carry a
  negative `margin` (the seconds the defense still needed) and `closePlay` — hooks for slow-motion replays.

**Catching.** For every catch the snapshot carries `PlayerSnapshot.gloveTarget` (world position where the ball will meet the glove / mitt: pitches — the catcher's
mitt plan from his read of the pitch, moving from where he set up toward the ball and limited by how fast his hand can move; throws and batted balls — the
the predicted flight, re-planned every tick from the latest trajectory, and over the last ticks the ball's own next positions, so **at the catch `gloveTarget` equals the `catch` event's `pos`**: within a few cm, 0 for throws / fly balls / pickoffs, ≤ ~10 cm for grounders and pitches), `gloveEta` (s) and `gloveHand`. `catchIn` (s, also on every player) counts down to the catch while a
glove target is set. The catch hint starts `CATCH_LEAD[hint]` before the catch, chosen from the engine's 24 fps clips so the clip's catch frame is the arrival:
`catch_pitch` 7/24 s, `catch_throw` 6/24, `catch_stretch` 8/24, `catch_fly` 10/24, `catch_fly_run` 12/24, `catch_line_drive` 5/24, `catch_backhand` 8/24,
`field_grounder` 11/24, `catch_comebacker` 7/24 (so `catchIn` equals that lead on the first frame the hint shows, and `animT` ≈ 0.5 at the catch: the hint's duration is twice the lead).
Which hint: `catch_pitch` for the catcher; `catch_stretch` / `catch_throw` for throws (the covering first baseman stretches); the pitcher's ground ball is `catch_comebacker`;
a hard grounder / liner picks `field_grounder` / `catch_line_drive`; a fly ball on the throwing-arm side `catch_backhand`; else `catch_fly`, or `catch_fly_run` when he is
running faster than ~3 m/s (the kind is decided from the predicted flight: still in the air at arrival = fly, bounces first / rolling / a loose ball below waist height = grounder, a throw or pickoff = `catch_throw` / `catch_stretch`; a clip that ran out or started too early is started again at the right lead). **Every** catch has hint + `gloveTarget` + `catchIn` + a `catch` event, including throws to bases, pickoffs and the casual returns to the pitcher (`ballReturn` legs, `catch_throw`, the toss ends in the receiver's glove). The pitcher's `PlayerSnapshot.pitchType` (and the `windup` event's `pitchType`) is known from the start of the windup, before release, for grip choice.
The glove's random miss is drawn when he commits to the
catch (so the renderer can show it coming). `catch` / `fielded` events carry `pos` (where the ball met the glove), `kind` (`pitch|throw|fly|line|ground|pickoff`),
`height` (`low|chest|high`), `side` (`glove|arm|backhand|forehand`) and `firm`. After a catch the ball stays at the glove and settles into the hand over a third of
a second.

**Overrun.** Stops are planned with the braking a person can do (`brakeDecel`, ~6.6 m/s², a little better with `iq` / `range`): the fielder starts slowing far enough out to
arrive near his spot at a walk (before, he planned 11 m/s² but could only brake at his 8 m/s² acceleration, so he ran through and turned back). Measured over full games:
overshoot past a stop goal is 0 at the median, p90 ≈ 0, p99 ≈ 0.7 m (max ≈ 1.5 m) — it was p90 0.9 m, p99 1.8 m, max 3 m; fielders arrive at their spot at ~0 m/s (p90 2.3 m/s).
A batter running through first still overruns by ~2-6 m by design.

**Umpires** (`umpires.ts`). The four umpires move (4.5 m/s) to see the play: the umpire of a bag the play is at goes to his ideal spot (first / third: foul territory ~4.6 m from the bag;
second: outfield grass 3.4 m beyond the bag; the plate umpire steps to the first-base side of the lane on a play at the plate), then back to rest. Calls follow the play
as `umpireCall {umpire: 'plate'|'first'|'second'|'third', umpireId, kind, pos, atBase?, playerId?}` (the umpire's position at the call) with a gesture hint on his `anim`
for ~1.3 s (0.6 s for a ball): `ball` / `ball_four` → `ump_ball` (no big gesture), `strike_called` → `ump_strike`, `strike_swinging`
→ `ump_strike_swinging`, a strikeout (`kind: 'strikeout'`, looking or swinging) → `ump_out_strikeout`, `foul` / `foul_tip` → `ump_foul`, `fair` → `ump_fair` (a ball that lands within 2.5 m of the line), `safe` → `ump_safe`, `out` → `ump_out`, `homerun`
→ `ump_homerun` (the foul-line umpire on that side, 0.4 s after the ball clears), `time` → `ump_time` (substitutions); the default is `ump_ready`. Timing: a strike / ball 0.25 / 0.2 s
after the catch, a base call 0.25 s after the tag / touch (0.55 s when it was close). `umpireCall` is separate from the existing `call` event (the ruling itself, whose shape did not change).
Not modelled: umpires do not avoid fielders who chase balls into foul territory (players do not collide in the sim).

**The batter's swing and body** (`batting.ts`, from the assets' analysis of the swing clip, `swing_bat_path.json`, `elbow_guides.json`). The swing starts from the clip's load pose (`loadPose()`: knob by the rear
shoulder, bat cocked up and back) and the hands extend into the arc over the first 80 % of the swing. Both hand targets (`knob + HAND_FRONT` = 0.12 m and `knob + HAND_REAR` = 0.26 m along the bat) are clamped
to the reach (`ARM_REACH`, 0.68 m) of **their own shoulder**, which moves with the torso (`shouldersAt`, `torsoState`: the shoulder line turns `TORSO_YAW_C` = 60° toward the pitcher and the body centre shifts
`LEAN_C` toward the plate / pitcher by contact), and are kept outside the torso ellipse (`TORSO_HALF`). The contact geometry is body-relative: the hands meet the ball from a feasible point
(`HANDS_FWD` 0.20 m toward the plate, `HANDS_LAT` 0.30 m toward the pitcher, `HANDS_Y` 1.15 m up, relative to the shoulder centre), the depth at which the ball is met follows from it (an inside pitch further
out in front; a pitch off the plate is reached for, the hands extend and, past the arm's reach, the clamp pulls the bat short: a miss). The bat turns about a virtual point `RH_NOM` = 0.48 m behind the knob
(near the rear shoulder); contact is still the sphere-vs-bat collision of the actual pose, and at contact the clamps are inactive for pitches he can reach. Because the bat is now near-perpendicular to the ball's
path at contact (hands 0.30 m toward the pitcher), the timing tolerance is larger and the pull tendency is now a contact depth (`pullDepth`: a puller meets the ball up to 0.14 m further out in front, where the bat is more turned, an opposite-field hitter deeper) instead of a timing shift; `sigmaT`,
`baseBatSpeed`, the vertical bat-path noise, and the steal estimate's tag time were re-tuned (stats below).

## People around the field: the return throw, the dugouts, coaches, ball kids

All coordinates are metres in the usual frame (+X toward third base, +Z toward centre field); the home team is in the **third-base dugout (+X)**, the visitors in the first-base one (−X).
They come from `src/sim/venue.ts` and the assets' `field.py` / `geom.py` (dugout footprint s 12–30 m, o 8.6–13.2 m along / off the base line, floor 1.05 m below the field).

**The return throw.** When a fielder is about to throw the ball back (from the start of the last 0.35 s before it leaves his hand, also for each leg around the horn) the receiver — the pitcher
usually — turns to face the thrower, holds his glove out (hint `catch_ready`, a loop) at the point where the ball will come to it and publishes `gloveTarget` / `catchIn` (seconds to the
catch, counting through the throw's flight); in flight the clip is `pitcher_catch_toss` (the pitcher, catch frame 8/24 s) or `catch_throw`, and every `ballReturn` ends in a `catch` event
at the glove (`kind: 'throw'`).

**Lifecycle (nobody warps).** Everybody exists all the time. Position players and the pitchers who are in the game sit on their bench (role `bench`, hint `bench_sit`, `pos.y` = the dugout floor,
−1.05 m) at seat `k` = `benchSeat(side, k)`: home seat 0 (18.6, 1.5) … seat 15 (28.7, 11.6), mirrored in X for the visitors; three relievers per team stand in the bullpen (role `bench`, home
mound end (49.5, 38.2), mirrored). The hitter after the one at the plate gets up (event `onDeck {playerId, team}`), walks aisle → steps (16.0, 2.3) → door (14.6, 1.0) at field level → the
**on-deck circle** (home (11.3, 0), mirrored; role `ondeck`), loose (`ondeck_ready`) with a swing with the donut (`ondeck_swing`, 2 s) every 6–10 s; when he is called (`batterUp`) he walks to his box
(hint `walk`, 2.4 m/s, 3–8 s; around behind the plate through (±5.2, −3.6) → (±3.4, −3.6) if his box is on the far side) and the pitch waits for him (bounded). A man who is out, a runner who
scored, fielders at the end of the inning and replaced players walk to the door, down the steps and sit down (`walk` → `bench_sit`); pinch runners and pinch hitters come from their seat;
a reliever jogs in from the bullpen; fielders come up the steps and run out. At the end of a play nobody is snapped any more: a runner still running through the bag brakes and walks back, a
batter sent out of the box by a foul walks back. Headless runs (`pace: 0`) place people directly.

**Base coaches** (roles `coach3b` / `coach1b`, `position` `C3B` / `C1B`, ids `coach-<home|away>-<3b|1b>`): the batting team's stand in the coach boxes — third (23.7, 15.1), first (−23.7, 15.1) —
the others are not on the field. Hints `coach_ready`, `coach_stop`, `coach_go` (windmill), `coach_slide`, `coach_advance`, `coach_signs`; event `coachSignal {coachId, kind: 'stop'|'go'|'slide'|
'advance'|'signs', runnerId?, base?}` when a call changes. The call is a **decision** (`DecisionKind` `'coach'`, request `CoachRequest`: coach, runner, base / heading / want, ball, `ballToBase`,
`runnerToBase`, `throwComing`; answer `{call: 'go'|'stop'|'advance'|'slide'|'none'}`). The built-in coach makes the runner's own call with his own judgement error and from the same state: `go`
or `stop` for a runner at or heading for third, `advance` or `stop` for a batter-runner at first, `slide` when a throw is on its way to the base. The runner takes it with a probability that falls
with his `iq` (0.75–0.97); if he does not, or if the side plays its runners with a provider that has no `coach`, his own decision stands. `coach_signs` is shown between pitches on the sim's
own steal / bunt calls (and as flavour with runners on).

**Ball kids and the bat boy** (roles `ballkid`, `batboy`; ids `ballkid-3b` / `ballkid-1b`, `batboy-<side>`): the kids sit on chairs down the lines in foul ground — (37.1, 30.8) and
(−37.1, 30.8) — `ballkid_sit`; the bat boy stands by the batting team's dugout (15.3, 8.0). A foul ball that nobody holds keeps flying and rolling as `deadBall` (`GameStateSnapshot.deadBall
{pos, state: rolling|resting|carried|tossed}`; the live ball is replaced in the pitcher's hand as before); when it stops in foul ground the nearer kid runs to it (`ballkid_run`), picks it
up (`ballkid_pickup`, event `ballKidRetrieve {ballKidId, pos}`) and takes it back to his chair, or 40 % of the time tosses it into the stands (`ballkid_toss`, event `ballTossedToFan {ballKidId,
pos}`). They keep out of a live play (the kid retreats when the ball is hit within 24 m). A hitter who runs with the ball in play drops his bat by the plate (`BatSnapshot.dropped`); the bat boy
fetches it once the play is over (`batBoyRetrieve {batBoyId, pos}`) and carries it back.

New hints: `catch_ready`, `pitcher_catch_toss`, `bench_sit`, `ondeck_ready`, `ondeck_swing`, `walk`, `bullpen_throw` (unused), `coach_*`, `ballkid_*`. New roles: `bench`, `ondeck`, `coach1b`, `coach3b`, `ballkid`, `batboy`.
About 45 entities are in a snapshot (on the field 14-18, benches ~20, staff 5). Statistics are unchanged (seeds 1-8 x 60 games: R/G 4.4, AVG .241, K% 23.5, BABIP .296, HR/G 1.04).

## Tempo: the real game's non-pitch time

`GameConfig.tempo: 'quick' | 'standard' | 'broadcast'` says how much of baseball's non-pitch time is modelled. The sim's default is `quick` (a little more than it always had); the browser game
passes `broadcast` (`simAdapter.ts`). `pace: 0` (headless, seasons, `npm run sim`) skips **all** of it: no routine, no signs, no visits, no breaks, and a pace-0 game is bit-for-bit what it was
before. `ritual` durations (waiting parts of the batter / pitcher routines) are `TEMPO_RITUAL` = 0.10 / 0.60 / 1.0 of the broadcast time and the long lulls (mound visits, pitching changes, challenges, breaks)
`TEMPO_LULL` = 0.25 / 0.60 / 1.0 (both times `pace`); an optional bit of ritual (a step-out, the rosin bag, the signs at `quick`) is shown with probability `showP` (0.25 / 1 / 1). A clip is never cut short.
What is decided (steps out, calls time, shakes off, steps off the rubber, who goes to the mound, whether a manager challenges) comes from the state and `aiRng`; what is only show (how long, how many warm-up swings)
from `propRng`, which nothing in the physics or the decisions reads. Same seed + same tempo = the same game.

**Measured** (`npm run sim -- 40 1 1 <tempo>`, 8 seeds x 40 games; pitch-to-pitch = release to release inside a plate appearance, medians):
| | quick | standard | broadcast |
|---|---|---|---|
| nobody on | 7.3 s | 13.5 s | 15.7 s (p10 12.7, p90 39 after a foul / a ball in play) |
| runners on | 7.2 s | 15.8 s | 22.2 s |
| mean half-inning (3 outs) | 4.0 min | 6.6 min | 7.5 min |
| a 9-inning game | 73 min | 116-126 min | 134-144 min |
| inning break | 6-15 s | 16-36 s | 26-60 s |
League line is unchanged by tempo: AVG .247 / .243 / .245, K% 23.4 / 23.2 / 23.4, BABIP .300 / .294 / .301, R/G 4.63 / 4.67 / 4.56, pitches per PA 3.63 / 3.65 / 3.63.

**Between pitches** (`tempo.ts`, run once the pitch is chosen; two lanes in parallel, then the stages in order): the batter on the first pitch of his turn takes 1-2 practice swings (`batter_practice_swing`,
1.2 s), adjusts (`batter_adjust`: his habit `PlayerSnapshot.tic` = `tap_plate | adjust_helmet | rock_bat | stretch`, fixed by his appearance seed) and digs in (`batter_step_in`); between pitches he steps out
(`batter_step_out` -> `batter_adjust` -> `batter_step_in`, 3-8 s, to 1.95 m off the plate) with a probability from foul balls, two strikes, the count of pitches and his `consistency`, or calls time (event
`timeCalled {by: 'batter'|'catcher'|'pitcher', playerId}`, the plate umpire's `ump_time`). The pitcher works (`pitcher_rosin` 2 s, `pitcher_adjust` 1.4 s, a step off the rubber `pitcher_step_off` after a pickoff
throw / a foul / a runner, then back), the time scaled by his `delivery.tempo`, his rattle and the runners; the catcher sometimes signals the infield (`catcher_signal_infield`); then **the signs**:
`catcher_signs` 1.2-2.4 s (a runner on second: +1 s and a decoyed 4-number sequence), event `signsGiven {catcherId, pitcherId, pitchType, complex, seq, reshown?}` where `seq` follows the pitch chosen
**before** the signs (the pitch-choice decision; `PitchRequest.shookOff` is set on the second one). He may **shake off** (`pitcher_shake_off` 1.3 s, event `shakeOff {pitcherId, catcherId, rejected}`: 3 % + rattle +
composure + a call that is not one of his better pitches, about 7 % overall): a second pitch decision refusing that type, new signs (`reshown: true`), then `pitcher_nod`, `pitcher_look_runner` with a runner
on, and the pitch. Everything is bounded (70 s) and `pace`-scaled.

**Mound visits** (`visits.ts`): by the state (rattle, bases loaded, runs this inning, pitch count, a walk, late and close with a man in scoring position; at most 4 per team per game and 14 pitches apart), event
`moundVisit {by: 'catcher'|'pitchingCoach'|'manager'|'infielders', purpose, visitorId, team, start, end}` and `moundVisitEnd`. The visitor walks out (`walk`; coach and manager from the dugout rail through the steps and
door as staff, roles `pitchcoach` / `manager`, hint `manager_walk`), 12-25 s of `mound_talk` (visitor) / `mound_talk_listen` (pitcher, the gathered infielders who stand at `moundRing` of `venue.ts`), and walks back; the pitcher
is steadier afterwards (rattle x 0.72, x 0.6 for the manager). Plate umpire `ump_time`. About 2-3 per game.
**Pitching change** (the decision is the old one; at `pace > 0` it is a sequence): `pitchingChangeStart {team, outId, inId, managerId}`, the manager signals (`manager_signal`) and walks out (`manager_walk`, ~14 s), the
reliever jogs in from the bullpen (`dug: 'toMound'`, role `pitcher`, `trot`), they talk (`mound_talk`, sometimes the infield gathers), `pitcher_handoff` (the ball goes to the manager's hand, `ball.holder` is null while he has it),
the old pitcher leaves, the manager gives the ball to the new one (`pitchingChange` + `substitution` events), 5-8 `warmup_pitch` throws to the catcher (each caught as a `catch` `kind: 'pitch'`, returned with the usual transfer
and toss), the catcher's throw down to second (the shortstop covers) and back, the plate umpire brushes off the plate (`umpire_brush_plate`); about 75-100 s at `broadcast`, 4 per game.
**Challenge**: a close call at a base (`out` / `safe` with |margin| < 0.1 s) can be challenged by the manager it went against (two per team per game, likelier the closer and the more it matters): `challenge {team,
managerId, base, runnerId, call, margin}`, `manager_signal`, the four umpires huddle at `umpHuddle` (`ump_huddle`), 45-115 s, `challengeResult {overturned}`. The verdict comes from the play's own margin; the sim's calls
come from the physics, so they stand (the check exists but cannot fail until the umpires can get something wrong).

**Dead-ball time**: after a ball goes out of play the plate umpire hands a new one (`ump_new_ball`); after an out with the bases empty the infield tosses it around the horn more often (+20 % at `broadcast`); the bench cheers
(`bench_cheer`) or stands (`bench_stand_up`) for hits, runs, homers and strikeouts; the reliever likely to come in loosens in the bullpen (`bullpen_throw`) when the pitcher is tiring (pitch count, rattle, runs). Not
modelled: the first baseman holding the runner at the bag (it would change the fielding), the grounds crew.
**Between innings** (`breaks.ts`): 26-60 s at `broadcast` (event `breakStart {inning, half, sec}`; the first half-inning 22-28 s): the fielders trot out and in as before, then the pitcher throws eight warm-up pitches (`warmup_pitch`) to the
catcher (the last followed by his throw down to second), the infielders roll ground balls to each other (`throw` / `field_grounder`) and the outfielders play catch (`toss` / `catch_toss`) with **extra balls that are only for show**
(`GameStateSnapshot.extraBalls`, positions in metres), the field umpires walk in to the plate, the plate umpire brushes it off; the first batter walks in after (bounded: 25 s over).

**Snapshot, additive**: `phaseDetail` ('batterRoutine' | 'pitcherRoutine' | 'signs' | 'shakeOff' | 'moundVisit' | 'pitchingChange' | 'review' | 'break' | null; `phase` itself is unchanged), `lull` (bool), `lullKind`
('walkup' | 'betweenPitches' | 'moundVisit' | 'pitchingChange' | 'break' | 'review'), `lullSec` (expected length), `lullRemaining`, `extraBalls`, `PlayerSnapshot.tic`. New roles `manager` (`MGR`) and
`pitchcoach` (`PCH`) at the dugout rail (manager (±17.1, 4.1), pitching coach (±18.4, 5.4), `venue.ts`; home +X), always on the snapshot. New hints: `batter_step_in`, `batter_practice_swing`, `batter_adjust`, `batter_step_out`, `catcher_signs`,
`catcher_signal_infield`, `pitcher_shake_off`, `pitcher_nod`, `pitcher_step_off`, `pitcher_rosin`, `pitcher_adjust`, `pitcher_look_runner`, `mound_talk`, `mound_talk_listen`, `manager_walk`, `manager_signal`,
`pitcher_handoff`, `warmup_pitch`, `umpire_brush_plate`, `ump_new_ball`, `ump_huddle`, `bench_cheer`, `bench_stand_up`, `catch_toss`, `bullpen_throw` (now used). New events: `signsGiven`, `shakeOff`, `timeCalled`,
`moundVisit`, `moundVisitEnd`, `pitchingChangeStart`, `challenge`, `challengeResult`, `breakStart`. The reliever coming in from the bullpen walks through the outfield wall (he is not on the field yet).

## Pacing

`pace: 1` gives a broadcast-like pace (a full 9-inning game is ~45 simulated minutes because dead time is
compressed; most of it is the 3–4 s between pitches). Use the renderer's own speed multiplier via `step(dt*speed)`.
`pace: 0` removes walk-ups/inning breaks and the ball handling / getting-set waits (players snap to their spots) for fast headless runs. At `pace: 1` a full nine-inning game is 40–48 simulated minutes (~2 s of compute).

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

No catcher/fielder interference (the catcher blocks only with the ball), no obstruction awards, no fielder collisions (players and umpires may overlap), wall
climbing is a jump plus a glove reach over the fence (no scaling the wall, no bullpen/stands), one shared field surface model, and substitutions take
effect between batters/innings. Stealing home and double steals are not offered as decisions. A bunt's bat pose is outside the arm-reach limit.
