import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { fenceAt } from '../field';
import { stepPlayer, wallContact, WALL_STAND } from '../movement';
import { lab } from './helpers';

describe('the outfield wall: a fielder slides along it at his own speed', () => {
  it('oblique runs into the wall near the corners never move him faster than 1.5x his top speed per tick (the radial snap did 3.8x)', () => {
    const l = lab('wall-corner', { pace: 0 });
    const w = l.w;
    const F = w.fieldingTeam.defense.get('LF')!;
    let worst = 0;
    for (const deg of [-50, -44, -38, -20, 0, 20, 38, 42, 44, 46, 50]) {
      const a = (deg * Math.PI) / 180;
      const d = fenceAt(w.env.fence, Math.sin(a), Math.cos(a)).distance;
      for (const off of [-0.9, -0.5, 0.5, 0.9]) {
        F.x = Math.sin(a) * (d - 6);
        F.z = Math.cos(a) * (d - 6);
        F.vx = F.vz = 0;
        F.onField = true;
        F.reactUntil = 0;
        F.goal = { x: Math.sin(a + off) * (d + 20), z: Math.cos(a + off) * (d + 20), mul: 1, stop: false };
        for (let i = 0; i < 240 * 4; i++) {
          const x0 = F.x, z0 = F.z;
          w.tick++;
          stepPlayer(F, w);
          worst = Math.max(worst, Math.hypot(F.x - x0, F.z - z0) / (F.vmax / 240));
          // and he never ends a tick through the wall
          expect(wallContact(w, F.x, F.z)).toBeNull();
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1.5);
    expect(WALL_STAND).toBeGreaterThan(0);
  });

  it('in live play over full games nobody on the field moves more than 1.5x his top speed in one tick', () => {
    let worst = 0, at = '';
    for (const seed of ['tp-1', 'tp-2']) {
      const g = createGame({ seed, pace: 1, tempo: 'quick' });
      const w = g._world;
      const prev = new Map<string, [number, number]>();
      let n = 0;
      while (!g.over && n++ < 240 * 8000) {
        g.step(1 / 240);
        const live = w.phase === 'inPlay';
        for (const t of [w.teams.home, w.teams.away]) for (const p of t.players.values()) {
          if (!p.onField || !live) {
            prev.delete(p.info.id);
            continue;
          }
          const q = prev.get(p.info.id);
          prev.set(p.info.id, [p.x, p.z]);
          if (!q) continue;
          const r = Math.hypot(p.x - q[0], p.z - q[1]) / (p.vmax / 240);
          if (r > worst) {
            worst = r;
            at = `${seed} t ${(w.tick / 240).toFixed(2)} ${p.fieldPos ?? p.info.id}`;
          }
        }
      }
    }
    expect(worst, at).toBeLessThanOrEqual(1.5);
  }, 600000);
});
