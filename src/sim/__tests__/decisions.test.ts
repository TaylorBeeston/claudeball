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
