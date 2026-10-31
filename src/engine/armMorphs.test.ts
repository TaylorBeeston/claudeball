import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { fadeArmDelta, fixArmMorphs } from './armMorphs';

describe('arm build morphs', () => {
  it('keeps a delta at the elbow, drops its share along the arm toward the wrist, and all of it at and past the wrist', () => {
    const ax = [1, 0, 0];
    expect(fadeArmDelta([0.02, 0.01, 0], 0, ax)).toEqual([0.02, 0.01, 0]);
    const mid = fadeArmDelta([0.02, 0.01, 0], 0.5, ax);
    expect(mid[0]).toBeCloseTo(0.01, 6);
    expect(mid[1]).toBeCloseTo(0.01, 6);
    const near = fadeArmDelta([0.02, 0.01, 0], 0.9, ax);
    expect(Math.abs(near[0])).toBeLessThan(0.001);
    expect(near[1]).toBeGreaterThan(0.004);
    expect(near[1]).toBeLessThan(0.01);
    expect(fadeArmDelta([0.02, 0.01, 0.003], 1, ax).every((v) => Math.abs(v) < 1e-12)).toBe(true);
    expect(fadeArmDelta([0.02, 0.01, 0.003], 1.3, ax).every((v) => Math.abs(v) < 1e-12)).toBe(true);
  });

  it('patches a skinned mesh: forearm vertices of build morphs only, once', () => {
    // a straight arm along +X: shoulder 0, elbow 0.3, wrist 0.6 (the bones' bind positions)
    const sh = new Bone(), el = new Bone(), wr = new Bone();
    sh.name = 'mixamorig:LeftArm';
    el.name = 'mixamorig:LeftForeArm';
    wr.name = 'mixamorig:LeftHand';
    sh.add(el);
    el.add(wr);
    el.position.x = 0.3;
    wr.position.x = 0.3;
    sh.updateMatrixWorld(true);
    const g = new BufferGeometry();
    // an upper-arm vertex, a mid-forearm one, one at the wrist, one in the hand
    g.setAttribute('position', new Float32BufferAttribute([0.15, 0, 0, 0.45, 0, 0, 0.6, 0, 0, 0.65, 0, 0], 3));
    g.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0, 2, 0, 0, 0], 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0], 4));
    const d = [0.02, 0.01, 0, 0.02, 0.01, 0, 0.02, 0.01, 0, 0.05, 0.01, 0];
    g.morphAttributes.position = [new Float32BufferAttribute(d, 3), new Float32BufferAttribute(d, 3)];
    g.morphTargetsRelative = true;
    const m = new SkinnedMesh(g, new MeshBasicMaterial());
    m.add(sh);
    m.bind(new Skeleton([sh, el, wr]));
    m.morphTargetDictionary = { build_heavy: 0, cheeks_full: 1 };
    m.updateMorphTargets = () => {};
    expect(fixArmMorphs(m)).toBeGreaterThan(0);
    const heavy = g.morphAttributes.position[0], face = g.morphAttributes.position[1];
    // upper arm untouched; mid-forearm: half its shift along the arm; wrist and hand: none
    expect(heavy.getX(0)).toBeCloseTo(0.02, 6);
    expect(heavy.getX(1)).toBeCloseTo(0.01, 6);
    expect(heavy.getY(1)).toBeCloseTo(0.01, 6);
    expect(Math.abs(heavy.getX(2)) + Math.abs(heavy.getY(2))).toBeLessThan(1e-9);
    expect(Math.abs(heavy.getX(3)) + Math.abs(heavy.getY(3))).toBeLessThan(1e-9);
    // other morphs untouched, and a second pass changes nothing
    expect(face.getX(2)).toBeCloseTo(0.02, 6);
    expect(fixArmMorphs(m)).toBe(0);
  });
});
