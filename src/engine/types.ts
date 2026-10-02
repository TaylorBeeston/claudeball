/**
 * Sim contract, engine side. Metric units, origin at home plate, +Y up,
 * +Z toward center field, +X toward THIRD base (1B is at -X; from behind the plate 1B is on the right). The engine only
 * renders what the sim reports; nothing here decides game outcomes.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

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
  /** home-run / dead-ball jog, rounding a base, an outfielder leaping at the wall */
  | 'trot'
  | 'run_turn'
  | 'catch_jump'
  /** easy walk / jog back to position (the sim reports it below ~2 m/s) */
  | 'walk'
  /** glove-to-hand ball transfer, standing */
  | 'transfer'
  /** easy casual throw (return throws after routine outs) */
  | 'toss'
  /** glove out, facing the thrower, waiting for a throw that has not left his hand yet (pitcher before the catcher's return) */
  | 'catch_ready'
  | 'pitcher_catch_toss'
  // catches: the glove meets the ball at `gloveTarget`
  | 'catch_pitch'
  | 'catch_throw'
  | 'catch_stretch'
  | 'catch_fly'
  | 'catch_fly_run'
  | 'catch_line_drive'
  | 'catch_comebacker'
  | 'catch_backhand'
  | 'field_grounder'
  // tags and slides
  | 'tag_glove'
  | 'tag_hand'
  | 'slide_feet'
  | 'slide_head'
  | 'slide_hook_left'
  | 'slide_hook_right'
  | 'dive_back'
  | 'catcher_block'
  // umpire gestures
  | 'ump_strike'
  | 'ump_strike_swinging'
  | 'ump_ball'
  | 'ump_safe'
  | 'ump_out'
  | 'ump_foul'
  | 'ump_fair'
  | 'ump_homerun'
  | 'ump_time'
  | 'ump_ready'
  // side cast
  | 'bench_sit'
  | 'ondeck_ready'
  | 'ondeck_swing'
  | 'coach_ready'
  | 'coach_stop'
  | 'coach_go'
  | 'coach_go_loop'
  | 'bench_cheer'
  | 'bench_stand_up'
  | 'coach_advance'
  | 'coach_slide'
  | 'coach_signs'
  | 'ballkid_sit'
  | 'ballkid_run'
  | 'ballkid_idle'
  | 'ballkid_pickup'
  | 'ballkid_toss'
  // non-pitch time (the sim's `tempo`): walk-ups, signs, shake-offs, mound visits, pitching changes
  | 'batter_step_in'
  | 'batter_practice_swing'
  | 'batter_adjust'
  | 'batter_step_out'
  | 'catcher_signs'
  | 'catcher_signal_infield'
  | 'pitcher_shake_off'
  | 'pitcher_nod'
  | 'pitcher_step_off'
  | 'pitcher_rosin'
  | 'pitcher_adjust'
  | 'pitcher_look_runner'
  | 'mound_talk'
  | 'mound_talk_listen'
  | 'manager_walk'
  | 'manager_signal'
  | 'pitcher_handoff'
  | 'warmup_pitch'
  | 'umpire_brush_plate'
  | 'ump_new_ball'
  | 'ump_huddle'
  | 'bullpen_throw';

export type PlayerRole =
  | 'pitcher'
  | 'catcher'
  | 'first'
  | 'second'
  | 'third'
  | 'short'
  | 'left'
  | 'center'
  | 'right'
  | 'batter'
  | 'runner'
  | 'umpire'
  | 'coach'
  /** the side cast: bench players, the on-deck batter, base coaches, ball kids (from the sim when it sends them, else made up by the engine's `SideCast`) */
  | 'bench'
  | 'ondeck'
  | 'coach1b'
  | 'coach3b'
  | 'ballkid'
  | 'batboy'
  | 'manager'
  | 'pitchcoach';

export interface PlayerSnap {
  id: string;
  /** 0 = away, 1 = home; umpires use -1 */
  team: number;
  role: PlayerRole;
  name?: string;
  number?: number;
  /** batter / thrower handedness */
  hand?: 'L' | 'R';
  pos: Vec3;
  /** yaw in radians, direction = (sin f, 0, cos f) */
  facing: number;
  vel: Vec3;
  anim: AnimHint;
  /** seconds since the animation hint began, if the sim tracks it */
  animTime?: number;
  /** 0..1 progress through a windup/swing/throw/slide style animation, if the sim reports it */
  animProgress?: number;
  /** seconds the current one-shot hint lasts (the windup's real length, tempo included), when known */
  animDur?: number;
  hasBall?: boolean;
  /** height / weight / build and looks, for per-player variety */
  physique?: { heightM: number; weightKg: number; build: 'lean' | 'athletic' | 'stocky' | 'heavy' };
  appearance?: { skin: number; hairColor: number; hairStyle: number; facialHair: number; seed: number };
  /** pitchers: mechanics; `fromStretch` is live (runners on) */
  delivery?: { style: 'overhand' | 'three_quarter' | 'sidearm' | 'submarine'; armSlotDeg: number; tempo: number; fromStretch: boolean };
  /** 20-80 scouting ratings (velocity in mph) */
  ratings?: Record<string, number>;
  /** where the ball will meet this fielder's glove (world, sim axes), while a catch is coming */
  gloveTarget?: Vec3;
  /** seconds until the catch (the hint starts the clip's catch-frame time before it, so the catch frame lands on the arrival) */
  catchIn?: number;
  /** umpires: HP, 1B-U, 2B-U, 3B-U */
  position?: string;
  /** pitchers: the pitch about to be thrown (FF, FT, SI, CH, …) when the sim says so; picks the 2-seam or 4-seam grip */
  pitchType?: string;
}

export interface BallSnap {
  pos: Vec3;
  vel: Vec3;
  /** angular velocity, rad/s */
  spin: Vec3;
  visible: boolean;
}

export interface BatSnap {
  visible: boolean;
  /** position of the bat's knob end */
  pos: Vec3;
  quat: Quat;
  /** a bat lying on the ground by the plate (the hitter ran with the ball in play) until the bat boy fetches it */
  dropped?: Vec3 | null;
}

export interface TeamInfo {
  name: string;
  abbr: string;
  /** primary jersey color, css hex */
  color: string;
  /** cap / trim color */
  trim: string;
}

export interface UmpireCall {
  seq: number;
  kind: 'none' | 'ball' | 'strike' | 'foul' | 'out' | 'safe' | 'homerun';
}

export interface PersonInfo {
  id: string;
  name: string;
  number: number;
  hand: 'L' | 'R';
  /** free-form stat line, e.g. ".291 AVG  24 HR" */
  stats?: string;
  ratings?: Record<string, number>;
  /** pitchers: the pitch mix */
  arsenal?: { type: string; mph: number; grade?: number }[];
  height?: number;
  position?: string;
}

/** Live box-score stats, as the sim reports them (see `TeamStatsSnapshot`). */
export interface StatsBat { pa: number; ab: number; h: number; doubles: number; triples: number; hr: number; bb: number; so: number; rbi: number; r: number; sb: number; avg: number; obp: number; slg: number; ops: number }
export interface StatsPit { outs: number; bf: number; h: number; r: number; er: number; bb: number; so: number; hr: number; pitches: number; strikes: number; ip: string; era: number; whip: number }
export interface StatsEntry {
  playerId: string;
  name: string;
  jersey: number;
  position: string;
  inGame: boolean;
  game: { batting: StatsBat; pitching: StatsPit | null };
  season: { batting: StatsBat; pitching: StatsPit | null };
}
export interface TeamStatsView {
  batters: StatsEntry[];
  pitchers: StatsEntry[];
  totals: { runs: number; hits: number; errors: number; lob: number };
}

export interface GameState {
  time: number;
  ball: BallSnap;
  bat: BatSnap;
  players: PlayerSnap[];
  umpireCall: UmpireCall;
  count: { balls: number; strikes: number };
  outs: number;
  inning: number;
  half: 'top' | 'bottom';
  score: { away: number; home: number };
  runners: [boolean, boolean, boolean];
  batter: PersonInfo | null;
  pitcher: PersonInfo | null;
  teams: { away: TeamInfo; home: TeamInfo };
  over: boolean;
  /** live box-score stats for both teams, when the sim provides them */
  stats?: { away: TeamStatsView; home: TeamStatsView };
  /** pitcher fatigue 0..1 and pitch count, when known */
  pitchCount?: number;
  /** the sim's finer phase ('batterRoutine', 'pitcherRoutine', 'signs', 'shakeOff', 'moundVisit', 'pitchingChange', 'review', 'break') */
  phaseDetail?: string | null;
  /** balls that are only for show (the warm-up between innings, bullpen), scene positions */
  extraBalls?: Vec3[];
  /** the sim's phase string ('prePitch', 'windup', 'inPlay', 'playOver', 'halfInningBreak', …) when it sends one */
  phase?: string;
  /** non-pitch time: the broadcast may cut away (B-roll) until it ends; absent when the sim has no `tempo` */
  lull?: Lull | null;
  /** a foul ball that nobody holds: flying / rolling / resting on the ground, carried by a ball kid (drawn by his hand), or tossed to a fan */
  deadBall?: { pos: Vec3; state: 'rolling' | 'resting' | 'carried' | 'tossed' } | null;
  /** who is on deck and on the benches (for the side cast), when the sim knows */
  side?: SideInfo;
}

/** what kind of non-pitch time the game is in (the sim's `lullKind`) */
export type LullKind = 'walkup' | 'betweenPitches' | 'moundVisit' | 'pitchingChange' | 'break' | 'review';

export interface Lull {
  kind: LullKind;
  /** seconds the lull lasts (the sim's `lullSec`: planned length at its start, or what is left; the director works out which) */
  sec: number;
  /** seconds left, when the sim says (its `lullRemaining`) */
  remaining?: number;
}

export interface SidePerson {
  id: string;
  name: string;
  number: number;
  hand: 'L' | 'R';
  physique?: PlayerSnap['physique'];
  appearance?: PlayerSnap['appearance'];
}

export interface SideInfo {
  /** 0 = away is batting, 1 = home */
  battingSide: 0 | 1;
  /** the batter on deck now (while nobody is up: the one about to step in) */
  onDeck: SidePerson | null;
  /** bench players per team ([away, home]) */
  bench: [SidePerson[], SidePerson[]];
}

export type GameEvent =
  | { type: 'pitch'; pitchType: string; speed: number; pitcherId: string }
  | { type: 'contact'; exitVelo: number; launchAngle: number; sprayAngle: number; distance?: number; batterId: string }
  | { type: 'catch'; playerId: string; inAir: boolean; pos?: Vec3; height?: number; side?: string; kind?: string; firm?: boolean }
  | { type: 'throw'; playerId: string; target: Vec3; targetId?: string }
  | { type: 'out'; playerId?: string; text?: string; closePlay?: boolean; margin?: number; base?: number | null }
  | { type: 'safe'; playerId?: string; base?: number; closePlay?: boolean; margin?: number }
  /** a fielder's tag: attempted, made or avoided by a slide / dodge */
  | { type: 'tag'; fielderId?: string; runnerId?: string; base?: number; result: 'attempt' | 'tag' | 'avoided'; pos?: Vec3; hand?: 'glove' | 'hand'; slide?: string }
  /** an umpire's call (`kind` as the sim reports it: ball, strike_called, strike_swinging, foul, fair, safe, out, homerun, foul_tip, time, ball_four, strikeout) */
  | { type: 'umpire_call'; kind: string; umpireId?: string; umpire?: string; pos?: Vec3; atBase?: number; playerId?: string }
  | { type: 'run'; playerId?: string; text?: string }
  /** the ball cleared the fence; `pos` is where it crossed it */
  | { type: 'homerun'; batterId: string; distance: number; pos?: Vec3 }
  /** a runner touched a base (base 1..3, 4 = home); `trot` when it is a dead-ball jog */
  | { type: 'base_touch'; playerId: string; base: number; trot: boolean; pos?: Vec3 }
  /** a fielder reaching over the fence took a home run away */
  | { type: 'robbed_hr'; playerId: string; batterId: string; distance: number; pos?: Vec3 }
  /** the ball met the outfield wall, or a fielder ran up to it */
  | { type: 'wall_contact'; who: 'ball' | 'fielder'; playerId?: string; pos: Vec3; speed: number }
  /** an outfielder left the ground at the wall */
  | { type: 'wall_leap'; playerId: string; pos?: Vec3 }
  /** a base coach's signal to a runner (stop / go / advance / slide) or to the batter (signs) */
  | { type: 'coach_signal'; coachId: string; signal: 'stop' | 'go' | 'advance' | 'slide' | 'signs'; runnerId?: string; base?: number; pos?: Vec3 }
  /** a ball kid picked up a ball (a foul ball) */
  | { type: 'ball_kid_retrieve'; kidId: string; pos: Vec3 }
  /** the bat boy picked up the dropped bat */
  | { type: 'bat_boy_retrieve'; batBoyId: string; pos: Vec3 }
  /** the next hitter got up and went to the on-deck circle; the one before him is out of the box */
  | { type: 'on_deck'; playerId: string; team: number }
  /** a ball kid tossed a ball to a fan in the stands; `pos` is where the fan sits */
  | { type: 'ball_tossed_to_fan'; kidId: string; pos: Vec3; from?: Vec3 }
  /** non-pitch moments from the sim's `tempo` (payloads as sent: ids, positions) */
  | { type: 'signs_given' | 'shake_off' | 'time_called' | 'mound_visit' | 'challenge' | 'pitching_change_start' | 'mound_visit_end' | 'challenge_result' | 'break_start'; playerId?: string; pos?: Vec3; data?: Record<string, unknown> }
  | { type: 'broadcast'; event: BroadcastEvent }
  | { type: 'ball' | 'strike' | 'foul' }
  | { type: 'play'; text: string }
  | { type: 'half_inning'; inning: number; half: 'top' | 'bottom' }
  | { type: 'game_end'; winner: 'away' | 'home' | 'tie' };

export interface GameLike {
  step(dt: number): void;
  getState(): GameState;
  on(cb: (e: GameEvent) => void): () => void;
}

/**
 * What the broadcast director tells the rest of the app (audio, HUD): camera transitions, replays, graphics and the B-roll shots that
 * feature a player. Delivered by `Engine.broadcast.on(cb)` and mirrored into the sim event path as `{type: 'broadcast', event}`.
 */
export type ShotLabel =
  | 'walkup' | 'ondeck' | 'faceCloseup' | 'shakeOff' | 'catcherSigns' | 'leadOff' | 'coachSigns' | 'managerWalk' | 'relieverJog' | 'relieverFace'
  | 'dugout' | 'dugoutReaction' | 'bullpen' | 'bullpenDoor' | 'crowd' | 'scoreboard' | 'aerial' | 'sky' | 'moundWide' | 'moundHuddle' | 'umpires'
  | 'coachSend' | 'kidToss';

export type BroadcastEvent =
  | { type: 'cameraCut'; kind: 'cut' | 'dissolve' | 'wipe' | 'replay' | 'broll'; from: string; to: string; durationMs: number; toBroll: boolean; simTime: number }
  | { type: 'replayStart'; variant: string; caption: string | null; slow: boolean; simTime: number }
  | { type: 'replayEnd'; variant: string; simTime: number }
  | { type: 'graphicShown'; kind: 'replay' | 'closePlay' | 'card'; subjectId?: string; simTime: number }
  | { type: 'shot'; phase: 'start' | 'end'; kind: ShotLabel; subjectId?: string; role?: string; card: boolean; holdMs: number; simTime: number };
