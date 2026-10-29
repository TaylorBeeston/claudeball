import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { ARM_REACH, BatSwing, HAND_FRONT, HAND_REAR, SHOULDERS_C, bodyPoint, loadPose } from '../batting';
import type { World } from '../world';

/** Every tick of the first swings (not bunts): the world at that moment. */
function swingTicks(seed: string, swings: number, fn: (w: World) => void) {
  const g = createGame({ seed, pace: 0 });
  const w = g._world;
  let seen = 0;
  let was = false;
  for (let i = 0; i < 400_000 && seen < swings; i++) {
    g.step(1 / 240);
    const sw = w.swing;
    if (!sw || !w.swingStarted || sw.plan.bunt || sw.done || w.phase !== 'pitch') {
      was = false;
      continue;
    }
    if (!was) seen++;
    was = true;
    fn(w);
  }
  return seen;
}

/** Each swing's plan, replayed from its start (BatSwing is a pure function of the plan and the time). */
function plans(seed: string, swings: number) {
  const out: BatSwing['plan'][] = [];
  let last: unknown = null;
  swingTicks(seed, swings, (w) => {
    if (w.swing!.plan !== last) out.push((last = w.swing!.plan) as BatSwing['plan']);
  });
  return out;
}

const d3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const DEG = 180 / Math.PI;
const at = (sw: BatSwing, tau: number) => {
  const s = new BatSwing(sw.plan);
  while (s.tau < tau - 1e-9) s.advance(Math.min(1 / 1920, tau - s.tau));
  return s.pose();
};

describe('bat vs batter body', () => {
  const ps = plans('body-1', 60);

  it('starts from the clip\'s load pose (the bat the hands hold when the swing starts)', () => {
    expect(ps.length).toBeGreaterThan(40);
    for (const p of ps) {
      const st = p.sgn > 0 ? 'R' : 'L';
      const k = new BatSwing(p).pose().knob;
      expect(d3(k, loadPose(st, p.scale).knob)).toBeLessThan(0.01);
    }
  });

  it('at contact each fist is within reach of its own shoulder on the drawn body', () => {
    let worst = 0;
    for (const p of ps) {
      const st = p.sgn > 0 ? 'R' : 'L';
      const pose = at(new BatSwing(p), p.tauC);
      const fist = (s: number) => ({ x: pose.knob.x + s * pose.dir.x, y: pose.knob.y + s * pose.dir.y, z: pose.knob.z + s * pose.dir.z });
      // the bottom fist is the lead arm's, the top fist the rear arm's
      worst = Math.max(worst, d3(fist(HAND_FRONT), bodyPoint(st, p.scale, SHOULDERS_C.lead)) / p.scale, d3(fist(HAND_REAR), bodyPoint(st, p.scale, SHOULDERS_C.rear)) / p.scale);
    }
    expect(worst).toBeLessThanOrEqual(ARM_REACH + 0.05);
  });

  it('never chops: the bat stays out of the ground and is not pointing down steeply on the way in', () => {
    let lowest = 90, before = 90, tip = 9;
    for (const p of ps) {
      const sw = new BatSwing(p);
      for (let tau = 0; tau <= p.tauC * 2.1; tau += 1 / 120) {
        const pose = at(sw, tau);
        const el = Math.asin(pose.dir.y) * DEG;
        lowest = Math.min(lowest, el);
        tip = Math.min(tip, pose.tip.y);
        if (tau <= p.tauC - 0.04) before = Math.min(before, el);
      }
    }
    expect(lowest).toBeGreaterThan(-50);
    expect(before).toBeGreaterThan(-35);
    expect(tip).toBeGreaterThan(0.15);
  });

  it('meets the ball with the barrel a little below the hands, rising through the zone at a positive attack angle', () => {
    const vba: number[] = [], attack: number[] = [];
    for (const p of ps) {
      const pose = at(new BatSwing(p), p.tauC);
      const v = pose.velAt(0.66);
      vba.push(Math.asin(pose.dir.y) * DEG);
      attack.push(Math.asin(v.y / Math.hypot(v.x, v.y, v.z)) * DEG);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    expect(med(vba)).toBeGreaterThan(-35);
    expect(med(vba)).toBeLessThan(-5);
    expect(Math.max(...vba)).toBeLessThan(5);
    expect(med(attack)).toBeGreaterThan(3);
    expect(med(attack)).toBeLessThan(20);
  });

  it('the bat\'s velocity is the rate of change of its pose; the sweet spot moves at the planned bat speed, the hands at a hitter\'s (4-7 m/s at impact)', () => {
    for (const p of ps.slice(0, 20)) {
      const sw = new BatSwing(p);
      const a = at(sw, p.tauC - 0.002), b = at(sw, p.tauC + 0.002), c = at(sw, p.tauC);
      const s = 0.66;
      const pt = (q: typeof a) => ({ x: q.knob.x + s * q.dir.x, y: q.knob.y + s * q.dir.y, z: q.knob.z + s * q.dir.z });
      const fd = { x: (pt(b).x - pt(a).x) / 0.004, y: (pt(b).y - pt(a).y) / 0.004, z: (pt(b).z - pt(a).z) / 0.004 };
      const v = c.velAt(s);
      expect(d3(fd, v)).toBeLessThan(0.3);
      expect(Math.hypot(v.x, v.y, v.z) / p.batSpeed).toBeGreaterThan(0.95);
      expect(Math.hypot(v.x, v.y, v.z) / p.batSpeed).toBeLessThan(1.05);
      const vk = c.velAt(0);
      expect(Math.hypot(vk.x, vk.y, vk.z)).toBeGreaterThan(3.5);
      expect(Math.hypot(vk.x, vk.y, vk.z)).toBeLessThan(11);
    }
  });

  it('does not jump frame to frame on its way into the plane (the arms\' IK follows the drawn bat: 60 Hz frames, before contact)', () => {
    let step = 0, travel = 0, turn = 0;
    const ang = (a: { dir: { x: number; y: number; z: number } }, b: typeof a) => Math.acos(Math.min(1, a.dir.x * b.dir.x + a.dir.y * b.dir.y + a.dir.z * b.dir.z)) * DEG;
    for (const p of ps) {
      const sw = new BatSwing(p);
      const P = Array.from({ length: 10 }, (_, k) => sw.at(k / 60)), Q = P.map((_, k) => sw.plane(k / 60));
      for (let k = 1; k < P.length && k / 60 < 0.95 * p.tauC; k++) {
        const d = (i: number) => ({ x: P[i].knob.x - P[i - 1].knob.x, y: P[i].knob.y - P[i - 1].knob.y, z: P[i].knob.z - P[i - 1].knob.z });
        travel = Math.max(travel, d3(P[k].knob, P[k - 1].knob));
        if (k >= 2) step = Math.max(step, d3(d(k), d(k - 1)));
        // the turn on top of the plane's own (near contact the bat turns ~35 deg a frame: that is its speed, not a jump)
        turn = Math.max(turn, ang(P[k - 1], P[k]) - ang(Q[k - 1], Q[k]));
      }
    }
    // before the cubic blend (t-0030) the knob jumped by 23 cm in one frame six frames in, its speed by 14 cm a frame, the bat 20 deg over the plane's
    expect(step).toBeLessThan(0.08);
    expect(travel).toBeLessThan(0.16);
    expect(turn).toBeLessThan(15);
  });
});
