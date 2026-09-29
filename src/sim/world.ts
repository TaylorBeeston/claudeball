import type { BallBody, BallStepFlags, Environment, PathSample } from './ball';
import type { BatSwing, SwingPlan, Stance } from './batting';
import type { StrikeZone, ThrownPitch } from './pitching';
import type { Rng } from './rng';
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
  gait: 'trot' | 'turn' | null;
  /** Tick of the last `wallContact` event for this player (rate limit). */
  wallTick: number;
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
  lob: { from: PlayerRT; to: PlayerRT; start: number; dur: number } | null;
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

export interface World {
  cfg: Required<Pick<GameConfig, 'dh' | 'innings' | 'extraInningsRunner' | 'pace'>> & GameConfig;
  rng: Rng;
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
  umpires: { id: string; name: string; position: 'HP' | '1B-U' | '2B-U' | '3B-U'; x: number; z: number }[];
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
