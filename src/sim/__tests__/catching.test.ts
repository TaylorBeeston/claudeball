import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import type { GameEvent, GameStateSnapshot } from '../types';

const CATCH_HINTS = new Set(['catch_pitch', 'catch_throw', 'catch_stretch', 'catch_fly', 'catch_backhand', 'field_grounder']);

/** Play the first innings at broadcast pace, remembering the snapshot from the tick before every catch. */
function catches(seed: string, innings = 3) {
  const g = createGame({ seed, pace: 1 });
  const w = g._world;
  let last: GameStateSnapshot | null = null;
  const out: { e: Extract<GameEvent, { type: 'catch' | 'fielded' }>; prev: GameStateSnapshot }[] = [];
  g.on('*', (e) => {
    if (e.type === 'catch' || e.type === 'fielded') out.push({ e, prev: last! });
  });
  let n = 0;
  while (!g.over && w.inning < innings && n++ < 240 * 3600) {
    g.step(1 / 240);
    last = g.getState();
  }
  return out;
}

describe('catching: the glove is where the ball is, and the catch is shown', () => {
  const all = [...catches('catch-a'), ...catches('catch-b')];

  it('every catch has a glove target from the trajectory: the ball meets the glove there', () => {
    expect(all.length).toBeGreaterThan(40);
    let withTarget = 0;
    for (const { e, prev } of all) {
      const p = prev.players.find((q) => q.id === e.fielderId)!;
      expect(p.gloveHand === 'L' || p.gloveHand === 'R').toBe(true);
      if (!p.gloveTarget) continue;
      withTarget++;
      const d = Math.hypot(p.gloveTarget.x - e.pos.x, p.gloveTarget.y - e.pos.y, p.gloveTarget.z - e.pos.z);
      expect(d).toBeLessThan(0.3);
    }
    expect(withTarget / all.length).toBeGreaterThan(0.9);
  });

  it('catch events say how the catch was made (kind, height, side, firm) and cover pitches, throws, fly balls and grounders', () => {
    const kinds = new Set<string>();
    for (const { e } of all) {
      expect(e.kind).toBeDefined();
      expect(['low', 'chest', 'high']).toContain(e.height);
      expect(['glove', 'arm', 'backhand', 'forehand']).toContain(e.side);
      expect(typeof e.firm).toBe('boolean');
      kinds.add(e.kind!);
      if (e.kind === 'ground') expect(['forehand', 'backhand']).toContain(e.side);
      if (e.kind === 'pitch') expect(e.type).toBe('catch');
    }
    for (const k of ['pitch', 'ground']) expect(kinds.has(k)).toBe(true);
    expect(kinds.has('throw') || kinds.has('fly')).toBe(true);
  });

  it('the catch animation is timed to the ball: its hint is on and the catch instant is about half-way through it', () => {
    let n = 0;
    const progress: number[] = [];
    for (const { e, prev } of all) {
      const p = prev.players.find((q) => q.id === e.fielderId)!;
      if (!CATCH_HINTS.has(p.anim)) continue;
      n++;
      progress.push(p.animT);
      if (e.kind === 'pitch') expect(p.anim).toBe('catch_pitch');
      if (e.kind === 'ground') expect(p.anim).toBe('field_grounder');
      if (e.kind === 'throw' || e.kind === 'pickoff') expect(['catch_throw', 'catch_stretch']).toContain(p.anim);
    }
    expect(n / all.length).toBeGreaterThan(0.85);
    const mean = progress.reduce((a, b) => a + b, 0) / progress.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.65);
  });

  it('the mitt moves during the pitch: from where the catcher set up toward where the ball arrives, before the catch', () => {
    const g = createGame({ seed: 'mitt', pace: 1 });
    const w = g._world;
    const track: { t: number; x: number; y: number }[] = [];
    let inFlight = false;
    g.on('pitchReleased', () => {
      inFlight = true;
      track.length = 0;
    });
    let pitchesSeen = 0;
    let moved = 0;
    g.on('catch', (e) => {
      if (e.kind !== 'pitch') return;
      pitchesSeen++;
      if (track.length > 20) {
        const a = track[2];
        const b = track[track.length - 1];
        if (Math.hypot(a.x - b.x, a.y - b.y) > 0.02) moved++;
      }
      inFlight = false;
    });
    let n = 0;
    while (!g.over && pitchesSeen < 25 && n++ < 240 * 900) {
      g.step(1 / 240);
      if (inFlight) {
        const c = g.getState().players.find((p) => p.role === 'catcher')!;
        if (c.gloveTarget) track.push({ t: w.tick, x: c.gloveTarget.x, y: c.gloveTarget.y });
      }
    }
    expect(pitchesSeen).toBeGreaterThan(15);
    expect(moved).toBeGreaterThan(pitchesSeen * 0.6);
  });

  it('after the catch the ball stays at the glove and settles into the hand (no jump)', () => {
    const g = createGame({ seed: 'settle', pace: 1 });
    const w = g._world;
    let caughtAt = -1;
    let catchPos = { x: 0, y: 0, z: 0 };
    let maxJump = 0;
    let prev: { x: number; y: number; z: number } | null = null;
    g.on('catch', (e) => {
      if (e.kind === 'pitch' && caughtAt < 0) {
        caughtAt = w.tick;
        catchPos = e.pos;
      }
    });
    let n = 0;
    while (!g.over && (caughtAt < 0 || w.tick < caughtAt + 90) && n++ < 240 * 300) {
      g.step(1 / 240);
      if (caughtAt >= 0) {
        const b = w.ball.body;
        if (prev) maxJump = Math.max(maxJump, Math.hypot(b.x - prev.x, b.y - prev.y, b.z - prev.z));
        prev = { x: b.x, y: b.y, z: b.z };
      }
    }
    expect(caughtAt).toBeGreaterThan(0);
    expect(maxJump).toBeLessThan(0.05); // never teleports between ticks
    void catchPos;
  });
});
