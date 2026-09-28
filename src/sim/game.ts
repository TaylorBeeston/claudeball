import { BATTER_X, ballFollowsHolder, startGame, startPlateAppearance, tickLob, tickPitch, tickPrePitch, tickWindup } from './flow';
import { tickInPlay } from './inplay';
import { afterPlayOver } from './rules';
import { stepPlayer } from './movement';
import { tickRunners } from './running';
import { createWorld } from './setup';
import { TICK } from './world';
import type { PlayerRT, World } from './world';
import type {
  BallSnapshot,
  BatSnapshot,
  BatterLine,
  GameConfig,
  GameEvent,
  GameEventType,
  GameStateSnapshot,
  PitcherLine,
  PlayerInfo,
  PlayerSnapshot,
  Team,
  TeamSide,
} from './types';

export type EventCallback = (e: GameEvent) => void;

export class Game {
  private w: World;

  constructor(cfg: GameConfig) {
    this.w = createWorld(cfg);
  }

  /** Advance the world by dtSeconds using a fixed internal step (1/240 s). Deterministic regardless of chunking. */
  step(dtSeconds: number): void {
    const w = this.w;
    w.acc += dtSeconds;
    const n = Math.floor(w.acc / TICK + 1e-9);
    w.acc -= n * TICK;
    for (let i = 0; i < n; i++) {
      if (w.phase === 'final' && w.tick > 0 && w.gameOver) {
        w.tick++;
        for (const t of [w.teams.home, w.teams.away]) for (const p of t.players.values()) if (p.onField) stepPlayer(p, w);
        continue;
      }
      this.tick();
    }
  }

  /** Simulate until the game ends (or maxSeconds of sim time pass). Returns the number of sim seconds simulated. */
  simulateToEnd(maxSeconds = 4 * 3600): number {
    const w = this.w;
    const start = w.tick;
    while (!w.gameOver && (w.tick - start) * TICK < maxSeconds) this.tick();
    return (w.tick - start) * TICK;
  }

  get over(): boolean {
    return this.w.gameOver;
  }

  private tick(): void {
    const w = this.w;
    w.tick++;
    switch (w.phase) {
      case 'pregame':
        startGame(w);
        break;
      case 'halfBreak':
        if (w.tick >= w.phaseUntil) startPlateAppearance(w);
        break;
      case 'prePitch':
        if (w.ball.lob) tickLob(w);
        else if (w.ball.holder) ballFollowsHolder(w);
        tickPrePitch(w);
        tickRunners(w);
        break;
      case 'windup':
        ballFollowsHolder(w);
        tickWindup(w);
        tickRunners(w);
        break;
      case 'pitch':
        tickPitch(w);
        tickRunners(w);
        break;
      case 'inPlay':
        tickInPlay(w);
        break;
      case 'playOver':
        if (w.ball.lob) tickLob(w);
        else if (w.ball.holder) ballFollowsHolder(w);
        tickRunners(w);
        if (w.swing && !w.swing.done && w.swingStarted) w.swing.advance(TICK);
        if (w.tick >= w.phaseUntil) afterPlayOver(w);
        break;
      case 'final':
        break;
    }
    if (w.gameOver && w.phase !== 'final') return;
    for (const t of [w.teams.home, w.teams.away]) for (const p of t.players.values()) if (p.onField) stepPlayer(p, w);
  }

  on<T extends GameEventType>(type: T, cb: (e: Extract<GameEvent, { type: T }>) => void): () => void;
  on(type: '*', cb: EventCallback): () => void;
  on(type: GameEventType | '*', cb: (e: never) => void): () => void {
    let s = this.w.listeners.get(type);
    if (!s) {
      s = new Set();
      this.w.listeners.set(type, s);
    }
    s.add(cb as EventCallback);
    return () => this.off(type, cb as EventCallback);
  }

  off(type: GameEventType | '*', cb: EventCallback): void {
    this.w.listeners.get(type)?.delete(cb);
  }

  /** Return and clear the queued events since the last drain. */
  drainEvents(): GameEvent[] {
    const e = this.w.events;
    this.w.events = [];
    return e;
  }

  getTeams(): { home: Team; away: Team } {
    return { home: this.w.teams.home.team, away: this.w.teams.away.team };
  }

  getBoxScore() {
    const w = this.w;
    const side = (t: typeof w.teams.home) => ({
      name: t.team.name,
      runs: t.runs,
      hits: t.hits,
      errors: t.errors,
      linescore: [...t.linescore],
      batters: t.team.roster
        .filter((p) => t.players.get(p.id)!.used)
        .map((p) => ({ id: p.id, name: p.name, line: { ...t.players.get(p.id)!.bat } as BatterLine })),
      pitchers: t.team.roster
        .filter((p) => p.isPitcher && t.players.get(p.id)!.pit.pitches > 0)
        .map((p) => ({ id: p.id, name: p.name, line: { ...t.players.get(p.id)!.pit } as PitcherLine })),
    });
    return { home: side(w.teams.home), away: side(w.teams.away), winner: w.winner, inning: w.inning };
  }

  getState(): GameStateSnapshot {
    return snapshot(this.w);
  }

  /** Internal access for tests and tooling. */
  get _world(): World {
    return this.w;
  }
}

export function createGame(cfg: GameConfig): Game {
  return new Game(cfg);
}

// ---------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------

function animOf(w: World, p: PlayerRT): { anim: PlayerSnapshot['anim']; t: number } {
  if (w.tick < p.animUntil) return { anim: p.anim, t: Math.min(1, (w.tick - p.animStart) / Math.max(1, p.animDur)) };
  if (p.anim === 'celebrate' && w.gameOver) return { anim: 'celebrate', t: 0 };
  const sp = Math.hypot(p.vx, p.vz);
  if (sp > 1.2) return { anim: 'run', t: 0 };
  return { anim: 'idle', t: 0 };
}

function snapPlayer(w: World, p: PlayerRT, role: PlayerSnapshot['role']): PlayerSnapshot {
  const a = animOf(w, p);
  return {
    id: p.info.id,
    name: p.info.name,
    team: p.team.side,
    role,
    position: (p.fieldPos ?? p.info.primaryPosition) as PlayerSnapshot['position'],
    jersey: p.info.jersey,
    pos: { x: p.x, y: 0, z: p.z },
    vel: { x: p.vx, y: 0, z: p.vz },
    facing: p.facing,
    anim: a.anim,
    animT: a.t,
    hasBall: p.hasBall,
    bats: p.info.bats,
    throws: p.info.throws,
    height: p.info.height,
  };
}

function snapshot(w: World): GameStateSnapshot {
  const players: PlayerSnapshot[] = [];
  const seen = new Set<PlayerRT>();
  for (const [pos, p] of w.fieldingTeam.defense) {
    if (!p.onField) continue;
    seen.add(p);
    players.push(snapPlayer(w, p, pos === 'P' ? 'pitcher' : pos === 'C' ? 'catcher' : 'fielder'));
  }
  for (const r of w.runners) {
    if (seen.has(r.p) || !r.p.onField) continue;
    seen.add(r.p);
    players.push(snapPlayer(w, r.p, 'runner'));
  }
  if (w.batter && w.batter.onField && !seen.has(w.batter)) {
    seen.add(w.batter);
    players.push(snapPlayer(w, w.batter, 'batter'));
  }
  for (const u of w.umpires) {
    players.push({
      id: u.id,
      name: u.name,
      team: 'home',
      role: 'umpire',
      position: u.position,
      jersey: 0,
      pos: { x: u.x, y: 0, z: u.z },
      vel: { x: 0, y: 0, z: 0 },
      facing: Math.atan2(-u.x, u.position === 'HP' ? 20 : 30 - u.z),
      anim: 'idle',
      animT: 0,
      hasBall: false,
      bats: 'R',
      throws: 'R',
      height: 1.8,
    });
  }
  const b = w.ball.body;
  const ball: BallSnapshot = {
    pos: { x: b.x, y: b.y, z: b.z },
    vel: { x: b.vx, y: b.vy, z: b.vz },
    spin: { x: b.wx, y: b.wy, z: b.wz },
    mode: w.ball.mode,
    holderId: w.ball.holder ? w.ball.holder.info.id : null,
    inPlay: w.phase === 'inPlay' || w.phase === 'pitch',
  };
  const side = w.batStance === 'R' ? 1 : -1;
  let bat: BatSnapshot;
  if (w.swing && w.swingStarted && w.batter && (w.phase === 'pitch' || w.phase === 'inPlay' || w.phase === 'playOver')) {
    const pose = w.swing.pose();
    bat = { active: true, batterId: w.batter.info.id, knob: pose.knob, tip: pose.tip, swingT: w.swing.progress };
  } else if (w.batter && (w.phase === 'prePitch' || w.phase === 'windup' || w.phase === 'pitch')) {
    // ready stance: bat cocked over the back shoulder
    const bx = w.batter.x;
    bat = {
      active: false,
      batterId: w.batter.info.id,
      knob: { x: bx + side * 0.05, y: 1.3, z: w.batter.z - 0.1 },
      tip: { x: bx + side * 0.1, y: 1.95, z: w.batter.z - 0.45 },
      swingT: -1,
    };
  } else {
    bat = { active: false, batterId: null, knob: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 0 }, swingT: -1 };
  }
  const runnerAt = (base: number) => {
    const r = w.runners.find((q) => q.state === 'live' && q.base === base && !(q.isBatter && q.base === 0));
    return r ? { playerId: r.p.info.id, name: r.p.info.name } : null;
  };
  const z = w.zone;
  const info = (p: PlayerRT): PlayerInfo => p.info;
  return {
    time: w.tick * TICK,
    phase: w.phase,
    inning: w.inning,
    half: w.half,
    outs: w.outs,
    balls: w.count.balls,
    strikes: w.count.strikes,
    score: { home: w.teams.home.runs, away: w.teams.away.runs },
    linescore: { home: [...w.teams.home.linescore], away: [...w.teams.away.linescore] },
    runners: { first: runnerAt(1), second: runnerAt(2), third: runnerAt(3) },
    batter: w.batter ? { info: info(w.batter), line: { ...w.batter.bat } } : null,
    pitcher: w.pitcher ? { info: info(w.pitcher), line: { ...w.pitcher.pit }, pitchCount: w.pitcher.pitchCount, fatigue: w.pitcher.fatigue } : null,
    ball,
    bat,
    players,
    umpire: { lastCall: w.lastCall, zone: { left: z.left, right: z.right, bottom: z.bottom, top: z.top, depthZ: 0.4318 } },
    lastPlay: w.lastPlay,
    gameOver: w.gameOver,
    winner: w.winner,
    teams: {
      home: { name: w.teams.home.team.name, abbrev: w.teams.home.team.abbrev },
      away: { name: w.teams.away.team.name, abbrev: w.teams.away.team.abbrev },
    },
  };
}

export type { TeamSide };
export { BATTER_X };
