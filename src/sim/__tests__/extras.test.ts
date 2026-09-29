import { describe, expect, it } from 'vitest';
import { addRunner, lab, ofType } from './helpers';
import { balk } from '../rules';
import { aiIntentionalWalk, aiBunt } from '../manager';
import { startPlateAppearance } from '../flow';

describe('intentional walks', () => {
  it('are issued in a late close game with first base open, a runner in scoring position, a dangerous hitter and a weak bat on deck', () => {
    const l = lab('ibb');
    const w = l.w;
    w.inning = 9;
    w.outs = 1;
    addRunner(w, 2, 3);
    const bt = w.battingTeam;
    const b = bt.lineup[bt.batIdx % 9].player;
    b.info.ratings.contact = 85;
    b.info.ratings.power = 85;
    b.info.ratings.eye = 80;
    const next = bt.lineup[(bt.batIdx + 1) % 9].player;
    next.info.ratings.contact = 30;
    next.info.ratings.power = 30;
    next.info.ratings.eye = 30;
    w.fieldingTeam.runs = 3;
    bt.runs = 3;
    let n = 0;
    for (let i = 0; i < 20; i++) if (aiIntentionalWalk(w)) n++;
    expect(n).toBeGreaterThan(10);
    // not with first base occupied, or early in the game
    addRunner(w, 1, 4);
    expect(aiIntentionalWalk(w)).toBe(false);
  });

  it('are not issued with the bases empty', () => {
    const l = lab('ibb-none');
    l.w.inning = 9;
    for (let i = 0; i < 10; i++) expect(aiIntentionalWalk(l.w)).toBe(false);
  });

  it('put the batter on first without a pitch and push forced runners', () => {
    const l = lab('ibb-run');
    const w = l.w;
    w.inning = 9;
    w.outs = 0;
    addRunner(w, 2, 3);
    const bt = w.battingTeam;
    w.fieldingTeam.runs = 2;
    bt.runs = 2;
    const b = bt.lineup[bt.batIdx % 9].player;
    b.info.ratings.contact = 90;
    b.info.ratings.power = 90;
    b.info.ratings.eye = 90;
    const nx = bt.lineup[(bt.batIdx + 1) % 9].player;
    nx.info.ratings.contact = 25;
    nx.info.ratings.power = 25;
    nx.info.ratings.eye = 25;
    // the lab already has a batter at the plate; walk the next one through the normal PA start
    const pitchesBefore = w.pitcher.pitchCount;
    let sawIntentional = false;
    for (let s = 0; s < 30 && !sawIntentional; s++) {
      w.phase = 'playOver';
      w.paDone = false;
      w.runners = w.runners.filter((r) => r.state === 'live');
      w.outs = 0;
      for (let k = 0; k < 12 && !ofType(l.events, 'walk').some((e) => e.intentional); k++) {
        w.tick++;
        startPlateAppearance(w);
      }
      sawIntentional = ofType(l.events, 'walk').some((e) => e.intentional);
    }
    expect(sawIntentional).toBe(true);
    expect(w.pitcher.pitchCount).toBe(pitchesBefore);
  });
});

describe('balks', () => {
  it('advance every runner one base and do not count as a pitch', () => {
    const l = lab('balk');
    const w = l.w;
    const r1 = addRunner(w, 1, 1);
    const r3 = addRunner(w, 3, 2);
    const before = { ...w.count };
    balk(w);
    for (let i = 0; i < 200; i++) l.g.step(0.05);
    expect(r1.base).toBe(2);
    expect(w.teams.away.runs + w.teams.home.runs).toBeGreaterThanOrEqual(1);
    expect(r3.state === 'scored' || r3.base === 4).toBe(true);
    expect(w.count.balls).toBe(before.balls);
    expect(ofType(l.events, 'call').some((c) => c.call.kind === 'balk')).toBe(true);
  });
});

describe('bunts', () => {
  it('a sacrifice bunt deadens the ball (slow exit speed) and usually advances the runner', () => {
    let exits: number[] = [];
    let contacts = 0;
    let attempts = 0;
    let advanced = 0;
    let sac = 0;
    for (let s = 0; s < 80; s++) {
      const l = lab('bunt' + s);
      const w = l.w;
      w.outs = 0;
      const r = addRunner(w, 1, 1);
      w.buntPlan = { kind: 'sac', psi: -0.1 };
      const start = w.tick;
      let done = false;
      l.g.on('plateAppearanceEnd', () => (done = true));
      for (let i = 0; i < 4000 && !done && (w.tick - start) / 240 < 60; i++) {
        l.g.step(0.05);
        if (w.phase === 'prePitch') w.buntPlan = { kind: 'sac', psi: -0.1 };
      }
      attempts++;
      const cs = ofType(l.events, 'contact');
      if (cs.length) {
        contacts++;
        exits.push(cs[0].exitMph);
      }
      const pa = ofType(l.events, 'plateAppearanceEnd')[0];
      if (pa?.result === 'sac bunt') sac++;
      if (r.base >= 2 || r.state === 'scored') advanced++;
    }
    exits = exits.filter((x) => x > 0);
    exits.sort((a, b) => a - b);
    const median = exits[Math.floor(exits.length / 2)];
    expect(contacts).toBeGreaterThan(40);
    expect(median).toBeLessThan(35);
    expect(advanced).toBeGreaterThan(12);
    expect(attempts).toBe(80);
    void sac;
  });

  it('the manager bunts with pitchers and weak hitters in sacrifice spots, not with the bases empty', () => {
    const l = lab('bunt-plan');
    const w = l.w;
    w.inning = 8;
    w.outs = 0;
    addRunner(w, 1, 1);
    w.batter!.info.ratings.contact = 30;
    w.batter!.info.ratings.power = 30;
    let n = 0;
    for (let i = 0; i < 100; i++) if (aiBunt(w)?.kind === 'sac') n++;
    expect(n).toBeGreaterThan(15);
    w.runners = [];
    let m = 0;
    w.batter!.info.ratings.speed = 40;
    for (let i = 0; i < 100; i++) if (aiBunt(w)) m++;
    expect(m).toBe(0);
  });
});
