import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { bodiesAhead, inPark, litShare, LIT_MIN, MOMENT_TTL, REACT_HEIGHT_MAX, reactionFov, MOMENT_WEIGHT, PACE, rankReactions, reactionCamera, roleClass, sightClear, type Moment, type PickContext, type ReactionNow } from '../reactionShots';
import { FaceState, personalityFor } from '../face/emotion';
import type { PlayerSnap } from '../types';

const snap = (o: Partial<PlayerSnap>): PlayerSnap => ({ id: 'x', team: 0, role: 'pitcher', pos: { x: 0, y: 0, z: 18.4 }, facing: Math.PI, vel: { x: 0, y: 0, z: 0 }, anim: 'idle', ...o });
const pitcher = snap({ id: 'P', role: 'pitcher' });
const batter = snap({ id: 'B', role: 'batter', pos: { x: -0.9, y: 0, z: 0 }, facing: 0 });
const catcher = snap({ id: 'C', role: 'catcher', pos: { x: 0, y: 0, z: -1.2 }, facing: 0 });
const runner = snap({ id: 'R', role: 'runner', pos: { x: -19.1, y: 0, z: 19.4 }, facing: 0.8 });
const players = [pitcher, batter, catcher, runner];

const live = (name = 'frustration', o: Partial<ReactionNow> = {}): ReactionNow => ({ name, strength: 0.9, age: 0.4, left: 1.5, pendingIn: null, ...o });
const moment = (kind: Moment['kind'], people: string[], at = 10): Moment => ({ kind, at, people, weight: MOMENT_WEIGHT[kind] });
const ctx = (over: Partial<PickContext> = {}): PickContext => ({
  now: 11,
  moments: [moment('strikeout', ['P', 'B', 'C'])],
  lookup: (id) => (id === 'P' ? live('yell') : id === 'B' ? live('dejection') : id === 'C' ? live('grin', { strength: 0.5 }) : null),
  players,
  recent: [],
  shownThisHalf: 0,
  pace: 'broadcast',
  ...over,
});

describe('reaction shots: who to show', () => {
  it('picks the person whose face shows the moment, best first', () => {
    const r = rankReactions(ctx());
    // (not the catcher: his face is behind the mask)
    expect(r.map((x) => x.id)).toEqual(['P', 'B']);
    expect(r[0].reaction).toBe('yell');
  });

  it('only shows a reaction that is still running (the face holds it through the shot) and strong enough to read', () => {
    expect(rankReactions(ctx({ lookup: () => live('yell', { left: -0.31 }) }))).toEqual([]);
    expect(rankReactions(ctx({ lookup: () => live('yell', { left: -0.2 }) }))).toHaveLength(2);
    expect(rankReactions(ctx({ lookup: () => live('yell', { strength: 0.29 }) }))).toEqual([]);
    expect(rankReactions(ctx({ lookup: () => null }))).toEqual([]);
  });

  it('every reaction it picks is one the face will hold through the shot (FaceState.holdFor)', () => {
    const f = new FaceState('p1', { ...personalityFor('p1'), expressiveness: 1, calm: 0 });
    f.react('frustration', 1);
    let picks = 0;
    for (let i = 0; i < 120; i++) {
      const info = f.reactionInfo();
      const picked = rankReactions(ctx({ moments: [moment('strikeout', ['B'])], lookup: () => info })).length > 0;
      // holdFor on a copy of the state now (it stretches the hold): the director's rule is inside the face's window
      if (picked) {
        const probe = new FaceState('p1', f.pers);
        probe.react('frustration', 1);
        for (let k = 0; k < i; k++) probe.tick(0.05);
        expect(probe.holdFor(3)).toBe(true);
        picks++;
      }
      f.tick(0.05);
    }
    expect(picks).toBeGreaterThan(40); // most of its 2.45 s hold
    expect(f.reactionInfo()).toBeNull();
  });

  it('forgets a moment after its time and never shows one that has not happened', () => {
    expect(rankReactions(ctx({ now: 10 + MOMENT_TTL + 0.01 }))).toEqual([]);
    expect(rankReactions(ctx({ now: 9.9 }))).toEqual([]);
  });

  it('keeps to the pace: a cap per half inning and a gap between two, per tempo', () => {
    for (const pace of ['broadcast', 'standard', 'quick'] as const) {
      const P = PACE[pace];
      const strong = [moment('error', ['P'])];
      expect(rankReactions(ctx({ pace, moments: strong, shownThisHalf: P.perHalf }))).toEqual([]);
      expect(rankReactions(ctx({ pace, moments: strong, shownThisHalf: P.perHalf - 1 }))).toHaveLength(1);
      const recent = [{ id: 'Z', cls: 'fielder' as const, at: 11 - P.gap + 0.5 }];
      expect(rankReactions(ctx({ pace, moments: strong, recent }))).toEqual([]);
      expect(rankReactions(ctx({ pace, moments: strong, recent: [{ ...recent[0], at: 11 - P.gap }] }))).toHaveLength(1);
    }
    // quicker tempos cut less: fewer per half inning, longer gaps, and only the bigger moments
    expect(PACE.quick.perHalf).toBeLessThan(PACE.standard.perHalf);
    expect(PACE.standard.perHalf).toBeLessThan(PACE.broadcast.perHalf);
    expect(PACE.quick.gap).toBeGreaterThan(PACE.broadcast.gap);
    expect(rankReactions(ctx({ pace: 'quick', moments: [moment('walk', ['P'])] }))).toEqual([]);
    expect(rankReactions(ctx({ pace: 'broadcast', moments: [moment('walk', ['P'])] }))).toHaveLength(1);
  });

  it('shows the big ones (home run, close call, a manager arguing) whatever the pace', () => {
    const recent = [{ id: 'Z', cls: 'fielder' as const, at: 10.5 }];
    for (const kind of ['homeRun', 'closeOut', 'challenge'] as const) {
      const lookup = () => live(kind === 'homeRun' ? 'shock' : 'argue');
      expect(rankReactions(ctx({ pace: 'quick', moments: [moment(kind, ['P'])], lookup, shownThisHalf: 9, recent }))).toHaveLength(1);
    }
  });

  it('never shows the same person twice in a row, and varies the kind of person', () => {
    expect(rankReactions(ctx({ recent: [{ id: 'P', cls: 'pitcher', at: -30 }] })).map((x) => x.id)).toEqual(['B']);
    expect(rankReactions(ctx({ avoid: 'P' })).map((x) => x.id)).not.toContain('P');
    // a pitcher was the last two reaction shots: the batter comes first even though the pitcher's yell is as strong
    const twoPitchers = [{ id: 'P2', cls: 'pitcher' as const, at: -60 }, { id: 'P3', cls: 'pitcher' as const, at: -30 }];
    expect(rankReactions(ctx({ recent: twoPitchers }))[0].id).toBe('B');
  });

  it('not someone in the middle of a throw or a warm-up pitch (he turns away mid-shot)', () => {
    const throwing = [{ ...pitcher, anim: 'warmup_pitch' as const }, batter, catcher, runner];
    expect(rankReactions(ctx({ players: throwing })).map((x) => x.id)).toEqual(['B']);
    expect(rankReactions(ctx({ players: [{ ...pitcher, anim: 'throw' }, batter] })).map((x) => x.id)).toEqual(['B']);
  });

  it('a brushback is the batter flinching, not whatever else his face does', () => {
    const m = [moment('brushback', ['B', 'P'])];
    expect(rankReactions(ctx({ moments: m, lookup: (id) => (id === 'B' ? live('concentration') : null) }))).toEqual([]);
    expect(rankReactions(ctx({ moments: m, lookup: (id) => (id === 'B' ? live('flinch') : null) }))[0].id).toBe('B');
  });

  it('only the moments asked for (a stage of a sequence)', () => {
    const ms = [moment('strikeout', ['B']), moment('homeRun', ['P'])];
    expect(rankReactions(ctx({ moments: ms, kinds: ['homeRun'] })).map((x) => x.id)).toEqual(['P']);
  });

  it('classes people by role', () => {
    expect(roleClass('pitcher')).toBe('pitcher');
    expect(roleClass('shortstop')).toBe('fielder');
    expect(roleClass('center')).toBe('fielder');
    expect(roleClass('bench')).toBe('dugout');
    expect(roleClass('umpire')).toBe('other');
  });
});

describe('reaction shots: the camera', () => {
  const head = (p: PlayerSnap) => new Vector3(p.pos.x, 1.75, p.pos.z);

  it('stands in the park: not behind the backstop, in the stands or past the fence', () => {
    expect(inPark(0, 10)).toBe(true);
    expect(inPark(0, -16)).toBe(false); // behind the backstop
    expect(inPark(0, 120)).toBe(false); // past the centre-field fence
    expect(inPark(-25, 15)).toBe(true); // foul ground by first base
    expect(inPark(-40, 5)).toBe(false); // the stands beyond it
  });

  it('frames the face from in front of where he looks, at eye level, at the close-up distance', () => {
    const off = reactionCamera(pitcher, head(pitcher), players, []);
    expect(off).not.toBeNull();
    // the pitcher faces home (facing pi = -Z): the camera is toward the plate, roughly level with his eyes
    expect(off!.z).toBeLessThan(-5);
    expect(Math.abs(off!.y)).toBeLessThan(0.2);
    expect(off!.length()).toBeGreaterThan(6.5);
  });

  it('moves round anybody standing in the line of sight, and gives up when every angle is blocked', () => {
    // the catcher and batter stand between the pitcher and a camera straight in front of him: it moves off the line
    const off = reactionCamera(pitcher, head(pitcher), [...players, snap({ id: 'U', role: 'umpire', pos: { x: 0, y: 0, z: 13 } })], []);
    expect(off).not.toBeNull();
    const cam = head(pitcher).add(off!);
    expect(sightClear(cam, head(pitcher), 'P', [...players, { id: 'U', pos: { x: 0, y: 0, z: 13 } }])).toBe(true);
    // a crowd all round him at 3 m: no clear close-up
    const ring = Array.from({ length: 24 }, (_, i) => ({ id: `k${i}`, pos: { x: Math.sin((i / 24) * 2 * Math.PI) * 3, y: 0, z: 18.4 + Math.cos((i / 24) * 2 * Math.PI) * 3 } }));
    expect(reactionCamera(pitcher, head(pitcher), ring, [])).toBeNull();
  });

  it('does not film through a solid block (a dugout, the batter\'s eye)', () => {
    // a wall right in front of the runner on every side the camera could take
    const box = { min: { x: -40, y: 0, z: 21 }, max: { x: 0, y: 4, z: 22 } };
    const r = snap({ id: 'R', role: 'runner', pos: { x: -19.1, y: 0, z: 19.4 }, facing: 0 });
    const off = reactionCamera(r, head(r), [r], [box]);
    if (off) {
      const cam = head(r).add(off);
      expect(cam.z).toBeLessThan(21); // on his side of the wall
    }
  });

  it('films the lit side of the face, and no face that the lights do not reach', () => {
    // one tower behind the pitcher (toward centre field, high): his face, turned to the plate, is in his own shadow
    const behind = [{ dir: new Vector3(0, 0.6, 0.8).normalize(), w: 1 }];
    expect(litShare({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 }, behind)).toBeLessThan(LIT_MIN);
    expect(reactionCamera(pitcher, head(pitcher), [pitcher], [], new Vector3(), behind)).toBeNull();
    // a tower over the first-base side (-X): the camera swings to that side of his face
    const side = [{ dir: new Vector3(-0.9, 0.4, 0.1).normalize(), w: 1 }];
    const off = reactionCamera(pitcher, head(pitcher), [pitcher], [], new Vector3(), side);
    expect(off).not.toBeNull();
    expect(off!.x).toBeLessThan(0);
    // no tower reaches him: no shot; no lights given (by day): no check
    expect(reactionCamera(pitcher, head(pitcher), [pitcher], [], new Vector3(), [])).toBeNull();
    expect(reactionCamera(pitcher, head(pitcher), [pitcher], [], new Vector3())).not.toBeNull();
    // a weak light does not count against a strong one
    expect(litShare({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 }, [{ dir: new Vector3(0, 0.5, -0.86), w: 0.1 }, { dir: new Vector3(0, 0.6, 0.8), w: 1 }])).toBeLessThan(LIT_MIN);
  });

  it('is a close-up on a wide screen and on a phone held upright: the head at least a fifth of the picture height', () => {
    const headFrac = (dist: number, aspect: number) => 0.25 / (2 * dist * Math.tan((reactionFov(dist, aspect) * Math.PI) / 360));
    for (const aspect of [16 / 9, 4 / 3, 412 / 915]) for (const dist of [7, 9.5]) expect(headFrac(dist, aspect)).toBeGreaterThan(0.2);
    expect(2 * 7 * Math.tan((reactionFov(7, 0.45) * Math.PI) / 360)).toBeCloseTo(REACT_HEIGHT_MAX, 5);
  });

  it('sees people walking into the shot: where they will be, relative to the subject the camera follows', () => {
    const walker = snap({ id: 'W', role: 'batter', pos: { x: 3, y: 0, z: 12 }, vel: { x: -1.5, y: 0, z: 0 } });
    const ahead = bodiesAhead(pitcher, [pitcher, walker, catcher]);
    expect(ahead.map((b) => b.id)).toEqual(['W@1', 'W@2']); // the catcher stands still, the pitcher is the subject
    expect(ahead[1].pos.x).toBeCloseTo(0);
    // he walks across in front of the pitcher: a camera straight in front is not clear then, so another angle is taken
    const cam = head(pitcher).add(new Vector3(0, 0, -7));
    expect(sightClear(cam, head(pitcher), 'P', ahead)).toBe(false);
    // following a walking subject, a teammate walking alongside him does not move relative to the camera
    const mate = snap({ id: 'M', role: 'runner', pos: { x: 2, y: 0, z: 18 }, vel: { x: -1.5, y: 0, z: 0 } });
    expect(bodiesAhead(snap({ ...walker, id: 'S' }), [mate])).toEqual([]);
  });

  it('keeps the lens clear: nobody right beside the camera', () => {
    const h = head(pitcher);
    const cam = h.clone().add(new Vector3(0, 0, -7));
    expect(sightClear(cam, h, 'P', [{ id: 'X', pos: { x: cam.x + 1.8, y: 0, z: cam.z } }])).toBe(false);
    expect(sightClear(cam, h, 'P', [{ id: 'X', pos: { x: cam.x + 2.2, y: 0, z: cam.z } }])).toBe(true);
    // a wider berth in the near part of the line (a big blurred head in the corner), the normal one near the face
    expect(sightClear(cam, h, 'P', [{ id: 'X', pos: { x: cam.x + 0.8, y: 0, z: cam.z + 2.5 } }])).toBe(false);
    expect(sightClear(cam, h, 'P', [{ id: 'X', pos: { x: cam.x + 0.8, y: 0, z: cam.z + 5 } }])).toBe(true);
    // someone down in the dugout pit is below the line
    expect(sightClear(cam, h, 'P', [{ id: 'X', pos: { x: 0, y: -1, z: 15 } }])).toBe(true);
  });
});
