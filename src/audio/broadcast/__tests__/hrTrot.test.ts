/**
 * No conversation over a home-run trot (promo jank log P6): the runs count only as each runner touches home, so during the trot the
 * game situation still shows the runners and the old score, and the booth used to start topics from it ("Two out, runner in scoring
 * position." / "Sanders with a chance to be the hero." after his home run; "It is tight in the ninth, 7-7" after a walk-off).
 * Seed 40 (standard tempo): Evan Sanders homers in the bottom of the 1st at sim 624.45.
 */
import { describe, expect, it } from 'vitest';
import { createGame } from '../../../sim/index';
import { Booth } from '../booth';
import { ctxFromRaw } from '../ctx';
import { mulberry32 } from '../../dsp';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('home-run trot', () => {
  it('the booth calls the home run and the run, and starts no topic until the next batter', () => {
    const g: any = createGame({ seed: 40, innings: 9, tempo: 'standard' } as never);
    const booth = new Booth({ rng: mulberry32(40 * 7 + 1), level: 'high' });
    const pending: any[] = [];
    g.on('*', (ev: any) => pending.push(ev));
    let t = 0, hrAt = -1, nextBatter = -1, lastPlay = '', busy = false;
    const said: { t: number; tag: string; imp: string; text: string }[] = [];
    // (the game's first home run: the trot, and the booth until the next batter)
    while (t < 3600 && nextBatter < 0) {
      g.step(1 / 120);
      t += 1 / 120;
      if (Math.round(t * 120) % 6 !== 0) continue;
      const rs = g.getState();
      const c = ctxFromRaw(rs, { lastPlay, crowd: 0.4, game: g });
      for (const ev of pending.splice(0)) {
        if (ev.type === 'homeRun' && hrAt < 0) hrAt = t;
        if (ev.type === 'batterUp' && hrAt >= 0 && nextBatter < 0) nextBatter = t;
        if (ev.type === 'playEnd') lastPlay = String(ev.description ?? '');
        if (ev.type === 'windup' || ev.type === 'contact') busy = true;
        if (ev.type === 'plateAppearanceEnd' || ev.type === 'call' || ev.type === 'halfInningEnd' || ev.type === 'batterUp') busy = false;
        booth.observe(ev, c, t);
      }
      booth.canTalk = !busy;
      for (const a of booth.tick(t, c, { suppressed: false, fieldHold: false }) as any[]) if (a.type === 'start') said.push({ t: a.at, tag: a.item.tag ?? '', imp: a.item.importance, text: a.clauses.map((x: any) => x.text).join(' ') });
    }
    expect(hrAt).toBeGreaterThan(0);
    expect(nextBatter).toBeGreaterThan(hrAt);
    const trot = said.filter((s) => s.t > hrAt + 0.5 && s.t < nextBatter);
    // the calls and the analyst's reaction are fine; a topic (a 'could' line that is not a reaction phrase) is not
    const topics = trot.filter((s) => s.imp === 'could' && !s.tag.startsWith('phrase.'));
    expect(topics, JSON.stringify(trot)).toEqual([]);
    expect(trot.some((s) => s.imp === 'must')).toBe(true);
  });
});
