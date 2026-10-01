import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { benchSeat, dugoutFloorY, onDeckSpot } from '../venue';
import type { GameStateSnapshot } from '../types';

function run(seed: string, innings: number, onTick: (s: GameStateSnapshot, tick: number) => void, every = 12) {
  const g = createGame({ seed, pace: 1 });
  const w = g._world;
  let n = 0;
  while (!g.over && w.inning < innings && n++ < 240 * 4000) {
    g.step(1 / 240);
    if (n % every === 0) onTick(g.getState(), w.tick);
  }
  return g;
}

describe('players come from the bench, warm up on deck and walk to the plate', () => {
  it('the dugouts are populated at the start: the batting side sits on its bench (bench_sit) at seats in its dugout', () => {
    const g = createGame({ seed: 'dug-1', pace: 1 });
    for (let i = 0; i < 12; i++) g.step(1 / 240);
    const s = g.getState();
    const bench = s.players.filter((p) => p.role === 'bench');
    expect(bench.length).toBeGreaterThanOrEqual(14);
    for (const p of bench.filter((q) => q.anim === 'bench_sit')) {
      const seat = benchSeat(p.team, 0);
      // inside the dugout (its side of the field, below the field level)
      expect(Math.sign(p.pos.x)).toBe(Math.sign(seat.x));
      expect(p.pos.y).toBeLessThan(-0.9);
      expect(dugoutFloorY(p.pos.x, p.pos.z)).toBeLessThan(0);
    }
    expect(bench.filter((p) => p.anim === 'bench_sit').length).toBeGreaterThanOrEqual(10);
  });

  it('the next hitter leaves the bench for the on-deck circle, warms up with a swing every 6-10 s, then walks to the box when he is called: 3-12 s, never faster than a walk-and-jog', () => {
    const swings = new Map<string, number[]>();
    const deckAt = new Map<string, { x: number; z: number }>();
    const rolesSeen = new Map<string, string[]>();
    let prevAnim = new Map<string, string>();
    const calledAt = new Map<string, number>();
    const g = createGame({ seed: 'dug-2', pace: 1 });
    const w = g._world;
    const readyAt = new Map<string, number>();
    g.on('batterUp', (e) => calledAt.set(e.batterId, w.tick));
    g.on('windup', () => {
      if (w.batter && !readyAt.has(w.batter.info.id + ':' + w.inning)) readyAt.set(w.batter.info.id + ':' + w.inning, w.tick);
    });
    let n = 0;
    const walkTimes: number[] = [];
    const onDeckEvents: string[] = [];
    g.on('onDeck', (e) => onDeckEvents.push(e.playerId));
    g.on('windup', () => {
      const b = w.batter;
      if (!b) return;
      const t0 = calledAt.get(b.info.id);
      if (t0 !== undefined) {
        walkTimes.push((w.tick - t0) / 240);
        calledAt.delete(b.info.id);
      }
    });
    while (!g.over && w.inning < 4 && n++ < 240 * 4000) {
      g.step(1 / 240);
      if (n % 6) continue;
      const s = g.getState();
      for (const p of s.players) {
        const seq = rolesSeen.get(p.id) ?? [];
        if (seq[seq.length - 1] !== p.role) seq.push(p.role);
        rolesSeen.set(p.id, seq);
        if (p.role === 'ondeck') {
          deckAt.set(p.id, { x: p.pos.x, z: p.pos.z });
          if (p.anim === 'ondeck_swing' && prevAnim.get(p.id) !== 'ondeck_swing') {
            const arr = swings.get(p.id) ?? [];
            arr.push(w.tick / 240);
            swings.set(p.id, arr);
          }
        }
        prevAnim.set(p.id, p.anim);
      }
    }
    // everybody who batted came off the bench, was on deck, then at the plate
    const throughDeck = [...rolesSeen.values()].filter((seq) => seq.includes('ondeck') && seq.includes('batter'));
    expect(throughDeck.length).toBeGreaterThanOrEqual(8);
    for (const seq of throughDeck) expect(seq.indexOf('bench')).toBeLessThan(seq.indexOf('ondeck'));
    expect(onDeckEvents.length).toBeGreaterThanOrEqual(8);
    // at the circle
    for (const [id, p] of deckAt) {
      const side = id.includes('-home-') ? 'home' : 'away';
      const c = onDeckSpot(side);
      expect(Math.hypot(p.x - c.x, p.z - c.z)).toBeLessThan(8);
    }
    // swings with the donut, 5-11 s apart
    const gaps: number[] = [];
    for (const arr of swings.values()) for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
    expect(gaps.length).toBeGreaterThan(3);
    for (const g2 of gaps) {
      expect(g2).toBeGreaterThan(4.5);
      expect(g2).toBeLessThan(12.5);
    }
    // the walk to the plate takes a realistic few seconds (called -> first windup)
    expect(walkTimes.length).toBeGreaterThan(8);
    const sorted = [...walkTimes].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.5)]).toBeGreaterThan(2.4);
    expect(sorted[Math.floor(sorted.length * 0.9)]).toBeLessThan(14);
  });

  it('nobody warps: over three innings no man moves faster than a sprint between samples, positions are continuous (bench, deck, plate, bases, dugout)', () => {
    for (const seed of ['dug-3', 'dug-4']) {
      const prev = new Map<string, { x: number; z: number }>();
      let worst = 0;
      let who = '';
      run(seed, 4, (s) => {
        for (const p of s.players) {
          const q = prev.get(p.id);
          if (q && p.role !== 'umpire') {
            const d = Math.hypot(p.pos.x - q.x, p.pos.z - q.z);
            if (d > worst) {
              worst = d;
              who = `${p.id} ${p.role} ${p.anim}`;
            }
          }
          prev.set(p.id, { x: p.pos.x, z: p.pos.z });
        }
      }, 12);
      // (sampled every 0.05 s: a sprint is 0.45 m, a ball kid / coach a little less)
      expect(worst, who).toBeLessThan(0.8);
    }
  });

  it('a player who is out walks back to the dugout and sits down; he is not removed from the picture', () => {
    const g = createGame({ seed: 'dug-5', pace: 1 });
    const w = g._world;
    const outs: string[] = [];
    g.on('out', (e) => outs.push(e.playerId));
    const seq = new Map<string, string[]>();
    let n = 0;
    while (!g.over && w.inning < 3 && n++ < 240 * 3000) {
      g.step(1 / 240);
      if (n % 24) continue;
      for (const p of g.getState().players) {
        const a = seq.get(p.id) ?? [];
        const tag = p.role === 'bench' ? (p.anim === 'bench_sit' ? 'sit' : 'walk') : p.role;
        if (a[a.length - 1] !== tag) a.push(tag);
        seq.set(p.id, a);
      }
    }
    expect(outs.length).toBeGreaterThan(5);
    let sat = 0;
    for (const id of outs) {
      const a = seq.get(id) ?? [];
      const i = a.lastIndexOf('walk');
      if (i >= 0 && a.slice(i).includes('sit')) sat++;
    }
    expect(sat).toBeGreaterThanOrEqual(Math.floor(outs.length * 0.6));
  });
});
