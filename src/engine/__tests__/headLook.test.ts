import { describe, expect, it } from 'vitest';
import { Bone, Group, Quaternion, Vector3 } from 'three';
import { HeadLook, LOOK_LIMITS, lookTarget, maxLookStep, type LookTarget } from '../headLook';
import { Rig } from '../gltfCharacter';

const deg = (r: number) => (r * 180) / Math.PI;

describe('lookTarget', () => {
  it('ignores targets that are too close, behind, or non-finite', () => {
    expect(lookTarget(0.2, 0, 0.3).valid).toBe(false);
    expect(lookTarget(0, 0, -10).valid).toBe(false);
    expect(lookTarget(NaN, 0, 5).valid).toBe(false);
    expect(lookTarget(5, 0, 5).valid).toBe(true);
  });
  it('clamps the offset to human limits', () => {
    const t = lookTarget(100, -100, 100.0);
    expect(deg(Math.abs(t.yaw))).toBeLessThanOrEqual(LOOK_LIMITS.yaw * 57.3 + LOOK_LIMITS.spineYaw * 57.3 + 1e-6);
    expect(deg(Math.abs(t.pitch))).toBeLessThanOrEqual(35 + 1e-6);
  });
  it('only adds the difference from where the clip already points the head', () => {
    // clip already has the head turned 90 deg left and the target is 80 deg left
    const t = lookTarget(Math.sin(1.4) * 10, 0, Math.cos(1.4) * 10, Math.PI / 2, 0);
    expect(deg(t.yaw)).toBeCloseTo(deg(1.4 - Math.PI / 2), 3);
  });
});

describe('HeadLook spring', () => {
  it('never moves faster than the speed cap, even when the target spikes every frame', () => {
    const hl = new HeadLook();
    const t: LookTarget = { yaw: 0, pitch: 0, valid: true };
    const dt = 1 / 60;
    for (let i = 0; i < 2000; i++) {
      // ball position spiking between extremes
      lookTarget(Math.random() * 400 - 200, Math.random() * 60 - 10, Math.random() * 400 - 200, 0, 0, t);
      hl.step(t, dt);
      expect(hl.lastStep).toBeLessThanOrEqual(maxLookStep(dt));
      expect(Math.abs(hl.yaw)).toBeLessThanOrEqual(LOOK_LIMITS.yaw + LOOK_LIMITS.spineYaw + 1e-9);
      expect(Math.abs(hl.pitch)).toBeLessThanOrEqual(LOOK_LIMITS.pitch + 1e-9);
    }
  });
  it('holds the speed cap under slow motion, stutters and long frames', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 20, 0.1, 5]) {
      const hl = new HeadLook();
      const t: LookTarget = { yaw: 1.5, pitch: 0.6, valid: true };
      for (let i = 0; i < 50; i++) {
        hl.step(t, dt);
        expect(hl.lastStep).toBeLessThanOrEqual(maxLookStep(Math.min(dt, 0.1)) + 1e-9);
      }
    }
  });
  it('settles on the target and returns to the clip pose when the target is dropped', () => {
    const hl = new HeadLook();
    const t: LookTarget = { yaw: 0.8, pitch: -0.2, valid: true };
    for (let i = 0; i < 240; i++) hl.step(t, 1 / 60);
    expect(hl.yaw).toBeCloseTo(0.8, 2);
    expect(hl.pitch).toBeCloseTo(-0.2, 2);
    for (let i = 0; i < 240; i++) hl.step(null, 1 / 60);
    expect(Math.abs(hl.yaw)).toBeLessThan(1e-2);
    expect(Math.abs(hl.pitch)).toBeLessThan(1e-2);
  });
  it('splits the yaw so neck + head never exceed 70 deg and the spine 20 deg', () => {
    const hl = new HeadLook();
    hl.yaw = LOOK_LIMITS.yaw + LOOK_LIMITS.spineYaw;
    const { spine, neckHeadYaw } = hl.split();
    expect(deg(spine)).toBeLessThanOrEqual(20 + 1e-6);
    expect(deg(neckHeadYaw)).toBeLessThanOrEqual(70 + 1e-6);
    expect(spine + neckHeadYaw).toBeGreaterThan(hl.yaw * 0.95);
  });
});

describe('Rig (mirror-safe bone math)', () => {
  // a 2-bone chain hanging under a model node that is mirrored the way left-handed players are
  const build = (mirrored: boolean) => {
    const model = new Group();
    model.scale.x = mirrored ? -1 : 1;
    const a = new Bone(), b = new Bone(), c = new Bone();
    model.add(a);
    a.add(b);
    b.add(c);
    b.position.set(0, -1, 0);
    c.position.set(0, -1, 0);
    a.position.set(0.3, 1.5, 0);
    a.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.4);
    model.updateMatrixWorld(true);
    return { model, a, b, c };
  };
  for (const mirrored of [false, true]) {
    it(`aims a bone at a target (mirrored=${mirrored})`, () => {
      const { model, a, b } = build(mirrored);
      const rig = new Rig(model);
      rig.refresh();
      const target = new Vector3(2, 1.2, 1);
      rig.aim(a, b, target);
      model.updateMatrixWorld(true);
      rig.refresh();
      const pa = rig.pos(a, new Vector3()), pb = rig.pos(b, new Vector3());
      const dir = pb.sub(pa).normalize();
      const want = target.clone().sub(pa).normalize();
      expect(dir.dot(want)).toBeGreaterThan(0.9999);
    });
    it(`is idempotent: aiming twice moves nothing (mirrored=${mirrored})`, () => {
      const { model, a, b } = build(mirrored);
      const rig = new Rig(model);
      rig.refresh();
      const target = new Vector3(-1, 0.4, 2);
      rig.aim(a, b, target);
      const q1 = a.quaternion.clone();
      rig.aim(a, b, target);
      expect(a.quaternion.angleTo(q1)).toBeLessThan(1e-6);
    });
  }
  it('quat() is the same rotation for mirrored and unmirrored models', () => {
    const u = build(false), m = build(true);
    const ru = new Rig(u.model), rm = new Rig(m.model);
    ru.refresh();
    rm.refresh();
    const qu = ru.quat(u.b, new Quaternion()), qm = rm.quat(m.b, new Quaternion());
    expect(qu.angleTo(qm)).toBeLessThan(1e-6);
  });
});
