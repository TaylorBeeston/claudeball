/**
 * Pluggable decision layer. EVERY choice a player, coach or manager makes goes through a `DecisionProvider`:
 * the built-in AI answers by default (`aiProvider`, see `ai.ts`); a human / UI / scripted test provider can answer any
 * subset of the kinds by handing `createGame({ providers })` (per side) or `game.setProvider(side, provider)`.
 *
 * A provider method receives a JSON-able request (with a lazy live `state` snapshot) and returns
 *   - a decision (synchronously), or
 *   - `undefined`  -> "no opinion": the default AI decides, or
 *   - `PENDING` / a Promise -> the sim PAUSES (`step()` advances nothing) until the answer arrives via the
 *     promise or `game.resolveDecision(id, decision)`.
 * Decisions are applied one sim tick after they are requested (identically for sync and async providers), and the sim
 * still enforces the rules (forced runners must advance, a tag-up must be retouched, the fence is solid...).
 * See README.md "Decision providers".
 */
import type { GameStateSnapshot, PitchSpec, PitchType, PlayerInfo, TeamSide, Vec3 } from './types';

export const PENDING: unique symbol = Symbol.for('claudeball.decision.pending');
export type Pending = typeof PENDING;

export type DecisionKind =
  | 'pitch'
  | 'pickoff'
  | 'swing'
  | 'bunt'
  | 'lead'
  | 'steal'
  | 'runner'
  | 'throw'
  | 'alignment'
  | 'pitchingChange'
  | 'pinchHit'
  | 'pinchRun'
  | 'intentionalWalk'
  | 'wallPlay'
  | 'coach';

interface Base<K extends DecisionKind> {
  /** Unique per game; pass it to `game.resolveDecision` for a deferred answer. */
  id: number;
  kind: K;
  /** The team that has to decide (fielding side for pitch/throw/alignment/pitching change/walks, batting side for the rest). */
  side: TeamSide;
  /** Sim seconds when the question was asked. */
  time: number;
  /** Full live game snapshot at the moment of the question (evaluated lazily, so it costs nothing unless read). */
  readonly state: GameStateSnapshot;
}

export interface Situation {
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  balls: number;
  strikes: number;
  /** batting team runs - fielding team runs */
  scoreDiff: number;
  /** who is on 1st / 2nd / 3rd (player ids, live runners at their last touched base) */
  runners: { first: string | null; second: string | null; third: string | null };
}

// ---------------------------------------------------------------------------------------------
// pitcher / catcher
// ---------------------------------------------------------------------------------------------

/** Which pitch to throw and where to aim it. Asked before every windup (fielding side). */
export interface PitchRequest extends Base<'pitch'> {
  situation: Situation;
  pitcher: PlayerInfo;
  batter: PlayerInfo;
  /** Side of the plate the batter stands on. */
  batterStance: 'L' | 'R';
  arsenal: PitchSpec[];
  lastPitchType: PitchType | null;
  pitchCount: number;
  /** 0 = fresh; > 0 as the pitcher tires (velocity and command suffer). */
  fatigue: number;
  /** Strike zone for this batter (m; x, y at the front of the plate). */
  zone: { left: number; right: number; bottom: number; top: number };
}
export interface PitchDecision {
  /** Must be in the pitcher's arsenal. */
  pitchType: PitchType;
  /** Aim point at the front of the plate: x (+ toward third base), y (height, m). The pitcher's command error is applied AFTER this. */
  targetX: number;
  targetY: number;
  /** Pitch carefully into the zone (slightly better command, no nibbling). */
  careful?: boolean;
}

/** Throw over to hold a runner? Asked before the windup when a runner can be picked (fielding side). */
export interface PickoffRequest extends Base<'pickoff'> {
  situation: Situation;
  pitcher: PlayerInfo;
  runner: PlayerInfo;
  base: number;
  /** How far the runner is off the bag (m). */
  lead: number;
}
export interface PickoffDecision {
  throw: boolean;
}

// ---------------------------------------------------------------------------------------------
// batter
// ---------------------------------------------------------------------------------------------

/**
 * Swing or take? Asked while the pitch is in flight, about 0.2 s before it reaches the plate (batting side). The batter
 * only knows what he perceives (noisy). For a bunt attempt (`bunt` set) it is asked at release.
 */
export interface SwingRequest extends Base<'swing'> {
  situation: Situation;
  batter: PlayerInfo;
  stance: 'L' | 'R';
  /** Seconds since release. */
  elapsed: number;
  observed: {
    /** Where the batter thinks the pitch will cross the front of the plate (noisy). */
    plateX: number;
    plateY: number;
    /** How far outside the zone he thinks it is (m; negative = inside). Includes his judgement noise. */
    distanceFromZone: number;
    timeToPlate: number;
    speedMph: number;
    /** Pitch type if he recognised it. */
    pitchType: PitchType | null;
  };
  zone: { left: number; right: number; bottom: number; top: number };
  bunt: { kind: 'sac' | 'hit'; psi: number } | null;
}
export interface SwingDecision {
  swing: boolean;
  /** Seconds later (+) / earlier (-) than ideal timing the swing starts. */
  timing?: number;
  /** Where to aim the sweet spot relative to the perceived location (m). */
  aimX?: number;
  aimY?: number;
  /** 0.8..1: swing effort (protect the plate = shorter, slower swing). Default 1 (0.965 when protecting). */
  effort?: number;
  /** Shorten up with two strikes (default: two strikes). */
  protect?: boolean;
}

/** Bunt this plate appearance? Asked once when the batter steps in (batting side). */
export interface BuntRequest extends Base<'bunt'> {
  situation: Situation;
  batter: PlayerInfo;
  stance: 'L' | 'R';
}
/** `null` = swing away. psi: direction to deaden the ball, radians, + toward third base. */
export type BuntDecision = { kind: 'sac' | 'hit'; psi: number } | null;

// ---------------------------------------------------------------------------------------------
// runners
// ---------------------------------------------------------------------------------------------

/** How far off the base to stand for this pitch (batting side). */
export interface LeadRequest extends Base<'lead'> {
  situation: Situation;
  runner: PlayerInfo;
  base: number;
  pitcher: PlayerInfo;
  /** Reasonable range (m). */
  min: number;
  max: number;
}
export interface LeadDecision {
  /** Metres from the bag toward the next base. */
  lead: number;
}

/** Break for the next base on this pitch? Asked when the pitcher starts his windup (batting side). */
export interface StealRequest extends Base<'steal'> {
  situation: Situation;
  runner: PlayerInfo;
  fromBase: number;
  toBase: number;
  pitcher: PlayerInfo;
  catcher: PlayerInfo;
  /** Nominal seconds from the start of the windup until the pitch is in the catcher's glove, incl. his transfer and throw to the bag. */
  ballTime: number;
  /** Nominal seconds for the runner to get there (own jump and speed). */
  runnerTime: number;
}
export interface StealDecision {
  go: boolean;
}

export interface RunnerBall {
  mode: 'held' | 'pitched' | 'batted' | 'thrown' | 'loose' | 'dead';
  pos: Vec3;
  vel: Vec3;
  holderId: string | null;
  inAir: boolean;
  caught: boolean;
  landed: boolean;
  hitWall: boolean;
  /** seconds until a fielder would catch a fly ball minus the time he needs to get there (null = not a catchable fly ball) */
  catchMargin: number | null;
}

/**
 * Advance / hold / return / tag up, for one runner. Asked when the ball is put in play and again whenever the play
 * changes (catch, drop, fielder gets the ball, throw released, ball off the wall, runner reaches or nears a base, a batter
 * runner passes first...) and after `recheckSec` if the last answer asked for it (batting side).
 */
export interface RunnerRequest extends Base<'runner'> {
  situation: Situation;
  runner: PlayerInfo;
  isBatterRunner: boolean;
  /** Last base legally touched (0 = none yet). */
  base: number;
  /** Base he is currently heading to (== base when settled). */
  heading: number;
  /** Base he currently intends to reach. */
  want: number;
  pos: Vec3;
  speed: number;
  /** Past first base on a run-through: still protected from a tag while he returns to the bag. */
  overrun: boolean;
  /** Forced to run (a runner behind him needs his base). */
  forced: boolean;
  /** Must retouch this base before advancing (fly ball was caught): 0 = no obligation. */
  mustRetouch: number;
  ball: RunnerBall;
  /** The fielder controlling / nearest the ball (null while it is in the air far from everyone). */
  fielder: { id: string; pos: Vec3; armMps: number; hasBall: boolean } | null;
  /** Seconds until the defense could have the ball at bases 1..4 (index 1..4), from live positions and arm strength. */
  ballToBase: number[];
  /** Seconds for this runner to reach bases 1..4 from where he is now (index 1..4). */
  runnerToBase: number[];
  /** Other live runners: base they are on / heading to. */
  others: { playerId: string; base: number; heading: number; want: number }[];
}
/**
 * A base coach's call for a runner who is looking at him (batting side): the third-base coach sends a runner home or holds him at third, the first-base coach
 * waves a batter-runner on to second or holds him, either calls a slide. The runner mostly obeys (smart runners trust their own read a little more).
 * Asked when the play changes around a runner heading for / standing at the coach's base.
 */
export interface CoachRequest extends Base<'coach'> {
  situation: Situation;
  /** Which coach, and who he is calling. */
  coach: '1b' | '3b';
  coachId: string;
  runner: PlayerInfo;
  /** Last base legally touched, the base he is heading to, the base he wants (his own read). */
  base: number;
  heading: number;
  want: number;
  pos: Vec3;
  speed: number;
  forced: boolean;
  ball: RunnerBall;
  /** Seconds until the defense could have the ball at bases 1..4 (index 1..4) and until the runner is there. */
  ballToBase: number[];
  runnerToBase: number[];
  /** A throw is on its way to the base he is heading to. */
  throwComing: boolean;
}
export interface CoachDecision {
  /** `go`: send him home (windmill); `stop`: hold him where he is going / at the base; `advance`: wave him on to the next base; `slide`; `none`: say nothing. */
  call: 'go' | 'stop' | 'advance' | 'slide' | 'none';
}

export interface RunnerDecision {
  /** Highest base he wants to reach (4 = score). <= his base means hold / return to it. */
  want: number;
  /** Fly ball in the air: stay on (or go back to) the bag and run on the catch. */
  tagUp?: boolean;
  /** Ask again after this many seconds even if nothing changes (AI: 0.05). Omit to be asked only when the play changes. */
  recheckSec?: number;
}

// ---------------------------------------------------------------------------------------------
// fielders
// ---------------------------------------------------------------------------------------------

export interface ThrowOption {
  action: 'throw' | 'tag' | 'run';
  base: number;
  runnerId: string;
  /** Who would take the throw (null when he tags / runs it himself). */
  receiverId: string | null;
  /** Would go through the cut-off man. */
  viaCutoff: boolean;
  /** Seconds until the ball is at the base (or he is), incl. the wind-up. */
  fielderTime: number;
  /** Seconds until the runner is there. */
  runnerTime: number;
  /** runnerTime - fielderTime (> 0: the play is there to be made). */
  margin: number;
  force: boolean;
}
/** What to do with the ball just secured (or re-evaluated as the play develops); fielding side. */
export interface ThrowRequest extends Base<'throw'> {
  situation: Situation;
  fielder: PlayerInfo;
  pos: Vec3;
  armMps: number;
  options: ThrowOption[];
  cutoffId: string | null;
}
export type ThrowDecision =
  | { action: 'hold'; recheckSec?: number }
  | { action: 'throw'; base: number; viaCutoff?: boolean; recheckSec?: number }
  | { action: 'tag'; runnerId: string; recheckSec?: number }
  | { action: 'run'; base: number; recheckSec?: number };

/** Defensive alignment before a pitch (fielding side). */
export interface AlignmentRequest extends Base<'alignment'> {
  situation: Situation;
  batter: PlayerInfo;
  stance: 'L' | 'R';
  defense: { position: string; playerId: string }[];
}
export interface AlignmentDecision {
  /** Infielders play in to cut off the run at the plate. */
  infieldIn?: boolean;
  /** Middle infielders cheat toward second for the double play. */
  doublePlayDepth?: boolean;
  /** Outfield depth offset (m, + = deeper). */
  outfieldDepth?: number;
  /** Shift the infield toward the batter's pull side (0..1). */
  shift?: number;
  /** Corner infielders hug the lines (late, protecting a lead). */
  guardLines?: boolean;
}

/** Wall play: an outfielder is at the fence under a ball he may reach (fielding side). */
export interface WallPlayRequest extends Base<'wallPlay'> {
  fielder: PlayerInfo;
  /** Height of the ball when it meets the wall (m) as he perceives it, and its height above the wall top. */
  ballHeightAtWall: number;
  aboveWall: number;
  wallHeight: number;
  /** Glove reach standing, and at the top of his jump (m). */
  standingReach: number;
  jumpReach: number;
  /** Seconds until the ball meets the wall. */
  timeToWall: number;
  /** Would clear the fence (a home run unless he catches it). */
  overFence: boolean;
}
export interface WallPlayDecision {
  leap: boolean;
  /** Seconds later (+) / earlier (-) than his natural takeoff timing. */
  timing?: number;
}

// ---------------------------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------------------------

export interface PitchingChangeRequest extends Base<'pitchingChange'> {
  situation: Situation;
  current: { info: PlayerInfo; pitchCount: number; fatigue: number; line: import('./types').PitcherLine; isStarter: boolean };
  bullpen: { info: PlayerInfo; isCloser: boolean }[];
  /** Batter due up. */
  batter: PlayerInfo;
}
export interface PitchingChangeDecision {
  /** Player id from `bullpen`, or null to stay with the current pitcher. */
  replaceWith: string | null;
}

export interface PinchHitRequest extends Base<'pinchHit'> {
  situation: Situation;
  due: PlayerInfo;
  position: string;
  bench: PlayerInfo[];
  pitcher: PlayerInfo;
}
export interface PinchHitDecision {
  playerId: string | null;
}

export interface PinchRunRequest extends Base<'pinchRun'> {
  situation: Situation;
  runners: { base: number; info: PlayerInfo }[];
  bench: PlayerInfo[];
}
export type PinchRunDecision = { base: number; playerId: string } | null;

export interface IntentionalWalkRequest extends Base<'intentionalWalk'> {
  situation: Situation;
  batter: PlayerInfo;
  onDeck: PlayerInfo;
}
export interface IntentionalWalkDecision {
  walk: boolean;
}

// ---------------------------------------------------------------------------------------------

export interface DecisionMap {
  pitch: [PitchRequest, PitchDecision];
  pickoff: [PickoffRequest, PickoffDecision];
  swing: [SwingRequest, SwingDecision];
  bunt: [BuntRequest, BuntDecision];
  lead: [LeadRequest, LeadDecision];
  steal: [StealRequest, StealDecision];
  runner: [RunnerRequest, RunnerDecision];
  throw: [ThrowRequest, ThrowDecision];
  alignment: [AlignmentRequest, AlignmentDecision];
  pitchingChange: [PitchingChangeRequest, PitchingChangeDecision];
  pinchHit: [PinchHitRequest, PinchHitDecision];
  pinchRun: [PinchRunRequest, PinchRunDecision];
  intentionalWalk: [IntentionalWalkRequest, IntentionalWalkDecision];
  wallPlay: [WallPlayRequest, WallPlayDecision];
  coach: [CoachRequest, CoachDecision];
}
export type RequestOf<K extends DecisionKind> = DecisionMap[K][0];
export type DecisionOf<K extends DecisionKind> = DecisionMap[K][1];
export type DecisionRequest = { [K in DecisionKind]: RequestOf<K> }[DecisionKind];

export type Answer<K extends DecisionKind> = DecisionOf<K> | undefined | Pending | PromiseLike<DecisionOf<K> | undefined>;

/** Implement any subset; a missing method (or a returned `undefined`) means "let the AI decide". */
export type DecisionProvider = { [K in DecisionKind]?: (req: RequestOf<K>) => Answer<K> };

/** The complete built-in AI: every kind answered from the request alone (delegate to it from your own provider). */
export type FullDecisionProvider = { [K in DecisionKind]: (req: RequestOf<K>) => DecisionOf<K> };
