/**
 * Adapter from the real simulation (`src/sim`: `createGame`, `GameStateSnapshot`, `GameEvent`)
 * to the engine's own `GameLike` contract (`types.ts`). Structural types only, so the engine
 * compiles whether or not `src/sim` exists.
 */
import type { AnimHint, GameEvent, GameLike, GameState, PersonInfo, PlayerRole, PlayerSnap, TeamInfo, TeamStatsView, Vec3 } from './types';
import { windupSeconds } from './pitchTiming';
import { BASES } from './dims';

type V = Vec3;
interface RSPlayer {
  id: string; name: string; team: 'home' | 'away'; role: string; position: string; jersey: number;
  pos: V; vel: V; facing: number; anim: AnimHint; animT: number; bats: 'L' | 'R' | 'S'; throws: 'L' | 'R';
  hasBall?: boolean;
  physique?: PlayerSnap['physique'];
  appearance?: PlayerSnap['appearance'];
  delivery?: PlayerSnap['delivery'];
  ratings?: Record<string, number>;
}
interface RSInfo {
  id: string; name: string; jersey: number; bats: 'L' | 'R' | 'S'; throws: 'L' | 'R'; height?: number; primaryPosition?: string;
  ratings?: Record<string, number>; arsenal?: { type: string; mph: number; grade?: number }[];
}
interface RSState {
  time: number; phase: string; inning: number; half: 'top' | 'bottom'; outs: number; balls: number; strikes: number;
  score: { home: number; away: number };
  runners: { first: unknown | null; second: unknown | null; third: unknown | null };
  batter: { info: RSInfo; line: { ab: number; h: number; hr: number; rbi: number } } | null;
  pitcher: { info: RSInfo; line: { outs: number; so: number; er: number }; pitchCount: number } | null;
  ball: { pos: V; vel: V; spin: V; mode: string; inPlay: boolean };
  bat: { active: boolean; knob: V; tip: V; swingT: number };
  players: RSPlayer[];
  umpire: { lastCall: { kind: string; time: number } | null };
  gameOver: boolean;
  winner: 'home' | 'away' | null;
  teams: { home: { name: string; abbrev: string }; away: { name: string; abbrev: string } };
  stats?: { home: TeamStatsView; away: TeamStatsView };
}
type RSEvent = { type: string; time: number } & Record<string, unknown>;
export interface RealGame {
  step(dt: number): void;
  getState(): RSState;
  on(type: '*', cb: (e: RSEvent) => void): () => void;
}

export function looksLikeRealSim(state: unknown): boolean {
  const s = state as Record<string, unknown>;
  return !!s && typeof s.phase === 'string' && typeof s.umpire === 'object';
}

const MPH = 0.44704;
const POS_ROLE: Record<string, PlayerRole> = {
  P: 'pitcher', C: 'catcher', '1B': 'first', '2B': 'second', '3B': 'third', SS: 'short', LF: 'left', CF: 'center', RF: 'right', DH: 'first',
};
/** Nominal clip lengths (s) used only to convert the sim's 0..1 progress for the procedural fallback rig. */
const NOMINAL: Partial<Record<AnimHint, number>> = { windup: 1.2, pitch: 0.55, swing: 0.4, throw: 0.6, catch: 0.5, field: 0.6, slide: 0.8, catch_jump: 1.2, transfer: 0.5, toss: 0.7 };

const PALETTE: [string, string][] = [
  ['#b3202f', '#161616'], ['#f4f4f0', '#12305f'], ['#0c2340', '#c8102e'], ['#1d6b3c', '#f2c94c'],
  ['#e07a1f', '#1a1a1a'], ['#5b2a86', '#e8e8e8'], ['#0a5ea8', '#ffffff'], ['#7a1f2b', '#d8c18a'],
];
function teamInfo(t: { name: string; abbrev: string }, side: number): TeamInfo {
  let h = side * 7;
  for (const c of t.abbrev) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [color, trim] = PALETTE[h % PALETTE.length];
  return { name: t.name, abbr: t.abbrev, color, trim };
}

function quatFromTo(a: V, b: V) {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < -0.9999) return { x: 1, y: 0, z: 0, w: 0 };
  const q = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x, w: 1 + d };
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

const CALL_KIND: Record<string, GameState['umpireCall']['kind']> = {
  ball: 'ball', strikeLooking: 'strike', strikeSwinging: 'strike', foul: 'foul', foulTip: 'foul', out: 'out', safe: 'safe', homeRun: 'homerun',
};

export class RealSimAdapter implements GameLike {
  private listeners = new Set<(e: GameEvent) => void>();
  private teams: { away: TeamInfo; home: TeamInfo } | null = null;
  private callSeq = 0;
  private lastCallTime = -1;
  private last: GameState | null = null;
  private names = new Map<string, string>();
  /** the sim stops the ball where it crosses the fence; the renderer lets it fly on into the seats (visual only, the outcome is decided) */
  private carry: { t0: number; p: V; v: V; landedAt: number } | null = null;

  constructor(private g: RealGame) {
    g.on('*', (e) => this.onEvent(e));
  }

  step(dt: number) {
    this.g.step(dt);
  }
  on(cb: (e: GameEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(e: GameEvent) {
    for (const l of this.listeners) l(e);
  }

  private who(id: unknown) {
    return this.names.get(String(id)) ?? 'The fielder';
  }

  private onEvent(e: RSEvent) {
    const s = this.last;
    switch (e.type) {
      case 'pitchReleased':
        this.emit({ type: 'pitch', pitchType: String(e.pitchType), speed: Number(e.mph) * MPH, pitcherId: String(e.pitcherId) });
        break;
      case 'contact':
        this.emit({ type: 'contact', exitVelo: Number(e.exitMph) * MPH, launchAngle: Number(e.launchDeg), sprayAngle: Number(e.sprayDeg), batterId: String(e.batterId) });
        break;
      case 'catch':
        this.emit({ type: 'catch', playerId: String(e.fielderId), inAir: !!e.fly });
        break;
      case 'fielded':
        this.emit({ type: 'catch', playerId: String(e.fielderId), inAir: false });
        break;
      case 'throw': {
        let target: V = { x: 0, y: 1.2, z: 0 };
        const toBase = e.toBase as number | null;
        if (toBase && toBase >= 1 && toBase <= 3) target = { x: BASES[toBase - 1].x, y: 1.2, z: BASES[toBase - 1].z };
        else if (e.toId) {
          const p = s?.players.find((q) => q.id === e.toId);
          if (p) target = { ...p.pos, y: 1.2 };
        }
        this.emit({ type: 'throw', playerId: String(e.fromId), target, targetId: e.toId ? String(e.toId) : undefined });
        break;
      }
      case 'out':
        this.emit({ type: 'out', playerId: String(e.playerId), text: `${this.who(e.playerId)} is out (${String(e.outType)}).` });
        break;
      case 'safe':
        this.emit({ type: 'play', text: `${this.who(e.playerId)} is safe.` });
        break;
      case 'runScored':
        this.emit({ type: 'run', playerId: String(e.playerId), text: `${this.who(e.playerId)} scores.` });
        break;
      case 'homeRun': {
        const v = s?.ball.vel;
        const p = (e.pos as V | undefined) ?? s?.ball.pos;
        if (p && v) this.carry = { t0: Number(e.time), p: { ...p }, v: { ...v }, landedAt: -1 };
        this.emit({ type: 'homerun', batterId: String(e.batterId), distance: Number(e.distance), pos: e.pos as V | undefined });
        this.emit({ type: 'run', playerId: String(e.batterId), text: `HOME RUN! ${this.who(e.batterId)} — ${Math.round(Number(e.distance) * 3.28084)} ft.` });
        break;
      }
      case 'baseTouch':
        this.emit({ type: 'base_touch', playerId: String(e.playerId), base: Number(e.base), trot: !!e.trot, pos: e.pos as V | undefined });
        break;
      case 'robbedHomeRun':
        this.carry = null;
        this.emit({ type: 'robbed_hr', playerId: String(e.fielderId), batterId: String(e.batterId), distance: Number(e.distance), pos: e.pos as V | undefined });
        this.emit({ type: 'play', text: `${this.who(e.fielderId)} robs ${this.who(e.batterId)} of a home run!` });
        break;
      case 'wallContact':
        this.emit({ type: 'wall_contact', who: e.who === 'fielder' ? 'fielder' : 'ball', playerId: e.fielderId ? String(e.fielderId) : undefined, pos: e.pos as V, speed: Number(e.speed) });
        break;
      case 'wallLeap':
        this.emit({ type: 'wall_leap', playerId: String(e.fielderId), pos: e.pos as V | undefined });
        break;
      case 'walk':
        this.emit({ type: 'play', text: `${this.who(e.batterId)} draws a walk.` });
        break;
      case 'call': {
        const kind = (e.call as { kind: string }).kind;
        if (kind === 'ball') this.emit({ type: 'ball' });
        else if (kind === 'strikeLooking' || kind === 'strikeSwinging') this.emit({ type: 'strike' });
        else if (kind === 'foul' || kind === 'foulTip') this.emit({ type: 'foul' });
        break;
      }
      case 'halfInningEnd': {
        // announce the half that is about to start
        const top = e.half === 'top';
        this.emit({ type: 'half_inning', inning: top ? Number(e.inning) : Number(e.inning) + 1, half: top ? 'bottom' : 'top' });
        break;
      }
      case 'playEnd':
        if (e.description) this.emit({ type: 'play', text: String(e.description) });
        break;
      case 'gameEnd':
        this.emit({ type: 'game_end', winner: e.winner as 'home' | 'away' });
        break;
    }
  }

  /** Ballistic flight (gravity + light drag) from the fence crossing while the sim's ball sits frozen there. */
  private applyCarry(st: GameState, simBall: V) {
    const c = this.carry!;
    const dt = st.time - c.t0;
    const frozen = Math.hypot(simBall.x - c.p.x, simBall.y - c.p.y, simBall.z - c.p.z) < 0.5;
    if (!frozen || dt < 0 || dt > 12) {
      this.carry = null;
      return;
    }
    const k = Math.exp(-0.05 * dt);
    const y = c.p.y + c.v.y * dt - 4.905 * dt * dt;
    let land = c.landedAt;
    if (land < 0 && y <= 0.1) land = this.carry!.landedAt = dt;
    const t = land >= 0 ? land : dt;
    const yy = land >= 0 ? 0.1 : y;
    const vy = c.v.y - 9.81 * t;
    st.ball = {
      ...st.ball,
      pos: { x: c.p.x + c.v.x * t * (1 + k) * 0.5, y: yy, z: c.p.z + c.v.z * t * (1 + k) * 0.5 },
      vel: land >= 0 ? { x: 0, y: 0, z: 0 } : { x: c.v.x * k, y: vy, z: c.v.z * k },
      visible: land < 0 || dt - land < 1.5,
    };
  }

  getState(): GameState {
    const s = this.g.getState();
    if (!this.teams) this.teams = { away: teamInfo(s.teams.away, 0), home: teamInfo(s.teams.home, 1) };
    const pitcherThrows = s.pitcher?.info.throws ?? 'R';
    const players: PlayerSnap[] = s.players.map((p) => {
      this.names.set(p.id, p.name);
      const role: PlayerRole = p.role === 'fielder' ? (POS_ROLE[p.position] ?? 'center') : (p.role as PlayerRole);
      const isBat = p.role === 'batter';
      const hand = isBat ? (p.bats === 'S' ? (pitcherThrows === 'R' ? 'L' : 'R') : p.bats) : p.throws;
      const nominal = NOMINAL[p.anim];
      // a pitcher's windup lasts as long as the sim's delivery (tempo, holding, stretch); everything else uses a nominal clip length
      const dur = p.anim === 'windup' && p.delivery ? windupSeconds(p.delivery.tempo, p.delivery.fromStretch, p.ratings?.holding ?? 50) : p.anim === 'pitch' ? 0.5 : nominal;
      return {
        id: p.id, team: p.role === 'umpire' ? -1 : p.team === 'away' ? 0 : 1, role, name: p.name, number: p.jersey, hand,
        pos: p.pos, facing: p.facing, vel: p.vel, anim: p.anim,
        animTime: dur ? p.animT * dur : undefined, animProgress: dur ? p.animT : undefined, animDur: dur,
        hasBall: p.hasBall, physique: p.physique, appearance: p.appearance, delivery: p.delivery, ratings: p.ratings,
      };
    });
    const knob = s.bat.knob, tip = s.bat.tip;
    const dir = { x: tip.x - knob.x, y: tip.y - knob.y, z: tip.z - knob.z };
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const call = s.umpire.lastCall;
    if (call && call.time !== this.lastCallTime) {
      this.lastCallTime = call.time;
      this.callSeq++;
    }
    const person = (i: RSInfo, stats: string): PersonInfo => ({ id: i.id, name: i.name, number: i.jersey, hand: i.throws, stats, ratings: i.ratings, arsenal: i.arsenal, height: i.height, position: i.primaryPosition });
    const b = s.batter;
    const p = s.pitcher;
    const st: GameState = {
      time: s.time,
      ball: { pos: s.ball.pos, vel: s.ball.vel, spin: s.ball.spin, visible: s.ball.mode !== 'dead' || s.ball.inPlay },
      bat: { visible: s.bat.active, pos: knob, quat: quatFromTo({ x: 0, y: 1, z: 0 }, { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl }) },
      players,
      umpireCall: { seq: this.callSeq, kind: call ? (CALL_KIND[call.kind] ?? 'none') : 'none' },
      count: { balls: s.balls, strikes: s.strikes },
      outs: s.outs,
      inning: s.inning,
      half: s.half,
      score: { away: s.score.away, home: s.score.home },
      runners: [!!s.runners.first, !!s.runners.second, !!s.runners.third],
      batter: b ? { ...person(b.info, `${b.line.ab ? (b.line.h / b.line.ab).toFixed(3).replace(/^0/, '') : '.000'} AVG  ${b.line.hr} HR  ${b.line.rbi} RBI`), hand: b.info.bats === 'S' ? (pitcherThrows === 'R' ? 'L' : 'R') : b.info.bats } : null,
      pitcher: p ? person(p.info, `${Math.floor(p.line.outs / 3)}.${p.line.outs % 3} IP  ${p.line.so} K  ${p.pitchCount} P`) : null,
      teams: this.teams,
      over: s.gameOver,
      stats: s.stats ? { away: s.stats.away, home: s.stats.home } : undefined,
      pitchCount: p?.pitchCount,
    };
    if (this.carry) this.applyCarry(st, s.ball.pos);
    this.last = st;
    return st;
  }
}
