import { describe, expect, it } from 'vitest';
import { CrowdModel, carryOf, hangTime, proximityOf, type CrowdCtx, type CrowdShot } from '../crowd';
import { mulberry32 } from '../dsp';
import type { RawEvent } from '../types';

const ctx = (o: Partial<CrowdCtx> = {}): CrowdCtx => ({ inning: 5, half: 'bottom', outs: 1, balls: 0, strikes: 0, score: { home: 2, away: 2 }, runners: [false, false, false], ...o });
const mk = (seed = 1, lowPower = false) => new CrowdModel({ rng: mulberry32(seed), lowPower });
const contact = (exitMph: number, launchDeg: number, sprayDeg = 5): RawEvent => ({ type: 'contact', exitMph, launchDeg, sprayDeg });

/** advance the model in 0.1 s steps; returns the shots taken and the energy at each step */
function run(m: CrowdModel, secs: number, life = false) {
  const shots: (CrowdShot & { t: number })[] = [];
  const energy: number[] = [];
  const bed: ReturnType<CrowdModel['update']>[] = [];
  for (let i = 0; i < Math.round(secs * 10); i++) {
    bed.push(m.update(0.1, life));
    energy.push(m.energy);
    for (const s of m.take()) shots.push({ ...s, t: +(m.t + s.delay).toFixed(2) });
  }
  return { shots, energy, bed };
}
const at = (e: number[], sec: number) => e[Math.round(sec * 10) - 1];
const first = (s: CrowdShot[], id: string) => s.find((x) => x.id === id);
const ids = (s: CrowdShot[]) => s.map((x) => x.id);

describe('crowd reaction model', () => {
  it('every ball hit makes an immediate pop sized by the contact: a soft "ooh" for weak, a sharper rise for hard', () => {
    const weak = mk();
    weak.observe(contact(58, 5), ctx());
    const rw = run(weak, 0.3);
    const hard = mk();
    hard.observe(contact(106, 14), ctx());
    const rh = run(hard, 0.3);
    expect(rw.shots[0].id).toBe('ooh');
    expect(rw.shots[0].t).toBeLessThan(0.2);
    expect(rh.shots.map((s) => s.id)).toContain('gasp');
    expect(rh.shots[0].gain).toBeGreaterThan(rw.shots[0].gain * 2);
    expect(hard.energy).toBeGreaterThan(weak.energy * 2);
    // sharper attack: the hard one reaches its level sooner
    expect(at(rh.energy, 0.2) / Math.max(...rh.energy)).toBeGreaterThan(at(rw.energy, 0.2) / Math.max(...rw.energy));
  });

  it('a foul dies faster than a fair hit: the pop is cut, an "aww" follows, the energy is gone in a second or two', () => {
    const fair = mk();
    fair.observe(contact(95, 12), ctx());
    const rf = run(fair, 3);
    const foul = mk();
    foul.observe(contact(95, 12), ctx());
    foul.observe({ type: 'call', call: { kind: 'foul', balls: 0, strikes: 0 } }, ctx());
    const ro = run(foul, 3);
    expect(at(ro.energy, 1.2)).toBeLessThan(at(rf.energy, 1.2) * 0.6);
    expect(ids(ro.shots)).toContain('aww');
    expect(ids(rf.shots)).not.toContain('aww');
    expect(Math.max(...ro.energy.slice(15))).toBeLessThan(0.05);
  });

  it('a deep fly ball builds anticipation while it is in the air, and the crowd holds its breath', () => {
    const m = mk();
    m.setContext(ctx());
    m.observe(contact(104, 30), ctx());
    const T = hangTime(104, 30);
    expect(T).toBeGreaterThan(3);
    expect(carryOf(104, 30)).toBeGreaterThan(90);
    const r = run(m, T);
    expect(at(r.energy, T * 0.8)).toBeGreaterThan(at(r.energy, T * 0.2) * 1.5); // rising with the ball
    expect(Math.max(...r.bed.map((b) => b.hush))).toBeGreaterThan(0.1);
    expect(first(r.shots, 'swell')).toBeTruthy();
    expect(first(r.shots, 'swell')!.rate).toBeLessThan(1.1); // stretched over the hang time
    // a short fly does not
    const s = mk();
    s.observe(contact(75, 22), ctx());
    expect(ids(run(s, 2).shots)).not.toContain('swell');
  });

  it('a caught fly: relief "ohh", applause when the home defence made the out; an "aww" when the home batter did', () => {
    const resolve = (half: 'top' | 'bottom') => {
      const m = mk();
      m.observe(contact(100, 30), ctx({ half }));
      run(m, 3);
      m.observe({ type: 'out', outType: 'fly' }, ctx({ half }));
      return run(m, 3);
    };
    const defence = resolve('top'); // home team fielding
    expect(ids(defence.shots)).toContain('oh_relief');
    expect(ids(defence.shots)).toContain('applause_small');
    const batter = resolve('bottom');
    expect(ids(batter.shots)).toContain('oh_relief');
    expect(ids(batter.shots)).not.toContain('applause_small');
    expect(ids(batter.shots)).toContain('aww');
    // the energy goes away after the catch
    expect(defence.energy[defence.energy.length - 1]).toBeLessThan(0.2);
  });

  it('a home run keeps building for 4-8 s with a long roar, clapping, whistles and a second wave', () => {
    const m = mk();
    m.observe(contact(106, 28, 10), ctx());
    run(m, 2.5);
    m.observe({ type: 'homeRun', distance: 125 }, ctx());
    const r = run(m, 12);
    const e = r.energy;
    expect(at(e, 0.5)).toBeGreaterThan(0.4); // the first wave, at once
    expect(at(e, 4)).toBeGreaterThan(at(e, 0.5) + 0.2); // and it keeps building
    expect(at(e, 7)).toBeGreaterThan(0.6); // a long tail
    expect(at(e, 12)).toBeLessThan(at(e, 4));
    const roars = r.shots.filter((s) => s.id === 'roar_big');
    expect(roars.length).toBeGreaterThanOrEqual(2);
    expect(roars[1].t).toBeGreaterThan(roars[0].t + 1.5); // a second wave
    expect(ids(r.shots)).toEqual(expect.arrayContaining(['whistle', 'applause', 'cheer_short']));
    expect(Math.max(...r.bed.map((b) => b.clap))).toBeGreaterThan(0.5);
    const span = Math.max(...r.shots.map((s) => s.t)) - Math.min(...r.shots.map((s) => s.t));
    expect(span).toBeGreaterThan(4);
  });

  it('a home run is bigger and lasts longer than a fair hit or a foul, and a visitor home run is muted with groans and boos', () => {
    const hr = mk();
    hr.observe({ type: 'homeRun' }, ctx());
    const rh = run(hr, 8);
    const hit = mk();
    hit.observe(contact(100, 14), ctx());
    hit.observe({ type: 'plateAppearanceEnd', result: 'double' }, ctx());
    const rd = run(hit, 8);
    expect(at(rh.energy, 5)).toBeGreaterThan(at(rd.energy, 5) + 0.3);
    const away = mk();
    away.observe({ type: 'homeRun' }, ctx({ half: 'top' }));
    const ra = run(away, 8);
    expect(Math.max(...ra.energy)).toBeLessThan(0.4);
    expect(ids(ra.shots)).toEqual(expect.arrayContaining(['groan', 'boo_few']));
    expect(ra.shots.find((s) => s.id === 'roar_big')).toBeUndefined();
    const roar = rh.shots.find((s) => s.id === 'roar_big')!;
    expect(roar.gain).toBeGreaterThan(0.75);
  });

  it('home-team success is louder than a visitor\'s, which is muted and gets groans, a few boos and a small pocket of cheering', () => {
    const play = (half: 'top' | 'bottom') => {
      const m = mk();
      m.observe({ type: 'plateAppearanceEnd', result: 'triple' }, ctx({ half }));
      return run(m, 4);
    };
    const home = play('bottom');
    const away = play('top');
    const cheerHome = home.shots.find((s) => s.id === 'roar_med')!;
    expect(cheerHome.gain).toBeGreaterThan(0.75);
    expect(away.shots.find((s) => s.id === 'roar_med')!.gain).toBeLessThan(cheerHome.gain * 0.4);
    expect(ids(away.shots)).toContain('aww');
    expect(ids(away.shots)).toContain('boo_few');
    expect(ids(home.shots)).not.toContain('boo_few');
    expect(Math.max(...away.energy)).toBeLessThan(Math.max(...home.energy) / 2);
  });

  it('on two strikes the home crowd claps the rhythm for its pitcher; not for the visitors\' pitcher', () => {
    const m = mk();
    m.observe({ type: 'call', call: { kind: 'strikeSwinging', balls: 1, strikes: 1 } }, ctx({ half: 'top' }));
    const r = run(m, 5);
    const claps = r.shots.filter((s) => s.id === 'clap_burst');
    expect(claps.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...claps.map((s) => s.t)) - Math.min(...claps.map((s) => s.t))).toBeGreaterThan(2.5);
    expect(Math.max(...r.bed.map((b) => b.clap))).toBeGreaterThan(0.1);
    const v = mk();
    v.observe({ type: 'call', call: { kind: 'strikeSwinging', balls: 1, strikes: 1 } }, ctx({ half: 'bottom' }));
    expect(ids(run(v, 5).shots)).not.toContain('clap_burst');
  });

  it('leans in on tense counts and goes quiet right before the pitch', () => {
    const m = mk();
    m.setContext(ctx({ strikes: 2, balls: 3, runners: [true, true, false] }));
    const calm = run(m, 3).bed.pop()!;
    m.observe({ type: 'windup' }, ctx({ strikes: 2, balls: 3, runners: [true, true, false] }));
    const pre = run(m, 3).bed.pop()!;
    expect(pre.hush).toBeGreaterThan(calm.hush + 0.2);
    expect(pre.murmur).toBeLessThan(calm.murmur);
    expect(pre.cutoff).toBeLessThan(calm.cutoff);
    m.observe({ type: 'pitchCrossed' }, ctx({ strikes: 2, balls: 3, runners: [true, true, false] }));
    expect(run(m, 3).bed.pop()!.hush).toBeLessThan(pre.hush);
    const easy = mk();
    easy.setContext(ctx());
    expect(run(easy, 3).bed.pop()!.hush).toBeLessThan(0.05);
  });

  it('a robbed home run: a gasp, then a groan and boos for the home batter, a roar for the home fielder', () => {
    const rob = (half: 'top' | 'bottom') => {
      const m = mk();
      m.observe(contact(105, 30), ctx({ half }));
      run(m, 2);
      m.observe({ type: 'robbedHomeRun' }, ctx({ half }));
      return run(m, 4);
    };
    const against = rob('bottom');
    expect(ids(against.shots)).toContain('gasp');
    expect(ids(against.shots)).toContain('groan');
    expect(ids(against.shots)).not.toContain('roar_med');
    const fav = rob('top');
    expect(ids(fav.shots)).toContain('gasp');
    expect(ids(fav.shots)).toContain('roar_med');
    expect(ids(fav.shots)).not.toContain('groan');
  });

  it('strikeouts, walks, steals, double plays and walk-offs react to whose side they favour', () => {
    const one = (ev: RawEvent, half: 'top' | 'bottom', extra: Partial<CrowdCtx> = {}) => {
      const m = mk();
      m.observe(ev, ctx({ half, ...extra }));
      return run(m, 3);
    };
    expect(ids(one({ type: 'out', outType: 'strikeout' }, 'top').shots)).toContain('cheer_short');
    expect(ids(one({ type: 'out', outType: 'strikeout' }, 'bottom').shots)).toContain('aww');
    expect(ids(one({ type: 'walk' }, 'top').shots)).toEqual(expect.arrayContaining(['aww', 'boo_few'])); // the home pitcher walks one
    expect(ids(one({ type: 'walk' }, 'bottom').shots)).toContain('applause_small');
    const steal = mk();
    steal.observe({ type: 'steal' }, ctx());
    const t = run(steal, 1);
    expect(ids(t.shots)).toContain('swell'); // tension first
    steal.observe({ type: 'safe', base: 2 }, ctx());
    expect(ids(run(steal, 2).shots)).toContain('cheer_short'); // then the pop
    const dp = mk();
    dp.observe({ type: 'out', outType: 'force' }, ctx({ half: 'top' }));
    dp.update(0.5);
    dp.observe({ type: 'out', outType: 'force' }, ctx({ half: 'top' }));
    expect(ids(run(dp, 2).shots)).toContain('roar_med');
    const walkoff = mk();
    walkoff.observe({ type: 'runScored', team: 'home', runsHome: 4, runsAway: 3 }, ctx({ inning: 9, half: 'bottom' }));
    const plain = mk();
    plain.observe({ type: 'runScored', team: 'home', runsHome: 3, runsAway: 1 }, ctx({ inning: 4, half: 'bottom' }));
    const w = run(walkoff, 10);
    const p = run(plain, 10);
    expect(Math.max(...w.energy)).toBeGreaterThan(Math.max(...p.energy) + 0.2);
    expect(w.shots.filter((s) => s.id === 'roar_big').length).toBeGreaterThan(p.shots.filter((s) => s.id === 'roar_big').length);
  });

  it('leverage: the same cheer is bigger in a tight late game than in an early blowout', () => {
    const tight = mk();
    tight.observe({ type: 'plateAppearanceEnd', result: 'single' }, ctx({ inning: 9, score: { home: 3, away: 3 }, runners: [false, true, false] }));
    const blow = mk();
    blow.observe({ type: 'plateAppearanceEnd', result: 'single' }, ctx({ inning: 2, score: { home: 0, away: 9 } }));
    expect(run(tight, 1).shots[0].gain).toBeGreaterThan(run(blow, 1).shots[0].gain * 1.15);
  });

  it('there is always a little life: lone claps, shouts, whistles, a kid, a vendor, a pocket of conversation, a seat; half as much on a phone', () => {
    const count = (low: boolean) => {
      const m = mk(7, low);
      m.setContext(ctx());
      return run(m, 300, true).shots;
    };
    const full = count(false);
    const low = count(true);
    for (const id of ['clap_single', 'shout', 'whistle', 'kid', 'vendor', 'chatter', 'seat_thump']) expect(ids(full), id).toContain(id);
    expect(low.length).toBeLessThan(full.length * 0.7);
    expect(full.every((s) => s.gain <= 0.6)).toBe(true); // incidental sounds stay in the background
    // and none while paused
    const p = mk(7);
    expect(run(p, 120, false).shots).toHaveLength(0);
  });

  it('is deterministic for a seed, and the shots come with delays inside the lookahead', () => {
    const a = mk(5);
    const b = mk(5);
    for (const m of [a, b]) {
      m.observe(contact(104, 28), ctx());
      m.observe({ type: 'homeRun' }, ctx());
    }
    expect(run(a, 8, true).shots).toEqual(run(b, 8, true).shots);
    const c = mk(3);
    c.observe(contact(100, 12), ctx());
    for (const s of c.take(0.2)) expect(s.delay).toBeLessThanOrEqual(0.2);
  });

  it('the bed gets louder and brighter with the level; closer cameras are louder and brighter than wide shots', () => {
    const m = mk();
    m.setContext(ctx());
    const quiet = run(m, 5).bed.pop()!;
    m.observe({ type: 'homeRun' }, ctx());
    const loud = run(m, 4).bed.pop()!;
    expect(loud.roar).toBeGreaterThan(quiet.roar * 2);
    expect(loud.cutoff).toBeGreaterThan(quiet.cutoff);
    const stands = proximityOf({ x: 70, y: 4, z: 110 });
    const behindPlate = proximityOf({ x: 0, y: 3, z: -8 });
    const wide = proximityOf({ x: 0, y: 40, z: -30 });
    expect(stands.gain).toBeGreaterThan(behindPlate.gain);
    expect(stands.gain).toBeGreaterThan(wide.gain);
    expect(stands.bright).toBeGreaterThan(wide.bright);
  });
});
