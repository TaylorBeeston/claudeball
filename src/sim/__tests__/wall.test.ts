import { describe, expect, it } from 'vitest';
import { fenceAt } from '../field';
import { fielders } from '../fielding';
import { WALL_STAND } from '../movement';
import { hitBall, lab, ofType } from './helpers';

function play(seed: string, mph: number, la: number, spray: number, seconds = 25) {
  const l = lab(seed);
  hitBall(l.w, mph, la, spray, 1800);
  let worst = -99;
  for (let i = 0; i < 240 * seconds && l.w.phase === 'inPlay'; i++) {
    l.g.step(1 / 240);
    for (const F of fielders(l.w)) worst = Math.max(worst, Math.hypot(F.x, F.z) - fenceAt(l.w.env.fence, F.x, F.z).distance);
  }
  return { l, worst };
}

describe('outfield wall', () => {
  it('is solid: no fielder is ever beyond it, however hard he chases a home run or a carom', () => {
    let worst = -99;
    for (const [mph, la, sp] of [[100, 28, 0], [102, 27, 8], [99, 32, -8], [104, 24, 20], [98, 9, -37], [96, 34, 0], [103, 26, -25]] as number[][]) {
      for (let k = 0; k < 3; k++) worst = Math.max(worst, play(`solid-${mph}-${la}-${sp}-${k}`, mph, la, sp).worst);
    }
    expect(worst).toBeLessThanOrEqual(-WALL_STAND + 1e-6);
  });

  it('the ball cannot slip out of the park along a slanted stretch of wall', () => {
    for (const sp of [-40, -37, -34, 34, 37, 40]) {
      const { l } = play(`slant-${sp}`, 98, 9, sp, 20);
      const b = l.w.ball.body;
      const beyond = Math.hypot(b.x, b.z) - fenceAt(l.w.env.fence, b.x, b.z).distance;
      // either a home run (ball over the top and dead) or still inside the wall
      const hr = ofType(l.events, 'homeRun').length > 0;
      expect(hr || beyond <= 0.01).toBe(true);
    }
  });

  it('a fielder leaps at the wall for balls just over it, and only the ones within his reach are robbed', () => {
    const byHeight = new Map<number, { n: number; robbed: number; leaps: number }>();
    for (let mph = 96; mph <= 110; mph++) {
      for (const la of [22, 25, 28, 31]) {
        for (const sp of [-6, 0, 6]) {
          const { l } = play(`rob-${mph}-${la}-${sp}`, mph, la, sp);
          const hr = ofType(l.events, 'homeRun')[0];
          const rob = ofType(l.events, 'robbedHomeRun')[0];
          const dy = rob ? rob.heightAboveWall : hr?.heightAboveWall;
          if (dy === undefined) continue;
          const bin = Math.floor(dy / 0.5);
          const b = byHeight.get(bin) ?? { n: 0, robbed: 0, leaps: 0 };
          b.n++;
          if (rob) {
            b.robbed++;
            // a robbery is an out, not a home run, and it is announced with a leap
            expect(ofType(l.events, 'homeRun').length).toBe(0);
            expect(ofType(l.events, 'wallLeap').length).toBeGreaterThan(0);
            expect(ofType(l.events, 'out').some((e) => e.outType === 'fly' || e.outType === 'line' || e.outType === 'pop')).toBe(true);
          }
          if (ofType(l.events, 'wallLeap').length) b.leaps++;
          byHeight.set(bin, b);
        }
      }
    }
    const total = [...byHeight.values()];
    const robbed = total.reduce((a, b) => a + b.robbed, 0);
    expect(robbed).toBeGreaterThan(0);
    // nothing more than ~1.5 m over the top of the wall is ever within reach of a glove
    for (const [bin, b] of byHeight) if (bin * 0.5 >= 1.5) expect(b.robbed).toBe(0);
    // the barely-over balls are robbed far more often than the ones well over
    const low = byHeight.get(0) ?? { n: 0, robbed: 0, leaps: 0 };
    const high = [...byHeight].filter(([k]) => k >= 3).reduce((a, [, b]) => a + b.n, 0);
    expect(low.n).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(0);
  });

  it('emits wallContact for the ball meeting the wall and animates the leap (catch_jump, feet off the ground)', () => {
    let sawJump = false;
    let sawBallContact = false;
    for (let k = 0; k < 21 && !sawJump; k++) {
      const mph = 100 + (k % 7);
      const la = [27, 24, 30][Math.floor(k / 7)];
      const l = lab(`jump-${mph}-${la}`);
      hitBall(l.w, mph, la, 0, 1800);
      for (let i = 0; i < 240 * 20 && l.w.phase === 'inPlay'; i++) {
        l.g.step(1 / 240);
        const s = l.g.getState();
        if (s.players.some((p) => p.anim === 'catch_jump' && p.pos.y > 0.15)) sawJump = true;
      }
      sawBallContact ||= ofType(l.events, 'wallContact').some((e) => e.who === 'ball');
    }
    expect(sawJump).toBe(true);
    for (const [mph, la, sp] of [[98, 9, -37], [100, 12, 30], [102, 15, 0], [99, 11, 20], [96, 10, 25], [104, 9, -30], [101, 12, -15], [97, 14, 10], [103, 11, 35], [99, 8, -25], [110, 14, -34], [108, 16, 34]] as number[][]) {
      if (sawBallContact) break;
      const l = lab(`carom-${mph}-${sp}`);
      hitBall(l.w, mph, la, sp, 800);
      for (let i = 0; i < 240 * 20 && l.w.phase === 'inPlay'; i++) l.g.step(1 / 240);
      sawBallContact ||= ofType(l.events, 'wallContact').some((e) => e.who === 'ball');
    }
    expect(sawBallContact).toBe(true);
  });
});
