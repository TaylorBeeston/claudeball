import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { RELEASE_S, releaseHeight, throwMotion, tossSpeed } from '../throws';

describe('short / easy throws: the motion fits the distance ("they never underhand throw")', () => {
  it('an underhand flip up close, a short-arm flick for a casual 8-25 m, a relaxed throw further, a real throw in a play', () => {
    expect(throwMotion(4, true)).toBe('toss_underhand');
    expect(throwMotion(6, false)).toBe('toss_underhand');
    expect(throwMotion(14, true)).toBe('toss_sidearm_short');
    expect(throwMotion(30, true)).toBe('throw_casual');
    expect(throwMotion(14, false)).toBe('throw');
    // a flip is a soft lob from about the waist, not a throw at arm speed
    expect(tossSpeed('toss_underhand', 5)).toBeLessThan(13.1);
    expect(tossSpeed('toss_underhand', 5)).toBeGreaterThan(6.9);
    expect(releaseHeight('toss_underhand')).toBeLessThan(releaseHeight('throw_casual'));
    for (const v of Object.values(RELEASE_S)) expect(v).toBeGreaterThan(0.3);
  });

  it('in a game the throwing hint is on whenever a release is pending, starts its release time ahead, and every short motion shows up', () => {
    const g = createGame({ seed: 'throws-1', pace: 1, tempo: 'standard' });
    const w = g._world;
    const seen = new Map<string, number>();
    let pendingWithoutHint = 0;
    let leads: number[] = [];
    const startOf = new Map<string, { anim: string; rel: number }>();
    let n = 0;
    while (!g.over && w.inning < 3 && n++ < 240 * 2400) {
      g.step(1 / 60);
      for (const p of g.getState().players) {
        if (p.releaseIn === undefined) {
          startOf.delete(p.id);
          continue;
        }
        if (!['throw', 'toss_underhand', 'toss_sidearm_short', 'throw_casual', 'roll_ball'].includes(p.anim)) pendingWithoutHint++;
        seen.set(p.anim, (seen.get(p.anim) ?? 0) + 1);
        if (!startOf.has(p.id)) {
          startOf.set(p.id, { anim: p.anim, rel: p.releaseIn });
          if (p.anim !== 'throw') leads.push(p.releaseIn);
        }
      }
    }
    expect(pendingWithoutHint).toBe(0);
    for (const m of ['toss_sidearm_short', 'roll_ball']) expect(seen.get(m) ?? 0, m).toBeGreaterThan(0);
    // the easy motions start (about) their clip's release time before the ball leaves
    leads = leads.filter((x) => x > 0.05);
    expect(leads.length).toBeGreaterThan(10);
    for (const l of leads) expect(l).toBeLessThanOrEqual(0.6);
  });
});
