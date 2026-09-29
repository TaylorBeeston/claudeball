/**
 * Public data contract of the baseball simulation. Everything returned from `Game` is
 * plain, JSON-serialisable data. See README.md for the coordinate system and semantics.
 */
import type { FenceConfig } from './field';

export type Vec3 = { x: number; y: number; z: number };
export type TeamSide = 'home' | 'away';
export type Handed = 'L' | 'R' | 'S';
export type FieldPosition = 'P' | 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF' | 'DH';
/** FF four-seam, FT two-seam, SI sinker, FC cutter, SL slider, SW sweeper, CU curve, CH changeup, FS splitter. */
export type PitchType = 'FF' | 'FT' | 'SI' | 'FC' | 'SL' | 'CU' | 'CH' | 'SW' | 'FS';

/** Animation hint for the rendering layer. */
export type AnimHint =
  | 'idle'
  | 'windup'
  | 'pitch'
  | 'swing'
  | 'run'
  | 'field'
  | 'throw'
  | 'catch'
  | 'slide'
  | 'celebrate'
  /** Jump / leap / climb at the outfield wall (`animT` runs over the leap). */
  | 'catch_jump'
  /** Easy home-run / dead-ball jog (`run` is a full sprint). */
  | 'trot'
  /** Rounding a base: a sprint with a hard curve into the bag. */
  | 'run_turn';

/** What the person is doing on the field right now. */
export type PlayerRole = 'pitcher' | 'catcher' | 'fielder' | 'batter' | 'runner' | 'umpire';

/**
 * Ratings on the 20-80 scouting scale (50 = league average, 10 points = one standard deviation, 80 = elite), except `velocity`
 * (fastball mph). Every rating feeds a mechanic (see README "Player attributes"): none is cosmetic.
 */
export interface Ratings {
  // hitting
  contact: number; // bat-to-ball skill: swing timing / bat-path precision
  power: number; // bat speed
  eye: number; // pitch recognition / perception noise
  discipline: number; // zone judgment vs chasing
  /** Pull tendency: + = contact out in front (pulls the ball), - = late (goes the other way). */
  pull: number;
  /** Gap / line-drive plane: high = compact, level bat path with a launch angle near 11 deg and little spread. */
  gap: number;
  /** Recognition of breaking / off-speed pitches (slider, curve, sweeper, change, splitter). */
  breaking: number;
  /** Repeatability of the swing (pitch to pitch) and how far his form drifts from day to day. */
  consistency: number;
  /** Composure in high-leverage spots (small effect through timing / command noise). */
  clutch: number;
  /** Stays sharp late in a game and over a season (legs fatigue with hard running). */
  durability: number;
  // running
  speed: number; // sprint speed
  acceleration: number; // first steps / burst
  baserunning: number; // decisions / jumps / reads
  // fielding
  glove: number; // hands: bobble / error resistance
  range: number; // first step / reaction / route
  arm: number; // throw velocity
  accuracy: number; // throw accuracy
  /** Throw release quickness (transfer and wind-up). */
  release: number;
  /** Fielding IQ: reads of the ball (judgement of the flight) and efficiency of his routes. */
  iq: number;
  catching: number; // catcher: receiving (glove work on the pitch)
  framing: number; // catcher: steals strikes on borderline pitches
  blocking: number; // catcher: keeps balls in the dirt in front of him
  pop: number; // catcher: exchange and throw to the bag
  // pitching
  velocity: number; // fastball velocity in mph (e.g. 84-100)
  control: number; // command: release / aim error (higher = tighter)
  movement: number; // spin quality for all pitches
  stamina: number; // pitches before wearing down
  composure: number; // pitcher: command holds up under pressure and after trouble
  holding: number; // pitcher: quickness from the stretch and how short a leash runners get
  pickoff: number; // pitcher: pickoff move (quickness and deception)
}

export interface PitchSpec {
  type: PitchType;
  /** Average velocity for this pitch in mph (before fatigue). */
  mph: number;
  /** Spin rate rpm. */
  rpm: number;
  /** Spin efficiency 0..1 (share of spin that produces movement). */
  efficiency: number;
  /** Direction of the Magnus force on the pitch as seen from the catcher, degrees: 0 = up (backspin), 90 = toward third base side (+X), 180 = down (topspin), 270 = toward first base side (-X). */
  breakDirDeg: number;
  /** Relative usage weight in the pitcher's mix. */
  usage: number;
  /** Scouting grade (20-80) of this pitch's movement / spin quality. */
  grade?: number;
  /** Scouting grade (20-80) of his command of this pitch. */
  command?: number;
}

/** Hidden hitter/pitcher habits that shape mechanics (not ratings). */
export interface Traits {
  /** Mean bat attack angle (deg, + = uppercut). */
  attackAngleDeg: number;
  /** How far below the ball's centre the batter aims the bat centre-line (m). */
  aimBelow: number;
  /** Willingness to swing early in the count (-1..1). */
  aggression: number;
  /** Pitcher arm slot: release height (m), lateral offset toward the arm side (m), extension (m). */
  armHeight: number;
  armSide: number;
  extension: number;
}

export type Build = 'lean' | 'athletic' | 'stocky' | 'heavy';

export interface Physique {
  heightM: number;
  weightKg: number;
  build: Build;
}

/** Indices into the renderer's palettes (stable per player). */
export interface Appearance {
  /** 0..5 light to dark. */
  skin: number;
  /** 0..5: black, dark brown, brown, blond, red, gray. */
  hairColor: number;
  /** 0..3: buzz, short, medium, long. */
  hairStyle: number;
  /** 0..2: none, stubble, beard. */
  facialHair: number;
  /** Free 0..2^31 seed for anything else. */
  seed: number;
}

export type DeliveryStyle = 'overhand' | 'three_quarter' | 'sidearm' | 'submarine';

/** A pitcher's mechanics (fixed for the pitcher); whether he is working from the stretch is per pitch (`PlayerSnapshot.delivery.fromStretch`). */
export interface Delivery {
  style: DeliveryStyle;
  /** Arm slot: degrees from vertical (0 = straight over the top, 45 = three-quarter, 90 = sidearm, 110+ = submarine). Sets the release point. */
  armSlotDeg: number;
  /** Relative pace of the motion (1 = average; > 1 quicker): windup length and time to the plate. */
  tempo: number;
}

export interface PlayerInfo {
  id: string;
  name: string;
  team: TeamSide;
  jersey: number;
  bats: Handed;
  throws: 'L' | 'R';
  primaryPosition: FieldPosition;
  height: number; // metres (== physique.heightM)
  age: number;
  physique: Physique;
  appearance: Appearance;
  /** Pitchers only. */
  delivery?: Delivery;
  ratings: Ratings;
  arsenal: PitchSpec[]; // empty for position players
  isPitcher: boolean;
  traits: Traits;
}

export interface Team {
  id: string;
  name: string;
  abbrev: string;
  roster: PlayerInfo[];
  /** Starting lineup in batting order (player ids) with the defensive position each plays. */
  lineup: { playerId: string; position: FieldPosition }[];
  startingPitcherId: string;
  /** Starting rotation (ids), in turn. */
  rotation?: string[];
  bullpen: string[];
  bench: string[];
}

export interface BatterLine {
  pa: number;
  ab: number;
  h: number;
  doubles: number;
  triples: number;
  hr: number;
  bb: number;
  so: number;
  hbp: number;
  rbi: number;
  r: number;
  sb: number;
  cs: number;
  sf: number;
  sh: number;
}

export interface PitcherLine {
  outs: number; // innings pitched * 3
  bf: number;
  h: number;
  r: number;
  er: number;
  bb: number;
  so: number;
  hr: number;
  hbp: number;
  pitches: number;
  strikes: number;
  wp: number;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  team: TeamSide;
  role: PlayerRole;
  /** Defensive position (for fielders); 'DH'/bench bats report their lineup position. */
  position: FieldPosition | 'HP' | '1B-U' | '2B-U' | '3B-U';
  jersey: number;
  pos: Vec3;
  vel: Vec3;
  /** Heading in radians: atan2(x, z). 0 faces center field, +PI/2 faces third-base side (+X). */
  facing: number;
  anim: AnimHint;
  /** 0..1 progress through the current windup / swing / throw / slide animation (when meaningful). */
  animT: number;
  hasBall: boolean;
  bats: Handed;
  throws: 'L' | 'R';
  height: number;
  /** (additive) scouting ratings, physique and looks of this player, and a pitcher's delivery (`fromStretch` is live). */
  ratings?: Ratings;
  physique?: Physique;
  appearance?: Appearance;
  delivery?: Delivery & { fromStretch: boolean };
}

export type BallMode = 'held' | 'pitched' | 'batted' | 'thrown' | 'loose' | 'dead';

export interface BallSnapshot {
  pos: Vec3;
  vel: Vec3;
  /** Angular velocity, rad/s, right-hand rule in sim axes. */
  spin: Vec3;
  mode: BallMode;
  holderId: string | null;
  /** True while the ball is in play (visible to the game); false in dead-ball periods. */
  inPlay: boolean;
}

export interface BatSnapshot {
  active: boolean;
  batterId: string | null;
  /** Handle (knob end) and barrel tip positions; the bat is the segment between them. */
  knob: Vec3;
  tip: Vec3;
  /** Progress through the swing 0..1, -1 when not swinging. */
  swingT: number;
}

export type CallKind =
  | 'ball'
  | 'strikeLooking'
  | 'strikeSwinging'
  | 'foul'
  | 'foulTip'
  | 'hitByPitch'
  | 'safe'
  | 'out'
  | 'fairBall'
  | 'homeRun'
  | 'infieldFly'
  | 'balk';

export interface CallInfo {
  kind: CallKind;
  time: number;
  balls: number;
  strikes: number;
  /** For ball/strike calls: where the pitch crossed the plate (x, y) and whether it was truly in the zone. */
  plateX?: number;
  plateY?: number;
  inZone?: boolean;
}

export interface RunnerInfo {
  playerId: string;
  name: string;
}

export interface GameStateSnapshot {
  time: number; // seconds since game start (sim clock)
  phase: string; // 'pregame' | 'prePitch' | 'windup' | 'pitch' | 'inPlay' | 'playOver' | 'halfInningBreak' | 'final'
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  balls: number;
  strikes: number;
  score: { home: number; away: number };
  linescore: { home: number[]; away: number[] };
  runners: { first: RunnerInfo | null; second: RunnerInfo | null; third: RunnerInfo | null };
  batter: { info: PlayerInfo; line: BatterLine } | null;
  pitcher: { info: PlayerInfo; line: PitcherLine; pitchCount: number; fatigue: number } | null;
  ball: BallSnapshot;
  bat: BatSnapshot;
  players: PlayerSnapshot[];
  umpire: {
    lastCall: CallInfo | null;
    zone: { left: number; right: number; bottom: number; top: number; depthZ: number };
  };
  lastPlay: string;
  gameOver: boolean;
  winner: TeamSide | null;
  teams: { home: { name: string; abbrev: string }; away: { name: string; abbrev: string } };
  /** Set while the sim is paused waiting for a decision provider (see README "Decision providers"). */
  pendingDecision?: { id: number; decision: import('./decisions').DecisionKind; side: TeamSide } | null;
}

export type OutType =
  | 'strikeout'
  | 'force'
  | 'tag'
  | 'fly'
  | 'line'
  | 'pop'
  | 'foulFly'
  | 'infieldFly'
  | 'pickoff'
  | 'caughtStealing'
  | 'tagUp'
  | 'batterInterference';

interface EBase {
  time: number;
}

export type GameEvent =
  | (EBase & { type: 'gameStart' })
  | (EBase & { type: 'halfInningStart'; inning: number; half: 'top' | 'bottom' })
  | (EBase & { type: 'halfInningEnd'; inning: number; half: 'top' | 'bottom' })
  | (EBase & { type: 'batterUp'; batterId: string; pitcherId: string })
  | (EBase & { type: 'windup'; pitcherId: string })
  | (EBase & { type: 'pitchReleased'; pitcherId: string; pitchType: PitchType; mph: number; rpm: number; release: Vec3; targetX: number; targetY: number })
  | (EBase & { type: 'pitchCrossed'; x: number; y: number; inZone: boolean; mph: number })
  | (EBase & { type: 'swing'; batterId: string })
  | (EBase & { type: 'contact'; batterId: string; exitMph: number; launchDeg: number; sprayDeg: number; spinRpm: number; pos: Vec3 })
  | (EBase & { type: 'call'; call: CallInfo })
  | (EBase & { type: 'fielded'; fielderId: string; clean: boolean; pos: Vec3 })
  | (EBase & { type: 'catch'; fielderId: string; fly: boolean; pos: Vec3 })
  | (EBase & { type: 'error'; fielderId: string; kind: 'drop' | 'bobble' | 'throw' })
  | (EBase & { type: 'throw'; fromId: string; toId: string | null; toBase: number | null; mph: number })
  | (EBase & { type: 'out'; playerId: string; outType: OutType; fielders: string[]; base: number | null })
  | (EBase & { type: 'safe'; playerId: string; base: number })
  | (EBase & { type: 'runnerAdvance'; playerId: string; fromBase: number; toBase: number })
  | (EBase & { type: 'runScored'; playerId: string; team: TeamSide; runsHome: number; runsAway: number })
  | (EBase & { type: 'runsNullified'; count: number; runsHome: number; runsAway: number })
  | (EBase & { type: 'steal'; runnerId: string; toBase: number })
  | (EBase & { type: 'pickoffAttempt'; pitcherId: string; base: number })
  | (EBase & { type: 'walk'; batterId: string; intentional: boolean })
  | (EBase & { type: 'hitByPitch'; batterId: string })
  | (EBase & { type: 'wildPitch'; pitcherId: string })
  | (EBase & { type: 'passedBall'; catcherId: string })
  | (EBase & { type: 'homeRun'; batterId: string; distance: number; /** metres the ball cleared the top of the wall by */ heightAboveWall?: number; pos?: Vec3 })
  /** The ball met the outfield wall (`who: 'ball'`, in play) or a fielder ran up to it (`who: 'fielder'`). */
  | (EBase & { type: 'wallContact'; who: 'ball' | 'fielder'; fielderId?: string; pos: Vec3; speed: number })
  /** A fielder leaves the ground at the wall for a ball he may reach over the fence. */
  | (EBase & { type: 'wallLeap'; fielderId: string; pos: Vec3; ballHeightAboveWall: number })
  /** A would-be home run was caught by a fielder reaching over the fence. */
  | (EBase & { type: 'robbedHomeRun'; fielderId: string; batterId: string; distance: number; heightAboveWall: number; pos: Vec3 })
  /** A runner touched a base (also for dead-ball trots): `trot` is true when it is not a live-ball touch. */
  | (EBase & { type: 'baseTouch'; playerId: string; base: number; trot: boolean; pos: Vec3 })
  | (EBase & { type: 'substitution'; team: TeamSide; inId: string; outId: string; reason: string })
  | (EBase & { type: 'pitchingChange'; team: TeamSide; inId: string; outId: string })
  | (EBase & { type: 'plateAppearanceEnd'; batterId: string; result: string })
  | (EBase & { type: 'playEnd'; description: string })
  | (EBase & { type: 'gameEnd'; winner: TeamSide; home: number; away: number })
  /** A provider deferred a decision: the sim is paused until `game.resolveDecision(id, ...)` / the promise settles. */
  | (EBase & { type: 'decisionRequested'; id: number; decision: import('./decisions').DecisionKind; side: TeamSide })
  | (EBase & { type: 'decisionResolved'; id: number; decision: import('./decisions').DecisionKind; side: TeamSide });

export type GameEventType = GameEvent['type'];

export interface GameConfig {
  /** Seed for the game PRNG. Same seed + same teams => identical game. */
  seed: number | string;
  homeTeam?: Team;
  awayTeam?: Team;
  /** Fence shape; defaults to a generic MLB park (330 / 375 / 400 / 375 / 330 ft). */
  fence?: FenceConfig;
  /** Universal designated hitter (default true). */
  dh?: boolean;
  /** Regulation innings (default 9). */
  innings?: number;
  /** Start extra innings with a runner on second (default true, MLB rule). */
  extraInningsRunner?: boolean;
  /** Steady wind in m/s in sim axes (x toward 3B, z toward CF). Default calm. */
  wind?: { x: number; z: number };
  /** Multiplier on the idle time between pitches / plays (default 1). Use 0 to skip dead time entirely. */
  pace?: number;
  /** Team-generation seed base if teams are not supplied (default: derived from seed). */
  teamSeed?: number | string;
  /** Decision providers per side (any subset of decisions; the built-in AI answers the rest). See README "Decision providers". */
  providers?: { home?: import('./decisions').DecisionProvider; away?: import('./decisions').DecisionProvider };
}
