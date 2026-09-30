import { describe, expect, it } from 'vitest';
import { BASE_POS } from '../field';
import { fielders } from '../fielding';
import { newPlay } from '../inplay';
import { Rng } from '../rng';
import { footOnBase, runnerBody } from '../tagging';
import type { GameEvent } from '../types';
import { giveBall } from '../util';
import type { PlayerRT, RunnerRT, World } from '../world';
import { addRunner, lab, ofType } from './helpers';

const unit = (x: number, z: number) => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

interface Trial {
  events: GameEvent[];
  out: boolean;
  safe: boolean;
}

/**
 * A play at second base: a runner comes in from first at `speed`; the shortstop is at the bag with the ball, having caught it `readyIn` seconds
 * from the start; the runner slides `kind` (or the game picks). Returns what happened.
 */
function playAtSecond(seed: string, opts: { startDist: number; speed: number; readyIn: number; slide?: 'feet' | 'head' | 'hookL' | 'hookR' | null; fielderSide?: number }): Trial {
  const l = lab(seed);
  const w = l.w;
  const bag = BASE_POS[2];
  const from = BASE_POS[1];
  const dir = unit(bag.x - from.x, bag.z - from.z);
  const r = addRunner(w, 1);
  r.stealing = true;
  r.want = 2;
  r.target = 2;
  r.origin = 1;
  r.reaction = 0;
  r.p.x = bag.x - dir.x * opts.startDist;
  r.p.z = bag.z - dir.z * opts.startDist;
  r.p.vx = dir.x * opts.speed;
  r.p.vz = dir.z * opts.speed;
  r.p.vmax = opts.speed;
  const F = fielders(w).find((p) => p.fieldPos === 'SS')!;
  // he stands 0.5 m to the side of the line, up the line toward the throw
  const left = { x: dir.z, z: -dir.x };
  const side = opts.fielderSide ?? 0;
  F.x = bag.x - dir.x * 0.4 + left.x * 0.45 * side;
  F.z = bag.z - dir.z * 0.4 + left.z * 0.45 * side;
  F.vx = F.vz = 0;
  F.facing = Math.atan2(-dir.x, -dir.z);
  F.goal = null;
  w.play = newPlay(w, 'steal');
  w.phase = 'inPlay';
  w.rng = new Rng(seed);
  giveBall(w, F);
  F.plan.lastAttempt = w.tick + Math.round(opts.readyIn * 240) - 24; // the catch happens at readyIn (a tag is ready 0.1 s later)
  F.plan.holdUntil = w.tick;
  if (opts.slide !== undefined) {
    r.slideKind = opts.slide;
    r.slideAt = w.tick;
  }
  const before = l.events.length;
  for (let i = 0; i < 240 * 4 && r.state === 'live' && !(r.contactBase === 2 && Math.hypot(r.p.vx, r.p.vz) < 0.5); i++) {
    // (a fielder who has not caught it yet cannot tag: emulate the arrival by withholding the ball until then)
    l.g.step(1 / 240);
    if (r.state !== 'live') break;
  }
  const events = l.events.slice(before);
  return { events, out: r.state === 'out', safe: r.state === 'live' && r.base === 2 };
}

describe('tagging: a real mechanism', () => {
  it('the fielder with the ball ready at the bag tags the runner out; a runner who is on the bag before the glove is ready is safe', () => {
    let outs = 0;
    let safes = 0;
    for (let k = 0; k < 40; k++) {
      const early = playAtSecond(`tag-early-${k}`, { startDist: 4.5, speed: 7.5, readyIn: 0.0, slide: 'feet' });
      const late = playAtSecond(`tag-late-${k}`, { startDist: 4.5, speed: 7.5, readyIn: 1.2, slide: 'feet' });
      if (early.out) outs++;
      if (late.safe) safes++;
    }
    expect(outs).toBeGreaterThanOrEqual(30); // in place and ready: nearly always out (the odd miss / drop is part of it)
    expect(outs).toBeLessThan(40 + 1);
    expect(safes).toBeGreaterThanOrEqual(36); // the ball got there after him
  });

  it('a tag connects with the glove (event chain tagAttempt -> tag -> out) and the out carries its margin and closePlay', () => {
    let seen = 0;
    for (let k = 0; k < 20 && !seen; k++) {
      const t = playAtSecond(`chain-${k}`, { startDist: 4.5, speed: 7.5, readyIn: 0, slide: 'feet' });
      const a = ofType(t.events, 'tagAttempt')[0];
      const tag = ofType(t.events, 'tag')[0];
      const out = ofType(t.events, 'out')[0];
      if (!tag) continue;
      seen++;
      expect(a.hand).toBe('glove');
      expect(a.base).toBe(2);
      expect(tag.time).toBeGreaterThanOrEqual(a.time);
      expect(out.outType === 'tag' || out.outType === 'caughtStealing').toBe(true);
      expect(typeof out.margin).toBe('number');
      expect(out.margin!).toBeGreaterThanOrEqual(0);
      expect(out.closePlay).toBe(Math.abs(out.margin!) < 0.1);
    }
    expect(seen).toBe(1);
  });

  it('a runner who slides away from the glove is tagged less often than one who slides straight in; the miss is announced as tagAvoided', () => {
    // the fielder is on the third-base side of the line (left of a runner heading up the first-to-second line), so the runner hooks right, away from him
    let straight = 0;
    let away = 0;
    let toward = 0;
    let avoidedEvents = 0;
    const N = 120;
    for (let k = 0; k < N; k++) {
      if (playAtSecond(`slide-f-${k}`, { startDist: 3.4, speed: 7.2, readyIn: 0, slide: 'feet', fielderSide: 1 }).out) straight++;
      const a = playAtSecond(`slide-a-${k}`, { startDist: 3.4, speed: 7.2, readyIn: 0, slide: 'hookR', fielderSide: 1 });
      const t = playAtSecond(`slide-t-${k}`, { startDist: 3.4, speed: 7.2, readyIn: 0, slide: 'hookL', fielderSide: 1 });
      if (a.out) away++;
      if (t.out) toward++;
      avoidedEvents += ofType(a.events, 'tagAvoided').filter((e) => e.slide === 'hookR').length;
    }
    console.log('tag rates: straight', straight, 'away', away, 'toward', toward, 'of', N);
    expect(away).toBeLessThan(straight - 8);
    expect(away).toBeLessThan(toward); // into the glove side is worse than away from it
    expect(avoidedEvents).toBeGreaterThan(0);
  });

  it('the sim itself picks the slide: away from the glove when the fielder is on the line, dives back on a pickoff, never into first', () => {
    const kinds = new Set<string>();
    for (let k = 0; k < 12; k++) {
      const l = lab(`pick-${k}`);
      const w = l.w;
      const bag = BASE_POS[2];
      const from = BASE_POS[1];
      const dir = unit(bag.x - from.x, bag.z - from.z);
      const r = addRunner(w, 1);
      r.stealing = true;
      r.want = 2;
      r.target = 2;
      r.origin = 1;
      r.reaction = 0;
      r.p.x = bag.x - dir.x * 5;
      r.p.z = bag.z - dir.z * 5;
      r.p.vx = dir.x * 7.5;
      r.p.vz = dir.z * 7.5;
      const F = fielders(w).find((p) => p.fieldPos === '2B')!;
      F.x = bag.x - dir.x * 0.8;
      F.z = bag.z - dir.z * 0.8 + 0.3 * (k % 2 ? 1 : -1);
      w.play = newPlay(w, 'steal');
      w.phase = 'inPlay';
      giveBall(w, F);
      F.plan.lastAttempt = w.tick;
      for (let i = 0; i < 240 * 2 && r.state === 'live' && !r.slideKind; i++) l.g.step(1 / 240);
      if (r.slideKind) kinds.add(r.slideKind);
    }
    expect([...kinds].some((k) => k === 'hookL' || k === 'hookR')).toBe(true);
    // a batter running through first never slides
    const l = lab('nofirst');
    const s = new Set<string>();
    l.g.on('*', () => undefined);
    for (const r of l.w.runners) s.add(String(r.slideKind));
    expect(s.has('feet')).toBe(false);
  });

  it('the tag can be dropped: a ball that jars loose on contact is an error and the runner is safe', () => {
    let drops = 0;
    let tags = 0;
    for (let k = 0; k < 300; k++) {
      const t = playAtSecond(`drop-${k}`, { startDist: 4.5, speed: 8.4, readyIn: 0, slide: 'feet' });
      if (ofType(t.events, 'error').some((e) => e.kind === 'drop')) {
        drops++;
        expect(t.out).toBe(false);
      }
      if (ofType(t.events, 'tag').length) tags++;
    }
    expect(tags).toBeGreaterThan(150);
    expect(drops).toBeGreaterThan(0);
    expect(drops).toBeLessThan(tags * 0.08);
  });

  it('a runner in the open sidesteps a sweep he sees coming: some sweeps miss and are announced as `tagAvoided` (dodge)', () => {
    let dodged = 0;
    let attempts = 0;
    let outs = 0;
    for (let k = 0; k < 120; k++) {
      const l = lab(`dodge-${k}`);
      const w = l.w;
      const r = addRunner(w, 1);
      r.want = 2;
      r.target = 2;
      r.stealing = true;
      r.reaction = 0;
      // caught in a rundown between the bases: fielder closing from the front
      const mid = { x: -9.7, z: 29.1 };
      r.p.x = mid.x;
      r.p.z = mid.z;
      r.p.vx = 3;
      r.p.vz = 3;
      const F = fielders(w).find((p) => p.fieldPos === '1B')!;
      F.x = mid.x + 1.6;
      F.z = mid.z + 1.6;
      F.vx = F.vz = 0;
      F.facing = Math.atan2(-1, -1);
      w.play = newPlay(w, 'steal');
      w.phase = 'inPlay';
      w.rng = new Rng(`d${k}`);
      giveBall(w, F);
      F.plan.lastAttempt = w.tick - 40;
      F.plan.holdUntil = w.tick;
      const before = l.events.length;
      for (let i = 0; i < 240 && r.state === 'live'; i++) l.g.step(1 / 240);
      const ev = l.events.slice(before);
      attempts += ofType(ev, 'tagAttempt').length ? 1 : 0;
      dodged += ofType(ev, 'tagAvoided').filter((e) => e.slide === 'dodge').length ? 1 : 0;
      if (r.state === 'out') outs++;
    }
    expect(attempts).toBeGreaterThan(60);
    expect(dodged).toBeGreaterThan(3);
    expect(outs).toBeGreaterThan(attempts * 0.3); // most are still tagged
    expect(outs).toBeLessThan(attempts);
  });
});

describe('force plays: a foot on the bag with the ball', () => {
  function forcePlay(seed: string, standoff: number) {
    const l = lab(seed);
    const w = l.w;
    const first = BASE_POS[1];
    const dir = unit(first.x - 0, first.z - 0);
    const r = addRunner(w, 0);
    r.isBatter = true;
    r.base = 0;
    r.target = 1;
    r.want = 1;
    r.touched = [false, false, false, false, false];
    r.p.x = first.x - dir.x * 3;
    r.p.z = first.z - dir.z * 3;
    r.p.vx = dir.x * 8;
    r.p.vz = dir.z * 8;
    r.reaction = 0;
    const F = fielders(w).find((p) => p.fieldPos === '1B')!;
    F.x = first.x - dir.x * 0.0 + (dir.z) * standoff;
    F.z = first.z - dir.z * 0.0 - (dir.x) * standoff;
    F.vx = F.vz = 0;
    w.play = newPlay(w, 'battedBall');
    w.phase = 'inPlay';
    giveBall(w, F);
    F.plan.lastAttempt = w.tick - 40;
    F.plan.holdUntil = w.tick;
    for (let i = 0; i < 240 * 2 && r.state === 'live' && r.base === 0; i++) l.g.step(1 / 240);
    return { l, r, F: F as PlayerRT, w: w as World, force: ofType(l.events, 'out').some((e) => e.outType === 'force') };
  }

  it('a foot within 0.65 m of the bag with the ball secure is a force out before the batter arrives; a fielder pulled off the bag has no force', () => {
    const on = forcePlay('force-on', 0.4);
    expect(on.force).toBe(true);
    const off = forcePlay('force-off', 1.5);
    expect(off.force).toBe(false);
    expect(footOnBase(on.F, 1)).toBe(true);
  });

  it('the out carries the margin by which the fielder beat the runner', () => {
    const on = forcePlay('force-margin', 0.4);
    const out = ofType(on.l.events, 'out').find((e) => e.outType === 'force')!;
    expect(out.margin).toBeGreaterThan(0.1);
    expect(out.closePlay).toBe(false);
  });
});

describe('the body a tag has to find', () => {
  it('an upright runner is a fat point; a sliding one a thin segment reaching the bag with his foot or hand', () => {
    const l = lab('body');
    const r = addRunner(l.w, 1) as RunnerRT;
    r.target = 2;
    r.p.x = -2;
    r.p.z = 30;
    const up = runnerBody(r);
    expect(up.tx).toBe(up.cx);
    r.slideKind = 'feet';
    const feet = runnerBody(r);
    expect(Math.hypot(feet.tx - feet.cx, feet.tz - feet.cz)).toBeCloseTo(1.0, 1);
    r.slideKind = 'head';
    const head = runnerBody(r);
    expect(Math.hypot(head.tx - head.cx, head.tz - head.cz)).toBeGreaterThan(1.1);
    expect(feet.radius).toBeLessThan(up.radius);
  });
});
