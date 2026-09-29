import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { PENDING } from '../decisions';
import type { DecisionProvider, PitchRequest } from '../decisions';

describe('decision providers: plumbing', () => {
  it('a provider that only answers `pitch` steers the pitcher; everything else stays with the AI', () => {
    const asked: string[] = [];
    const provider: DecisionProvider = {
      pitch: (req) => {
        asked.push(req.pitcher.arsenal[0].type);
        return { pitchType: req.arsenal[0].type, targetX: 0, targetY: (req.zone.top + req.zone.bottom) / 2, careful: true };
      },
    };
    const g = createGame({ seed: 'prov-1', pace: 0, providers: { home: provider, away: provider } });
    let n = 0;
    const types = new Set<string>();
    g.on('pitchReleased', (e) => {
      n++;
      types.add(e.pitchType);
    });
    for (let i = 0; i < 20000 && n < 30; i++) g.step(0.02);
    expect(n).toBeGreaterThanOrEqual(30);
    expect(asked.length).toBeGreaterThanOrEqual(30);
    // both teams' starters always throw their first-listed pitch, right down the middle
    expect(types.size).toBeLessThanOrEqual(2);
  });

  it('a deferred answer pauses the sim until resolved (PENDING) and a promise pauses it too', async () => {
    let held: PitchRequest | null = null;
    const g = createGame({
      seed: 'prov-2',
      pace: 0,
      providers: {
        home: { pitch: (req) => ((held = req), PENDING) },
        away: { pitch: (req) => ((held = req), PENDING) },
      },
    });
    for (let i = 0; i < 20000 && g.pendingDecisions.length === 0; i++) g.step(0.02);
    expect(g.pendingDecisions.length).toBe(1);
    const t0 = g.getState().time;
    for (let i = 0; i < 200; i++) g.step(0.05);
    expect(g.getState().time).toBe(t0); // nothing advances while a question is open
    expect(g.getState().pendingDecision?.decision).toBe('pitch');
    expect(g.resolveDecision(held!.id, undefined)).toBe(true); // undefined: let the AI decide
    for (let i = 0; i < 20; i++) g.step(0.05);
    expect(g.getState().time).toBeGreaterThan(t0);

    // promise style
    const g2 = createGame({ seed: 'prov-2', pace: 0, providers: { home: { pitch: () => new Promise(() => undefined) }, away: { pitch: () => new Promise(() => undefined) } } });
    for (let i = 0; i < 20000 && g2.pendingDecisions.length === 0; i++) g2.step(0.02);
    expect(g2.pendingDecisions.length).toBe(1);
  });

  it('sync and deferred answers give the same game', () => {
    const answer = (req: PitchRequest) => ({ pitchType: req.arsenal[0].type, targetX: 0.05, targetY: (req.zone.top + req.zone.bottom) / 2 });
    const sync = createGame({ seed: 'prov-3', pace: 0, providers: { home: { pitch: answer }, away: { pitch: answer } } });
    const defer = createGame({
      seed: 'prov-3',
      pace: 0,
      providers: { home: { pitch: (r) => (setTimeout(() => defer.resolveDecision(r.id, answer(r)), 0), PENDING) }, away: { pitch: (r) => (setTimeout(() => defer.resolveDecision(r.id, answer(r)), 0), PENDING) } },
    });
    const ev = (g: ReturnType<typeof createGame>) => {
      const out: string[] = [];
      g.on('*', (e) => {
        if (e.type !== 'decisionRequested' && e.type !== 'decisionResolved') out.push(JSON.stringify(e));
      });
      return out;
    };
    const a = ev(sync);
    const b = ev(defer);
    for (let i = 0; i < 6000; i++) sync.step(0.05);
    return (async () => {
      let guard = 0;
      while (defer.getState().time < sync.getState().time && guard++ < 200000) {
        defer.step(0.05);
        if (defer.pendingDecisions.length) await new Promise((r) => setTimeout(r, 0));
      }
      const n = Math.min(a.length, b.length);
      expect(n).toBeGreaterThan(50);
      expect(b.slice(0, n)).toEqual(a.slice(0, n));
    })();
  });
});

// ---------------------------------------------------------------------------------------------
// outcomes follow decisions (scripted providers)
// ---------------------------------------------------------------------------------------------
import { addRunner, hitBall, lab, ofType } from './helpers';
import type { RunnerRequest } from '../decisions';
import type { GameEvent } from '../types';

const HOLD: DecisionProvider = { runner: (req: RunnerRequest) => ({ want: req.base }) };
/** Tag up on a fly ball, then go home once it is caught or drops. */
const SEND: DecisionProvider = { runner: (req: RunnerRequest) => (req.ball.caught || req.ball.landed || !req.ball.inAir ? { want: 4 } : { want: req.base, tagUp: true }) };

/** Runner on third, nobody out, a deep fly to center: play it with the given base-running provider. */
function deepFly(seed: string, provider: DecisionProvider | undefined, mph = 92, la = 32) {
  const l = lab(seed, provider ? { providers: { home: provider, away: provider } } : {});
  l.w.outs = 0;
  addRunner(l.w, 3);
  const before = l.events.length;
  hitBall(l.w, mph, la, 0, 1800);
  for (let i = 0; i < 240 * 30 && l.w.phase === 'inPlay'; i++) l.g.step(1 / 240);
  return { l, events: l.events.slice(before), runs: l.w.battingTeam.runs };
}

describe('decision providers: outcomes follow the decisions', () => {
  it('a runner who always holds at third does not score on a fly ball; one who always tags and goes does', () => {
    for (const [mph, la] of [[88, 34], [92, 32], [90, 38]] as number[][]) {
      const hold = deepFly('sf-a', HOLD, mph, la);
      const send = deepFly('sf-a', SEND, mph, la);
      expect(ofType(hold.events, 'out').map((e) => e.outType)).toContain('fly');
      expect(ofType(hold.events, 'runScored').length).toBe(0);
      expect(ofType(send.events, 'runScored').length).toBe(1);
      expect(send.runs - hold.runs).toBe(1);
    }
  });

  it('the fielder who is told to hold the ball never throws; the default AI does throw to stop an advancing runner', () => {
    const holdFielders: DecisionProvider = { throw: () => ({ action: 'hold' }) };
    const run = (fielders: DecisionProvider | undefined) => {
      const l = lab('hold-throw', { providers: { home: { ...fielders, ...SEND }, away: { ...fielders, ...SEND } } });
      l.w.outs = 0;
      addRunner(l.w, 2);
      addRunner(l.w, 1, 2);
      const before = l.events.length;
      hitBall(l.w, 82, 12, 8, 500); // a single to left with runners going
      for (let i = 0; i < 240 * 30 && l.w.phase === 'inPlay'; i++) l.g.step(1 / 240);
      return l.events.slice(before);
    };
    const held = run(holdFielders);
    const ai = run(undefined);
    expect(ofType(held, 'throw').length).toBe(0);
    expect(ofType(ai, 'throw').length).toBeGreaterThan(0);
  });

  it('an outfielder told not to leap at the wall does not leave the ground; told to leap he does', () => {
    const grid: [number, number, number][] = [];
    for (let mph = 96; mph <= 106; mph += 1) for (const la of [24, 27, 30]) grid.push([mph, la, 0]);
    let leapsNo = 0;
    let leapsYes = 0;
    for (const [mph, la, sp] of grid) {
      for (const leap of [false, true]) {
        const p: DecisionProvider = { wallPlay: () => ({ leap }) };
        const l = lab(`wall-${mph}-${la}`, { providers: { home: p, away: p } });
        hitBall(l.w, mph, la, sp, 1800);
        for (let i = 0; i < 240 * 20 && l.w.phase === 'inPlay'; i++) l.g.step(1 / 240);
        const n = ofType(l.events, 'wallLeap').length;
        if (leap) leapsYes += n;
        else leapsNo += n;
      }
    }
    expect(leapsNo).toBe(0);
    expect(leapsYes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// audit: nothing is decided before the physics runs
// ---------------------------------------------------------------------------------------------

/** Pass-through wrapper: asks the built-in AI (so the AI's own RNG use is unchanged), records every answer, can flip one. */
function recording(flipRunnerAnswerAt = -1) {
  const answers: unknown[] = [];
  let n = 0;
  let flippedAtTick = -1;
  const make = (g: () => ReturnType<typeof createGame>): DecisionProvider => ({
    runner: (req) => {
      let d = g().ai.runner(req);
      if (n === flipRunnerAnswerAt) {
        d = { want: d.want > req.base ? req.base : Math.min(4, req.base + 1), tagUp: false, recheckSec: d.recheckSec };
        flippedAtTick = Math.round(req.time * 240);
      }
      n++;
      answers.push(d);
      return d;
    },
  });
  return { make, answers, flippedAt: () => flippedAtTick };
}

function playWith(seed: string, flipAt = -1, replay?: unknown[], maxSeconds = 4000, probeTick = -1) {
  const rec = recording(flipAt);
  let g!: ReturnType<typeof createGame>;
  const replayProvider: DecisionProvider | null = replay ? { runner: (() => { let i = 0; return () => replay[i++] as never; })() } : null;
  const prov = replayProvider ?? rec.make(() => g);
  g = createGame({ seed, pace: 0, providers: { home: prov, away: prov } });
  const events: GameEvent[] = [];
  g.on('*', (e) => events.push(e));
  const rngAt = new Map<number, string>();
  let t = 0;
  while (!g.over && t < maxSeconds * 240) {
    g.step(1 / 240);
    t++;
    if (probeTick >= 0 && t === probeTick) rngAt.set(0, g._world.rng.state());
    if (probeTick < 0 && rec.flippedAt() >= 0 && !rngAt.has(0)) rngAt.set(0, g._world.rng.state());
  }
  return { g, events, rec, rngAtFlip: rngAt.get(0) };
}

describe('audit: no outcome is decided in advance', () => {
  it('same seed + same decisions => the same game (replaying the recorded answers reproduces every event)', () => {
    const a = playWith('audit-1');
    expect(a.rec.answers.length).toBeGreaterThan(100);
    const b = playWith('audit-1', -1, a.rec.answers);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });

  it('changing ONE base-running decision changes the game from that moment on, and only from then on', () => {
    const base = playWith('audit-2', -1);
    // flip a decision late enough that runners are on and the ball is in play (search for one that changes the game)
    let found = false;
    for (const idx of [40, 90, 150, 220, 300, 420, 600, 800]) {
      const flipped = playWith('audit-2', idx);
      if (flipped.rec.flippedAt() < 0) continue;
      const tick = flipped.rec.flippedAt();
      const probe = playWith('audit-2', -1, undefined, 4000, tick + 1);
      const flippedProbe = playWith('audit-2', idx, undefined, 4000, tick + 1);
      // the physics generator has consumed exactly the same draws at the moment of the decision
      expect(flippedProbe.rngAtFlip).toBe(probe.rngAtFlip);
      expect(probe.rngAtFlip).toBeDefined();
      const cut = tick / 240;
      const same = (e: GameEvent) => e.time < cut - 0.05;
      const pa = base.events.filter(same).filter((e) => e.type !== 'decisionRequested');
      const pb = flipped.events.filter(same).filter((e) => e.type !== 'decisionRequested');
      // everything before the decision is identical (nothing looked ahead), and the physics stream had consumed the same draws
      expect(JSON.stringify(pb)).toBe(JSON.stringify(pa));
      if (JSON.stringify(flipped.events) !== JSON.stringify(base.events)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('the physics random stream at a decision point does not depend on the answer', () => {
    // two forks of the same fly-ball play: identical up to the runner's decision, so the physics generator is in the same state
    const stateAtDecision: string[] = [];
    for (const prov of [HOLD, SEND]) {
      const l = lab('sf-rng', { providers: { home: prov, away: prov } });
      l.w.outs = 0;
      addRunner(l.w, 3);
      hitBall(l.w, 92, 32, 0, 1800);
      // step to just before the ball is caught (the first tag-up / hold answer is applied a tick after the question)
      for (let i = 0; i < 240 * 2; i++) l.g.step(1 / 240);
      stateAtDecision.push(l.w.rng.state());
    }
    expect(stateAtDecision[0]).toBe(stateAtDecision[1]);
  });
});
