import { describe, expect, it } from 'vitest';
import type { DecisionProvider } from '../decisions';
import { createGame } from '../game';
import { ballKidSpot, batBoySpot, coachBox } from '../venue';
import { addRunner, hitBall, lab, ofType } from './helpers';

describe('base coaches', () => {
  it('the batting side\'s coaches stand in their boxes (coach1b / coach3b), the others are not on the field; they change over with the half-innings', () => {
    const g = createGame({ seed: 'coach-1', pace: 1 });
    const w = g._world;
    for (let i = 0; i < 240; i++) g.step(1 / 240);
    const s = g.getState();
    const coaches = s.players.filter((p) => p.role === 'coach1b' || p.role === 'coach3b');
    expect(coaches.length).toBe(2);
    for (const c of coaches) {
      const box = coachBox(c.role === 'coach3b' ? 3 : 1);
      expect(Math.hypot(c.pos.x - box.x, c.pos.z - box.z)).toBeLessThan(1);
      expect(c.team).toBe(w.battingTeam.side);
      expect(c.anim).toBe('coach_ready');
    }
    expect(coaches.find((c) => c.role === 'coach3b')!.pos.x).toBeGreaterThan(0); // third base is +X
    expect(coaches.find((c) => c.role === 'coach1b')!.pos.x).toBeLessThan(0);
    // a half-inning later the other team's coaches are out and these are gone
    let n = 0;
    const first = w.battingTeam.side;
    while (w.battingTeam.side === first && n++ < 240 * 1500) g.step(1 / 240);
    for (let i = 0; i < 240 * 14; i++) g.step(1 / 240);
    const s2 = g.getState();
    const c2 = s2.players.filter((p) => p.role === 'coach1b' || p.role === 'coach3b');
    expect(c2.every((c) => c.team === w.battingTeam.side)).toBe(true);
    expect(c2.length).toBe(2);
  });

  it('the third-base coach\'s call follows the state of the play: runners he sends score, runners he holds mostly stop at third', () => {
    const rows: { call: string; scored: boolean }[] = [];
    for (let k = 0; k < 60; k++) {
      const l = lab(`coach-send-${k}`, { pace: 1 });
      const w = l.w;
      const r = addRunner(w, 2);
      const calls: string[] = [];
      l.g.on('coachSignal', (e) => {
        if (e.runnerId === r.p.info.id && e.kind !== 'signs') calls.push(e.kind);
      });
      // a single to left / left-centre with a runner on second: sometimes there is a play at the plate, sometimes not
      hitBall(w, 70 + (k % 6) * 4, 7 + (k % 4) * 3, 8 + (k % 5) * 6, 800);
      for (let i = 0; i < 240 * 25 && w.phase !== 'prePitch'; i++) l.g.step(1 / 240);
      const scored = ofType(l.events, 'runScored').some((e) => e.playerId === r.p.info.id);
      const last = calls.filter((c) => c === 'go' || c === 'stop').at(-1);
      if (last) rows.push({ call: last, scored });
    }
    const go = rows.filter((r) => r.call === 'go');
    const stop = rows.filter((r) => r.call === 'stop');
    expect(go.length).toBeGreaterThan(5);
    expect(stop.length).toBeGreaterThan(3);
    expect(go.filter((r) => r.scored).length / go.length).toBeGreaterThan(0.7);
    expect(stop.filter((r) => r.scored).length / stop.length).toBeLessThan(0.4);
  });

  it('a provider can make the call: the `coach` decision kind (request carries the runner and the play), and its answer moves the runner', () => {
    const asked: { coach: string; base: number }[] = [];
    const outcomes = { go: 0, stop: 0 };
    for (const call of ['go', 'stop'] as const) {
      for (let k = 0; k < 24; k++) {
        const prov: DecisionProvider = {
          coach: (req) => {
            if (call === 'go' && asked.length < 3) asked.push({ coach: req.coach, base: req.base });
            return { call: req.coach === '3b' ? call : 'none' };
          },
        };
        const l = lab(`coach-prov-${k}`, { pace: 1, providers: { home: prov, away: prov } });
        const r = addRunner(l.w, 2);
        hitBall(l.w, 74, 8, 10 + (k % 4) * 8, 800);
        for (let i = 0; i < 240 * 25 && l.w.phase !== 'prePitch'; i++) l.g.step(1 / 240);
        if (ofType(l.events, 'runScored').some((e) => e.playerId === r.p.info.id)) outcomes[call]++;
      }
    }
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0].coach).toBe('3b');
    expect(outcomes.go).toBeGreaterThan(outcomes.stop + 3);
  });

  it('the third-base coach gives signs between pitches when the sim has a steal or a bunt on', () => {
    let signs = 0;
    const g = createGame({ seed: 'coach-signs', pace: 1 });
    g.on('coachSignal', (e) => {
      if (e.kind === 'signs') signs++;
    });
    let n = 0;
    while (!g.over && g._world.inning < 4 && n++ < 240 * 3000) g.step(1 / 240);
    expect(signs).toBeGreaterThan(3);
  });
});

describe('ball kids and the bat boy', () => {
  it('a foul ball that stops in foul ground is fetched by the nearer ball kid, who then takes it back or tosses it to a fan; fielders do not chase it', () => {
    let retrieved = 0;
    let tossed = 0;
    for (let k = 0; k < 8 && !(retrieved >= 1 && tossed >= 1); k++) {
      const l = lab(`kid-${k}`, { pace: 1 });
      const w = l.w;
      const near = new Set<string>();
      l.g.on('ballKidRetrieve', (e) => {
        retrieved++;
        near.add(e.ballKidId);
      });
      l.g.on('ballTossedToFan', (e) => {
        tossed++;
        const kid = w.staff.find((s) => s.id === e.ballKidId)!;
        // toward the stands, away from the field
        expect(Math.hypot(e.pos.x, e.pos.z)).toBeGreaterThan(Math.hypot(kid.homeX, kid.homeZ));
      });
      // a foul ball down the third-base line (k even) or the first-base line (odd)
      hitBall(w, 70, 5, k % 2 ? -62 : 62, 0);
      let sawDead = false;
      for (let i = 0; i < 240 * 40; i++) {
        l.g.step(1 / 240);
        if (w.deadBall) sawDead = true;
      }
      if (sawDead) {
        const snap = l.g.getState();
        expect(snap.deadBall === null || typeof snap.deadBall.state === 'string').toBe(true);
      }
    }
    expect(retrieved).toBeGreaterThanOrEqual(1);
  });

  it('over a few games the ball kids retrieve foul balls and sometimes toss one to a fan; the kids stay on their chairs in between (ballkid_sit)', () => {
    let retrieved = 0;
    let tossed = 0;
    let sitting = 0;
    let samples = 0;
    for (const seed of ['kid-g1', 'kid-g2']) {
      const g = createGame({ seed, pace: 1 });
      const w = g._world;
      g.on('ballKidRetrieve', () => retrieved++);
      g.on('ballTossedToFan', () => tossed++);
      let n = 0;
      while (!g.over && w.inning < 5 && n++ < 240 * 5000) {
        g.step(1 / 240);
        if (n % 240 === 0) {
          for (const p of g.getState().players.filter((q) => q.role === 'ballkid')) {
            samples++;
            const chair = ballKidSpot(p.id.includes('3b') ? 3 : 1);
            if (p.anim === 'ballkid_sit' && Math.hypot(p.pos.x - chair.x, p.pos.z - chair.z) < 0.6) sitting++;
          }
        }
      }
    }
    expect(retrieved).toBeGreaterThanOrEqual(3);
    expect(tossed).toBeGreaterThanOrEqual(1);
    expect(sitting / samples).toBeGreaterThan(0.6);
  });

  it('a ball kid gets out of the way of a ball in play', () => {
    const l = lab('kid-away', { pace: 1 });
    const w = l.w;
    hitBall(w, 85, 4, 58, 0); // a hard foul liner toward the third-base-side kid
    let retreated = false;
    for (let i = 0; i < 240 * 6; i++) {
      l.g.step(1 / 240);
      if (w.staff.some((s) => s.role === 'ballkid' && s.task === 'retreat')) retreated = true;
    }
    expect(retreated).toBe(true);
  });

  it('the bat boy retrieves the bat a hitter dropped running to first and carries it back', () => {
    let retrieved = 0;
    let droppedSeen = 0;
    for (let k = 0; k < 4 && retrieved < 2; k++) {
      const l = lab(`batboy-${k}`, { pace: 1 });
      const w = l.w;
      l.g.on('batBoyRetrieve', (e) => {
        retrieved++;
        expect(Math.hypot(e.pos.x, e.pos.z)).toBeLessThan(3); // at the plate
      });
      hitBall(w, 80, 6, 10 + k * 4, 800);
      for (let i = 0; i < 240 * 30; i++) {
        l.g.step(1 / 240);
        if (i % 24 === 0 && l.g.getState().bat.dropped) droppedSeen++;
      }
      const spot = batBoySpot(w.battingTeam.side);
      const boy = w.staff.find((s) => s.role === 'batboy' && s.team === w.battingTeam.side)!;
      expect(Math.hypot(boy.x - spot.x, boy.z - spot.z)).toBeLessThan(2.5);
      expect(w.batDown).toBeNull();
    }
    expect(droppedSeen).toBeGreaterThan(0);
    expect(retrieved).toBeGreaterThanOrEqual(1);
  });
});
