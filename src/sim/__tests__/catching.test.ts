import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { CATCH_LEAD } from '../fielding';
import { groundHeight } from '../field';
import type { GameEvent, GameStateSnapshot } from '../types';

const CATCH_HINTS = new Set(['catch_pitch', 'catch_throw', 'catch_stretch', 'catch_fly', 'catch_backhand', 'field_grounder', 'catch_fly_run', 'catch_line_drive', 'catch_comebacker']);

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
      if (e.kind === 'ground') expect(['field_grounder', 'catch_comebacker', 'catch_line_drive', 'catch_backhand']).toContain(p.anim);
      if (e.kind === 'throw' || e.kind === 'pickoff') expect(['catch_throw', 'catch_stretch']).toContain(p.anim);
    }
    expect(n / all.length).toBeGreaterThan(0.85);
    const mean = progress.reduce((a, b) => a + b, 0) / progress.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.65);
  });

  it('catchIn counts down to the catch: the hint starts CATCH_LEAD before it, so the catch frame lands on arrival', () => {
    let n = 0;
    let err = 0;
    for (const { e, prev } of all) {
      const p = prev.players.find((q) => q.id === e.fielderId)!;
      if (!CATCH_HINTS.has(p.anim) || p.catchIn == null) continue;
      n++;
      // prev is one tick before the catch, so catchIn is ~0 - and the hint's own duration is 2x its lead (catch at half-way)
      err += Math.abs(p.catchIn);
      expect(p.catchIn).toBeLessThan(0.1);
      expect(CATCH_LEAD[p.anim]).toBeGreaterThan(0.15);
    }
    expect(n / all.length).toBeGreaterThan(0.8);
    expect(err / n).toBeLessThan(0.05);
  });

  it('catchIn is exposed ahead of time: at the lead, the glove target and a positive catchIn are there', () => {
    const g = createGame({ seed: 'catchin', pace: 1 });
    const w = g._world;
    let seen = 0;
    let armedAtLead = 0;
    g.on('windup', (e) => {
      expect(typeof e.pitchType).toBe('string');
    });
    let n = 0;
    while (!g.over && seen < 15 && n++ < 240 * 900) {
      g.step(1 / 240);
      const c = g.getState().players.find((p) => p.role === 'catcher')!;
      if (c.anim === 'catch_pitch' && c.catchIn != null && c.catchIn > 0.2 && c.catchIn < 0.32) {
        seen++;
        if (c.gloveTarget) armedAtLead++;
      }
      if (w.tick > 240 * 900) break;
    }
    expect(seen).toBeGreaterThan(5);
    expect(armedAtLead).toBe(seen);
  });

  it('when a catch hint first shows, catchIn is about that hint\'s lead (the catch frame lands on arrival)', () => {
    const g = createGame({ seed: 'lead', pace: 1 });
    const prevAnim = new Map<string, string>();
    const errs: number[] = [];
    let n = 0;
    while (!g.over && errs.length < 60 && n++ < 240 * 1200) {
      g.step(1 / 240);
      for (const p of g.getState().players) {
        const was = prevAnim.get(p.id);
        prevAnim.set(p.id, p.anim);
        if (was !== p.anim && CATCH_HINTS.has(p.anim) && p.catchIn != null) errs.push(p.catchIn - CATCH_LEAD[p.anim]);
      }
    }
    expect(errs.length).toBeGreaterThan(30);
    const sorted = errs.map(Math.abs).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.5)]).toBeLessThan(0.03);
  });

  it('the pitcher\'s grip is known before release (pitchType on the windup event and the pitcher snapshot)', () => {
    const g = createGame({ seed: 'grip', pace: 1 });
    const announced: string[] = [];
    g.on('windup', (e) => announced.push(e.pitchType!));
    let checked = 0;
    let n = 0;
    while (!g.over && checked < 10 && n++ < 240 * 900) {
      g.step(1 / 240);
      if (g._world.phase === 'windup') {
        const p = g.getState().players.find((q) => q.role === 'pitcher')!;
        expect(p.pitchType).toBe(announced[announced.length - 1]);
        checked++;
        while (g._world.phase === 'windup') g.step(1 / 240);
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('the mound profile is the asset field.py mound_h: min(1 in/ft cone, 18 ft circle skirt)', () => {
    // sample values from assets/README.md "Mound"
    const samples: [number, number, number][] = [[0, 17.98, 0.229], [0, 16.5, 0.105], [0, 19.5, 0.225], [0, 20.5, 0.125], [2.5, 19, 0.007], [0, 18.5, 0.254], [0, 19.15, 0.254]];
    for (const [x, z, h] of samples) expect(Math.abs(groundHeight(x, z) - h)).toBeLessThan(0.002);
    expect(groundHeight(0, 19.153 + 0.01)).toBeLessThan(0.254); // the level top ends at 60 ft + 34 in = 19.152 m
    expect(groundHeight(0, 5)).toBe(0);
    expect(groundHeight(3, 19)).toBe(0); // outside the 18 ft circle laterally (x = 9 ft = 2.74 m)
    expect(groundHeight(0, 60 * 0.3048 + 9 * 0.3048 + 1)).toBe(0); // and behind it
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
