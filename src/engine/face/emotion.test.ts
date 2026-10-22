import { describe, expect, it } from 'vitest';
import { FACE_KEYS, FaceState, MAX_ACTIVE, PRESETS, capActive, personalityFor, springStep, type Personality } from './emotion';
import { reactionsFor, tensionFor, type FaceCtx } from './reactions';

const idx = (k: (typeof FACE_KEYS)[number]) => FACE_KEYS.indexOf(k);
/** a fixed, middle-of-the-road temperament (no chewing, so the jaw is quiet) */
const PLAIN: Personality = { expressiveness: 1, calm: 0.3, fiery: 0.5, chews: false, blinkRate: 1, smile: 0.05, brow: 0.05, asym: 0, valence: 0 };
const run = (f: FaceState, sec: number, act = {}) => {
  let w = f.step(0);
  for (let t = 0; t < sec; t += 1 / 60) w = f.step(1 / 60, act);
  return w;
};

describe('springs', () => {
  it('a critically damped step reaches the target without overshoot', () => {
    let x = 0, v = 0, peak = 0;
    for (let i = 0; i < 120; i++) {
      [x, v] = springStep(x, v, 1, 12, 1 / 60);
      peak = Math.max(peak, x);
    }
    expect(x).toBeGreaterThan(0.99);
    expect(peak).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('a face never jumps: no key moves more than a spring allows in one frame', () => {
    const f = new FaceState('a', PLAIN);
    run(f, 1);
    const before = Float64Array.from(f.step(1 / 60));
    f.react('shout', 1);
    const after = f.step(1 / 60);
    for (let i = 0; i < FACE_KEYS.length; i++) if (!FACE_KEYS[i].startsWith('blink')) expect(Math.abs(after[i] - before[i])).toBeLessThan(0.12);
  });
});

describe('reactions', () => {
  it('rise, hold and fall back to the resting face', () => {
    const f = new FaceState('b', PLAIN);
    run(f, 2);
    const rest = f.step(1 / 60)[idx('jaw_open')];
    f.react('shout', 1);
    const peak = run(f, 0.8)[idx('jaw_open')];
    expect(peak).toBeGreaterThan(0.6);
    run(f, PRESETS.shout.hold + PRESETS.shout.release + 1.5);
    expect(f.reaction).toBeNull();
    expect(f.step(1 / 60)[idx('jaw_open')]).toBeLessThan(rest + 0.05);
  });
  it('a stronger reaction pre-empts, a weaker one waits behind', () => {
    const f = new FaceState('c', PLAIN);
    f.react('concentration', 1);
    run(f, 0.2);
    f.react('wince', 1);
    expect(f.reaction).toBe('wince');
    f.react('nod', 1);
    expect(f.reaction).toBe('wince');
    run(f, PRESETS.wince.attack + PRESETS.wince.hold + 0.05);
    expect(f.reaction).toBe('nod');
  });
  it('a delayed reaction starts later (grin, then shout)', () => {
    const f = new FaceState('d', PLAIN);
    f.react('grin', 1);
    f.react('shout', 1, 1.0);
    run(f, 0.5);
    expect(f.reaction).toBe('grin');
    run(f, 0.6);
    expect(f.reaction).toBe('shout');
  });
  it('a close-up holds the reaction through the shot', () => {
    const f = new FaceState('e', PLAIN);
    f.react('frustration', 1);
    run(f, 1);
    expect(f.holdFor(4)).toBe(true);
    const w = run(f, 3.5);
    expect(f.reaction).toBe('frustration');
    expect(w[idx('lip_press')]).toBeGreaterThan(0.6);
    // long over: nothing to hold
    run(f, 8);
    expect(f.holdFor(4)).toBe(false);
  });
  it('a fiery person yells harder than a calm one', () => {
    const hot = new FaceState('f', { ...PLAIN, fiery: 1, calm: 0 }), cool = new FaceState('f', { ...PLAIN, fiery: 0, calm: 1 });
    hot.react('yell', 1);
    cool.react('yell', 1);
    expect(run(hot, 0.6)[idx('jaw_open')]).toBeGreaterThan(run(cool, 0.6)[idx('jaw_open')] + 0.15);
  });
  it('a face coming back into the picture shows its reaction at once (no ramp from a stale face)', () => {
    const f = new FaceState('n', PLAIN);
    run(f, 1);
    f.react('shout', 1);
    for (let t = 0; t < 0.6; t += 1 / 60) f.tick(1 / 60);
    expect(f.step(0)[idx('jaw_open')]).toBeGreaterThan(0.6);
  });
  it('a reaction leaves its mood behind', () => {
    const f = new FaceState('g', PLAIN);
    f.react('joy', 1);
    run(f, 10);
    expect(f.valence).toBeGreaterThan(0.15);
  });
});

describe('life', () => {
  it('blinks every few seconds, and fully', () => {
    const f = new FaceState('h', PLAIN);
    let closes = 0, was = false, maxB = 0;
    for (let t = 0; t < 30; t += 1 / 60) {
      const b = f.step(1 / 60)[idx('blink_L')];
      maxB = Math.max(maxB, b);
      if (b > 0.9 && !was) closes++;
      was = b > 0.9;
    }
    expect(maxB).toBeGreaterThan(0.95);
    expect(closes).toBeGreaterThanOrEqual(4);
    expect(closes).toBeLessThanOrEqual(16);
  });
  it('saccades stay small', () => {
    const f = new FaceState('i', PLAIN);
    for (let t = 0; t < 10; t += 1 / 60) {
      f.step(1 / 60);
      expect(Math.abs(f.sacYaw)).toBeLessThan(0.05);
      expect(Math.abs(f.sacPitch)).toBeLessThan(0.035);
    }
  });
  it('a chewer chews at 1.6-2 Hz, a talker moves the jaw', () => {
    const chew = new FaceState('j', { ...PLAIN, chews: true });
    let lo = 1, hi = 0;
    run(chew, 1);
    for (let t = 0; t < 2; t += 1 / 60) {
      const j = chew.step(1 / 60)[idx('jaw_open')];
      lo = Math.min(lo, j);
      hi = Math.max(hi, j);
    }
    expect(hi - lo).toBeGreaterThan(0.04);
    const talk = new FaceState('k', PLAIN);
    let tHi = 0;
    for (let t = 0; t < 2; t += 1 / 60) tHi = Math.max(tHi, talk.step(1 / 60, { talking: true })[idx('jaw_open')]);
    expect(tHi).toBeGreaterThan(0.08);
  });
  it('pressure knits the brows', () => {
    const a = new FaceState('l', PLAIN), b = new FaceState('l', PLAIN);
    expect(run(a, 3, { tension: 1 })[idx('brow_down_L')]).toBeGreaterThan(run(b, 3)[idx('brow_down_L')] + 0.15);
  });
  it(`keeps at most ${MAX_ACTIVE} keys non-zero`, () => {
    const f = new FaceState('m', { ...PLAIN, chews: true });
    f.react('wince', 1.4);
    for (let t = 0; t < 3; t += 1 / 60) {
      const w = f.step(1 / 60, { tension: 1, effort: true });
      expect([...w].filter((x) => x > 0).length).toBeLessThanOrEqual(MAX_ACTIVE);
    }
    const w = new Float64Array([0.5, 0.001, 0.2, 0.9, 0.3]);
    capActive(w, 2);
    expect([...w]).toEqual([0.5, 0, 0, 0.9, 0]);
  });
});

describe('personality', () => {
  it('is stable per id and varies between people', () => {
    expect(personalityFor('OMA-home-sp1')).toEqual(personalityFor('OMA-home-sp1'));
    const ps = Array.from({ length: 40 }, (_, i) => personalityFor(`p${i}`));
    const chewers = ps.filter((p) => p.chews).length;
    expect(chewers).toBeGreaterThan(4);
    expect(chewers).toBeLessThan(24);
    for (const p of ps) {
      expect(p.expressiveness).toBeGreaterThanOrEqual(0.6);
      expect(p.expressiveness).toBeLessThanOrEqual(1.25);
    }
  });
  it('composure (clutch) calms; umpires are calm and never fiery', () => {
    expect(personalityFor('x', { clutch: 80 }).calm).toBeGreaterThan(personalityFor('x', { clutch: 20 }).calm);
    const u = personalityFor('ump-hp', undefined, 'umpire');
    expect(u.calm).toBeGreaterThanOrEqual(0.8);
    expect(u.fiery).toBe(0);
  });
});

describe('event table', () => {
  const cast = [
    { id: 'B', team: 0, role: 'batter', hand: 'R' as const },
    { id: 'P', team: 1, role: 'pitcher' },
    { id: 'C', team: 1, role: 'catcher' },
    { id: 'AB', team: 0, role: 'bench' },
    { id: 'HB', team: 1, role: 'bench' },
    { id: 'AM', team: 0, role: 'manager' },
    { id: 'K', team: -1, role: 'ballkid' },
  ];
  const ctx: FaceCtx = { half: 'top', batterId: 'B', pitcherId: 'P', cast };
  const of = (acts: ReturnType<typeof reactionsFor>, id: string) => acts.filter((a) => a.id === id);
  it('strikeout: the batter frustrated, the pitcher yells (a calm one nods), the benches split', () => {
    const a = reactionsFor({ type: 'pa_end', batterId: 'B', result: 'strikeout looking' }, ctx);
    expect(of(a, 'B').map((x) => x.reaction)).toEqual(['frustration', 'glare']);
    expect(of(a, 'P')[0]).toMatchObject({ reaction: 'yell', calmAlt: 'nod' });
    expect(of(a, 'AB')[0].mood![0]).toBeLessThan(0);
    expect(of(a, 'HB')[0].mood![0]).toBeGreaterThan(0);
  });
  it('home run: grin then shout; the pitcher stunned then down; the batting bench cheers', () => {
    const a = reactionsFor({ type: 'homerun', batterId: 'B' }, ctx);
    expect(of(a, 'B').map((x) => [x.reaction, x.delay ?? 0])).toEqual([['grin', 0], ['shout', 2.2]]);
    expect(of(a, 'P').map((x) => x.reaction)).toEqual(['shock', 'dejection']);
    expect(of(a, 'AB')[0].reaction).toBe('joy');
    expect(of(a, 'HB')[0].reaction).toBe('dejection');
    // his own run, sent with the homer, does not cut the grin short; another runner scoring shouts
    expect(reactionsFor({ type: 'run', playerId: 'B' }, { ...ctx, homer: 'B' }).filter((x) => x.id === 'B')).toEqual([]);
    expect(reactionsFor({ type: 'run', playerId: 'B' }, ctx).find((x) => x.id === 'B')!.reaction).toBe('shout');
    // the plate appearance's end does not react to the homer twice
    expect(reactionsFor({ type: 'pa_end', batterId: 'B', result: 'home run' }, ctx)).toEqual([]);
  });
  it('walk, hit, error, hit by pitch, brushback, ball kid', () => {
    expect(of(reactionsFor({ type: 'pa_end', batterId: 'B', result: 'walk' }, ctx), 'B')[0].reaction).toBe('relief');
    expect(of(reactionsFor({ type: 'pa_end', batterId: 'B', result: 'double' }, ctx), 'B')[0].reaction).toBe('joy');
    expect(reactionsFor({ type: 'error', fielderId: 'C' }, ctx)[0]).toMatchObject({ id: 'C', reaction: 'grimace' });
    expect(reactionsFor({ type: 'hbp', batterId: 'B' }, ctx)[0]).toMatchObject({ id: 'B', reaction: 'wince' });
    expect(of(reactionsFor({ type: 'pitch_crossed', x: 0.6, y: 1.5 }, ctx), 'B')[0].reaction).toBe('flinch');
    // inside to a right-handed batter only: away, or low, is no brushback
    expect(reactionsFor({ type: 'pitch_crossed', x: -0.6, y: 1.5 }, ctx)).toEqual([]);
    expect(reactionsFor({ type: 'pitch_crossed', x: 0.6, y: 0.8 }, ctx)).toEqual([]);
    expect(reactionsFor({ type: 'ball_kid_retrieve', kidId: 'K' }, ctx)[0]).toMatchObject({ id: 'K', reaction: 'delight' });
  });
  it('a close play out: the runner of the batting side argues; a mound visit talks', () => {
    expect(reactionsFor({ type: 'out', playerId: 'B', closePlay: true }, ctx)[0]).toMatchObject({ reaction: 'argue', talk: 2.5 });
    expect(reactionsFor({ type: 'out', playerId: 'B' }, ctx)).toEqual([]);
    expect(reactionsFor({ type: 'mound_visit', playerId: 'AM' }, ctx).find((x) => x.id === 'AM')!.talk).toBeGreaterThan(3);
  });
  it('pressure: bases loaded, late and close, two strikes', () => {
    const s = { inning: 8, score: { away: 3, home: 3 }, runners: [true, true, true] as [boolean, boolean, boolean], count: { strikes: 2, balls: 1 } };
    expect(tensionFor('batter', s)).toBeCloseTo(0.95);
    expect(tensionFor('bench', s)).toBe(0);
    expect(tensionFor('pitcher', { ...s, runners: [false, false, false], inning: 2 })).toBe(0);
  });
});
