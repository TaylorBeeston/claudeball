import { describe, expect, it } from 'vitest';
import { coachDecision, fanSeat, hash01, makeLayout, SideCast } from '../sideCast';
import type { GameState, PlayerSnap } from '../types';

const snap = (over: Partial<PlayerSnap>): PlayerSnap => ({ id: 'p', team: 0, role: 'pitcher', pos: { x: 0, y: 0, z: 18 }, facing: 0, vel: { x: 0, y: 0, z: 0 }, anim: 'idle', ...over });
const state = (players: PlayerSnap[] = [], over: Partial<GameState> = {}): GameState =>
  ({
    time: 0,
    ball: { pos: { x: 0, y: 1, z: 18 }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, visible: false },
    bat: { visible: false, pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } },
    players,
    umpireCall: { seq: 0, kind: 'none' },
    count: { balls: 0, strikes: 0 },
    outs: 0,
    inning: 1,
    half: 'top',
    score: { away: 0, home: 0 },
    runners: [false, false, false],
    batter: null,
    pitcher: null,
    teams: {} as GameState['teams'],
    over: false,
    ...over,
  }) as GameState;

describe('side cast layout', () => {
  it('seats the visitors on the first-base side (−X) and the home team on third (+X), on the dugout floor', () => {
    const l = makeLayout();
    expect(l.bench[0].every((s) => s.pos.x < 0)).toBe(true);
    expect(l.bench[1].every((s) => s.pos.x > 0)).toBe(true);
    expect(l.bench[1][0].pos.y).toBeCloseTo(-1.05, 2);
    // seats are at least a bat's length apart
    const z = l.bench[1].map((s) => s.pos.z);
    expect(z[1] - z[0]).toBeGreaterThan(0.8);
  });
  it('puts the coaches beside the bags on foul ground and the kids down the lines', () => {
    const l = makeLayout();
    expect(l.coach.first.x).toBeLessThan(-19.2);
    expect(l.coach.third.x).toBeGreaterThan(19.2);
    expect(l.kids[0].x).toBeLessThan(0);
    expect(l.kids[1].x).toBeGreaterThan(0);
  });
});

describe('coaches', () => {
  it('waves a runner home when the ball is far away and holds him when it is close or a throw is coming', () => {
    expect(coachDecision({ base: 3, runnerDistance: 8, ballDistanceToHome: 80, ballSpeed: 5, ballTowardHome: false })).toBe('go');
    expect(coachDecision({ base: 3, runnerDistance: 8, ballDistanceToHome: 25, ballSpeed: 5, ballTowardHome: false })).toBe('stop');
    expect(coachDecision({ base: 3, runnerDistance: 5, ballDistanceToHome: 25, ballSpeed: 30, ballTowardHome: true })).toBe('slide');
    expect(coachDecision({ base: 1, runnerDistance: 8, ballDistanceToHome: 70, ballSpeed: 5, ballTowardHome: false })).toBe('advance');
    expect(coachDecision({ base: 1, runnerDistance: 8, ballDistanceToHome: 30, ballSpeed: 5, ballTowardHome: false })).toBe('stop');
  });
});

describe('SideCast', () => {
  it('makes up bench, on-deck, coaches and ball kids when the sim sends none, and nothing twice', () => {
    const sc = new SideCast({ hasClip: () => true });
    const out = sc.update(state(), 1 / 60);
    const roles = new Set(out.map((p) => p.role));
    for (const r of ['bench', 'ondeck', 'coach1b', 'coach3b', 'ballkid']) expect(roles.has(r as never)).toBe(true);
    expect(new Set(out.map((p) => p.id)).size).toBe(out.length);
    expect(out.filter((p) => p.role === 'bench')).toHaveLength(8);
  });
  it('leaves a category alone once the sim sends it, and drops what it made before', () => {
    const sc = new SideCast({ hasClip: () => true });
    sc.update(state(), 1 / 60);
    const out = sc.update(state([snap({ id: 'sim-bench', role: 'bench' }), snap({ id: 'sim-od', role: 'ondeck' }), snap({ id: 'c', role: 'coach3b' }), snap({ id: 'k', role: 'ballkid' })]), 1 / 60);
    expect(out.filter((p) => ['bench', 'ondeck', 'coach1b', 'coach3b', 'ballkid'].includes(p.role))).toHaveLength(0);
  });
  it('sends a ball kid after a foul ball that came down in foul ground and tosses or returns it, with events, deterministically', () => {
    const run = () => {
      const sc = new SideCast({ hasClip: () => true });
      const events: string[] = [];
      let t = 0;
      const live = (x: number, y: number, z: number, vz = 5) => state([], { ball: { pos: { x, y, z }, vel: { x: 0, y: y > 0.3 ? -5 : 0, z: vz }, spin: { x: 0, y: 0, z: 0 }, visible: true } });
      sc.update(live(0, 1, 5), 1 / 60);
      sc.note({ type: 'foul' });
      for (let i = 0; i < 30; i++, t += 1 / 60) sc.update(live(-30 + i * 0.1, 3 - i * 0.09, 20), 1 / 60);
      for (let i = 0; i < 60 * 40; i++, t += 1 / 60) {
        sc.update(state([], { ball: { pos: { x: -33, y: 0.04, z: 20 }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, visible: false } }), 1 / 60, (e) => events.push(e.type));
      }
      return events;
    };
    const a = run();
    expect(a).toContain('ball_kid_retrieve');
    expect(run()).toEqual(a);
  });
  it('the on-deck batter walks to where the sim starts the next batter once the play is over', () => {
    const sc = new SideCast({ hasClip: () => true });
    let out = sc.update(state([snap({ id: 'b', role: 'batter', team: 0, pos: { x: 0.7, y: 0, z: 0.15 } })]), 1 / 60);
    const od = () => out.find((p) => p.role === 'ondeck')!;
    const start = { ...od().pos };
    for (let i = 0; i < 60 * 12; i++) out = sc.update(state([]), 1 / 60);
    const end = od().pos;
    expect(Math.hypot(end.x - -3.2, end.z - -4)).toBeLessThan(0.3);
    expect(Math.hypot(start.x - end.x, start.z - end.z)).toBeGreaterThan(3);
  });
});

describe('helpers', () => {
  it('the fan sits behind the foul fence on the kid\'s side and above the field', () => {
    const f = fanSeat({ x: 24, y: 0, z: 20 });
    expect(f.x).toBeGreaterThan(24);
    expect(f.y).toBeGreaterThan(1.5);
    expect(hash01('a', 1)).toBe(hash01('a', 1));
    expect(hash01('a', 1)).not.toBe(hash01('a', 2));
  });
});
