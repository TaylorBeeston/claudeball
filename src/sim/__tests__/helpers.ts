import { createGame, Game } from '../game';
import { beginBattedBall } from '../inplay';
import { makeRunner } from '../running';
import { giveBall } from '../util';
import type { GameConfig, GameEvent } from '../types';
import type { RunnerRT, World } from '../world';
import { BASE_POS } from '../field';
import { MPH, DEG } from '../math';

export interface Lab {
  g: Game;
  w: World;
  events: GameEvent[];
}

/** A game advanced to the first pre-pitch moment, with every event recorded. */
export function lab(seed: string | number, cfg: Partial<GameConfig> = {}): Lab {
  const g = createGame({ seed, pace: 0, ...cfg });
  const w = g._world;
  const events: GameEvent[] = [];
  g.on('*', (e) => events.push(e));
  for (let i = 0; i < 2000 && !(w.phase === 'prePitch' && w.batter); i++) g.step(0.05);
  w.ball.lob = null;
  for (const r of w.runners) r.p.onField = false;
  w.runners = [];
  w.outs = 0;
  giveBall(w, w.pitcher);
  w.count = { balls: 0, strikes: 0 };
  return { g, w, events };
}

export function addRunner(w: World, base: number, k = 1): RunnerRT {
  const bt = w.battingTeam;
  const p = bt.lineup[(bt.batIdx + k) % 9].player;
  const r = makeRunner(w, p, false);
  r.base = base;
  r.target = base;
  r.want = base;
  r.origin = base;
  r.touched[base] = true;
  const bp = BASE_POS[base];
  p.x = bp.x;
  p.z = bp.z;
  p.vx = p.vz = 0;
  p.goal = null;
  return r;
}

/** Inject a bat-ball contact (the swing physics is tested separately): exit speed mph, launch and spray in degrees (+ spray = toward 3B). */
export function hitBall(w: World, mph: number, launchDeg: number, sprayDeg: number, spinRpm = 0): void {
  const b = w.ball.body;
  const v = mph * MPH;
  const L = launchDeg * DEG;
  const S = sprayDeg * DEG;
  if (w.ball.holder) {
    w.ball.holder.hasBall = false;
    w.ball.holder = null;
  }
  b.x = 0;
  b.y = 1.0;
  b.z = 0.7;
  b.vx = v * Math.sin(S) * Math.cos(L);
  b.vy = v * Math.sin(L);
  b.vz = v * Math.cos(S) * Math.cos(L);
  // backspin: omega = vhat x up (right-hand rule) gives lift
  const hv = Math.hypot(b.vx, b.vz) || 1;
  const rpm = (spinRpm * 2 * Math.PI) / 60;
  b.wx = (-b.vz / hv) * rpm;
  b.wy = 0;
  b.wz = (b.vx / hv) * rpm;
  b.rolling = false;
  w.phase = 'pitch';
  w.ball.mode = 'batted';
  beginBattedBall(w, { s: 0.65, exitSpeed: v, launchDeg, sprayDeg, spinRpm, offsetY: 0 });
}

/** Run until the play is over (phase leaves inPlay) or timeout seconds pass. */
export function runPlay(l: Lab, timeout = 60): void {
  const t0 = l.w.tick;
  while (l.w.phase === 'inPlay' && (l.w.tick - t0) / 240 < timeout) l.g.step(0.02);
}

export const ofType = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e) => e.type === type) as Extract<GameEvent, { type: T }>[];
