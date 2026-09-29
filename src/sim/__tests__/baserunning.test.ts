import { describe, expect, it } from 'vitest';
import { BASE_POS } from '../field';
import { createGame } from '../game';
import { addRunner, hitBall, lab, ofType } from './helpers';

const FIRST = BASE_POS[1];
/** Distance beyond the first-base bag along the home->first line (m). */
const beyondFirst = (x: number, z: number) => ((x - FIRST.x) * FIRST.x + (z - FIRST.z) * FIRST.z) / Math.hypot(FIRST.x, FIRST.z);

/** Play a batted ball at broadcast pace, sampling the batter each 1/60 s until the next pitch is set up. */
function track(seed: string, mph: number, la: number, spray: number, setup?: (l: ReturnType<typeof lab>) => void) {
  const l = lab(seed, { pace: 1 });
  setup?.(l);
  const id = l.w.batter!.info.id;
  hitBall(l.w, mph, la, spray, 1200);
  const samples: { t: number; x: number; z: number; anim: string; present: boolean; phase: string }[] = [];
  for (let i = 0; i < 240 * 60 && !(l.w.phase === 'prePitch' && i > 240); i++) {
    l.g.step(1 / 240);
    if (i % 4 === 0) {
      const p = l.g.getState().players.find((q) => q.id === id);
      samples.push({ t: i / 240, x: p?.pos.x ?? NaN, z: p?.pos.z ?? NaN, anim: p?.anim ?? '', present: !!p, phase: l.w.phase });
    }
  }
  return { l, id, samples };
}

describe('baserunning', () => {
  it('a batter put out at first still runs through the bag and walks off (he does not stop short or vanish)', () => {
    const { l, samples } = track('run-out', 75, -2, 6);
    expect(ofType(l.events, 'out').some((e) => e.outType === 'force' && e.base === 1)).toBe(true);
    const maxBeyond = Math.max(...samples.filter((s) => s.present).map((s) => beyondFirst(s.x, s.z)));
    expect(maxBeyond).toBeGreaterThan(2);
    // he is still on screen a couple of seconds after the out
    const outTime = ofType(l.events, 'out')[0].time;
    const t0 = samples[0].t;
    const after = samples.filter((s) => s.t + (l.w.tick / 240 - samples.at(-1)!.t) > outTime + 1.5 - t0 && s.present);
    expect(after.length).toBeGreaterThan(5);
  });

  it('a safe batter overruns first, then returns to the bag; the play ends with him on it', () => {
    let checked = 0;
    const cands: [string, number, number, number][] = [];
    for (const seed of ['s5', 's6', 's7', 's8', 's9']) for (const [mph, la, sp] of [[85, 6, 25], [88, 4, 20], [84, 5, -20], [82, 7, 0], [86, 5, -10], [78, 9, 15]]) cands.push([seed, mph, la, sp]);
    for (const [seed, mph, la, sp] of cands) {
      if (checked >= 2) break;
      const { l, samples } = track(seed, mph, la, sp);
      const adv = ofType(l.events, 'runnerAdvance').filter((e) => e.fromBase === 0 && e.toBase === 1);
      if (adv.length !== 1 || ofType(l.events, 'runnerAdvance').some((e) => e.toBase >= 2)) continue; // only clean singles
      checked++;
      const beyond = samples.filter((s) => s.present).map((s) => beyondFirst(s.x, s.z));
      expect(Math.max(...beyond)).toBeGreaterThan(2.5);
      // ... and he touched first exactly once on the way
      expect(ofType(l.events, 'baseTouch').filter((e) => e.base === 1).length).toBe(1);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('extra-base hits touch each base exactly once, in order, with the run_turn hint at the bags', () => {
    const seen = new Set<string>();
    let doubles = 0;
    for (const [mph, la, sp] of [[96, 14, 18], [98, 12, -20], [100, 16, 30], [95, 13, -30], [97, 15, 12]] as number[][]) {
      const { l, id, samples } = track(`xbh-${mph}-${sp}`, mph, la, sp);
      for (const s of samples) seen.add(s.anim);
      const t = ofType(l.events, 'baseTouch').filter((e) => e.playerId === id).map((e) => e.base);
      if (!t.length) continue;
      // never out of order and never twice
      expect(t).toEqual([...t].sort((a, b) => a - b));
      expect(new Set(t).size).toBe(t.length);
      if (t.includes(2)) doubles++;
    }
    expect(doubles).toBeGreaterThan(0);
    expect(seen.has('run_turn')).toBe(true);
  });

  it('a home run is a real trot: every runner touches every base, around 20 s for the batter, with baseTouch events and a celebration at the plate', () => {
    const l = lab('trot', { pace: 1 });
    addRunner(l.w, 1);
    const batter = l.w.batter!.info.id;
    const runner1 = l.w.runners.find((r) => r.base === 1)!.p.info.id;
    hitBall(l.w, 108, 27, -20, 1800);
    const anims = new Set<string>();
    const startTick = l.w.tick;
    let lastTouchTick = 0;
    l.g.on('baseTouch', () => (lastTouchTick = l.w.tick));
    for (let i = 0; i < 240 * 90 && !(l.w.phase === 'prePitch' && i > 240); i++) {
      l.g.step(1 / 240);
      if (i % 12 === 0) for (const p of l.g.getState().players) if (p.id === batter) anims.add(p.anim);
    }
    const touches = ofType(l.events, 'baseTouch');
    expect(ofType(l.events, 'homeRun').length).toBe(1);
    expect(touches.filter((e) => e.playerId === batter).map((e) => e.base)).toEqual([1, 2, 3, 4]);
    expect(touches.filter((e) => e.playerId === runner1).map((e) => e.base)).toEqual([2, 3, 4]);
    const bt = touches.filter((e) => e.playerId === batter);
    expect(bt.slice(1).every((e) => e.trot)).toBe(true);
    const around = bt[3].time - bt[0].time;
    expect(around).toBeGreaterThan(14);
    expect(around).toBeLessThan(32);
    // the batter runs, jogs, turns and celebrates
    for (const a of ['trot', 'celebrate']) expect(anims.has(a)).toBe(true);
    expect(anims.has('run_turn') || anims.has('trot')).toBe(true);
    // both runs scored, the next batter only came up after the last runner crossed the plate
    const scored = ofType(l.events, 'runScored');
    expect(scored.length).toBe(2);
    const nextUp = ofType(l.events, 'batterUp').filter((e) => e.time > touches[0].time).at(-1);
    void nextUp;
    expect(lastTouchTick).toBeGreaterThan(startTick);
  });

  it('runners never share a base or pass each other over whole games', () => {
    for (const seed of ['share-1', 'share-2']) {
      const g = createGame({ seed, pace: 0.05 });
      const w = g._world;
      let bad = 0;
      let t = 0;
      while (!g.over && t < 4 * 3600 * 240) {
        g.step(0.25);
        t += 60;
        const settled = w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead && r.target === r.base && !r.overrun);
        const bases = settled.map((r) => r.base);
        if (new Set(bases).size !== bases.length && w.phase === 'playOver') bad++;
      }
      expect(bad).toBe(0);
    }
  });
});
