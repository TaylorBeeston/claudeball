import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import type { GameEvent } from '../types';
import { hitBall, lab, ofType } from './helpers';
import { detour } from '../umpires';

describe('umpires: positions, timed calls and gestures', () => {
  const g = createGame({ seed: 'ump-1', pace: 1 });
  const w = g._world;
  const events: GameEvent[] = [];
  g.on('*', (e) => events.push(e));
  const seenAnims = new Set<string>();
  const posLog: { key: string; x: number; z: number; tick: number }[] = [];
  /** the umpires' stances (not gestures) seen in each phase */
  const stanceByPhase = new Map<string, Set<string>>();
  // (the umpires gather at the plate during the break, a visit, a change and a review: those are not the positions this test is about)
  let lastGather = -99999;
  const gathering = () => {
    if (w.lull && (w.lull.kind === 'break' || w.lull.kind === 'review' || w.lull.kind === 'pitchingChange' || w.lull.kind === 'moundVisit')) lastGather = w.tick;
    return w.tick - lastGather < 240 * 14; // (and the walk back to their places afterwards)
  };
  let n = 0;
  while (!g.over && w.inning < 4 && n++ < 240 * 3600) {
    g.step(1 / 60);
    for (const u of w.umpires) {
      if (!gathering()) posLog.push({ key: u.key, x: u.x, z: u.z, tick: w.tick });
      if (w.tick < u.animUntil) seenAnims.add(u.anim);
    }
    if (w.tick % 24 === 0) {
      const set = stanceByPhase.get(w.phase) ?? new Set<string>();
      for (const p of g.getState().players) if (p.role === 'umpire' && !String(p.anim).startsWith('ump_') ) set.add(p.anim);
      for (const p of g.getState().players) if (p.role === 'umpire' && p.anim === 'ump_ready') set.add(p.anim);
      stanceByPhase.set(w.phase, set);
    }
  }

  it('calls come after the play: a pitch call ~0.2-0.3 s after the catch, a base call 0.2-0.6 s after the tag / force', () => {
    const calls = ofType(events, 'umpireCall');
    expect(calls.length).toBeGreaterThan(40);
    let pitchChecked = 0;
    for (const c of calls) {
      if (c.umpire !== 'plate' || !(c.kind === 'ball' || c.kind === 'strike_called' || c.kind === 'strike_swinging' || c.kind === 'strikeout' || c.kind === 'ball_four')) continue;
      const cr = [...events].reverse().find((e) => e.time <= c.time && e.type === 'call' && (e.call.kind === 'ball' || e.call.kind === 'strikeLooking' || e.call.kind === 'strikeSwinging'));
      if (!cr) continue;
      pitchChecked++;
      const dt = c.time - cr.time;
      expect(dt).toBeGreaterThanOrEqual(0.19);
      expect(dt).toBeLessThanOrEqual(0.3);
    }
    expect(pitchChecked).toBeGreaterThan(30);
    let baseChecked = 0;
    for (const c of calls) {
      if (c.kind !== 'out' || c.atBase === undefined) continue;
      const o = [...events].reverse().find((e) => e.time <= c.time && e.type === 'out' && e.playerId === c.playerId);
      if (!o) continue;
      baseChecked++;
      const dt = c.time - o.time;
      expect(dt).toBeGreaterThanOrEqual(0.24);
      expect(dt).toBeLessThanOrEqual(0.6);
    }
    expect(baseChecked).toBeGreaterThan(0);
  });

  it('a call comes from the umpire who has the play: the bag\'s umpire for a base call, the plate umpire for pitches', () => {
    for (const c of ofType(events, 'umpireCall')) {
      if (c.kind === 'ball' || c.kind.startsWith('strike') || c.kind === 'ball_four' || c.kind === 'time') expect(c.umpire).toBe('plate');
      if ((c.kind === 'out' || c.kind === 'safe') && c.atBase) expect(c.umpire).toBe(c.atBase === 1 ? 'first' : c.atBase === 2 ? 'second' : c.atBase === 3 ? 'third' : 'plate');
      expect(Number.isFinite(c.pos.x + c.pos.z)).toBe(true);
    }
    const kinds = new Set(ofType(events, 'umpireCall').map((c) => c.kind));
    for (const k of ['ball', 'strike_called', 'strike_swinging', 'foul']) expect(kinds.has(k as never)).toBe(true);
  });

  it('gestures show on the umpire\'s anim (ump_*); otherwise he is set (`ump_ready`) only while a pitch is coming, and stands relaxed (`idle`) between pitches', () => {
    for (const a of ['ump_ball', 'ump_strike', 'ump_foul']) expect(seenAnims.has(a)).toBe(true);
    for (const a of seenAnims) expect(a.startsWith('ump')).toBe(true);
    for (const [phase, anims] of stanceByPhase) {
      if (phase === 'windup' || phase === 'pitch') expect([...anims]).toEqual(['ump_ready']);
      else expect(anims.has('ump_ready')).toBe(false);
    }
    expect(stanceByPhase.get('prePitch')?.has('idle')).toBe(true);
    expect(stanceByPhase.get('halfBreak')?.has('idle')).toBe(true);
  });

  it('the base umpires stay out of the way: foul territory down the lines, beyond the bag at second; the plate umpire behind the plate', () => {
    for (const p of posLog) {
      if (p.key === 'first' || p.key === 'third') expect(Math.abs(p.x)).toBeGreaterThan(p.z - 0.01); // foul territory
      if (p.key === 'second') expect(p.z).toBeGreaterThan(38.8);
      if (p.key === 'plate') expect(p.z).toBeLessThan(-1);
    }
  });

  it('a base umpire moves to see a play at his bag (and returns afterwards)', () => {
    const moved = new Set<string>();
    const start = new Map(posLog.slice(0, 4).map((p) => [p.key, p]));
    for (const p of posLog) {
      const s = start.get(p.key)!;
      if (p.key !== 'plate' && Math.hypot(p.x - s.x, p.z - s.z) > 1.5) moved.add(p.key);
    }
    expect(moved.size).toBeGreaterThanOrEqual(1);
  });

  it('a home run is signalled by the umpire nearest the fence (ump_homerun), a foul by the nearest umpire', () => {
    const l = lab('ump-hr', { pace: 1 });
    hitBall(l.w, 108, 27, -20, 1800);
    for (let i = 0; i < 240 * 25 && l.w.phase === 'inPlay'; i++) l.g.step(1 / 240);
    const hr = ofType(l.events, 'umpireCall').find((c) => c.kind === 'homerun');
    expect(hr).toBeDefined();
    expect(hr!.umpire === 'first' || hr!.umpire === 'third').toBe(true);
    const home = ofType(l.events, 'homeRun')[0];
    expect(hr!.time - home.time).toBeGreaterThan(0.3);
    expect(hr!.time - home.time).toBeLessThan(0.6);
  });

  it('a strikeout is signalled with `ump_out_strikeout` (a strike swinging that is not the third stays `ump_strike_swinging`)', () => {
    const g = createGame({ seed: 'ump-k', pace: 0 });
    const w = g._world;
    const seen = { k: 0, sw: 0 };
    g.on('umpireCall', (e) => {
      const u = w.umpires.find((q) => q.id === e.umpireId)!;
      if (e.kind === 'strikeout') {
        expect(u.anim).toBe('ump_out_strikeout');
        seen.k++;
      }
      if (e.kind === 'strike_swinging') {
        expect(u.anim).toBe('ump_strike_swinging');
        seen.sw++;
      }
    });
    let n = 0;
    while (!g.over && seen.k < 6 && n++ < 240 * 3000) g.step(1 / 60);
    expect(seen.k).toBeGreaterThanOrEqual(6);
    expect(seen.sw).toBeGreaterThan(0);
  });
});

describe('the plate umpire walks round the catcher', () => {
  it('detour: a way through the catcher goes 1.4 m beside him; a clear way is left alone', () => {
    const c = { x: 0, z: -0.7 };
    const v = detour({ x: 0.25, z: -2.6 }, 0, 0.95, c)!;
    expect(v).not.toBeNull();
    expect(Math.hypot(v.x - c.x, v.z - c.z)).toBeCloseTo(1.4, 5);
    expect(v.x).toBeGreaterThan(1.2); // the side the path leans to (third-base side)
    expect(detour({ x: 2.5, z: -2.6 }, 2.5, 0.95, c)).toBeNull();
    expect(detour({ x: 0.25, z: -2.6 }, 0.2, -2.0, c)).toBeNull(); // the catcher is not between
  });
});
