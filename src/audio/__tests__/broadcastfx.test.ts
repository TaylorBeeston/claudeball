import { describe, expect, it } from 'vitest';
import { BroadcastFx } from '../broadcastfx';
import { SFX_DEFS, renderSfx } from '../synth';

describe('broadcast stings', () => {
  it('dissolves and wipes whoosh softly; an ordinary cut is silent; a cut to B-roll or out of a replay ticks very quietly', () => {
    const f = new BroadcastFx();
    expect(f.event({ type: 'cameraCut', kind: 'dissolve', from: 'pitch', to: 'broll', durationMs: 600 }, 10)).toMatchObject({ id: 'bfx_whoosh' });
    expect(f.event({ type: 'cameraCut', kind: 'cut', from: 'pitch', to: 'follow' }, 20)).toBeNull();
    expect(f.event({ type: 'cameraCut', kind: 'wipe', from: 'wide', to: 'pitch' }, 30)?.id).toBe('bfx_whoosh');
    const tick = f.event({ type: 'cameraCut', kind: 'cut', from: 'pitch', to: 'broll' }, 40)!;
    expect(tick.id).toBe('bfx_thunk');
    expect(tick.gain).toBeLessThan(0.5);
    expect(f.event({ type: 'cameraCut', kind: 'cut', from: 'replay', to: 'pitch' }, 50)?.id).toBe('bfx_thunk');
  });

  it('a replay gets a whoosh with a rising sting once, not once per event', () => {
    const f = new BroadcastFx();
    expect(f.event({ type: 'cameraCut', kind: 'replay', from: 'follow', to: 'replay' }, 100)?.id).toBe('bfx_replay');
    expect(f.event({ type: 'replayStart' }, 100.2)).toBeNull();
    expect(f.event({ type: 'replayEnd' }, 108)?.id).toBe('bfx_whoosh');
  });

  it('a graphic blips, a stadium aerial thumps, but never more often than one sting every 3 s (a replay sting after 1 s)', () => {
    const f = new BroadcastFx();
    expect(f.event({ type: 'graphicShown', kind: 'lowerThird' }, 5)?.id).toBe('bfx_blip');
    expect(f.event({ type: 'cameraCut', kind: 'dissolve' }, 6.5)).toBeNull(); // too soon
    expect(f.event({ type: 'cameraCut', kind: 'cut', from: 'pitch', to: 'aerial' }, 9)?.id).toBe('bfx_thump');
    expect(f.event({ type: 'cameraCut', kind: 'cut', from: 'aerial', to: 'pitch' }, 11)).toBeNull();
    expect(f.event({ type: 'replayStart' }, 12.5)?.id).toBe('bfx_replay'); // 3.5 s later
    expect(f.event({ type: 'cameraCut', kind: 'cut', from: 'pitch', to: 'aerial' }, 14)).toBeNull(); // thump only every 25 s
    // over a whole minute of busy camera work: never closer than 3 s, except the replay sting
    const g = new BroadcastFx();
    for (let t = 0; t < 60; t += 0.7) {
      g.event({ type: 'cameraCut', kind: t % 2 < 1 ? 'dissolve' : 'wipe' }, t);
      g.event({ type: 'graphicShown' }, t + 0.3);
    }
    for (let i = 1; i < g.played.length; i++) expect(g.played[i].t - g.played[i - 1].t).toBeGreaterThanOrEqual(3 - 1e-9);
  });

  it('until the engine sends events the director\'s shot changes drive it; afterwards only the events do', () => {
    const f = new BroadcastFx();
    expect(f.shot('pitch', 0)).toBeNull();
    expect(f.shot('follow', 5)).toBeNull(); // an ordinary cut
    expect(f.shot('replay', 20)?.id).toBe('bfx_replay');
    expect(f.shot('pitch', 30)?.id).toBe('bfx_whoosh');
    expect(f.shot('broll', 40)?.id).toBe('bfx_thunk');
    expect(f.shot('wide', 50)?.id).toBe('bfx_thump');
    f.event({ type: 'graphicShown' }, 60);
    expect(f.eventsSeen).toBe(true);
    expect(f.shot('replay', 80)).toBeNull();
    expect(f.event({ type: 'somethingElse' }, 90)).toBeNull();
  });

  it('the stings are synthesised, short, finite and quiet enough not to be heard as music', () => {
    for (const id of ['bfx_whoosh', 'bfx_thunk', 'bfx_replay', 'bfx_blip', 'bfx_thump'] as const) {
      const d = SFX_DEFS[id];
      const r = renderSfx(id, 0, 0);
      expect(d.buckets).toBe(1);
      const x = r.ch[0];
      expect(x.length / r.sr).toBeLessThan(1.2);
      let pk = 0;
      for (const v of x) {
        expect(Number.isFinite(v)).toBe(true);
        pk = Math.max(pk, Math.abs(v));
      }
      expect(pk).toBeGreaterThan(0.1);
      expect(pk).toBeLessThanOrEqual(0.61);
    }
  });
});
