import { bullpenMound } from '../venue';
import { describe, expect, it } from 'vitest';
import { armMps } from '../attributes';
import { fielders } from '../fielding';
import { createGame } from '../game';
import { READY_TIMEOUT, casualSpeed, readyToPitch, transferCatcher, transferRoutine } from '../handling';
import { DEFAULT_SPOTS, DUGOUT } from '../setup';
import { substitutePitcher } from '../manager';
import { MOUND_DIST } from '../field';
import type { GameEvent } from '../types';
import { hitBall, lab, ofType } from './helpers';

const tickSecs = 1 / 240;

describe('getting set before the pitch', () => {
  it('no pitch starts until every fielder is at his spot, the pitcher has the ball on the rubber and the batter is in the box', () => {
    const g = createGame({ seed: 'set-1', pace: 1 });
    const w = g._world;
    let pitches = 0;
    let bad = 0;
    g.on('windup', () => {
      pitches++;
      const r = readyToPitch(w);
      if (!r.ready) bad++;
      expect(w.ball.holder).toBe(w.pitcher);
      expect(Math.hypot(w.pitcher.x, w.pitcher.z - MOUND_DIST)).toBeLessThan(0.8);
      for (const F of fielders(w)) if (F.home) expect(Math.hypot(F.x - F.home.x, F.z - F.home.z)).toBeLessThan(1.6);
    });
    while (!g.over && w.inning < 4 && pitches < 400) g.step(1 / 30);
    expect(pitches).toBeGreaterThan(60);
    expect(bad).toBe(0);
  });

  it('a fielder sent far from his spot is waited for, the pitch is not started while he trots back', () => {
    const l = lab('set-2', { pace: 1 });
    const w = l.w;
    const LF = fielders(w).find((p) => p.fieldPos === 'LF')!;
    // he has just run down a ball at the far corner
    LF.x = 50;
    LF.z = 60;
    LF.vx = LF.vz = 0;
    const t0 = w.tick;
    let pitchAt = -1;
    l.g.on('windup', () => (pitchAt = pitchAt < 0 ? w.tick : pitchAt));
    for (let i = 0; i < 240 * 60 && pitchAt < 0; i++) l.g.step(tickSecs);
    expect(pitchAt).toBeGreaterThan(0);
    // he had to get back (~29 m at a jog) first, and he was in place when the pitch began
    expect((pitchAt - t0) / 240).toBeGreaterThan(3.5);
    expect(Math.hypot(LF.x - LF.home!.x, LF.z - LF.home!.z)).toBeLessThan(1.6);
    expect(Math.hypot(LF.home!.x - DEFAULT_SPOTS.LF.x, LF.home!.z - DEFAULT_SPOTS.LF.z)).toBeLessThan(8); // (his spot, shaded a little by the alignment)
  });

  it('the wait is bounded: a fielder who cannot get back does not stall the game', () => {
    const l = lab('set-3', { pace: 1 });
    const w = l.w;
    const RF = fielders(w).find((p) => p.fieldPos === 'RF')!;
    RF.x = -50;
    RF.z = 60;
    RF.vx = RF.vz = 0;
    RF.vmax = 0.2; // effectively pinned
    const t0 = w.tick;
    let pitchAt = -1;
    l.g.on('windup', () => (pitchAt = pitchAt < 0 ? w.tick : pitchAt));
    for (let i = 0; i < 240 * 90 && pitchAt < 0; i++) l.g.step(tickSecs);
    expect(pitchAt).toBeGreaterThan(0);
    const waited = (pitchAt - t0) / 240;
    expect(waited).toBeGreaterThan(READY_TIMEOUT * 0.6);
    expect(waited).toBeLessThan(READY_TIMEOUT + 8);
  });

  it('headless runs (pace 0) skip all of it: fielders are simply in place', () => {
    const l = lab('set-4', { pace: 0 });
    const w = l.w;
    for (const F of fielders(w)) if (F.home) expect(Math.hypot(F.x - F.home.x, F.z - F.home.z)).toBeLessThan(0.01);
  });

  it('a pitching change: the reliever jogs in from the dugout, the pitch waits for him, the old pitcher walks off', () => {
    const l = lab('set-5', { pace: 1 });
    const w = l.w;
    const t = w.fieldingTeam;
    const old = t.pitcher;
    const np = t.bullpen.find((p) => !p.used)!;
    substitutePitcher(w, t, np);
    const d = DUGOUT[t.side];
    const bp = bullpenMound(t.side);
    expect(Math.hypot(np.x - bp.x, np.z - bp.z)).toBeLessThan(6); // he comes in from the bullpen, where he was warming up
    expect(old.onField).toBe(true); // still on screen, walking off
    let pitchAt = -1;
    l.g.on('windup', () => (pitchAt = pitchAt < 0 ? w.tick : pitchAt));
    let sawOldLeave = false;
    for (let i = 0; i < 240 * 60 && pitchAt < 0; i++) {
      l.g.step(tickSecs);
      if (Math.hypot(old.x - d.x, old.z - d.z) < 2) sawOldLeave = true;
    }
    expect(pitchAt).toBeGreaterThan(0);
    expect(Math.hypot(np.x, np.z - MOUND_DIST)).toBeLessThan(0.8);
    expect(w.ball.holder).toBe(np);
    for (let i = 0; i < 240 * 20; i++) l.g.step(tickSecs);
    expect(old.onField).toBe(false);
    void sawOldLeave;
  });

  it('between innings the fielders who just came off jog in to their dugout and the others run out to their spots', () => {
    const g = createGame({ seed: 'set-6', pace: 1 });
    const w = g._world;
    let seen = 0;
    let started = false;
    let leaversDuringBreak = 0;
    g.on('halfInningStart', (e) => {
      if (e.inning === 1 && e.half === 'top') return;
      started = true;
    });
    for (let i = 0; i < 60 * 3600 && seen < 1 && !g.over; i++) {
      g.step(1 / 60);
      if (started) {
        if (w.phase === 'halfBreak') leaversDuringBreak = Math.max(leaversDuringBreak, w.leavers.length);
        if (w.phase === 'prePitch') seen++;
      }
    }
    expect(leaversDuringBreak).toBeGreaterThanOrEqual(6);
    expect(w.leavers.length).toBeLessThan(leaversDuringBreak);
  });
});

describe('ball handling after a dead ball', () => {
  function forceOutAtFirst() {
    for (const seed of ['run-out', 'fo2', 'fo3', 'fo4', 'fo5', 'fo6']) {
      const l = lab(seed, { pace: 1 });
      hitBall(l.w, 75, -2, 6, 1200);
      const anims = new Set<string>();
      const first = { id: '' };
      for (let i = 0; i < 240 * 40 && !(l.w.phase === 'prePitch' && i > 240); i++) {
        l.g.step(tickSecs);
        const ret = l.w.ret;
        if (ret && ret.stage === 'transfer') {
          first.id = ret.from.info.id;
          const p = l.g.getState().players.find((q) => q.id === ret.from.info.id)!;
          anims.add(p.anim);
        }
      }
      const outs = ofType(l.events, 'out').filter((e) => e.outType === 'force' && e.base === 1);
      const ret = ofType(l.events, 'ballReturn').find((e) => outs.length && e.time > outs[0].time);
      if (outs.length && ret) return { l, out: outs[0], ret, anims, holderId: first.id };
    }
    throw new Error('no force out at first found');
  }

  it('after a force out at first the fielder transfers, looks and only then makes an easy return: delayed by at least the transfer time, hint `transfer` then a casual throw', () => {
    const { l, out, ret, anims, holderId } = forceOutAtFirst();
    const holder = fielders(l.w).concat(l.w.pitcher).find((p) => p.info.id === holderId)!;
    const delay = ret.time - out.time;
    expect(delay).toBeGreaterThanOrEqual(0.4); // never quicker than the fastest transfer
    expect(delay).toBeGreaterThan(transferRoutine(holder.info.ratings, true, -0.1) - 0.05);
    expect(anims.has('transfer')).toBe(true);
    // casual speed
    const v = ret.mph * 0.44704;
    expect(v).toBeGreaterThanOrEqual(25);
    expect(v).toBeLessThanOrEqual(40);
    expect(v).toBeLessThanOrEqual(armMps(holder.info.ratings) + 0.5);
    expect(ret.casual).toBe(true);
  });

  it('the ball really travels at that easy speed and lands in the pitcher\'s hand; the pitch waits for it', () => {
    const l = lab('ret-1', { pace: 1 });
    const w = l.w;
    hitBall(w, 75, -2, 6, 1200);
    let maxSpeed = 0;
    let flying = false;
    let pitchedBeforeBack = false;
    l.g.on('pitchReleased', () => {
      if (w.ball.holder !== w.pitcher && flying) pitchedBeforeBack = true;
    });
    for (let i = 0; i < 240 * 40 && !(w.phase === 'prePitch' && i > 240 && w.ret === null && w.ball.holder === w.pitcher); i++) {
      l.g.step(tickSecs);
      if (w.ret && w.ret.stage === 'flight') {
        flying = true;
        const b = w.ball.body;
        maxSpeed = Math.max(maxSpeed, Math.hypot(b.vx, b.vz));
      }
    }
    expect(flying).toBe(true);
    expect(maxSpeed).toBeGreaterThan(20);
    expect(maxSpeed).toBeLessThan(42);
    expect(w.ball.holder).toBe(w.pitcher);
    expect(pitchedBeforeBack).toBe(false);
    void casualSpeed;
  });

  it('the catcher gets it back to the pitcher after each pitch: catch, transfer, look, a casual toss (about a second in all), with a `ballReturn` event', () => {
    const g = createGame({ seed: 'catch-ret', pace: 1 });
    const w = g._world;
    const events: GameEvent[] = [];
    g.on('*', (e) => events.push(e));
    let n = 0;
    while (!g.over && n++ < 60 * 600 && ofType(events, 'ballReturn').filter((e) => e.fromId === w.catcher.info.id).length < 8) g.step(1 / 60);
    const legs = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'ballReturn' && e.fromId.includes('-') && e.toId === w.pitcher.info.id);
    expect(legs.length).toBeGreaterThan(5);
    let checked = 0;
    for (const { e, i } of legs) {
      if (e.type !== 'ballReturn') continue;
      // the catch that started it
      const catchEv = [...events.slice(0, i)].reverse().find((x) => x.type === 'catch' && !x.fly);
      if (!catchEv || catchEv.type !== 'catch' || catchEv.fielderId !== e.fromId || catchEv.kind !== 'pitch' || e.time - catchEv.time > 3) continue; // (the catcher's own catch of the pitch)
      // only pitches that left the at-bat alive (a strikeout's return is the slower after-an-out routine)
      if (events.some((x) => x.time > catchEv.time && x.time < e.time && (x.type === 'out' || x.type === 'walk' || x.type === 'plateAppearanceEnd' || x.type === 'hitByPitch'))) continue;
      const dt = e.time - catchEv.time;
      expect(dt).toBeGreaterThan(0.25);
      expect(dt).toBeLessThan(1.5);
      expect(e.mph * 0.44704).toBeLessThanOrEqual(41);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
    void transferCatcher;
  });

  it('after a strikeout with the bases empty the infield sometimes tosses it around before it gets back to the pitcher', () => {
    let horn = false;
    for (const seed of ['horn-1', 'horn-2', 'horn-3']) {
      const g = createGame({ seed, pace: 1 });
      const w = g._world;
      const events: GameEvent[] = [];
      g.on('*', (e) => events.push(e));
      let n = 0;
      while (!g.over && w.inning < 5 && n++ < 60 * 2400) g.step(1 / 30);
      const legs = ofType(events, 'ballReturn');
      const pitcherIds = new Set([w.teams.home.pitcher.info.id, w.teams.away.pitcher.info.id, ...[...w.teams.home.players.values(), ...w.teams.away.players.values()].filter((p) => p.info.isPitcher).map((p) => p.info.id)]);
      if (legs.some((e) => !pitcherIds.has(e.toId))) horn = true;
      if (horn) break;
    }
    expect(horn).toBe(true);
  });
});
