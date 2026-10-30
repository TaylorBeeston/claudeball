/**
 * The hands meet the forearms at the wrist on every body build.
 *
 * The build morphs (build_lean / stocky / muscular / heavy) of the body skin and the sleeves move the forearm's skin ALONG the arm, more toward
 * the hand (measured on player_base, build at 1: heavy +8 mm at the elbow, +18 mm a hand's width before the wrist, +37 mm at it and up to 11 cm
 * on the body's own hand stub that the hand mesh covers; stocky about two thirds of that; lean -5 to -34 mm), but the bones do not move and the
 * hands are separate meshes without build morphs (Hand_*, gloves, batting gloves). So on every heavier player the forearm's skin ran on into
 * the hand (shards and a stretched second hand out of the wrist, through the batting gloves) and on a lean one it pulled back from it.
 *
 * At load, each build morph's delta on a forearm vertex is faded so the skin meets the hand as it does on the base body: the shift along the
 * forearm fades out from the elbow to the wrist (the forearm keeps its girth), the whole delta over the last few centimetres before the wrist
 * joint (the hand's cuff does not grow), nothing past it. Pure maths below, the three.js side in `fixArmMorphs`.
 */
import { Matrix4, Vector3, type BufferAttribute, type InterleavedBufferAttribute, type Object3D, type SkinnedMesh } from 'three';

export const ARM_MORPH = {
  /** the morphs faded (body builds; the face and finger morphs are left alone) */
  match: /^build_/,
  /** share of the forearm (elbow 0, wrist 1) where the whole delta starts fading, and where it is gone */
  fadeFrom: 0.8,
  fadeTo: 1,
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One morph delta `d` of a vertex at `t` along the forearm (0 at the elbow joint, 1 at the wrist joint; `axis` the unit elbow -> wrist
 * direction in the same space): the delta with its share along the axis faded out toward the wrist and the whole of it faded out at the wrist.
 */
export function fadeArmDelta(d: number[], t: number, axis: number[], out: number[] = [0, 0, 0]): number[] {
  const keepAxial = 1 - smooth(0, 1, t);
  const keep = 1 - smooth(ARM_MORPH.fadeFrom, ARM_MORPH.fadeTo, t);
  const a = (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) * (1 - keepAxial);
  out[0] = (d[0] - a * axis[0]) * keep;
  out[1] = (d[1] - a * axis[1]) * keep;
  out[2] = (d[2] - a * axis[2]) * keep;
  return out;
}

const done = new WeakSet<object>();
const bareName = (n: string) => n.replace(/^mixamorig:?/, '');

/**
 * Fade the build morphs of every skinned mesh under `root` on the forearms (in place; geometry shared by clones and the LOD copies is patched
 * once). Returns the number of vertex deltas changed.
 */
export function fixArmMorphs(root: Object3D): number {
  let changed = 0;
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh || !m.morphTargetDictionary) return;
    const g = m.geometry;
    const targets = g.morphAttributes.position;
    if (!targets?.length || !g.morphTargetsRelative) return;
    const which = Object.entries(m.morphTargetDictionary).filter(([k]) => ARM_MORPH.match.test(k)).map(([, i]) => targets[i]).filter((a) => a && !done.has(a));
    if (!which.length) return;
    const pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw) return;
    const bones = m.skeleton.bones;
    // each side's elbow and wrist joints in the mesh's own (bind) space
    const sides: { fore: number; hand: number; E: Vector3; axis: number[]; len: number }[] = [];
    for (const s of ['Left', 'Right']) {
      const fore = bones.findIndex((b) => bareName(b.name) === `${s}ForeArm`), hand = bones.findIndex((b) => bareName(b.name) === `${s}Hand`);
      if (fore < 0 || hand < 0) continue;
      const at = (i: number) => new Vector3().applyMatrix4(new Matrix4().copy(m.skeleton.boneInverses[i]).invert()).applyMatrix4(m.bindMatrixInverse);
      const E = at(fore), W = at(hand);
      const ax = W.clone().sub(E);
      const len = ax.length();
      if (len < 1e-6) continue;
      ax.divideScalar(len);
      sides.push({ fore, hand, E, axis: [ax.x, ax.y, ax.z], len });
    }
    if (!sides.length) return;
    const d = [0, 0, 0], r = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      // the side this vertex hangs on (its weight on that forearm and hand)
      let best: (typeof sides)[number] | null = null, bw = 0.01;
      for (const s of sides) {
        let wsum = 0;
        for (let k = 0; k < 4; k++) {
          const j = si.getComponent(i, k);
          if (j === s.fore || j === s.hand) wsum += sw.getComponent(i, k);
        }
        if (wsum > bw) {
          bw = wsum;
          best = s;
        }
      }
      if (!best) continue;
      const t = ((pos.getX(i) - best.E.x) * best.axis[0] + (pos.getY(i) - best.E.y) * best.axis[1] + (pos.getZ(i) - best.E.z) * best.axis[2]) / best.len;
      if (t <= 0) continue;
      for (const a of which) {
        d[0] = a.getX(i);
        d[1] = a.getY(i);
        d[2] = a.getZ(i);
        if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;
        fadeArmDelta(d, t, best.axis, r);
        (a as BufferAttribute | InterleavedBufferAttribute).setXYZ(i, r[0], r[1], r[2]);
        changed++;
      }
    }
    for (const a of which) {
      done.add(a);
      a.needsUpdate = true;
    }
  });
  return changed;
}
