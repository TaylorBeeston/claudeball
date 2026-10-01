import { BATTER_X, ballFollowsHolder, startGame, startPlateAppearance, tickLob, tickPitch, tickPrePitch, tickWindup } from './flow';
import { tickInPlay } from './inplay';
import { afterPlayOver } from './rules';
import { stepPlayer } from './movement';
import { tickRunners } from './running';
import { createWorld } from './setup';
import { pendingDecisions, resolveDecision } from './dispatch';
import type { DecisionKind, DecisionProvider, DecisionRequest, FullDecisionProvider } from './decisions';
import { snapshot } from './snapshot';
import { tickBallReturn, tickLeavers } from './handling';
import { tickUmpires } from './umpires';
import { initDugouts, tickDugout } from './dugout';
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
    initDugouts(this.w);
  }

  /** Advance the world by dtSeconds using a fixed internal step (1/240 s). Deterministic regardless of chunking. */
  step(dtSeconds: number): void {
    const w = this.w;
    if (w.dec.waiting > 0) return; // paused: a provider has not answered yet
    w.acc += dtSeconds;
    const n = Math.floor(w.acc / TICK + 1e-9);
    w.acc -= n * TICK;
    for (let i = 0; i < n; i++) {
      if (w.dec.waiting > 0) break;
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
    while (!w.gameOver && w.dec.waiting === 0 && (w.tick - start) * TICK < maxSeconds) this.tick();
    return (w.tick - start) * TICK;
  }

  /** Questions a provider deferred (PENDING / a promise): while any is open `step()` does nothing. */
  get pendingDecisions(): DecisionRequest[] {
    return pendingDecisions(this.w);
  }

  /** Answer a deferred question (`undefined` = let the AI decide). Returns false if `id` is not waiting. */
  resolveDecision(id: number, decision: unknown): boolean {
    return resolveDecision(this.w, id, decision);
  }

  /** Replace (or clear, with null) the decision provider of a side. */
  setProvider(side: TeamSide, provider: DecisionProvider | null): void {
    this.w.dec.providers[side] = provider ?? undefined;
  }

  /** The built-in AI, kind by kind, for providers that want to delegate to it or adjust its answers. */
  get ai(): FullDecisionProvider {
    return this.w.ai;
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
        if (w.ret) tickBallReturn(w);
        else if (w.ball.lob) tickLob(w);
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
        if (w.ret) tickBallReturn(w);
        else if (w.ball.lob) tickLob(w);
        else if (w.ball.holder) ballFollowsHolder(w);
        tickRunners(w);
        if (w.swing && !w.swing.done && w.swingStarted) w.swing.advance(TICK);
        if (w.tick >= w.phaseUntil) afterPlayOver(w);
        break;
      case 'final':
        break;
    }
    if (w.gameOver && w.phase !== 'final') return;
    tickLeavers(w);
    tickDugout(w);
    tickUmpires(w);
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

export type { TeamSide };
export { BATTER_X };
