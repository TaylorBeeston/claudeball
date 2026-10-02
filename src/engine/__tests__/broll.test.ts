import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { availableKinds, computeRig, DEFAULT_BULLPENS, MIN_HOLD, MIN_LULL, planNext, RETURN_MARGIN, type BrollKind, type Landmarks, type PlanContext } from '../broll';
import type { GameState, LullKind, PlayerSnap } from '../types';

const p = (o: Partial<PlayerSnap>): PlayerSnap => ({ id: 'x', team: 0, role: 'pitcher', pos: { x: 0, y: 0, z: 18.4 }, facing: 0, vel: { x: 0, y: 0, z: 0 }, anim: 'idle', ...o });
const state = (players: PlayerSnap[]): GameState =>
  ({ time: 0, ball: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, visible: false }, players, half: 'top' }) as unknown as GameState;
const lm: Landmarks = {
  crowdShots: [1, 2, 3].map((i) => ({ pos: new Vector3(i, 5, -40), target: new Vector3(i, 6, -60) })),
  dugoutShots: [{ pos: new Vector3(30, 3, -6), target: new Vector3(25, 0, 8) }, { pos: new Vector3(-30, 3, -6), target: new Vector3(-25, 0, 8) }],
  scoreboard: new Vector3(0, 25, 160),
  bullpens: DEFAULT_BULLPENS,
};
const all = new Set<BrollKind>(['walkup', 'batterFace', 'onDeck', 'dugout', 'dugoutReaction', 'pitcherFace', 'catcherSigns', 'shakeOff', 'leadOff', 'coachSigns', 'bullpen', 'crowd', 'scoreboard', 'aerial', 'sky', 'moundWide', 'moundHuddle', 'managerWalk', 'bullpenDoor', 'relieverJog', 'relieverFace', 'umpires']);
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ lull: { kind: 'walkup', remaining: 12 }, available: all, recent: [], seed: 1, shownThisLull: 0, ...over });

describe('B-roll planner', () => {
  it('skips B-roll when the lull is short and when no hold fits', () => {
    expect(planNext(ctx({ lull: { kind: 'betweenPitches', remaining: MIN_LULL - 0.1 } }))).toBeNull();
    expect(planNext(ctx({ lull: { kind: 'betweenPitches', remaining: 3.5 }, shownThisLull: 1 }))).not.toBeNull();
    expect(planNext(ctx({ lull: { kind: 'betweenPitches', remaining: MIN_HOLD + RETURN_MARGIN - 0.05 }, shownThisLull: 1 }))).toBeNull();
  });
  it('holds 2.5-6 s and never past what the lull has left', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const kind of ['walkup', 'betweenPitches', 'moundVisit', 'pitchingChange', 'break', 'review'] as LullKind[]) {
        const rem = 3.4 + (seed % 12);
        const s = planNext(ctx({ seed, lull: { kind, remaining: rem }, shownThisLull: 1 }));
        if (!s) continue;
        expect(s.hold).toBeGreaterThanOrEqual(MIN_HOLD);
        expect(s.hold).toBeLessThanOrEqual(6);
        expect(s.hold).toBeLessThanOrEqual(rem - RETURN_MARGIN + 1e-9);
      }
    }
  });
  it('never repeats a kind inside the window or a subject back to back, and only picks available kinds', () => {
    const recent: PlanContext['recent'] = [];
    const picked: BrollKind[] = [];
    for (let i = 0; i < 40; i++) {
      const avail = new Set<BrollKind>(['pitcherFace', 'catcherSigns', 'shakeOff', 'leadOff', 'coachSigns', 'batterFace']);
      const s = planNext(ctx({ seed: i * 17 + 3, lull: { kind: 'betweenPitches', remaining: 30 }, available: avail, recent, shownThisLull: i > 0 ? 1 : 0 }));
      expect(s).not.toBeNull();
      expect(avail.has(s!.kind)).toBe(true);
      expect(picked.slice(-4)).not.toContain(s!.kind);
      picked.push(s!.kind);
      recent.push({ kind: s!.kind });
    }
    expect(new Set(picked).size).toBeGreaterThanOrEqual(5);
  });
  it('a mound visit goes wide, then onto the huddle', () => {
    const a = planNext(ctx({ lull: { kind: 'moundVisit', remaining: 20 } }))!;
    expect(a.kind).toBe('moundWide');
    const b = planNext(ctx({ lull: { kind: 'moundVisit', remaining: 20 }, shownThisLull: 1, recent: [{ kind: 'moundWide' }], seed: 5 }))!;
    expect(b.kind).toBe('moundHuddle');
  });
  it('a walk-up opens on the walk, then the face; a break on the aerial', () => {
    expect(planNext(ctx({ lull: { kind: 'walkup', remaining: 20 } }))!.kind).toBe('walkup');
    expect(planNext(ctx({ lull: { kind: 'walkup', remaining: 20 }, shownThisLull: 1, recent: [{ kind: 'walkup' }] }))!.kind).toBe('batterFace');
    expect(planNext(ctx({ lull: { kind: 'break', remaining: 20 } }))!.kind).toBe('aerial');
  });
  it('opens with the dugout of the team that just scored', () => {
    const s = planNext(ctx({ lull: { kind: 'walkup', remaining: 20 }, reactionTeam: 1 }))!;
    expect(s.kind).toBe('dugoutReaction');
    expect(s.team).toBe(1);
  });
  it('scenery dissolves, people cut, and the same seed gives the same shot', () => {
    const a = planNext(ctx({ lull: { kind: 'break', remaining: 20 }, shownThisLull: 1, recent: [{ kind: 'aerial' }], seed: 9 }))!;
    expect(planNext(ctx({ lull: { kind: 'break', remaining: 20 }, shownThisLull: 1, recent: [{ kind: 'aerial' }], seed: 9 }))).toEqual(a);
    expect(planNext(ctx({ lull: { kind: 'break', remaining: 20 } }))!.transition).toBe('dissolve');
    expect(planNext(ctx({ lull: { kind: 'walkup', remaining: 20 } }))!.transition).toBe('cut');
  });
});

describe('availability and rigs', () => {
  const players = [p({ id: 'b', role: 'batter', pos: { x: 0.7, y: 0, z: 0.1 } }), p({ id: 'pit', role: 'pitcher' }), p({ id: 'c', role: 'catcher', pos: { x: 0, y: 0, z: -1.3 } }), p({ id: 'r1', role: 'runner', pos: { x: -17, y: 0, z: 17.5 } })];
  it('offers only what the state can show', () => {
    const a = availableKinds(state(players), lm);
    for (const k of ['batterFace', 'pitcherFace', 'catcherSigns', 'leadOff', 'crowd', 'aerial', 'dugout'] as BrollKind[]) expect(a.available.has(k)).toBe(true);
    for (const k of ['onDeck', 'managerWalk', 'bullpen', 'relieverJog', 'umpires', 'walkup'] as BrollKind[]) expect(a.available.has(k)).toBe(false);
    const moving = availableKinds(state([{ ...players[0], vel: { x: 0, y: 0, z: 1.2 }, anim: 'batter_step_in' }, ...players.slice(1)]), lm);
    expect(moving.available.has('walkup')).toBe(true);
  });
  it('every kind gives finite camera numbers on a bare state (falls back to the pitch view)', () => {
    for (const k of all) {
      const r = computeRig({ kind: k, variant: 7, hold: 3, transition: 'cut' }, { state: state(players), lm, t: 1, aspect: 16 / 9, battingSide: 0 });
      for (const v of [...r.pos.toArray(), ...r.tgt.toArray(), ...r.focus.toArray(), r.fov, r.slab]) expect(Number.isFinite(v)).toBe(true);
      expect(r.fov).toBeGreaterThan(0.2);
      expect(r.fov).toBeLessThan(80);
      expect(r.pos.y).toBeGreaterThan(0.3);
    }
  });
  it('the face close-up racks focus from the background to the face', () => {
    const shot = { kind: 'batterFace' as const, subject: 'b', variant: 3, hold: 3, transition: 'cut' as const };
    const a = computeRig(shot, { state: state(players), lm, t: 0, aspect: 16 / 9, battingSide: 0 });
    const f0 = a.focus.clone(), cam = a.pos.clone();
    const b = computeRig(shot, { state: state(players), lm, t: 2, aspect: 16 / 9, battingSide: 0 });
    expect(f0.distanceTo(cam)).toBeGreaterThan(b.focus.distanceTo(cam) + 2);
  });
});

import { Broadcast } from '../broadcast';
import { shotLabel } from '../broll';

describe('broadcast labels and emitter', () => {
  it('gives the HUD one label per shot and a card only for shots about a person', () => {
    const s = (kind: BrollKind) => shotLabel({ kind, variant: 0, hold: 3, transition: 'cut' });
    expect(s('batterFace')).toEqual({ kind: 'faceCloseup', card: true });
    expect(s('pitcherFace')).toEqual({ kind: 'faceCloseup', card: true });
    expect(s('onDeck')).toEqual({ kind: 'ondeck', card: true });
    expect(s('walkup')).toEqual({ kind: 'walkup', card: true });
    expect(s('crowd')).toEqual({ kind: 'crowd', card: false });
    expect(s('catcherSigns').card).toBe(false);
  });
  it('delivers to every listener, survives one that throws, and unsubscribes', () => {
    const b = new Broadcast();
    const got: string[] = [];
    const off = b.on((e) => got.push(e.type));
    b.on(() => {
      throw new Error('boom');
    });
    const quiet = console.error;
    console.error = () => {};
    b.emit({ type: 'replayEnd', variant: 'infield', simTime: 1 });
    off();
    b.emit({ type: 'replayEnd', variant: 'infield', simTime: 2 });
    console.error = quiet;
    expect(got).toEqual(['replayEnd']);
  });
});
