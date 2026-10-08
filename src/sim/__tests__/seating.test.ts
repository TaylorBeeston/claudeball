import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { restSpot } from '../umpires';
import { BENCH_SEAT_O, BENCH_SEAT_TOP, BENCH_SIT_LIFT, CREW_MEETING, DUG_FLOOR, DUG_S, SIT_CLIP_SEAT, ballKidSpot } from '../venue';
import type { GameStateSnapshot } from '../types';

/** a field position in the dugout / stand frame of the assets: `s` along the base line from the plate, `o` off it into foul ground */
const lineFrame = (x: number, z: number) => ({ s: (Math.abs(x) + z) * Math.SQRT1_2, o: (Math.abs(x) - z) * Math.SQRT1_2 });

/** Everyone the camera can see sitting, over the first innings of a `standard`-tempo game (the one the broadcast plays). */
function watch(seed: string, innings: number, onTick: (s: GameStateSnapshot, tick: number, phase: string) => void) {
  const g = createGame({ seed, pace: 1, tempo: 'standard' });
  const w = g._world;
  let n = 0;
  onTick(g.getState(), w.tick, w.phase);
  while (!g.over && w.inning < innings + 1 && n++ < 240 * 6000) {
    g.step(1 / 60);
    onTick(g.getState(), w.tick, w.phase);
  }
}

describe('sitters sit on something: every seated pose is on a real seat at the seat height its clip is made for', () => {
  const sitters: { id: string; role: string; anim: string; x: number; y: number; z: number }[] = [];
  watch('seats-1', 2, (s) => {
    for (const p of s.players) if (/sit/.test(p.anim)) sitters.push({ id: p.id, role: p.role, anim: p.anim, x: p.pos.x, y: p.pos.y, z: p.pos.z });
  });

  it('the seat heights agree: the bench_sit root is lifted by (bench top - the clip\'s seat height)', () => {
    expect(BENCH_SIT_LIFT).toBeCloseTo(BENCH_SEAT_TOP - SIT_CLIP_SEAT, 6);
  });

  it('bench_sit: on the dugout bench (its length and depth), root on the floor + the lift', () => {
    const bench = sitters.filter((p) => p.anim === 'bench_sit');
    expect(bench.length).toBeGreaterThan(1000);
    for (const p of bench) {
      const { s, o } = lineFrame(p.x, p.z);
      expect(s).toBeGreaterThan(DUG_S[0] + 1.3);
      expect(s).toBeLessThan(DUG_S[1] - 0.6);
      expect(o).toBeGreaterThan(BENCH_SEAT_O[0] - 0.05);
      expect(o).toBeLessThan(BENCH_SEAT_O[1]);
      expect(p.y).toBeCloseTo(DUG_FLOOR + BENCH_SIT_LIFT, 3);
    }
  });

  it('ballkid_sit: only ball kids, at their chairs down the lines (the engine puts the chair where they sit), root on the ground', () => {
    const kids = sitters.filter((p) => p.anim === 'ballkid_sit');
    expect(kids.length).toBeGreaterThan(100);
    for (const p of kids) {
      expect(p.role).toBe('ballkid');
      const spot = [ballKidSpot(1), ballKidSpot(3)].reduce((a, b) => (Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? a : b));
      expect(Math.hypot(spot.x - p.x, spot.z - p.z)).toBeLessThan(0.3);
      expect(p.y).toBe(0);
    }
  });

  it('no other seated hint is sent', () => {
    for (const p of sitters) expect(['bench_sit', 'ballkid_sit']).toContain(p.anim);
  });
});

describe('umpires before the first pitch and between innings (standard tempo)', () => {
  const fair: string[] = [];
  const setOutsidePitch: string[] = [];
  let first: { id: string; x: number; z: number }[] = [];
  let meeting3s: { id: string; x: number; z: number }[] = [];
  let atFirstPitch: { id: string; x: number; z: number; position: string }[] | null = null;
  watch('ump-crew', 2, (s, tick, phase) => {
    const umps = s.players.filter((p) => p.role === 'umpire');
    if (tick === 0) first = umps.map((u) => ({ id: u.id, x: u.pos.x, z: u.pos.z }));
    if (tick === 240 * 3) meeting3s = umps.map((u) => ({ id: u.id, x: u.pos.x, z: u.pos.z }));
    if (!atFirstPitch && phase === 'windup') atFirstPitch = umps.map((u) => ({ id: u.id, x: u.pos.x, z: u.pos.z, position: u.position as string }));
    for (const u of umps) {
      // standing in the diamond between home and second (walking across it to take the field is fine) (fair ground short of the outfield grass), outside a live play
      const standing = Math.hypot(u.vel.x, u.vel.z) < 0.3;
      const inDiamond = standing && u.pos.z > Math.abs(u.pos.x) + 0.3 && Math.hypot(u.pos.x, u.pos.z) > 1.5 && Math.hypot(u.pos.x, u.pos.z - 18.4) < 26 && u.pos.z < 38;
      if (inDiamond && phase !== 'inPlay') fair.push(`${u.id} ${phase} t${tick} (${u.pos.x.toFixed(1)}, ${u.pos.z.toFixed(1)})`);
      if (u.anim === 'ump_ready' && phase !== 'windup' && phase !== 'pitch' && phase !== 'pickoff') setOutsidePitch.push(`${u.id} ${phase}`);
    }
  });

  it('the crew starts at its plate meeting in foul ground beside home (and is still there 3 s in)', () => {
    expect(first).toHaveLength(4);
    expect(meeting3s).toHaveLength(4);
    for (const u of [...first, ...meeting3s]) {
      expect(Math.hypot(u.x - CREW_MEETING.x, u.z - CREW_MEETING.z)).toBeLessThan(1.5);
      expect(Math.abs(u.x)).toBeGreaterThan(u.z); // foul
    }
  });

  it('every umpire is at his post when the first pitch comes', () => {
    expect(atFirstPitch).not.toBeNull();
    for (const u of atFirstPitch!) {
      const r = restSpot({ position: u.position as 'HP' });
      expect(Math.hypot(u.x - r.x, u.z - r.z)).toBeLessThan(1.5);
    }
  });

  it('no umpire stands in the diamond outside a live play, and none is set (crouched) unless a pitch is coming', () => {
    expect(fair.slice(0, 5)).toEqual([]);
    expect(setOutsidePitch.slice(0, 5)).toEqual([]);
  });
});
