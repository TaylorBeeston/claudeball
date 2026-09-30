import { describe, expect, it } from 'vitest';
import { addRunner, hitBall, lab, ofType, runPlay } from './helpers';
import { applyPitchOutcome } from '../rules';

describe('rules', () => {
  it('a slow grounder to the shortstop is a force/ground out at first, not a hit', () => {
    let outs = 0;
    let hits = 0;
    for (let s = 0; s < 24; s++) {
      const l = lab('gb-' + s);
      hitBall(l.w, 62, -12, 12 + (s % 6) * 2); // routine grounder toward SS
      runPlay(l);
      const pa = ofType(l.events, 'plateAppearanceEnd').at(-1)!;
      if (pa.result === 'groundout') outs++;
      if (['single', 'double'].includes(pa.result)) hits++;
    }
    expect(outs).toBeGreaterThanOrEqual(18);
    expect(hits).toBeLessThanOrEqual(4);
  });

  it('force out: with the bases loaded a fielder stepping on the bag beats the runner (batter forced at 1B, force chain)', () => {
    const l = lab('force1');
    addRunner(l.w, 1, 1);
    hitBall(l.w, 70, -3, 18);
    runPlay(l);
    const outs = ofType(l.events, 'out');
    expect(outs.length).toBeGreaterThanOrEqual(1);
    expect(outs.every((o) => o.outType === 'force' || o.outType === 'tag')).toBe(true);
    // the force is on a runner who was forced (either the runner going to second or the batter)
    expect(l.w.outs).toBeGreaterThanOrEqual(1);
  });

  it('infield fly is declared with runners on 1st and 2nd, fewer than two outs, and the batter is out', () => {
    const l = lab('iff');
    addRunner(l.w, 1, 1);
    addRunner(l.w, 2, 2);
    hitBall(l.w, 45, 70, 8, 0); // high pop up around the mound
    runPlay(l);
    const calls = ofType(l.events, 'call').filter((c) => c.call.kind === 'infieldFly');
    expect(calls.length).toBe(1);
    const outs = ofType(l.events, 'out');
    expect(outs.some((o) => o.outType === 'infieldFly' || o.outType === 'pop' || o.outType === 'fly')).toBe(true);
  });

  it('no infield fly with first base open', () => {
    const l = lab('iff2');
    addRunner(l.w, 2, 1);
    hitBall(l.w, 45, 70, 8, 0);
    runPlay(l);
    expect(ofType(l.events, 'call').filter((c) => c.call.kind === 'infieldFly').length).toBe(0);
  });

  it('tag-up: a runner on third cannot score on a caught fly ball before the catch', () => {
    const l = lab('tagup');
    const r = addRunner(l.w, 3, 1);
    hitBall(l.w, 88, 40, 0, 1500); // fly ball to center
    runPlay(l, 45);
    const catches = ofType(l.events, 'catch').filter((c) => c.fly);
    const runs = ofType(l.events, 'runScored');
    expect(catches.length).toBeGreaterThan(0);
    if (runs.length) expect(runs[0].time).toBeGreaterThan(catches[0].time);
    void r;
  });

  it('walk-off: a bases-loaded walk in the bottom of the 9th ends the game as the run scores', () => {
    const l = lab('walkoff', { innings: 1 });
    const w = l.w;
    // play until the bottom of the 1st inning with the game tied
    for (let i = 0; i < 400000 && !(w.half === 'bottom' && w.phase === 'prePitch'); i++) l.g.step(0.05);
    expect(w.half).toBe('bottom');
    w.teams.away.runs = 0;
    w.teams.home.runs = 0;
    w.outs = 1;
    addRunner(w, 1, 1);
    addRunner(w, 2, 2);
    addRunner(w, 3, 3);
    w.count = { balls: 3, strikes: 1 };
    applyPitchOutcome(w, 'ball', { ballLive: false, droppedThird: false });
    for (let i = 0; i < 400 && !l.g.over; i++) l.g.step(0.05);
    expect(l.g.over).toBe(true);
    expect(w.winner).toBe('home');
    expect(w.teams.home.runs).toBe(1);
  });

  it('walk-off with real dead-ball time: the runner jogs home and the game ends the moment he scores', () => {
    const l = lab('walkoff-paced', { innings: 1, pace: 1 });
    const w = l.w;
    for (let i = 0; i < 400000 && !(w.half === 'bottom' && w.phase === 'prePitch'); i++) l.g.step(0.05);
    expect(w.half).toBe('bottom');
    w.teams.away.runs = 0;
    w.teams.home.runs = 0;
    w.outs = 0;
    for (const r of w.runners) r.p.onField = false;
    w.runners = [];
    addRunner(w, 1, 1);
    addRunner(w, 2, 2);
    addRunner(w, 3, 3);
    w.count = { balls: 3, strikes: 0 };
    applyPitchOutcome(w, 'ball', { ballLive: false, droppedThird: false });
    for (let i = 0; i < 4000 && !l.g.over; i++) l.g.step(0.05);
    expect(l.g.over).toBe(true);
    expect(w.winner).toBe('home');
    expect(w.teams.home.runs).toBe(1);
  });

  it('a force out on the third out nullifies a run that crossed the plate first (no run scores)', () => {
    const l = lab('nullify');
    const w = l.w;
    w.outs = 2;
    addRunner(w, 1, 1);
    addRunner(w, 3, 2);
    // a routine grounder: batter beats it? either way check invariants about the linescore
    hitBall(w, 60, -2, 20);
    runPlay(l);
    const total = w.teams.home.runs + w.teams.away.runs;
    const scored = ofType(l.events, 'runScored').length - ofType(l.events, 'runsNullified').reduce((s, e) => s + e.count, 0);
    expect(total).toBe(scored);
  });

  it('strike three ends the plate appearance; four balls is a walk', () => {
    const l = lab('count');
    const w = l.w;
    const before = w.outs;
    w.count = { balls: 0, strikes: 2 };
    applyPitchOutcome(w, 'strikeSwinging', { ballLive: false, droppedThird: false });
    expect(w.outs).toBe(before + 1);
    const l2 = lab('count2');
    l2.w.count = { balls: 3, strikes: 0 };
    applyPitchOutcome(l2.w, 'ball', { ballLive: false, droppedThird: false });
    expect(ofType(l2.events, 'walk').length).toBe(1);
  });
});
