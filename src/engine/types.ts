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
  | 'catch_jump';

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
  | 'coach';

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
}

export type GameEvent =
  | { type: 'pitch'; pitchType: string; speed: number; pitcherId: string }
  | { type: 'contact'; exitVelo: number; launchAngle: number; sprayAngle: number; distance?: number; batterId: string }
  | { type: 'catch'; playerId: string; inAir: boolean }
  | { type: 'throw'; playerId: string; target: Vec3; targetId?: string }
  | { type: 'out'; playerId?: string; text?: string }
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
  | { type: 'ball' | 'strike' | 'foul' }
  | { type: 'play'; text: string }
  | { type: 'half_inning'; inning: number; half: 'top' | 'bottom' }
  | { type: 'game_end'; winner: 'away' | 'home' | 'tie' };

export interface GameLike {
  step(dt: number): void;
  getState(): GameState;
  on(cb: (e: GameEvent) => void): () => void;
}
