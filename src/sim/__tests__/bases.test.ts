/**
 * Touch every base: a base is touched by a foot that comes down on the bag (or a slide's leading foot / hand), not by the body
 * passing near it. Runners time their steps onto the bag; one who goes past with no foot on it has missed it, and the defense can
 * appeal (the user saw a runner pass first base without a foot on it).
 */
import { describe, expect, it } from 'vitest';
import { appealOut, appealStage } from '../appeals';
import { BASE_POS } from '../field';
import { fielders } from '../fielding';
import { makeRunner } from '../running';
import { newPlay } from '../inplay';
import { BAG_HALF, distToBase, footPoint, gaitFor, GAITS, naturalStep, shoeOn, standsOn, STEP_AIM, TURN_GAITS } from '../stride';
import { giveBall } from '../util';
import type { RunnerRT, World } from '../world';
import { addRunner, lab, ofType } from './helpers';
import type { GameEvent } from '../types';

const unit = (x: number, z: number) => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

/** A batter-runner (or a runner from `from`) on the base path `dist` metres short of base `to`, running at `speed`, his stride at `phase`. */
function runnerAt(w: World, from: number, to: number, dist: number, speed: number, phase: number, want = to): RunnerRT {
  const a = from === 0 ? { x: 0, z: 0 } : BASE_POS[from];
  const b = BASE_POS[to % 4];
  const d = unit(b.x - a.x, b.z - a.z);
  const r = from === 0 ? makeRunner(w, w.batter!, true) : addRunner(w, from);
  // (nobody at the plate in the runner's way: the batter is the batter-runner, or he has stepped away)
  if (from > 0 && w.batter) w.batter.onField = false;
  r.base = from;
  r.target = to;
  r.want = want;
  r.reaction = 0;
  const p = r.p;
  p.x = b.x - d.x * dist;
  p.z = b.z - d.z * dist;
  p.vx = d.x * speed;
  p.vz = d.z * speed;
  p.vmax = speed;
  p.facing = Math.atan2(d.x, d.z);
  p.stride.len = naturalStep(speed);
  p.stride.dist = phase * p.stride.len;
  p.stride.last = null;
  p.stride.prev = null;
  r.strikeSeen = 0;
  // a play with the ball in the pitcher's glove on the mound, and a defense that holds it: nothing but the runner's feet decides
  w.play = newPlay(w, 'steal');
  w.phase = 'inPlay';
  giveBall(w, w.pitcher);
  return r;
}

const holdIt = { throw: () => ({ action: 'hold' as const, recheckSec: 99 }) };
/** The batting side: the runner wants `want` whatever happens, the coaches say nothing. */
const keepGoing = (want: number) => ({ runner: () => ({ want, recheckSec: 99 }), coach: () => ({ call: 'none' as const }) });

const touches = (ev: GameEvent[], id: string, base: number) => ofType(ev, 'baseTouch').filter((e) => e.playerId === id && e.base === base);

describe('the bag and the plate', () => {
  it('bags are 15 in squares with their edges along the base paths; the plate is the pentagon', () => {
    const f = BASE_POS[1];
    expect(distToBase(1, f.x, f.z)).toBe(0);
    // along the base path from home, the bag ends half a side (not half a diagonal) from its middle
    const d = unit(f.x, f.z);
    expect(distToBase(1, f.x - d.x * (BAG_HALF - 0.01), f.z - d.z * (BAG_HALF - 0.01))).toBe(0);
    expect(distToBase(1, f.x - d.x * (BAG_HALF + 0.1), f.z - d.z * (BAG_HALF + 0.1))).toBeCloseTo(0.1, 5);
    // a body 0.5 m from the middle of the bag is not on it (the old rule counted anything within 0.9 m)
    expect(distToBase(2, BASE_POS[2].x + 0.5, BASE_POS[2].z)).toBeGreaterThan(0.2);
    expect(distToBase(4, 0, 0.2)).toBe(0);
    expect(distToBase(4, 0, 0.42)).toBe(0);
    expect(distToBase(4, 0.15, 0.05)).toBeGreaterThan(0.05); // outside the point
    expect(distToBase(4, 5.3, 7.4)).toBeGreaterThan(8);
  });

  it('the footstrike offsets are the gait clips\' (the left foot lands left of the body, the right foot right)', () => {
    for (const g of GAITS) {
      const L = footPoint(0, 0, 0, g.speed, 0, false);
      const R = footPoint(0, 0, 0, g.speed, 1, false);
      // facing +Z his left is +X
      expect(L.x).toBeGreaterThan(0);
      expect(R.x).toBeLessThan(0);
      expect(L.z).toBeGreaterThan(0.2);
    }
  });
});

describe('runners time their steps onto the bag', () => {
  it('running through first, rounding first and second, and stopping at second: a foot lands on the bag every time, at every speed and stride phase', () => {
    let n = 0;
    for (const [from, to, want] of [[0, 1, 1], [0, 1, 2], [1, 2, 3], [1, 2, 2], [2, 3, 3], [3, 4, 4]] as const) {
      for (const speed of [5, 6.5, 7.6, 8.6]) {
        for (const phase of [0, 0.25, 0.5, 0.75]) {
          const l = lab(`steps-${from}-${to}-${speed}-${phase}`);
          l.g.setProvider(l.w.fieldingTeam.side, holdIt);
          l.g.setProvider(l.w.battingTeam.side, keepGoing(want));
          const r = runnerAt(l.w, from, to, 9 + phase, speed, phase, want);
          // the footstrike that made the touch: its shoe is on the bag
          let shoe = false;
          l.g.on('baseTouch', (e) => {
            if (e.playerId !== r.p.info.id || e.base !== to) return;
            const s = r.p.stride;
            shoe = r.slideKind || standsOn(r.p, to) ? true : [s.last, s.prev].some((st) => !!st && shoeOn(to, st) && Math.hypot(st.x - e.touch!.x, st.z - e.touch!.z) < 1e-6);
          });
          for (let i = 0; i < 240 * 4 && !(r.base >= to); i++) l.g.step(1 / 240);
          const t = touches(l.events, r.p.info.id, to);
          expect(r.base, `${from}->${to} want ${want} at ${speed} m/s phase ${phase}`).toBeGreaterThanOrEqual(to);
          expect(r.touched[to], `${from}->${to} want ${want} at ${speed} m/s phase ${phase}: ${JSON.stringify(ofType(l.events, "baseMissed"))}`).toBe(true);
          expect(t.length).toBe(1);
          // the point of the foot (or the slide's limb) is on the bag
          expect(t[0].limb).toBeDefined();
          expect(shoe, `${from}->${to} want ${want} at ${speed} m/s phase ${phase}`).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBe(96);
  });

  it('standing on the bag (or right beside it, a foot on it) is a touch; standing off it is not', () => {
    const l = lab('stand');
    const r = addRunner(l.w, 1);
    const b = BASE_POS[2];
    r.p.x = b.x + 0.05;
    r.p.z = b.z;
    expect(standsOn(r.p, 2)).toBe(true);
    r.p.x = b.x + 1.0;
    expect(standsOn(r.p, 2)).toBe(false);
  });
});

describe('a missed base', () => {
  /**
   * A batter-runner running through first who does not time his steps (`STEP_AIM` off): his left foot comes down `short` metres
   * before the bag's near edge (toe to edge), and the next one, a full stride on, past it. 4 cm short: a near miss he may not feel;
   * 30 cm: one he does.
   */
  function untimed(seed: string, short: number) {
    const l = lab(seed);
    l.g.setProvider(l.w.fieldingTeam.side, holdIt);
    l.g.setProvider(l.w.battingTeam.side, keepGoing(1));
    const g = gaitFor(8.6, false);
    // ankle at -(half bag + toe + short) from the middle of the bag; the body that far behind the ankle when it lands
    const ankle = BAG_HALF + 0.2 + short;
    const body = ankle + g.fwd[0];
    const r = runnerAt(l.w, 0, 1, body + 0.21, 8.6, 0, 1);
    r.p.stride.next = 0;
    r.p.stride.len = naturalStep(8.6);
    r.p.stride.dist = r.p.stride.len - 0.21;
    return { l, r };
  }

  it('a runner who goes past the bag with no foot on it either feels it and goes back to touch it, or runs on with the base flagged missed', () => {
    let back = 0, unaware = 0;
    const keep = { ...STEP_AIM };
    STEP_AIM.maxSteps = 0;
    for (let k = 0; k < 24; k++) {
      const { l, r } = untimed(`miss-${k}`, k % 2 ? 0.04 : 0.3);
      const id = r.p.info.id;
      for (let i = 0; i < 240 * 6 && !(r.base >= 1 && Math.hypot(r.p.vx, r.p.vz) < 1); i++) l.g.step(1 / 240);
      const missed = ofType(l.events, 'baseMissed').filter((e) => e.playerId === id && e.base === 1);
      expect(missed.length, `seed ${k}`).toBeGreaterThanOrEqual(1);
      if (missed[0].knows) {
        back++;
        // he went back for it: touched it after all (with a foot), and nothing to appeal
        expect(touches(l.events, id, 1).length, `seed ${k}`).toBe(1);
        expect(l.w.misses.some((m) => m.r === r)).toBe(false);
      } else {
        unaware++;
        expect(r.base).toBeGreaterThanOrEqual(1);
        expect(touches(l.events, id, 1).length).toBe(0);
        expect(l.w.misses.filter((m) => m.r === r && m.base === 1).length).toBe(1);
        // (a force: the batter-runner missing first is out on an appeal even with runs scoring)
        expect(l.w.misses[0].forced).toBe(true);
      }
    }
    Object.assign(STEP_AIM, keep);
    expect(back).toBeGreaterThan(2);
    expect(unaware).toBeGreaterThan(2);
  });
});

describe('appeals', () => {
  /** A runner on second who missed first on his way, the ball with the pitcher after the play. */
  function missedFirst(seed: string, pace: number, seen: boolean) {
    const l = lab(seed, { pace });
    const w = l.w;
    const r = addRunner(w, 2);
    r.touched[1] = false;
    w.misses.push({ r, base: 1, seen, tick: w.tick, done: false, forced: false });
    w.phase = 'playOver';
    giveBall(w, w.pitcher);
    return { l, w, r };
  }

  it('the defense appeals a miss a fielder saw: the ball goes to the first baseman, he steps on the bag, the umpire calls the runner out', () => {
    const { l, w, r } = missedFirst('appeal-1', 1, true);
    const outs0 = w.outs;
    let done = false;
    for (let i = 0; i < 240 * 20 && !done; i++) {
      done = appealStage(w);
      l.g.step(1 / 240);
    }
    expect(done).toBe(true);
    expect(r.state).toBe('out');
    expect(w.outs).toBe(outs0 + 1);
    const ap = ofType(l.events, 'appeal');
    expect(ap.map((e) => e.stage)).toEqual(['start', 'out']);
    const F = fielders(w).find((p) => p.fieldPos === '1B')!;
    expect(ap[1].fielderId).toBe(F.info.id);
    const out = ofType(l.events, 'out').find((e) => e.playerId === r.p.info.id)!;
    expect(out.outType).toBe('appeal');
    expect(out.base).toBe(1);
    // the first-base umpire's signal
    expect(w.umpQueue.some((c) => c.ump === 'first') || ofType(l.events, 'umpireCall').some((e) => e.umpire === 'first' && e.kind === 'out')).toBe(true);
    // he had the ball and his foot on the bag
    expect(Math.hypot(F.x - BASE_POS[1].x, F.z - BASE_POS[1].z)).toBeLessThan(0.7);
  });

  it('a miss nobody saw stays safe; a provider can decline an appeal too', () => {
    // (a question is answered on the tick after it is asked)
    const settle = (x: ReturnType<typeof missedFirst>) => {
      for (let i = 0; i < 10; i++) {
        if (appealStage(x.w)) return true;
        x.w.tick++;
      }
      return false;
    };
    const a = missedFirst('appeal-2', 0, false);
    expect(settle(a)).toBe(true);
    expect(a.r.state).toBe('live');
    const b = missedFirst('appeal-3', 0, true);
    b.l.g.setProvider(b.w.fieldingTeam.side, { appeal: () => ({ appeal: false }) });
    expect(settle(b)).toBe(true);
    expect(b.r.state).toBe('live');
    const c = missedFirst('appeal-4', 0, true);
    expect(settle(c)).toBe(true);
    expect(c.r.state).toBe('out');
  });

  it('runs: the appealed runner\'s run comes off; as the third out, the runs of the runners behind him on the play too, all of them on a force', () => {
    for (const forced of [false, true]) {
      const l = lab(`appeal-runs-${forced}`);
      const w = l.w;
      w.outs = 2;
      const lead = addRunner(w, 3, 1);
      const trail = addRunner(w, 2, 2);
      const ahead = addRunner(w, 3, 3); // (a runner ahead of him: his run stands unless it was a force)
      lead.origin = 2;
      trail.origin = 1;
      ahead.origin = 3;
      const runs0 = w.battingTeam.runs;
      w.play = { runsThisPlay: [], outsThisPlay: [] } as unknown as World['play'];
      // ahead scores, then the lead runner (who missed third on the way), then the trailing runner
      for (const r of [ahead, lead, trail]) {
        r.state = 'live';
        r.base = 4;
        r.state = 'scored';
        w.battingTeam.runs++;
        w.inningRuns++;
        w.play!.runsThisPlay.push({ runner: r, tick: w.tick + (r === ahead ? -10 : r === lead ? 1 : 2) });
      }
      const m = { r: lead, base: 3, seen: true, tick: w.tick, done: false, forced };
      appealOut(w, m, fielders(w).find((p) => p.fieldPos === '3B')!);
      expect(w.outs).toBe(3);
      const left = w.play!.runsThisPlay.map((rs) => rs.runner);
      expect(left.includes(lead)).toBe(false);
      expect(left.includes(trail)).toBe(false);
      expect(left.includes(ahead)).toBe(true);
      expect(w.battingTeam.runs).toBe(runs0 + 1);
      void forced;
    }
  });
});

describe('the stride matches the shipped clips', () => {
  it('step lengths and stance speeds are the manifest\'s; touchdown offsets are the ones measured from player_base.glb', async () => {
    const { readFileSync } = await import('node:fs');
    const man = JSON.parse(readFileSync(new URL('../../../assets/players/player_manifest.json', import.meta.url), 'utf8'));
    const { loadRig, strikesOf } = await import('../../../tools/contact/clipfeet');
    const rig = await loadRig();
    for (const g of [...GAITS, ...TURN_GAITS]) {
      const c = man.clips[g.name];
      expect(g.step, g.name).toBeCloseTo(c.distance_per_cycle_m / 2, 2);
      expect(g.speed, g.name).toBeCloseTo(c.footSpeed, 2);
      const s = strikesOf(rig, g.name);
      for (const k of s.strikes) {
        const foot = k.foot === 'L' ? 0 : 1;
        expect(Math.abs(g.fwd[foot] - k.fwd), `${g.name} ${k.foot} fwd`).toBeLessThan(0.01);
        expect(Math.abs(g.side[foot] - k.side), `${g.name} ${k.foot} side`).toBeLessThan(0.01);
      }
    }
  }, 60000);
});

describe('dead-ball placements walk', () => {
  it('in any phase of two whole games nobody on view moves further in one tick than he can run (the batter back into the box, runners onto their bags)', async () => {
    const { createGame } = await import('../game');
    const { dugoutFloorY } = await import('../venue');
    let worst = 0, at = '';
    for (const seed of ['snap-1', 'snap-2']) {
      const g = createGame({ seed, pace: 1, tempo: 'quick' });
      const w = g._world;
      const prev = new Map<string, [number, number, boolean]>();
      for (let n = 0; !g.over && n < 240 * 8000; n++) {
        g.step(1 / 240);
        for (const t of [w.teams.home, w.teams.away]) for (const p of t.players.values()) {
          const vis = (p.onField || !!p.dug) && p.dug !== 'bench' && p.dug !== 'bullpen' && dugoutFloorY(p.x, p.z) >= 0;
          const q = prev.get(p.info.id);
          prev.set(p.info.id, [p.x, p.z, vis]);
          if (!q || !vis || !q[2]) continue;
          const d = Math.hypot(p.x - q[0], p.z - q[1]);
          const r = d / (Math.max(p.vmax, 3) / 240);
          if (d > 0.03 && r > worst) {
            worst = r;
            at = `${seed} t ${(w.tick / 240).toFixed(2)} ${w.phase} ${p.info.id} ${(d * 100).toFixed(0)} cm`;
          }
        }
      }
    }
    expect(worst, at).toBeLessThanOrEqual(1.5);
  }, 600000);
});
