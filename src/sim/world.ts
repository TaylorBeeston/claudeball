import type { BallBody, BallStepFlags, Environment, PathSample } from './ball';
import type { BatSwing, SwingPlan, Stance } from './batting';
import type { StrikeZone, ThrownPitch } from './pitching';
import type { Rng } from './rng';
import type { DecState } from './dispatch';
import type { FullDecisionProvider, PitchDecision, StealDecision } from './decisions';
import type {
  AnimHint,
  BatterLine,
  CallInfo,
  FieldPosition,
  GameConfig,
  GameEvent,
  PitcherLine,
  PlayerInfo,
  PlayerRole,
  Team,
  TeamSide,
} from './types';

export const TICK = 1 / 240; // fixed internal timestep (s)
export const TICKS_PER_SEC = 240;
export const secToTicks = (s: number) => Math.max(0, Math.round(s * TICKS_PER_SEC));

export interface Goal {
  x: number;
  z: number;
  /** Brake to a stop at the goal (otherwise run through at full speed). */
  stop: boolean;
  /** Speed multiplier (jog = ~0.55). */
  mul: number;
}

export interface PlayerRT {
  info: PlayerInfo;
  team: TeamRT;
  bat: BatterLine;
  pit: PitcherLine;
  pitchCount: number;
  /** Currently in the game (not yet substituted out). */
  inGame: boolean;
  /** Has been used (cannot re-enter once removed). */
  used: boolean;
  fieldPos: FieldPosition | null;
  // kinematics
  x: number;
  z: number;
  vx: number;
  vz: number;
  facing: number;
  lookAt: { x: number; z: number } | null;
  goal: Goal | null;
  reactUntil: number; // tick before which the player does not move
  vmax: number;
  accel: number;
  // presentation
  role: PlayerRole;
  anim: AnimHint;
  animStart: number;
  animDur: number;
  animUntil: number; // tick until which an override anim stays
  hasBall: boolean;
  // derived
  fatigue: number;
  onField: boolean;
  /** Fielding plan for the current play. */
  plan: FielderPlan;
  /** Wall leap in progress. */
  leap: Leap | null;
  /** Gait presentation for the renderer: jogging (`trot`) or a hard turn at a bag (`turn`). */
  gait: 'trot' | 'turn' | 'walk' | null;
  /** Tick of the last `wallContact` event for this player (rate limit). */
  wallTick: number;
  /** Tick before which he will not start another tag sweep. */
  tagReady: number;
  /** Where he belongs for the current alignment (fielders) — set by `resetDefense`. */
  home: { x: number; z: number } | null;
  /** Where the ball will meet his glove (see `PlayerSnapshot.gloveTarget`), the tick that is predicted for, and whether the catch animation has been started. */
  gloveTarget: { x: number; y: number; z: number } | null;
  gloveAt: number;
  catchArmed: boolean;
  /** After a catch the ball stays at the glove and settles into the hand over the next third of a second. */
  gloveHold: { x: number; y: number; z: number; t0: number } | null;
  /** Sprint fatigue 0 (fresh) .. 1. */
  legs: number;
  /** Hitter's day-to-day form (standard-normal-ish, AR(1) over his plate appearances). */
  form: number;
  /** Pitcher's rattled state 0..1 (runs, walks and hits against him this outing). */
  rattle: number;
  /** Where he is when he is not in the play: seated on the bench, walking to / from it, on deck, in the bullpen (null = on the field or hidden). */
  dug: 'bench' | 'toBench' | 'toDeck' | 'deck' | 'bullpen' | null;
  /** His bench seat (index) and the way points he still has to walk through (the dugout door, the steps, the aisle ...), and the goal he takes up after them. */
  seat: number;
  route: { x: number; z: number }[];
  routeMul: number;
  after: Goal | null;
  /** Tick of his next warm-up swing while on deck. */
  nextSwing: number;
}

export type PlanKind = 'idle' | 'chase' | 'cover' | 'backup' | 'cutoff' | 'receive' | 'tag' | 'hold' | 'wall';

/** An outfielder's plan for a ball that will reach (or clear) the outfield wall above his standing reach. */
export interface WallPlan {
  /** Predicted tick at which the ball meets the wall plane. */
  crossTick: number;
  /** Where he plants (just inside the wall) and where the ball meets the wall. */
  x: number;
  z: number;
  /** Ball height at the wall and how far above the top of the wall it is (m, may be negative). */
  crossY: number;
  dy: number;
  over: boolean;
  /** Decision to leap (null until decided). */
  leap: boolean | null;
  /** Leap timing offset the decision asked for (s, + = later). */
  timing: number;
}

/** A jump in progress (wall leap). */
export interface Leap {
  t0: number;
  dur: number;
  /** Peak height of the jump (m). */
  h: number;
}

export interface FielderPlan {
  kind: PlanKind;
  base: number;
  tx: number;
  tz: number;
  /** Reaction: tick at which the fielder starts moving on this play. */
  reactTick: number;
  /** Persistent trajectory-judgment bias (m per second of remaining flight). */
  biasX: number;
  biasZ: number;
  /** Persistent misjudgement of the ball's height (m) and timing (s) at the wall. */
  biasY: number;
  biasT: number;
  /** Wall play (outfielder going to the fence for a ball he may have to leap for). */
  wall: WallPlan | null;
  /** Ball secured; earliest tick the fielder can throw. */
  holdUntil: number;
  /** Throw wind-up in progress: release at this tick (0 = none). */
  releaseAt: number;
  throwBase: number;
  throwTo: PlayerRT | null;
  /** The glove's random miss for the catch he is about to make, drawn once (unit normals; scaled by the catch's difficulty at the instant). */
  catchZ: [number, number] | null;
  /** Throw decision bookkeeping (sequence, situation at the last answer, when to ask again). */
  askSeq: number;
  lastSig: string;
  recheckTick: number;
  asking: boolean;
  /** Runner he is closing on to tag. */
  tagTarget: RunnerRT | null;
  /** Last tick this fielder attempted a catch (to avoid double attempts). */
  lastAttempt: number;
  /** Ticks since the play started at which this fielder was 'primary'. */
  wasPrimary: boolean;
  delays: number;
}

export interface LineupSlot {
  player: PlayerRT;
  position: FieldPosition;
}

export interface TeamRT {
  side: TeamSide;
  team: Team;
  players: Map<string, PlayerRT>;
  lineup: LineupSlot[]; // 9, batting order
  batIdx: number; // next batter index
  bench: PlayerRT[];
  bullpen: PlayerRT[];
  pitcher: PlayerRT;
  defense: Map<FieldPosition, PlayerRT>; // current fielders (no DH)
  runs: number;
  hits: number;
  errors: number;
  /** Runners left on base at the end of half-innings. */
  lob: number;
  linescore: number[];
  dhLostPitcherHits: boolean;
}

export type RunnerState = 'live' | 'out' | 'scored';

export interface RunnerRT {
  p: PlayerRT;
  base: number; // last base legally touched (0 = home/none)
  target: number; // base heading to (1..4; 4 = home plate); equals base when settled
  state: RunnerState;
  origin: number; // base at the start of the play
  isBatter: boolean; // batter-runner on this play
  /** Must retouch this base before advancing (tag-up obligation), 0 = none. */
  retouch: number;
  /** Left the base on the pitch (stealing). */
  stealing: boolean;
  /** Reached a base at least once on this play by error (for earned-run accounting). */
  reachedOnError: boolean;
  /** Pitcher responsible for this runner. */
  responsible: PlayerRT;
  /** Runner has committed to a decision (avoid dithering). */
  committedUntil: number;
  slide: boolean;
  dead: boolean; // dead-ball movement (no plays)
  /** Decided to hold at target on this play. */
  awarded: boolean;
  scoredTick: number;
  /** Safe-lock: touched this base at tick (prevents double counting). */
  touched: boolean[];
  /** Base the runner wants to reach on this play (>= base). */
  want: number;
  ghost: boolean;
  earned: boolean;
  /** Passing first base on a run-through (protected from tags while returning). */
  overrun: boolean;
  /** Per-play judgement bias (seconds) on ball-arrival estimates. */
  bias: number;
  /** Tag-up: waiting for the catch before advancing. */
  tagWait: boolean;
  /** Tick of the catch that started the tag-up (0 = none). */
  retouchDone: boolean;
  reaction: number; // tick before which the runner has not reacted
  stealDelay: number;
  leadX: number;
  leadZ: number;
  /** Decision bookkeeping: sequence for question keys, situation at the last answer, when to ask again. */
  askSeq: number;
  lastSig: string;
  recheckTick: number;
  /** Lead distance chosen for the current pitch (m) and the key it was chosen for. */
  leadDist: number;
  leadKey: string;
  /** A runner decision has been requested and not yet applied. */
  asking: boolean;
  /** The slide he is in (null = running), when it began, and the base whose bag he is touching (0 = none). */
  slideKind: 'feet' | 'head' | 'hookL' | 'hookR' | 'diveBack' | null;
  slideAt: number;
  contactBase: number;
  /** A sidestep away from a tag he has seen coming. */
  dodged: boolean;
  /** Dead-ball trot speed (m/s), 0 = not trotting. */
  trot: number;
  /** Put out before reaching this base: he still runs through it before walking off. */
  exitVia: number;
  exitDone: boolean;
  /** Tick the runner was put out / scored (leaving the field). */
  outTick: number;
  /** A run scored on a home run: he celebrates at the plate until then. */
  celebrateUntil: number;
}

export type BallMode = 'held' | 'pitched' | 'batted' | 'thrown' | 'loose' | 'dead';

export interface BallRT {
  body: BallBody;
  mode: BallMode;
  holder: PlayerRT | null;
  flags: BallStepFlags;
  /** For 'thrown' balls: intended receiver and base. */
  throwTo: PlayerRT | null;
  throwBase: number | null;
  thrower: PlayerRT | null;
  throwTarget: { x: number; z: number } | null;
  /** For throws that are not physics (catcher -> pitcher lobs). */
  lob: { from: PlayerRT; to: PlayerRT; start: number; dur: number; arc?: number } | null;
  /** Cached prediction for fielders. */
  path: PathSample[];
  pathStart: number; // tick when path was computed
  pathDirty: boolean;
  lastTouch: PlayerRT | null;
  touchedGround: boolean;
  touchedWall: boolean;
  lastBounceTick: number;
}

export type Phase = 'pregame' | 'prePitch' | 'windup' | 'pitch' | 'pickoff' | 'inPlay' | 'playOver' | 'halfBreak' | 'final';

export interface BipInfo {
  startTick: number;
  exitMph: number;
  launchDeg: number;
  sprayDeg: number;
  contact: { x: number; y: number; z: number };
  /** Fair/foul status: undecided until it lands / is touched / passes the bag. */
  status: 'undecided' | 'fair' | 'foul';
  /** First ground/fielder touch position for fair-foul. */
  firstTouch: { x: number; z: number } | null;
  peakY: number;
  landed: boolean;
  caught: boolean;
  /** Batter hit the ball while a runner was thrown at etc. */
  infieldFly: boolean;
  infieldFlyChecked: boolean;
  homeRun: boolean;
  /** A would-be home run caught over the fence. */
  robbed: boolean;
  groundRuleDouble: boolean;
  bunt: boolean;
  fielders: PlayerRT[]; // touches in order
  fieldersTouched: string[];
  errorBy: PlayerRT | null;
  /** Position of the first fielder touch on this ball (for scoring/description). */
  firstFielder: PlayerRT | null;
  /** Did the ball hit the ground before the first fielder touch. */
  bounced: boolean;
  line: boolean;
}

export type PlayKind = 'battedBall' | 'looseBall' | 'pickoff' | 'steal' | 'deadBall' | 'droppedThird';

export interface PlayState {
  kind: PlayKind;
  startTick: number;
  bip: BipInfo | null;
  runsThisPlay: { runner: RunnerRT; tick: number }[];
  outsThisPlay: { runner: RunnerRT; force: boolean; brBeforeFirst: boolean; tick: number }[];
  dead: boolean;
  batterOut: boolean;
  hadError: boolean;
  fieldersChoice: boolean;
  errors: PlayerRT[];
  settleTicks: number;
  primary: PlayerRT | null;
  catchMargin: number | null;
  est: number[];
  estTick: number;
  aiNext: number;
  runnerAiNext: number;
  throws: number;
  touches: PlayerRT[];
  covers: Record<number, PlayerRT | null>;
  cutoff: PlayerRT | null;
  /** Foul ball / dead ball reason once decided. */
  deadReason: string;
  deadTick: number;
  /** A thrown ball that got past its receiver was already charged. */
  throwChecked: boolean;
  lastThrowTick: number;
  lastThrower: PlayerRT | null;
  /** Two-out run/RBI bookkeeping. */
  rbiEligible: boolean;
  dropped3Swinging: boolean;
  finished?: boolean;
}

export interface Count {
  balls: number;
  strikes: number;
}

/** Decisions gathered for the pitch about to be thrown (pickoff / pitch / steals), before the windup starts. */
export interface PrePitch {
  alignmentDone: boolean;
  pickoffDone: boolean;
  pitch: PitchDecision | null;
  stealsDone: boolean;
  /** Tick by which the pitch goes anyway if someone is still not in place (0 = not started waiting). */
  readyBy: number;
  /** Runner asked about stealing on this pitch and the answer. */
  steal: { r: RunnerRT; go: boolean } | null;
}

export type UmpKey = 'plate' | 'first' | 'second' | 'third';

/** A person around the field who is not a player: a base coach, a ball kid, the bat boy. */
export interface StaffRT {
  id: string;
  name: string;
  role: 'coach1b' | 'coach3b' | 'ballkid' | 'batboy';
  team: import('./types').TeamSide;
  jersey: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  facing: number;
  /** Where he is heading (null = standing), his speed cap, and what he is doing. */
  goal: { x: number; z: number } | null;
  speed: number;
  anim: import('./types').AnimHint;
  animStart: number;
  animUntil: number;
  /** Visible on the field (a coach of the team in the field stays in the dugout, out of the snapshot). */
  active: boolean;
  /** Ball kid / bat boy task state machine, coach signal state. */
  task: string;
  taskUntil: number;
  /** Coach: the runner and call currently signalled. */
  call: { runnerId: string; kind: import('./types').CoachSignalKind } | null;
  /** Ball kid: the home chair; bat boy: his spot. */
  homeX: number;
  homeZ: number;
}

export interface UmpireRT {
  id: string;
  name: string;
  position: 'HP' | '1B-U' | '2B-U' | '3B-U';
  key: UmpKey;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Where he wants to be, and since when (he reacts a moment after the play changes). */
  gx: number;
  gz: number;
  goalSince: number;
  facing: number;
  anim: import('./types').AnimHint;
  animStart: number;
  animUntil: number;
}

/** A fielder at a bag with the ball secure and his glove set down where the runner's foot / hand will arrive. */
export interface BagTag {
  F: PlayerRT;
  r: RunnerRT;
  base: number;
  hand: 'glove' | 'hand';
  /** Where the glove is (re-aimed while the runner is still far, fixed once he is committed to his slide). */
  glove: { x: number; z: number };
  frozen: boolean;
  announced: boolean;
  /** Tick before which the glove cannot make contact (the clip's swing). */
  earliest: number;
  /** Tick of the clip's contact frame: a runner who got round the glove is announced (`tagAvoided`) then. */
  contactTick: number;
  /** The fielder's per-tick step toward the glove point while the sweep is made. */
  step?: { x: number; z: number };
}

/** A fielder's tag sweep: from the start until the glove / hand arrives where he aimed. */
export interface TagSweep {
  F: PlayerRT;
  r: RunnerRT;
  start: number;
  contact: number;
  hand: 'glove' | 'hand';
  aim: { x: number; z: number };
  base: number | null;
  /** The runner's sidestep, if he made one (tick, direction). */
  dodgeAt: number;
  dodgeDir: { x: number; z: number };
  /** How far the fielder moves toward the glove point each tick while the sweep is made. */
  step: { x: number; z: number };
}

/** Casual ball handling: glove-to-hand transfer, a look at the situation, then an easy toss (possibly around the horn) to the pitcher. */
export interface BallReturn {
  stage: 'transfer' | 'look' | 'flight';
  from: PlayerRT;
  to: PlayerRT;
  /** Tick the current stage ends (transfer / look). */
  until: number;
  /** Seconds he looks over the situation after the transfer. */
  look: number;
  /** Further recipients after `to` (the pitcher last). */
  chain: PlayerRT[];
  /** After a pitch (catcher's return) rather than after a play. */
  afterPitch: boolean;
}

export interface World {
  cfg: Required<Pick<GameConfig, 'dh' | 'innings' | 'extraInningsRunner' | 'pace'>> & GameConfig;
  rng: Rng;
  /** Randomness of the AI's own judgement / mixed strategies (separate from physics noise, so another provider never shifts the physics stream). */
  aiRng: Rng;
  dec: DecState;
  ai: FullDecisionProvider;
  /** Plate-appearance start stage (see flow.startPlateAppearance). */
  paStage: number;
  prep: PrePitch;
  /** The catcher's mitt plan for the pitch in flight. */
  mitt: { x0: number; y0: number; x: number; y: number; tC: number; react: number; armed: boolean } | null;
  /** Swing decision state for the pitch in flight. */
  swingObs: import('./batting').SwingObservation | null;
  swingDecided: boolean;
  /** Bunt attempt on the pitch about to be thrown / in flight. */
  buntNow: { kind: 'sac' | 'hit'; psi: number } | null;
  /** Latest defensive alignment decision (infield in, shifts...). */
  align: import('./decisions').AlignmentDecision;
  env: Environment;
  tick: number;
  acc: number; // leftover seconds
  phase: Phase;
  phaseUntil: number; // tick at which a timed phase ends
  teams: { home: TeamRT; away: TeamRT };
  battingTeam: TeamRT;
  fieldingTeam: TeamRT;
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  count: Count;
  batter: PlayerRT | null;
  batStance: Stance;
  zone: StrikeZone;
  pitcher: PlayerRT;
  catcher: PlayerRT;
  runners: RunnerRT[]; // all live/tracked runners (excluding removed)
  /** Runners who are out or scored and are walking off the field (still on screen). */
  exiting: RunnerRT[];
  /** Tag sweeps in progress (open-field) and gloves set at a bag. */
  tags: TagSweep[];
  bagTags: BagTag[];
  /** Fielders / replaced players jogging to their dugout. */
  leavers: { p: PlayerRT; since: number }[];
  /** A casual ball return in progress (after a dead ball or a pitch). */
  ret: BallReturn | null;
  /** After an out with the bases empty the infield may toss it around (set by the rules, consumed by the return). */
  hornKind: 'k' | 'out' | null;
  ball: BallRT;
  play: PlayState | null;
  // pitch in progress
  pitch: ThrownPitch | null;
  pitchTick: number;
  pitchAim: { x: number; y: number; intent: string } | null;
  pitchCrossed: boolean;
  pitchInZone: boolean;
  swingPlan: SwingPlan | null;
  swing: BatSwing | null;
  swingStarted: boolean;
  swingContact: boolean;
  swingEnd: number;
  catcherHandled: boolean;
  /** Pending steal attempts this pitch. */
  stealing: Set<RunnerRT>;
  /** Pace-related waits. */
  pitchClock: number;
  lastCall: CallInfo | null;
  lastPlay: string;
  gameOver: boolean;
  winner: TeamSide | null;
  events: GameEvent[];
  listeners: Map<string, Set<(e: GameEvent) => void>>;
  /** Pitch sequence memory for the pitcher AI. */
  seq: { lastType: string | null; lastMph: number; count: number };
  fbMphSeen: number;
  /** Umpire zone tendencies (per game). */
  umpBias: { width: number; low: number; high: number; noise: number };
  /** Ghost runner / bookkeeping. */
  pendingPitchingChange: TeamRT | null;
  /** Last half-inning score baseline for runs-in-inning tracking. */
  inningRuns: number;
  /** Runs scored in the current half inning and pitcher/responsible accounting. */
  paPitches: number;
  paDone: boolean;
  tsTickPlayOver: number;
  /** Strikeout / walk handling flags. */
  pendingAdvance: { runner: RunnerRT; toBase: number }[];
  /** Tick when the current half-inning started (for clocks). */
  halfStartTick: number;
  /** Fielders of the defense placed at positions in the snapshot. */
  umpires: UmpireRT[];
  /** Umpire calls waiting for their moment (after the catch, after the tag / touch). */
  umpQueue: { due: number; ump: UmpKey; kind: import('./types').UmpireCallKind; atBase?: number; playerId?: string; swinging?: boolean }[];
  /** Base coaches (both teams), ball kids and the bat boy. */
  staff: StaffRT[];
  /** A foul ball that is out of play: where it is, whether a ball kid has it, and who is after it. */
  deadBall: { x: number; y: number; z: number; vx: number; vz: number; state: 'rolling' | 'resting' | 'carried' | 'tossed'; kid: string | null; since: number; tossTo?: { x: number; z: number } } | null;
  /** A bat on the ground by the plate waiting for the bat boy. */
  batDown: { x: number; z: number; by: string } | null;
  /** A random stream for the things that are only for show (warm-up swing timing, ball kids' choices): the physics and decision streams never see it. */
  propRng: Rng;
  ballInPlayEver: boolean;
  jitter: number;
  passedBallFlag: boolean;
  batterKeepsPA: boolean;
  foulReset: boolean;
  wildPitchFlag: boolean;
  /** Home team leads in the bottom of the last inning: game ends when the play resolves. */
  walkOffPending: boolean;
  /** Bunt intent for the current plate appearance (decided by the manager/batter at the start of the PA). */
  buntPlan: { kind: 'sac' | 'hit'; psi: number } | null;
}
