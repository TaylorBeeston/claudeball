import { describe, expect, it } from 'vitest';
import { DEFAULT_ENV, flightStep, newFlags, stepBall } from '../ball';
import type { BallBody } from '../ball';
import * as A from '../attributes';
import { BatSwing, batBallCollision, buildSwing, perceivePitch, aiSwingDecision, stanceFor } from '../batting';
import { DEFAULT_FENCE, MOUND_DIST, groundHeight, MOUND_HEIGHT } from '../field';
import { doThrow, fielders, fieldingAttempts, initFielderPlans, solveThrow, transferTicks } from '../fielding';
import { newPlay } from '../inplay';
import { giveBall, releaseBall } from '../util';
import { MPH } from '../math';
import { stepPlayer } from '../movement';
import { strikeZoneFor, throwPitch } from '../pitching';
import { generateTeam } from '../roster';
import { Rng } from '../rng';
import { stealTimes } from '../running';
import type { PlayerInfo, Ratings } from '../types';
import { umpireCall } from '../flow';
import { lab } from './helpers';
import { addRunner } from './helpers';

const env = DEFAULT_ENV(DEFAULT_FENCE);
const team = generateTeam('attr-test');
const baseHitter = team.roster.find((p) => !p.isPitcher && p.bats === 'R')!;
const basePitcher = team.roster.find((p) => p.isPitcher && p.throws === 'R')!;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

/** A copy of a player with some ratings replaced. */
function withRatings(p: PlayerInfo, r: Partial<Ratings>): PlayerInfo {
  return { ...p, ratings: { ...p.ratings, ...r }, delivery: p.delivery ? { ...p.delivery } : undefined };
}

function pitchTo(p: PlayerInfo, rng: Rng, opts: { targetX?: number; targetY?: number; type?: string; ctx?: object } = {}) {
  const spec = (opts.type ? p.arsenal.find((a) => a.type === opts.type) : null) ?? p.arsenal[0];
  const slot = { x: p.traits.armSide, y: p.traits.armHeight, ext: p.traits.extension };
  return throwPitch(p, slot, spec, opts.targetX ?? 0, opts.targetY ?? 0.8, { fatigue: 0, rng, env, ...(opts.ctx ?? {}) });
}

/** Swings at pitches down the middle: returns per-swing timing error (s), spray and launch of the contacts. */
function swings(b: PlayerInfo, n: number, seed: string, mods = { form: 0, pressure: 0 }, pitcher = basePitcher) {
  const rng = new Rng(seed);
  const zone = strikeZoneFor(b.height);
  const stance = stanceFor(b.bats, pitcher.throws);
  const timing: number[] = [];
  const spray: number[] = [];
  const la: number[] = [];
  const alpha: number[] = [];
  let contacts = 0;
  for (let i = 0; i < n; i++) {
    const pitch = pitchTo(pitcher, rng, { targetX: 0, targetY: (zone.top + zone.bottom) / 2 });
    const obs = perceivePitch(b, stance, pitch, zone, 93, rng);
    const ctx = { balls: 1, strikes: 1, outs: 0, runnersOn: false, scoringPosition: false, inning: 1, scoreDiff: 0 };
    const plan = buildSwing(b, stance, pitch, obs, { swing: true }, ctx, rng, null, 0, mods);
    timing.push(plan.startTime - (plan.plannedContactTime - 0.155));
    alpha.push((plan.alpha * 180) / Math.PI);
    const ball: BallBody = { x: pitch.release.x, y: pitch.release.y, z: pitch.release.z, vx: pitch.vel.x, vy: pitch.vel.y, vz: pitch.vel.z, wx: pitch.spin.x, wy: pitch.spin.y, wz: pitch.spin.z, rolling: false };
    const swing = new BatSwing(plan);
    let t = 0;
    const dt = 1 / 2400;
    let res = null as ReturnType<typeof batBallCollision>;
    while (ball.z > -1 && ball.y > 0) {
      flightStep(ball, dt, env);
      t += dt;
      if (t >= plan.startTime && !swing.done) {
        swing.advance(dt);
        res = batBallCollision(ball, swing.pose());
        if (res) break;
      }
    }
    if (res) {
      contacts++;
      spray.push(res.sprayDeg);
      la.push(res.launchDeg);
    }
  }
  return { timing, spray, la, contacts, alpha };
}

describe('attributes: hitters', () => {
  it('consistency: a consistent hitter repeats his swing timing (lower variance) and his form drifts less', () => {
    const lo = swings(withRatings(baseHitter, { consistency: 20 }), 500, 'cons-a');
    const hi = swings(withRatings(baseHitter, { consistency: 80 }), 500, 'cons-a');
    expect(sd(hi.timing)).toBeLessThan(sd(lo.timing) * 0.85);
    // day-to-day form: a steadier hitter's AR(1) form has a smaller spread over many plate appearances
    const drift = (cons: number) => {
      const rng = new Rng(`form-${cons}`);
      let f = 0;
      const xs: number[] = [];
      for (let i = 0; i < 3000; i++) xs.push((f = A.nextForm(f, cons, rng.normal(0, 1))));
      return sd(xs);
    };
    expect(drift(80)).toBeLessThan(drift(20) * 0.8);
  });

  it('contact: better barrel accuracy means less timing error', () => {
    const lo = swings(withRatings(baseHitter, { contact: 30 }), 500, 'contact-a');
    const hi = swings(withRatings(baseHitter, { contact: 70 }), 500, 'contact-a');
    expect(sd(hi.timing)).toBeLessThan(sd(lo.timing));
    expect(hi.contacts).toBeGreaterThan(lo.contacts);
  });

  it('power: bat speed sets the exit velocity', () => {
    const bs = (power: number) => {
      const rng = new Rng('power-a');
      const zone = strikeZoneFor(baseHitter.height);
      const b = withRatings(baseHitter, { power });
      const stance = stanceFor(b.bats, basePitcher.throws);
      const pitch = pitchTo(basePitcher, rng, { targetY: (zone.top + zone.bottom) / 2 });
      const obs = perceivePitch(b, stance, pitch, zone, 93, rng);
      return buildSwing(b, stance, pitch, obs, { swing: true }, { balls: 0, strikes: 0, outs: 0, runnersOn: false, scoringPosition: false, inning: 1, scoreDiff: 0 }, rng).batSpeed;
    };
    expect(bs(75)).toBeGreaterThan(bs(30) + 3);
  });

  it('pull: a pull hitter meets the ball out front and hits it toward his pull side; an opposite-field hitter the other way', () => {
    const puller = swings(withRatings(baseHitter, { pull: 80 }), 600, 'pull-a');
    const oppo = swings(withRatings(baseHitter, { pull: 20 }), 600, 'pull-a');
    // a right-handed hitter pulls toward third base / left field (+ spray)
    expect(mean(puller.spray)).toBeGreaterThan(mean(oppo.spray) + 3);
  });

  it('gap: a gap hitter has a more level, repeatable bat path (launch angles cluster near the line-drive band)', () => {
    const gap = swings(withRatings(baseHitter, { gap: 80 }), 600, 'gap-a');
    const not = swings(withRatings(baseHitter, { gap: 20 }), 600, 'gap-a');
    // the planned bat path: a gap hitter's attack angle is drawn toward ~11 deg and repeats better
    expect(sd(gap.alpha)).toBeLessThan(sd(not.alpha));
    const target = 11;
    const shortfall = (a: number[]) => Math.abs(mean(a) - target);
    expect(shortfall(gap.alpha)).toBeLessThanOrEqual(shortfall(not.alpha) + 0.3);
  });

  it('breaking-ball eye: a hitter who reads breaking pitches recognises them more often and misjudges them less', () => {
    const rate = (breaking: number) => {
      const rng = new Rng('brk-a');
      const b = withRatings(baseHitter, { breaking });
      const p = generateTeam('brk-p').roster.find((q) => q.isPitcher && q.arsenal.some((a) => a.type === 'SL'))!;
      const zone = strikeZoneFor(b.height);
      const stance = stanceFor(b.bats, p.throws);
      let rec = 0;
      const err: number[] = [];
      for (let i = 0; i < 800; i++) {
        const pitch = pitchTo(p, rng, { type: 'SL', targetX: 0.05, targetY: (zone.top + zone.bottom) / 2 - 0.1 });
        const o = perceivePitch(b, stance, pitch, zone, 93, rng);
        if (o.recognised) rec++;
        err.push(Math.hypot(o.front.x - pitch.plateX, o.front.y - pitch.plateY));
      }
      return { rec: rec / 800, err: mean(err) };
    };
    const lo = rate(20);
    const hi = rate(80);
    expect(hi.rec).toBeGreaterThan(lo.rec + 0.1);
    expect(hi.err).toBeLessThan(lo.err);
  });

  it('clutch: pressure adds noise for a hitter with poor composure and less for a clutch one', () => {
    const noise = (clutch: number, pressure: number) => sd(swings(withRatings(baseHitter, { clutch }), 500, 'clutch-a', { form: 0, pressure }).timing);
    expect(A.clutchScale(20, 1)).toBeGreaterThan(A.clutchScale(80, 1));
    expect(A.clutchScale(50, 1)).toBeCloseTo(1, 5);
    expect(noise(20, 1)).toBeGreaterThan(noise(80, 1));
    // no pressure, no difference
    expect(A.clutchScale(20, 0)).toBe(A.clutchScale(80, 0));
    // leverage: late, close, runners in scoring position is worth more than an early blowout
    expect(A.pressureOf(9, 9, 2, 0, [2])).toBeGreaterThan(A.pressureOf(2, 9, 0, 6, []));
  });

  it("form moves a hitter's effective contact (a hot hitter makes more contact than a cold one)", () => {
    const hot = swings(baseHitter, 500, 'form-a', { form: 2, pressure: 0 });
    const cold = swings(baseHitter, 500, 'form-a', { form: -2, pressure: 0 });
    expect(hot.contacts).toBeGreaterThan(cold.contacts);
  });
});

describe('attributes: running', () => {
  /** Ticks for a player to cover `dist` metres from a standing start along +z, as the game moves him. */
  function race(setRatings: Partial<Ratings>, dist: number) {
    const l = lab('race');
    const w = l.w;
    const p = w.battingTeam.lineup[3].player;
    p.info = withRatings(p.info, setRatings);
    p.vmax = A.sprintOf(p.info.ratings.speed);
    p.accel = A.accelOfRating(p.info.ratings.acceleration);
    p.x = 0;
    p.z = 0;
    p.vx = p.vz = 0;
    p.reactUntil = 0;
    p.legs = 0;
    p.goal = { x: 0, z: dist, stop: false, mul: 1 };
    let t = 0;
    while (p.z < dist && t < 240 * 10) {
      stepPlayer(p, w);
      t++;
    }
    return t / 240;
  }

  it('speed: the faster runner gets to the bag first (27.4 m)', () => {
    expect(race({ speed: 75, acceleration: 50 }, 27.4)).toBeLessThan(race({ speed: 30, acceleration: 50 }, 27.4) - 0.2);
  });
  it('acceleration: a quicker first step wins a short race at the same top speed', () => {
    expect(race({ speed: 50, acceleration: 75 }, 8)).toBeLessThan(race({ speed: 50, acceleration: 25 }, 8));
  });
  it('baserunning: reads of arrival times are tighter and jumps better with baserunning IQ', () => {
    const l = lab('steal-iq');
    const r = addRunner(l.w, 1);
    const good = (() => { r.p.info = withRatings(r.p.info, { baserunning: 80 }); return stealTimes(l.w, r, 0.9).runnerTime; })();
    const bad = (() => { r.p.info = withRatings(r.p.info, { baserunning: 20 }); return stealTimes(l.w, r, 0.9).runnerTime; })();
    expect(good).toBeLessThan(bad);
  });
  it('durability: hard running tires the legs, and a low-durability player loses more speed', () => {
    const l = lab('legs');
    const w = l.w;
    const run = (durability: number) => {
      const p = w.battingTeam.lineup[4].player;
      p.info = withRatings(p.info, { durability, speed: 50, acceleration: 50 });
      p.vmax = A.sprintOf(50);
      p.legs = 0;
      p.x = 0;
      p.z = 0;
      p.vx = p.vz = 0;
      p.reactUntil = 0;
      // sprint back and forth for a while
      for (let lap = 0; lap < 30; lap++) {
        p.goal = { x: 0, z: lap % 2 ? 0 : 60, stop: false, mul: 1 };
        for (let i = 0; i < 240 * 8; i++) {
          stepPlayer(p, w);
          if (Math.abs(p.z - (lap % 2 ? 0 : 60)) < 1) break;
        }
      }
      return { legs: p.legs, factor: A.legsSpeedFactor(p.legs, durability) };
    };
    const iron = run(80);
    const glass = run(20);
    expect(glass.legs).toBeGreaterThan(0.3);
    expect(glass.factor).toBeLessThan(iron.factor - 0.02);
  });
});

describe('attributes: fielding', () => {
  it('arm strength shortens the throw: higher arm means more speed and less time to the base', () => {
    const from = { x: 0, y: 1.7, z: 60 };
    const to = { x: -19.4, y: 1.3, z: 19.4 };
    const time = (arm: number) => solveThrow(from, to, A.armMps({ arm } as Ratings), env).time;
    expect(time(75)).toBeLessThan(time(30) - 0.1);
    expect(A.armMps({ arm: 75 } as Ratings)).toBeGreaterThan(A.armMps({ arm: 30 } as Ratings) + 8);
  });

  it('release quickness shortens the transfer and the wind-up', () => {
    const l = lab('release');
    const F = fielders(l.w).find((p) => p.fieldPos === 'SS')!;
    F.info = withRatings(F.info, { release: 25, glove: 50 });
    const slow = transferTicks(F, 0);
    F.info = withRatings(F.info, { release: 80, glove: 50 });
    const fast = transferTicks(F, 0);
    expect(fast).toBeLessThan(slow);
    expect(A.throwWindup({ release: 80 } as Ratings, 0.5)).toBeLessThan(A.throwWindup({ release: 25 } as Ratings, 0.5));
  });

  it('range and fielding IQ: better reads (smaller judgement error) and a quicker first step', () => {
    const l = lab('reads');
    const sample = (r: Partial<Ratings>) => {
      const biasX: number[] = [];
      const react: number[] = [];
      for (let k = 0; k < 400; k++) {
        const F = fielders(l.w).find((p) => p.fieldPos === 'CF')!;
        F.info = withRatings(F.info, r);
        l.w.rng = new Rng(`reads-${k}`);
        initFielderPlans(l.w, 0);
        biasX.push(F.plan.biasX);
        react.push(F.plan.reactTick - l.w.tick);
      }
      return { sd: sd(biasX), react: mean(react) };
    };
    const good = sample({ range: 75, iq: 75 });
    const poor = sample({ range: 25, iq: 25 });
    expect(good.sd).toBeLessThan(poor.sd * 0.6);
    expect(good.react).toBeLessThan(poor.react);
    // and the route: IQ raises the share of top speed that turns into progress
    expect(A.routeEfficiency({ iq: 80 } as Ratings)).toBeGreaterThan(A.routeEfficiency({ iq: 20 } as Ratings));
  });

  it('accuracy: a more accurate arm puts the throw closer to where it is aimed (doThrow, N throws)', () => {
    const l = lab('accuracy');
    const w = l.w;
    const F = fielders(w).find((p) => p.fieldPos === 'SS')!;
    const R = fielders(w).find((p) => p.fieldPos === '1B')!;
    const spread = (accuracy: number) => {
      F.info = withRatings(F.info, { accuracy, arm: 55 });
      const errs: number[] = [];
      for (let k = 0; k < 300; k++) {
        w.rng = new Rng(`acc-${k}`);
        w.play = newPlay(w, 'battedBall');
        w.phase = 'inPlay';
        F.x = 8;
        F.z = 33;
        F.vx = F.vz = 0;
        R.x = -19.4 + 0.5;
        R.z = 19.4 - 0.5;
        R.vx = R.vz = 0;
        giveBall(w, F);
        F.plan.throwTo = R;
        F.plan.throwBase = 1;
        F.plan.delays = 0;
        doThrow(w, F);
        const b = w.ball.body;
        const aimX = -19.4 - F.x;
        const aimZ = 19.4 - F.z;
        errs.push(Math.atan2(b.vx, b.vz) - Math.atan2(aimX, aimZ));
      }
      return sd(errs);
    };
    expect(spread(80)).toBeLessThan(spread(20) * 0.85);
  });

  it('glove: better hands field routine ground balls cleanly more often (the glove noise model, N attempts)', () => {
    const l = lab('glove');
    const w = l.w;
    const F = fielders(w).find((p) => p.fieldPos === 'SS')!;
    const clean = (glove: number) => {
      F.info = withRatings(F.info, { glove });
      let ok = 0;
      for (let k = 0; k < 500; k++) {
        w.rng = new Rng(`glove-${k}`);
        w.play = newPlay(w, 'looseBall');
        w.phase = 'inPlay';
        releaseBall(w);
        F.hasBall = false;
        const b = w.ball.body;
        b.x = F.x + 0.55;
        b.z = F.z + 0.4;
        b.y = 0.0366;
        b.vx = -9;
        b.vy = 0;
        b.vz = -3;
        b.rolling = true;
        w.ball.mode = 'loose';
        F.plan.reactTick = 0;
        F.plan.lastAttempt = -999;
        F.plan.releaseAt = 0;
        fieldingAttempts(w);
        if (w.ball.holder === F) ok++;
      }
      return ok / 500;
    };
    expect(clean(80)).toBeGreaterThan(clean(20) + 0.05);
  });
});

describe('attributes: catchers', () => {
  it('framing: a good framer gets more borderline pitches called strikes', () => {
    const l = lab('framing');
    const w = l.w;
    const rate = (framing: number) => {
      w.catcher.info = withRatings(w.catcher.info, { framing });
      w.rng = new Rng('frame-a');
      const z = w.zone;
      let strikes = 0;
      for (let i = 0; i < 6000; i++) if (umpireCall(w, z.right + 0.025, (z.top + z.bottom) / 2)) strikes++;
      return strikes / 6000;
    };
    expect(rate(80)).toBeGreaterThan(rate(20) + 0.02);
  });

  it('blocking: a better blocker covers more of the dirt', () => {
    expect(A.blockHalfWidth({ blocking: 80 } as Ratings)).toBeGreaterThan(A.blockHalfWidth({ blocking: 25 } as Ratings) + 0.15);
  });

  it('pop time: a quick exchange and transfer beats a slow one against a steal', () => {
    const l = lab('pop');
    const r = addRunner(l.w, 1);
    l.w.catcher.info = withRatings(l.w.catcher.info, { pop: 80 });
    const quick = stealTimes(l.w, r, 0.9).ballTime;
    l.w.catcher.info = withRatings(l.w.catcher.info, { pop: 20 });
    const slow = stealTimes(l.w, r, 0.9).ballTime;
    expect(quick).toBeLessThan(slow - 0.1);
    expect(A.catcherTransfer({ pop: 80 } as Ratings)).toBeLessThan(A.catcherTransfer({ pop: 20 } as Ratings));
  });
});

describe('attributes: pitchers', () => {
  it('consistency: a repeatable pitcher has a tighter release point over many pitches', () => {
    const spread = (consistency: number) => {
      const p = withRatings(basePitcher, { consistency });
      const rng = new Rng('rel-a');
      const ys: number[] = [];
      const xs: number[] = [];
      for (let i = 0; i < 400; i++) {
        const pitch = pitchTo(p, rng);
        ys.push(pitch.release.y);
        xs.push(pitch.release.x);
      }
      return Math.hypot(sd(ys), sd(xs));
    };
    expect(spread(80)).toBeLessThan(spread(20) * 0.7);
  });

  it('control: a wilder pitcher misses his spot by more', () => {
    const miss = (control: number) => {
      const p = withRatings(basePitcher, { control });
      const rng = new Rng('ctl-a');
      const e: number[] = [];
      for (let i = 0; i < 500; i++) {
        const pitch = pitchTo(p, rng);
        e.push(Math.hypot(pitch.plateX - 0, pitch.plateY - 0.8));
      }
      return mean(e);
    };
    expect(miss(75)).toBeLessThan(miss(25));
  });

  it("each pitch has its own command: a pitch he cannot locate scatters more than the one he can", () => {
    const rng = new Rng('cmd-a');
    const base = basePitcher.arsenal[0];
    const miss = (command: number) => {
      const p = { ...basePitcher, arsenal: [{ ...base, command }] };
      const e: number[] = [];
      for (let i = 0; i < 500; i++) {
        const pitch = pitchTo(p, rng);
        e.push(Math.hypot(pitch.plateX, pitch.plateY - 0.8));
      }
      return mean(e);
    };
    expect(miss(75)).toBeLessThan(miss(25));
  });

  it('velocity and stretch: the fastball speed is the rating, a little less from the stretch', () => {
    const rng = new Rng('vel-a');
    const mph = (v: number, stretch: boolean) => {
      const spec = { ...basePitcher.arsenal[0], mph: v };
      const p = { ...basePitcher, arsenal: [spec] };
      return mean(Array.from({ length: 200 }, () => pitchTo(p, rng, { ctx: { stretch } }).mph));
    };
    expect(mph(98, false)).toBeGreaterThan(mph(90, false) + 6);
    expect(mph(94, true)).toBeLessThan(mph(94, false) - 0.3);
  });

  it("composure: a fragile pitcher's command suffers more under pressure and after trouble", () => {
    expect(A.composureScale({ composure: 20 } as Ratings, 1, 1)).toBeGreaterThan(A.composureScale({ composure: 80 } as Ratings, 1, 1));
    const miss = (composure: number, pressure: number, rattled: number) => {
      const p = withRatings(basePitcher, { composure });
      const rng = new Rng('comp-a');
      const e: number[] = [];
      for (let i = 0; i < 600; i++) e.push(Math.hypot(...(([x, y]) => [x, y - 0.8])([pitchTo(p, rng, { ctx: { pressure, rattled } }).plateX, pitchTo(p, rng, { ctx: { pressure, rattled } }).plateY]) as [number, number]));
      return mean(e);
    };
    expect(miss(20, 1, 1)).toBeGreaterThan(miss(80, 1, 1));
  });

  it('stamina: the pitch limit follows stamina (and durability a little)', () => {
    expect(A.pitchLimit({ stamina: 75, durability: 50 } as Ratings)).toBeGreaterThan(A.pitchLimit({ stamina: 40, durability: 50 } as Ratings) + 30);
  });

  it('movement per pitch: a higher-graded pitch has more spin and more efficient (more break)', () => {
    const t = generateTeam('grades').roster.filter((p) => p.isPitcher);
    const specs = t.flatMap((p) => p.arsenal.filter((a) => a.type === 'SL'));
    const hi = specs.filter((s) => (s.grade ?? 50) > 58);
    const lo = specs.filter((s) => (s.grade ?? 50) < 42);
    expect(hi.length).toBeGreaterThan(0);
    expect(lo.length).toBeGreaterThan(0);
    expect(mean(hi.map((s) => s.rpm))).toBeGreaterThan(mean(lo.map((s) => s.rpm)));
  });
});

describe('attributes: delivery', () => {
  const geo = (slot: number, h = 1.9, left = false) => A.releaseGeometry({ style: A.styleOf(slot), armSlotDeg: slot, tempo: 1 }, h, left, 1.85);

  it('the arm slot sets the release point: sidearm releases lower and wider than over the top; submarine lowest', () => {
    const over = geo(10);
    const q3 = geo(45);
    const side = geo(85);
    const sub = geo(115);
    expect(over.armHeight).toBeGreaterThan(q3.armHeight);
    expect(q3.armHeight).toBeGreaterThan(side.armHeight);
    expect(side.armHeight).toBeGreaterThan(sub.armHeight);
    expect(Math.abs(side.armSide)).toBeGreaterThan(Math.abs(q3.armSide));
    expect(Math.abs(q3.armSide)).toBeGreaterThan(Math.abs(over.armSide));
    expect(A.styleOf(10)).toBe('overhand');
    expect(A.styleOf(45)).toBe('three_quarter');
    expect(A.styleOf(85)).toBe('sidearm');
    expect(A.styleOf(115)).toBe('submarine');
    // lefties release on the other side
    expect(geo(45, 1.9, true).armSide).toBeLessThan(0);
    expect(geo(45, 1.9, false).armSide).toBeGreaterThan(0);
  });

  it('the release height is measured above the mound', () => {
    const g = geo(45);
    expect(g.armHeight - g.aboveMound).toBeCloseTo(MOUND_HEIGHT, 3);
    // and every generated pitcher's release is above the mound by his body's reach
    for (const p of generateTeam('rel-h').roster.filter((q) => q.isPitcher)) expect(p.traits.armHeight).toBeGreaterThan(MOUND_HEIGHT + 0.8);
  });

  it('a pitcher really releases from his arm slot', () => {
    const rng = new Rng('slot-a');
    const mk = (slot: number) => ({ ...basePitcher, delivery: { style: A.styleOf(slot), armSlotDeg: slot, tempo: 1 }, traits: { ...basePitcher.traits, ...A.releaseGeometry({ style: A.styleOf(slot), armSlotDeg: slot, tempo: 1 }, basePitcher.height, false, 1.85) } });
    const y = (slot: number) => mean(Array.from({ length: 50 }, () => pitchTo(mk(slot), rng).release.y));
    expect(y(10)).toBeGreaterThan(y(85) + 0.3);
  });

  it('tempo, the stretch and holding decide the time to the plate: the stretch is quicker than the windup; a quick tempo and a good holder quicker still', () => {
    const d = { style: 'three_quarter' as const, armSlotDeg: 45, tempo: 1 };
    const r = { holding: 50 } as Ratings;
    expect(A.deliverySeconds(d, r, true)).toBeLessThan(A.deliverySeconds(d, r, false) - 0.15);
    expect(A.deliverySeconds({ ...d, tempo: 1.15 }, r, false)).toBeLessThan(A.deliverySeconds(d, r, false));
    expect(A.deliverySeconds(d, { holding: 80 } as Ratings, true)).toBeLessThan(A.deliverySeconds(d, { holding: 20 } as Ratings, true));
  });

  it('holding and the pickoff move: a good holder shortens the lead; a good move gets to the base sooner and freezes the runner', () => {
    expect(A.holdingLeadAdjust({ holding: 80 })).toBeLessThan(A.holdingLeadAdjust({ holding: 20 }));
    expect(A.pickoffSeconds({ pickoff: 80 } as Ratings)).toBeLessThan(A.pickoffSeconds({ pickoff: 20 } as Ratings));
    expect(A.pickoffRunnerReaction(50, { pickoff: 80 } as Ratings)).toBeGreaterThan(A.pickoffRunnerReaction(50, { pickoff: 20 } as Ratings));
  });

  it('in a game the stretch is used exactly when runners are on, and the windup phase really is shorter with a runner on', () => {
    const windupSeconds = (runner: boolean) => {
      const l = lab('stretch');
      const w = l.w;
      if (runner) addRunner(w, 3); // (a runner on third: no pickoff throws to interrupt)
      const st = () => l.g.getState().players.find((p) => p.role === 'pitcher')!.delivery!.fromStretch;
      expect(st()).toBe(runner);
      for (let i = 0; i < 240 * 30 && w.phase !== 'windup'; i++) l.g.step(1 / 240);
      expect(w.phase).toBe('windup');
      return (w.phaseUntil - w.tick) / 240;
    };
    const empty = windupSeconds(false);
    const stretch = windupSeconds(true);
    expect(stretch).toBeLessThan(empty - 0.15);
  });
});

describe('the mound', () => {
  it('is 10 in above home plate at the rubber, falls 1 in per foot for 6 ft toward home, and is flat grass elsewhere', () => {
    expect(groundHeight(0, MOUND_DIST)).toBeCloseTo(0.254, 3);
    expect(groundHeight(0, MOUND_DIST + 0.5)).toBeCloseTo(0.254, 3);
    const front = MOUND_DIST - 0.5 * 0.3048; // slope starts 6 in in front of the rubber
    expect(groundHeight(0, front)).toBeCloseTo(0.254, 3);
    expect(groundHeight(0, front - 6 * 0.3048)).toBeCloseTo(0.254 - 6 * 0.0254, 3);
    expect(groundHeight(0, front - 1 * 0.3048)).toBeCloseTo(0.254 - 0.0254, 3);
    expect(groundHeight(0, 5)).toBe(0);
    expect(groundHeight(20, MOUND_DIST)).toBe(0);
    expect(groundHeight(0, 40)).toBe(0);
    // monotone falling away from the rubber
    let prev = 1;
    for (let z = MOUND_DIST; z > 14; z -= 0.25) {
      const h = groundHeight(0, z);
      expect(h).toBeLessThanOrEqual(prev + 1e-9);
      prev = h;
    }
  });

  it('the pitcher stands on it in the snapshot and holds the ball at mound height', () => {
    const l = lab('mound');
    const s = l.g.getState();
    const P = s.players.find((p) => p.role === 'pitcher')!;
    expect(P.pos.y).toBeGreaterThan(0.15);
    expect(P.pos.y).toBeLessThan(0.26);
    const other = s.players.filter((p) => p.role === 'fielder' && p.position !== 'P')[0];
    expect(other.pos.y).toBe(0);
    expect(s.ball.pos.y).toBeGreaterThan(1.3);
  });

  it('a ball rolling over the mound rides on it', () => {
    const b: BallBody = { x: 0, y: 0.5, z: MOUND_DIST + 0.2, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, rolling: false };
    const flags = newFlags();
    for (let i = 0; i < 480; i++) stepBall(b, 1 / 240, env, null, flags);
    // it settles on the level top (10 in up) instead of falling through it to the grass
    expect(b.y).toBeGreaterThan(MOUND_HEIGHT);
    expect(b.y).toBeLessThan(MOUND_HEIGHT + 0.05);
  });
});

describe('roster generation', () => {
  const players = Array.from({ length: 30 }, (_, i) => generateTeam(`gen${i}`).roster).flat();
  const hitters = players.filter((p) => !p.isPitcher);
  it('ratings sit on the 20-80 scale with mean ~50 for regulars', () => {
    for (const p of players) for (const [k, v] of Object.entries(p.ratings)) if (k !== 'velocity') expect(v, `${p.name} ${k}`).toBeGreaterThanOrEqual(20), expect(v, `${p.name} ${k}`).toBeLessThanOrEqual(80);
    const reg = hitters.filter((p) => !p.id.includes('-bn'));
    for (const k of ['contact', 'power', 'eye', 'speed', 'consistency', 'iq', 'breaking'] as const) expect(Math.abs(mean(reg.map((p) => p.ratings[k])) - 50)).toBeLessThan(6);
  });
  it('power and contact trade off; size goes with power and against speed', () => {
    const corr = (a: number[], b: number[]) => {
      const ma = mean(a);
      const mb = mean(b);
      let sab = 0, sa = 0, sb = 0;
      for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
      return sab / Math.sqrt(sa * sb);
    };
    expect(corr(hitters.map((p) => p.ratings.power), hitters.map((p) => p.ratings.contact))).toBeLessThan(0.1);
    expect(corr(hitters.map((p) => p.ratings.power), hitters.map((p) => p.physique.weightKg))).toBeGreaterThan(0.15);
    expect(corr(hitters.map((p) => p.ratings.speed), hitters.map((p) => p.physique.weightKg))).toBeLessThan(-0.2);
    expect(corr(hitters.map((p) => p.ratings.speed), hitters.map((p) => p.ratings.acceleration))).toBeGreaterThan(0.5);
  });
  it('throwing hand follows the position: no left-handed catchers, second basemen, shortstops or third basemen; some at first and in the outfield', () => {
    const lefties = (pos: string[]) => hitters.filter((p) => pos.includes(p.primaryPosition) && p.throws === 'L').length;
    expect(lefties(['C', '2B', 'SS', '3B'])).toBe(0);
    expect(lefties(['1B', 'LF', 'CF', 'RF'])).toBeGreaterThan(20);
  });
  it('physique, looks, age and handedness are filled in and plausible; pitchers have deliveries and repertoires', () => {
    for (const p of players) {
      expect(p.physique.heightM).toBe(p.height);
      expect(p.physique.weightKg).toBeGreaterThan(65);
      expect(p.physique.weightKg).toBeLessThan(140);
      expect(['lean', 'athletic', 'stocky', 'heavy']).toContain(p.physique.build);
      expect(p.age).toBeGreaterThanOrEqual(21);
      expect(p.age).toBeLessThanOrEqual(40);
      expect(p.appearance.skin).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(p.appearance.seed)).toBe(true);
    }
    expect(new Set(hitters.map((p) => p.bats))).toEqual(new Set(['R', 'L', 'S']));
    const pit = players.filter((p) => p.isPitcher);
    expect(new Set(pit.map((p) => p.delivery!.style)).size).toBe(4);
    expect(new Set(pit.flatMap((p) => p.arsenal.map((a) => a.type))).size).toBeGreaterThanOrEqual(8);
    for (const p of pit) {
      expect(p.arsenal.length).toBeGreaterThanOrEqual(2);
      expect(p.delivery!.tempo).toBeGreaterThan(0.75);
    }
    // a catcher is built for the job and heavier, a shortstop lighter than a first baseman
    const avg = (pos: string, f: (p: PlayerInfo) => number) => mean(hitters.filter((p) => p.primaryPosition === pos).map(f));
    expect(avg('1B', (p) => p.physique.weightKg)).toBeGreaterThan(avg('SS', (p) => p.physique.weightKg));
  });
});

describe('the AI still decides swings from what it perceives', () => {
  it('a good eye discriminates better than a poor one', () => {
    const swingsAtBalls = (eye: number, discipline: number) => {
      const b = withRatings(baseHitter, { eye, discipline });
      const rng = new Rng('disc-a');
      const zone = strikeZoneFor(b.height);
      const stance = stanceFor(b.bats, basePitcher.throws);
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const pitch = pitchTo(basePitcher, rng, { targetX: 0.42, targetY: zone.bottom - 0.25 });
        const o = perceivePitch(b, stance, pitch, zone, 93, rng);
        if (aiSwingDecision(b, { balls: 0, strikes: 0, outs: 0, runnersOn: false, scoringPosition: false, inning: 1, scoreDiff: 0 }, o.dPerceived).swing) n++;
      }
      return n;
    };
    expect(swingsAtBalls(75, 75)).toBeLessThan(swingsAtBalls(25, 25));
  });
});

describe('MPH sanity', () => {
  it('stays consistent', () => expect(93 * MPH).toBeGreaterThan(41));
});
