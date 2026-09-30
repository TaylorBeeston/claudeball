import { describe, expect, it } from 'vitest';
import { createGame } from '../game';
import { ARM_REACH, HAND_FRONT, HAND_REAR, SHOULDER_Z, TORSO_HALF, bodyCentre, loadPose, shouldersAt, torsoState } from '../batting';
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

const d3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('bat vs batter body', () => {
  it('each hand stays within reach of its OWN shoulder through every swing (start, contact, follow-through)', () => {
    let worst = 0;
    let frames = 0;
    const seen = swingTicks('body-1', 40, (w) => {
      const sw = w.swing!;
      const pose = sw.pose();
      const { yaw, lean } = torsoState(sw.tau, sw.plan.tauC);
      const { front, rear } = shouldersAt(w.batStance, yaw, lean);
      const hf = { x: pose.knob.x + HAND_FRONT * pose.dir.x, y: pose.knob.y + HAND_FRONT * pose.dir.y, z: pose.knob.z + HAND_FRONT * pose.dir.z };
      const hr = { x: pose.knob.x + HAND_REAR * pose.dir.x, y: pose.knob.y + HAND_REAR * pose.dir.y, z: pose.knob.z + HAND_REAR * pose.dir.z };
      worst = Math.max(worst, d3(hf, front), d3(hr, rear));
      frames++;
    });
    expect(seen).toBeGreaterThanOrEqual(20);
    expect(frames).toBeGreaterThan(300);
    expect(worst).toBeLessThanOrEqual(ARM_REACH + 1e-6);
  });

  it('starts from the clip\'s load pose (no jump to 0.58 m beside the batter)', () => {
    let n = 0;
    let worst = 0;
    swingTicks('body-2', 30, (w) => {
      const sw = w.swing!;
      if (sw.tau > 0.02) return;
      const l = loadPose(w.batStance);
      const k = sw.pose().knob;
      worst = Math.max(worst, d3(k, l.knob));
      n++;
    });
    expect(n).toBeGreaterThan(10);
    expect(worst).toBeLessThan(0.12);
  });

  it('keeps both hands outside the torso (plus elbow room) except when the body itself blocks the reach', () => {
    let frames = 0;
    let inside = 0;
    swingTicks('body-3', 40, (w) => {
      const sw = w.swing!;
      const pose = sw.pose();
      const { yaw, lean } = torsoState(sw.tau, sw.plan.tauC);
      const c = bodyCentre(w.batStance, lean);
      const sg = w.batStance === 'R' ? 1 : -1;
      for (const off of [HAND_FRONT, HAND_REAR]) {
        const hx = pose.knob.x + off * pose.dir.x - c.x;
        const hz = pose.knob.z + off * pose.dir.z - c.z;
        const a = hx * Math.sin(yaw) * sg + hz * Math.cos(yaw);
        const b = -hx * Math.cos(yaw) * sg + hz * Math.sin(yaw);
        if (Math.hypot(a / TORSO_HALF.lateral, b / TORSO_HALF.depth) < 0.9) inside++;
        frames++;
      }
    });
    expect(frames).toBeGreaterThan(600);
    expect(inside / frames).toBeLessThan(0.01);
  });

  it('at contact the hands are where the plan put them (the reach clamp is inactive for pitches he can reach)', () => {
    let contacts = 0;
    let free = 0;
    let prev = 0;
    swingTicks('body-4', 60, (w) => {
      const sw = w.swing!;
      if (prev < sw.plan.tauC && sw.tau >= sw.plan.tauC) {
        const pose = sw.pose();
        const p = sw.plan;
        const th = sw.theta;
        const ep = sw.eps;
        const un = { x: p.pivot.x + p.rh * Math.cos(ep) * Math.sin(th), y: p.pivot.y + p.rh * Math.sin(ep), z: p.pivot.z + p.rh * Math.cos(ep) * Math.cos(th) };
        contacts++;
        if (d3(un, pose.knob) < 0.02) free++;
      }
      prev = sw.tau;
    });
    expect(contacts).toBeGreaterThan(20);
    expect(free / contacts).toBeGreaterThan(0.55);
  });

  it('at contact the lead wrist is in the region the assets\' swing analysis found feasible (height >= 1.05 m, >= 0.30 m toward the pitcher) for pitches at or above 0.75 m', () => {
    const rows: { by: number; fy: number; lat: number }[] = [];
    let prev = 0;
    swingTicks('body-5', 140, (w) => {
      const sw = w.swing!;
      if (prev < sw.plan.tauC && sw.tau >= sw.plan.tauC) {
        const p = sw.pose();
        rows.push({ by: w.ball.body.y, fy: p.knob.y + HAND_FRONT * p.dir.y, lat: p.knob.z + HAND_FRONT * p.dir.z - SHOULDER_Z });
      }
      prev = sw.tau;
    });
    const hi = rows.filter((r) => r.by >= 0.75);
    expect(hi.length).toBeGreaterThan(15);
    const med = [...hi].map((r) => r.fy).sort((a, b) => a - b)[Math.floor(hi.length / 2)];
    expect(med).toBeGreaterThanOrEqual(1.04);
    expect(hi.filter((r) => r.lat >= 0.3).length / hi.length).toBeGreaterThan(0.9);
    // (lower pitches: he has to get the hands down to them; the engine's hand IK should ease off there)
  });
});
