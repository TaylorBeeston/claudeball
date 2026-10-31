import { describe, expect, it } from 'vitest';
import { CATCH_YAW, catchYaw, newCatchYaw } from './catchYaw';

const dt = 1 / 60;
/** the sim's facing frame by frame (rad) and his speed (m/s): what the body is asked to hold */
function run(frames: { facing: number; speed: number; on?: boolean }[], body0 = 0) {
  const st = newCatchYaw();
  return frames.map((f) => catchYaw(st, f.on ?? true, f.facing, body0, f.speed, dt));
}

describe('catchYaw: the body heading while he takes and holds a ball', () => {
  it('holds through a shuffle-led swing of the sim facing and its way back (t-0039 LF catch: 1.7 rad out and back in 0.35 s)', () => {
    const frames: { facing: number; speed: number }[] = [];
    for (let i = 0; i < 12; i++) frames.push({ facing: 0, speed: 0.5 });
    // 0.15 s out at the sim's 14 rad/s while he shuffles at ~1.1 m/s, then back at 9 rad/s standing
    for (let i = 1; i <= 9; i++) frames.push({ facing: Math.min(1.7, i * 14 * dt), speed: 1.1 });
    for (let i = 1; i <= 12; i++) frames.push({ facing: Math.max(0.05, 1.7 - i * 9 * dt), speed: 0.3 });
    for (let i = 0; i < 12; i++) frames.push({ facing: 0.05, speed: 0 });
    const out = run(frames);
    const max = Math.max(...out.map((y) => Math.abs(y ?? 0)));
    expect(max).toBeLessThan(0.06);
    expect(out[out.length - 1]).toBeCloseTo(0.05, 6);
  });

  it('takes a settled new facing once it has held for the steady time', () => {
    const frames = [...Array.from({ length: 6 }, () => ({ facing: 0, speed: 0 })), ...Array.from({ length: 12 }, () => ({ facing: 1.2, speed: 0 }))];
    const out = run(frames);
    const first = out.findIndex((y) => y === 1.2);
    // the jump frame is not steady; the facing is then taken after `steady` s
    expect(first).toBeGreaterThan(6);
    expect((first - 6) * dt).toBeLessThanOrEqual(CATCH_YAW.steady + 2 * dt);
  });

  it('follows a run (a steady facing above the shuffle speeds) and lets go when he is not taking a ball', () => {
    const out = run([...Array.from({ length: 10 }, () => ({ facing: 2, speed: 4 })), { facing: 2, speed: 4, on: false }]);
    expect(out[9]).toBe(2);
    expect(out[10]).toBeNull();
  });

  it('starts from the body heading it is given, not the sim facing', () => {
    expect(run([{ facing: 1, speed: 1.2 }], 0.4)[0]).toBe(0.4);
  });
});
