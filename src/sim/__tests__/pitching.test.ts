import { describe, expect, it } from 'vitest';
import { DEFAULT_ENV } from '../ball';
import { DEFAULT_FENCE } from '../field';
import { MPH } from '../math';
import { makePitchSpec, generateTeam } from '../roster';
import { throwPitch, strikeZoneFor, pitchTouchesZone } from '../pitching';
import { Rng } from '../rng';

const env = DEFAULT_ENV(DEFAULT_FENCE);
const team = generateTeam(11);
const pitcher = team.roster.find((p) => p.isPitcher)!;
const slot = { x: -0.4, y: 1.75, ext: 1.85 };

function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sd(xs: number[]) {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

describe('pitch physics', () => {
  it('a 93 mph fastball takes ~0.40s and lands near its target with command error', () => {
    const rng = new Rng(3);
    const spec = makePitchSpec('FF', 93, 50, false, rng, 1);
    const xs: number[] = [];
    const ys: number[] = [];
    const ts: number[] = [];
    for (let i = 0; i < 200; i++) {
      const p = throwPitch(pitcher, slot, spec, 0.0, 0.8, { fatigue: 0, rng, env });
      xs.push(p.plateX);
      ys.push(p.plateY);
      ts.push(p.tPlate);
    }
    expect(mean(ts)).toBeGreaterThan(0.38);
    expect(mean(ts)).toBeLessThan(0.44);
    expect(Math.abs(mean(xs))).toBeLessThan(0.05);
    expect(Math.abs(mean(ys) - 0.8)).toBeLessThan(0.06);
    expect(sd(xs)).toBeGreaterThan(0.06);
    expect(sd(xs)).toBeLessThan(0.3);
  });

  it('fastball has induced rise vs a spinless pitch, curveball drops more', () => {
    const rng = new Rng(4);
    const ff = makePitchSpec('FF', 93, 50, false, rng, 1);
    const noSpin = { ...ff, rpm: 0 };
    const cu = makePitchSpec('CU', 93, 50, false, rng, 1);
    // aim both at the same spot; without spin the aim solver compensates, so compare what happens
    // when the *same release direction* is used: use the solver's aim for FF with spin, then remove it.
    const p1 = throwPitch({ ...pitcher, ratings: { ...pitcher.ratings, control: 100 } }, slot, ff, 0, 0.75, { fatigue: 0, rng, env });
    const p0 = throwPitch({ ...pitcher, ratings: { ...pitcher.ratings, control: 100 } }, slot, noSpin, 0, 0.75, { fatigue: 0, rng, env });
    expect(p1.release.y).toBeGreaterThan(1); // sanity
    // the FF aimed direction is flatter than the no-spin one (needs less upward loft)
    expect(p1.vel.y).toBeLessThan(p0.vel.y);
    const pc = throwPitch(pitcher, slot, cu, 0, 0.75, { fatigue: 0, rng, env });
    // curveball is much slower and aimed higher (drops in)
    expect(pc.mph).toBeLessThan(p1.mph - 10);
    expect(pc.vel.y).toBeGreaterThan(p1.vel.y);
  });

  it('control matters and fatigue hurts', () => {
    const rng = new Rng(5);
    const spec = makePitchSpec('FF', 93, 50, false, rng, 1);
    const spread = (ctl: number, fat: number) => {
      const p = { ...pitcher, ratings: { ...pitcher.ratings, control: ctl } };
      const xs: number[] = [];
      for (let i = 0; i < 300; i++) xs.push(throwPitch(p, slot, spec, 0, 0.8, { fatigue: fat, rng, env }).plateX);
      return sd(xs);
    };
    expect(spread(80, 0)).toBeLessThan(spread(30, 0));
    expect(spread(50, 0.9)).toBeGreaterThan(spread(50, 0));
    const fast = throwPitch(pitcher, slot, spec, 0, 0.8, { fatigue: 0, rng: new Rng(1), env }).mph;
    const tired = throwPitch(pitcher, slot, spec, 0, 0.8, { fatigue: 1, rng: new Rng(1), env }).mph;
    expect(tired).toBeLessThan(fast - 1.5);
  });

  it('strike zone geometry', () => {
    const z = strikeZoneFor(1.85);
    expect(z.top).toBeGreaterThan(0.9);
    expect(z.bottom).toBeLessThan(0.55);
    const rng = new Rng(7);
    const spec = makePitchSpec('FF', 93, 50, false, rng, 1);
    const good = { ...pitcher, ratings: { ...pitcher.ratings, control: 95 } };
    let strikes = 0;
    for (let i = 0; i < 100; i++) {
      const p = throwPitch(good, slot, spec, 0, (z.top + z.bottom) / 2, { fatigue: 0, rng, env });
      if (pitchTouchesZone(p, z)) strikes++;
    }
    expect(strikes).toBeGreaterThan(85);
    void MPH;
  });
});
