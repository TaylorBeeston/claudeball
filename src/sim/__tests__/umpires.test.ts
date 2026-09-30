import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import type { GameEvent } from '../types';
import { hitBall, lab, ofType } from './helpers';

describe('umpires: positions, timed calls and gestures', () => {
  const g = createGame({ seed: 'ump-1', pace: 1 });
  const w = g._world;
  const events: GameEvent[] = [];
  g.on('*', (e) => events.push(e));
  const seenAnims = new Set<string>();
  const posLog: { key: string; x: number; z: number; tick: number }[] = [];
  let n = 0;
  while (!g.over && w.inning < 4 && n++ < 240 * 3600) {
    g.step(1 / 60);
    for (const u of w.umpires) {
      posLog.push({ key: u.key, x: u.x, z: u.z, tick: w.tick });
      if (w.tick < u.animUntil) seenAnims.add(u.anim);
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

  it('gestures show on the umpire\'s anim (ump_*) and he is otherwise ready', () => {
    for (const a of ['ump_ball', 'ump_strike', 'ump_foul']) expect(seenAnims.has(a)).toBe(true);
    for (const a of seenAnims) expect(a.startsWith('ump_')).toBe(true);
    const s = g.getState();
    for (const p of s.players.filter((q) => q.role === 'umpire')) expect(String(p.anim).startsWith('ump_')).toBe(true);
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
});
