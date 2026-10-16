/**
 * Bodies and contact. The regression is the verify skill's seed 3 CLOSE PLAY (broadcast, 9 innings, sim 1225.5 s): a steal of second
 * where the runner's slide stopped ~2 m short of the bag (the slide clips' travel on top of the sim's) and the second baseman and the
 * shortstop both went to the bag and stood inside each other and the runner. Rebuilt here as steals of second with a real pitch, the
 * catcher's real throw and the defense's own coverage, so it does not depend on one seed's timeline.
 */
import { describe, expect, it } from 'vitest';
import { BASE_POS } from '../field';
import { gatherBodies } from '../bodies';
import { distToBase } from '../stride';
import { runnerBody } from '../tagging';
import { addRunner, lab, ofType } from './helpers';

function steal(seed: string) {
  const l = lab(seed, { pace: 1 });
  const w = l.w;
  const r = addRunner(w, 1);
  l.g.setProvider(w.battingTeam.side, { steal: () => ({ go: true }), swing: () => ({ swing: false }), bunt: () => ({ bunt: false }) } as never);
  l.g.setProvider(w.fieldingTeam.side, { pickoff: () => ({ throw: false }) });
  let closest = Infinity, who = '';
  let limbOnBag = false;
  const bag = BASE_POS[2];
  for (let i = 0; i < 240 * 40 && r.state === 'live' && !(r.base === 2 && w.phase !== 'inPlay' && w.phase !== 'pitch'); i++) {
    l.g.step(1 / 240);
    if (r.slideKind && distToBase(2, runnerBody(r).tx, runnerBody(r).tz) <= 0.05) limbOnBag = true;
    if (w.phase !== 'inPlay') continue;
    // everyone around second: no two upright bodies inside each other (a slide may tangle with the tagger's feet at the bag)
    const near = gatherBodies(w).filter((b) => Math.hypot(b.x - bag.x, b.z - bag.z) < 6);
    for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) {
      const A = near[a], B = near[b];
      // (a slide, or the runner down on the bag after it, tangles with the tagger's feet: seen from above that is no body inside another)
      const down = (x: typeof A) => !!x.tip || (!!x.run && x.run.contactBase === 2 && Math.hypot(x.vx, x.vz) < 2.5 && Math.hypot(x.x - bag.x, x.z - bag.z) < 1.0);
      if (down(A) || down(B)) continue;
      const d = Math.hypot(A.x - B.x, A.z - B.z);
      if (d < closest) {
        closest = d;
        who = `${A.cls}${B.cls} ${A.id} ${B.id} t=${(w.tick / 240).toFixed(2)}`;
      }
    }
  }
  return { l, w, r, closest, who, limbOnBag };
}

describe('a steal of second (the seed 3 close play)', () => {
  it('only the covering man takes the throw at the bag, beside it; nobody is inside anybody; a runner called safe got his foot / hand on the bag', () => {
    let safes = 0, outs = 0;
    for (let k = 0; k < 14; k++) {
      const s = steal(`steal-${k}`);
      if (!ofType(s.l.events, 'steal').length && !ofType(s.l.events, 'out').length) continue; // (the ball got away / was fouled: no play at second)
      expect(s.closest, s.who).toBeGreaterThan(0.38);
      const safe = ofType(s.l.events, 'baseTouch').some((e) => e.base === 2 && e.playerId === s.r.p.info.id);
      if (safe) {
        safes++;
        const t = ofType(s.l.events, 'baseTouch').find((e) => e.base === 2 && e.playerId === s.r.p.info.id)!;
        expect(distToBase(2, t.touch!.x, t.touch!.z), `steal-${k}`).toBeLessThan(0.3);
      } else if (s.r.state === 'out') outs++;
    }
    expect(safes + outs).toBeGreaterThan(8);
    expect(safes).toBeGreaterThan(0);
  });
});

describe('the rules on contact', () => {
  /** A runner going from first to second at `speed`, a fielder `f` placed at (x, z), and a batted ball in play. */
  function scene(seed: string) {
    const l = lab(seed);
    const w = l.w;
    const r = addRunner(w, 1);
    r.target = 2;
    r.want = 2;
    r.origin = 1;
    const a = BASE_POS[1], b = BASE_POS[2];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    r.p.x = a.x + ((b.x - a.x) / L) * 10;
    r.p.z = a.z + ((b.z - a.z) / L) * 10;
    r.p.vx = ((b.x - a.x) / L) * 7;
    r.p.vz = ((b.z - a.z) / L) * 7;
    return { l, w, r };
  }
  const bodyOf = (w: import('../world').World, id: string) => gatherBodies(w).find((b) => b.id === id)!;

  it('runner interference: running into the fielder fielding a batted ball is an out and a dead ball; the batter gets first, the others go back', async () => {
    const { contactRules } = await import('../contact');
    const { hitBall } = await import('./helpers');
    const { l, w, r } = scene('int-1');
    hitBall(w, 70, -5, 30);
    const F = [...w.fieldingTeam.defense.values()].find((p) => p.fieldPos === '2B')!;
    w.play!.primary = F;
    F.x = r.p.x + 0.3;
    F.z = r.p.z + 0.3;
    // the grounder is at his feet: he is making the play on it
    w.ball.body.x = F.x + 0.8;
    w.ball.body.z = F.z;
    w.ball.body.y = 0.1;
    const br = w.runners.find((q) => q.isBatter)!;
    contactRules(w, [{ a: bodyOf(w, r.p.info.id), b: bodyOf(w, F.info.id), speed: 5, x: F.x, z: F.z }]);
    expect(r.state).toBe('out');
    expect(ofType(l.events, 'out').find((e) => e.playerId === r.p.info.id)!.outType).toBe('interference');
    expect(w.play!.dead).toBe(true);
    expect(br.want).toBe(1);
  });

  it('obstruction: a fielder without the ball in the runner\'s lane; with a throw on its way to that base the ball is dead and he is given it, otherwise he cannot be put out short of it', async () => {
    const { contactRules } = await import('../contact');
    const rules = await import('../rules');
    for (const throwComing of [true, false]) {
      const { l, w, r } = scene(`obs-${throwComing}`);
      const { newPlay } = await import('../inplay');
      w.play = newPlay(w, 'steal');
      w.phase = 'inPlay';
      const F = [...w.fieldingTeam.defense.values()].find((p) => p.fieldPos === '1B')!;
      F.hasBall = false;
      F.plan.kind = 'idle';
      F.x = r.p.x + r.p.vx * 0.05;
      F.z = r.p.z + r.p.vz * 0.05;
      if (throwComing) {
        w.ball.holder = null;
        w.ball.mode = 'thrown';
        w.ball.throwBase = 2;
        w.ball.throwTo = null;
      }
      contactRules(w, [{ a: bodyOf(w, r.p.info.id), b: bodyOf(w, F.info.id), speed: 4, x: F.x, z: F.z }]);
      const ob = ofType(l.events, 'obstruction');
      expect(ob.length).toBe(1);
      expect(ob[0].base).toBe(2);
      expect(ob[0].deadBall).toBe(throwComing);
      if (throwComing) {
        expect(w.play!.dead).toBe(true);
        expect(r.want).toBe(2);
      } else {
        // a tag on him before second does not count: he is given second
        rules.recordOut(w, r, 'tag', [F], null, false);
        expect(r.state).toBe('live');
        expect(r.want).toBe(2);
      }
    }
  });

  it('runner and fielder meeting as they break (the ball still well away from him, or the runner just off his bag) is incidental, not interference', async () => {
    const { contactRules } = await import('../contact');
    const { hitBall } = await import('./helpers');
    const { w, r } = scene('int-2');
    hitBall(w, 70, -5, 30);
    const F = [...w.fieldingTeam.defense.values()].find((p) => p.fieldPos === '2B')!;
    w.play!.primary = F;
    F.x = r.p.x + 0.3;
    F.z = r.p.z + 0.3;
    w.ball.body.x = F.x + 8;
    w.ball.body.z = F.z;
    w.ball.body.y = 0.1;
    contactRules(w, [{ a: bodyOf(w, r.p.info.id), b: bodyOf(w, F.info.id), speed: 5, x: F.x, z: F.z }]);
    expect(r.state).toBe('live');
    expect(w.play!.dead).toBe(false);
  });

  it('a fielder covering the bag the runner is going to, or brushing him, or a fielder with the ball: no obstruction', async () => {
    const { contactRules } = await import('../contact');
    const { newPlay } = await import('../inplay');
    const { l, w, r } = scene('obs-no');
    w.play = newPlay(w, 'steal');
    w.phase = 'inPlay';
    const F = [...w.fieldingTeam.defense.values()].find((p) => p.fieldPos === 'SS')!;
    F.x = r.p.x + r.p.vx * 0.05;
    F.z = r.p.z + r.p.vz * 0.05;
    contactRules(w, [{ a: bodyOf(w, r.p.info.id), b: bodyOf(w, F.info.id), speed: 0.5, x: F.x, z: F.z }]); // brushing
    F.hasBall = true;
    w.ball.holder = F;
    contactRules(w, [{ a: bodyOf(w, r.p.info.id), b: bodyOf(w, F.info.id), speed: 5, x: F.x, z: F.z }]); // with the ball
    F.hasBall = false;
    w.ball.holder = w.pitcher;
    F.plan.kind = 'cover';
    F.x = BASE_POS[2].x + 0.3;
    F.z = BASE_POS[2].z - 0.3;
    r.p.x = BASE_POS[2].x - 0.6;
    r.p.z = BASE_POS[2].z - 0.6;
    contactRules(w, [{ a: bodyOf(w, r.p.info.id), b: bodyOf(w, F.info.id), speed: 5, x: F.x, z: F.z }]); // covering the bag
    expect(ofType(l.events, 'obstruction').length).toBe(0);
  });

  it('out of the baseline: more than 3 ft off his line to the base while a tag comes is an out', async () => {
    const { baselineCheck } = await import('../contact');
    const { newPlay } = await import('../inplay');
    const { w, r } = scene('base-line');
    w.play = newPlay(w, 'steal');
    w.phase = 'inPlay';
    const b = BASE_POS[2];
    r.tagLine = { x0: r.p.x, z0: r.p.z, bx: b.x, bz: b.z, until: w.tick + 240 };
    r.p.x += 0.6; // sideways from his line (it runs toward second along +x +z): ~0.42 m off
    r.p.z -= 0.6;
    expect(baselineCheck(w, r)).toBe(false);
    r.p.x += 0.5;
    r.p.z -= 0.5;
    expect(baselineCheck(w, r)).toBe(true);
    expect(r.state).toBe('out');
  });
});
