/**
 * Thin adapter between the simulation and the renderer. The engine never
 * reaches into the sim directly: it talks to `SimDriver`, which
 *  - picks the real sim (`src/sim`) when present, else the mock,
 *  - runs it on a fixed timestep accumulator (render rate independent),
 *  - exposes interpolated snapshots for smooth rendering,
 *  - records recent history so the broadcast can replay the last play.
 */
import type { GameEvent, GameLike, GameState, PlayerSnap, Vec3 } from './types';
import { MockGame } from './mockSim';
import { RealSimAdapter, looksLikeRealSim, type RealGame } from './realSimAdapter';
import { lerpAngle } from './dims';

type CreateGame = (opts: { seed: number }) => GameLike;

// `import.meta.glob` resolves to {} when src/sim does not exist yet.
const simModules = import.meta.glob('../sim/index.ts', { eager: true }) as Record<string, { createGame?: CreateGame }>;

export function createSimSource(seed: number, forceMock = false): { game: GameLike; kind: 'sim' | 'mock' } {
  const mod = Object.values(simModules)[0];
  if (!forceMock && mod?.createGame) {
    const g = mod.createGame({ seed });
    // the real sim exposes its own snapshot/event shapes; wrap them into the engine contract
    if (looksLikeRealSim(g.getState())) return { game: new RealSimAdapter(g as unknown as RealGame), kind: 'sim' };
    return { game: g, kind: 'sim' };
  }
  return { game: new MockGame(seed), kind: 'mock' };
}

export interface TimedEvent {
  simTime: number;
  event: GameEvent;
}

export const SIM_DT = 1 / 120;
const HISTORY_DT = 1 / 60;
const HISTORY_SECONDS = 75; // a home-run replay starts after the whole trot

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

/** Interpolate between two snapshots for rendering (discrete fields come from `b`). */
export function interpolateState(a: GameState, b: GameState, t: number): GameState {
  if (t >= 1 || a === b) return b;
  const prev = new Map<string, PlayerSnap>();
  for (const p of a.players) prev.set(p.id, p);
  const players = b.players.map((p) => {
    const q = prev.get(p.id);
    if (!q) return p;
    // teleport guard (position swaps between plays)
    if (Math.hypot(p.pos.x - q.pos.x, p.pos.z - q.pos.z) > 8) return p;
    return { ...p, pos: lerp3(q.pos, p.pos, t), facing: lerpAngle(q.facing, p.facing, t) };
  });
  const jump = Math.hypot(b.ball.pos.x - a.ball.pos.x, b.ball.pos.y - a.ball.pos.y, b.ball.pos.z - a.ball.pos.z) > 6;
  return {
    ...b,
    time: lerp(a.time, b.time, t),
    ball: jump ? b.ball : { ...b.ball, pos: lerp3(a.ball.pos, b.ball.pos, t) },
    bat: { ...b.bat, pos: lerp3(a.bat.pos, b.bat.pos, t) },
    players,
  };
}

export class SimDriver {
  readonly game: GameLike;
  readonly kind: 'sim' | 'mock';
  speed = 1;
  paused = false;
  /** set by the camera director while a replay plays: the live game waits (unlike `paused`, animations keep running) */
  hold = false;
  /** true while fast-forwarding to the next half inning; listeners should not cut cameras */
  skipping = false;

  private acc = 0;
  private prev: GameState;
  private curr: GameState;
  private listeners = new Set<(e: TimedEvent) => void>();
  private histAcc = 0;
  readonly history: GameState[] = [];
  private historyEvents: TimedEvent[] = [];
  private skipTarget: { inning: number; half: 'top' | 'bottom' } | null = null;
  private stepsThisFrame = 0;
  private crossListeners = new Set<(x: number, y: number, inZone: boolean) => void>();

  constructor(seed = 20260928, forceMock = false) {
    const src = createSimSource(seed, forceMock);
    this.game = src.game;
    this.kind = src.kind;
    this.curr = this.prev = this.game.getState();
    this.game.on((event) => {
      const te = { simTime: this.curr.time, event };
      this.historyEvents.push(te);
      if (this.historyEvents.length > 200) this.historyEvents.shift();
      for (const l of this.listeners) l(te);
    });
  }

  on(cb: (e: TimedEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Fires when a pitched ball crosses the front of the plate (derived from ball state). */
  onPitchCross(cb: (x: number, y: number, inZone: boolean) => void) {
    this.crossListeners.add(cb);
  }

  get state() {
    return this.curr;
  }

  skipToNextHalfInning() {
    this.skipTarget = { inning: this.curr.inning, half: this.curr.half };
    this.skipping = true;
  }

  /** Advance by a real-time delta; returns interpolation alpha for rendering. */
  advance(realDt: number): { state: GameState; alpha: number; steps: number } {
    let steps = 0;
    const budgetEnd = performance.now() + 10;
    if (!this.paused && !this.hold) {
      this.acc += Math.min(realDt, 0.1) * this.speed;
      const maxSteps = 600;
      while (this.acc >= SIM_DT && steps < maxSteps) {
        this.stepOnce();
        this.acc -= SIM_DT;
        steps++;
        if (performance.now() > budgetEnd && !this.skipping) break;
      }
      if (this.skipping) {
        // fast-forward until the half inning flips (bounded per frame)
        const t1 = performance.now() + 12;
        while (this.skipping && performance.now() < t1) {
          this.stepOnce();
          steps++;
          const s = this.curr;
          if (this.skipTarget && (s.inning !== this.skipTarget.inning || s.half !== this.skipTarget.half || s.over)) {
            this.skipping = false;
            this.skipTarget = null;
            this.acc = 0;
          }
        }
      }
      if (this.acc > SIM_DT * 4) this.acc = 0; // fell behind: drop time rather than spiral
    }
    this.stepsThisFrame = steps;
    return { state: interpolateState(this.prev, this.curr, this.acc / SIM_DT), alpha: this.acc / SIM_DT, steps };
  }

  private stepOnce() {
    this.game.step(SIM_DT);
    this.prev = this.curr;
    this.curr = this.game.getState();
    const a = this.prev.ball, b = this.curr.ball;
    if (b.visible && a.visible && a.pos.z > 0 && b.pos.z <= 0 && b.vel.z < -5 && !this.skipping) {
      const f = a.pos.z / (a.pos.z - b.pos.z);
      const x = a.pos.x + (b.pos.x - a.pos.x) * f, y = a.pos.y + (b.pos.y - a.pos.y) * f;
      const inZone = Math.abs(x) < 0.216 + 0.036 && y > 0.5 - 0.036 && y < 1.05 + 0.036;
      for (const l of this.crossListeners) l(x, y, inZone);
    }
    this.histAcc += SIM_DT;
    if (this.histAcc >= HISTORY_DT) {
      this.histAcc -= HISTORY_DT;
      this.history.push(this.curr);
      const cap = Math.ceil(HISTORY_SECONDS / HISTORY_DT);
      if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
    }
  }

  get lastStepCount() {
    return this.stepsThisFrame;
  }

  recentEvents(sinceSimTime: number): TimedEvent[] {
    return this.historyEvents.filter((e) => e.simTime >= sinceSimTime);
  }
}
