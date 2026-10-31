import { describe, expect, it } from 'vitest';
import { createGame } from '../game';

/** Three innings at pace 1: every seated bench man's hint sequence, with the tick each hint starts. */
function benchHints(seed: string) {
  const g = createGame({ seed, pace: 1, tempo: 'standard', innings: 9 });
  const w = g._world;
  const seq = new Map<string, { hint: string; tick: number }[]>();
  let n = 0;
  while (!g.over && w.inning < 4 && n++ < 240 * 3600 * 2) {
    g.step(1 / 240);
    // every tick, from the world (what the snapshot shows a man on the bench doing: his hint while it lasts, else seated)
    for (const t of [w.teams.home, w.teams.away]) {
      for (const p of t.players.values()) {
        // (off the bench: called on deck, out to the field, walking back; he may leave in the middle of a reaction)
        const anim = p.dug !== 'bench' || p.route.length ? 'away' : w.tick < p.animUntil ? p.anim : 'bench_sit';
        const s = seq.get(p.info.id) ?? [];
        if (s[s.length - 1]?.hint !== anim) s.push({ hint: anim, tick: w.tick });
        seq.set(p.info.id, s);
      }
    }
  }
  return seq;
}

describe('the bench does not move as one', () => {
  const seq = benchHints('bench-life');
  it('a man gets up before he cheers and sits back down after (no jump from seated to standing)', () => {
    let cheers = 0;
    for (const s of seq.values()) {
      for (let i = 0; i < s.length; i++) {
        if (s[i].hint !== 'bench_cheer') continue;
        cheers++;
        const before = s.slice(0, i).reverse().find((x) => x.hint !== 'bench_cheer' && x.hint !== 'bench_stand');
        expect(before?.hint).toBe('bench_stand_up');
      }
      for (let i = 1; i < s.length; i++) if (s[i].hint === 'bench_sit' && s[i - 1].hint !== 'away') expect(s[i - 1].hint).toBe('bench_sit_down');
    }
    expect(cheers).toBeGreaterThan(2);
  });
  it('the men of one reaction get up at different moments, and some get up by themselves now and then', () => {
    const ups: number[] = [];
    for (const s of seq.values()) for (const x of s) if (x.hint === 'bench_stand_up') ups.push(x.tick);
    ups.sort((a, b) => a - b);
    // within a reaction (starts less than 1 s apart) no two on the same tick
    let together = 0, close = 0;
    for (let i = 1; i < ups.length; i++) {
      if (ups[i] - ups[i - 1] < 240) close++;
      if (ups[i] === ups[i - 1]) together++;
    }
    expect(close).toBeGreaterThan(2);
    expect(together).toBeLessThanOrEqual(1); // (two men's own fidgets may meet on a tick by chance; a reaction's never do)
    const stands = [...seq.values()].filter((s) => s.some((x) => x.hint === 'bench_stand')).length;
    expect(stands).toBeGreaterThan(2);
  });
});
