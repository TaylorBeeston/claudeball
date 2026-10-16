/**
 * The players' 22-bone rig (Mixamo names, no twist or finger bones) as plain arrays: forward kinematics from local rotations, and each bone's
 * ANATOMICAL frame. Everything is in rig space: inside the character's model node, with the left-hander mirror (`scale.x = -1`) and the height
 * scale divided out, so a mirrored player measures exactly like a right-handed one (see `Rig` in gltfCharacter.ts).
 *
 * Anatomical frame of a bone = its rig-space world rotation times the inverse of its rest (bind) rotation. In the rest pose every anatomical
 * frame is the identity, i.e. the body axes: +Z forward (chest, toes), +Y up, +X the model's left. A joint's angles are then the rotation
 * between two anatomical frames, independent of how the rig's bones happen to be rolled.
 */
import { qmul, qrel, qrot } from './qmath';

export const BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
] as const;
export type BoneName = (typeof BONES)[number];
export const NB = BONES.length;
export const B = Object.fromEntries(BONES.map((n, i) => [n, i])) as Record<BoneName, number>;
export const PARENT: number[] = [
  -1, B.Hips, B.Spine, B.Spine1, B.Spine2, B.Neck,
  B.Spine2, B.LeftShoulder, B.LeftArm, B.LeftForeArm,
  B.Spine2, B.RightShoulder, B.RightArm, B.RightForeArm,
  B.Hips, B.LeftUpLeg, B.LeftLeg, B.LeftFoot,
  B.Hips, B.RightUpLeg, B.RightLeg, B.RightFoot,
];

/** A pose: local rotations / translations of the 22 bones and the Hips' parent (the Armature node) in rig space. */
export interface PoseLocals {
  /** NB x (x, y, z, w) local rotations */
  lq: Float64Array;
  /** NB x (x, y, z) local translations (model units) */
  lp: Float64Array;
  /** the Hips' parent in rig space: rotation (4), position (3), uniform scale (1) */
  base: Float64Array;
}

export interface PoseWorld {
  /** rig-space world rotations and positions */
  wq: Float64Array;
  wp: Float64Array;
  /** anatomical frames: wq * inverse(rest wq) */
  aq: Float64Array;
}

export const newLocals = (): PoseLocals => ({ lq: new Float64Array(NB * 4), lp: new Float64Array(NB * 3), base: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1]) });
export const newWorld = (): PoseWorld => ({ wq: new Float64Array(NB * 4), wp: new Float64Array(NB * 3), aq: new Float64Array(NB * 4) });

export function copyLocals(src: PoseLocals, dst: PoseLocals = newLocals()): PoseLocals {
  dst.lq.set(src.lq);
  dst.lp.set(src.lp);
  dst.base.set(src.base);
  return dst;
}

const tq = [0, 0, 0, 1], tv = [0, 0, 0];

/** Forward kinematics: rig-space world rotations and positions (and anatomical frames when `rest` is given). */
export function fk(L: PoseLocals, out: PoseWorld = newWorld(), rest?: PoseWorld): PoseWorld {
  const { lq, lp, base } = L;
  const s = base[7];
  for (let i = 0; i < NB; i++) {
    const p = PARENT[i];
    if (p < 0) {
      qmul(base, lq, out.wq, 0, i * 4, i * 4);
      qrot(base, lp[i * 3], lp[i * 3 + 1], lp[i * 3 + 2], tv);
      out.wp[i * 3] = base[4] + s * tv[0];
      out.wp[i * 3 + 1] = base[5] + s * tv[1];
      out.wp[i * 3 + 2] = base[6] + s * tv[2];
    } else {
      qmul(out.wq, lq, out.wq, p * 4, i * 4, i * 4);
      qrot(out.wq, lp[i * 3], lp[i * 3 + 1], lp[i * 3 + 2], tv, p * 4);
      out.wp[i * 3] = out.wp[p * 3] + s * tv[0];
      out.wp[i * 3 + 1] = out.wp[p * 3 + 1] + s * tv[1];
      out.wp[i * 3 + 2] = out.wp[p * 3 + 2] + s * tv[2];
    }
  }
  if (rest) anatomical(out, rest);
  return out;
}

/** fill `w.aq` = wq * inverse(rest.wq) */
export function anatomical(w: PoseWorld, rest: PoseWorld) {
  for (let i = 0; i < NB; i++) {
    const o = i * 4;
    // a * inverse(r)
    const ax = w.wq[o], ay = w.wq[o + 1], az = w.wq[o + 2], aw = w.wq[o + 3];
    const bx = -rest.wq[o], by = -rest.wq[o + 1], bz = -rest.wq[o + 2], bw = rest.wq[o + 3];
    w.aq[o] = aw * bx + ax * bw + ay * bz - az * by;
    w.aq[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
    w.aq[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
    w.aq[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
  }
}

/** rotation of bone `c`'s anatomical frame relative to bone `p`'s (identity in the rest pose) */
export function jointRot(w: PoseWorld, p: number, c: number, out: number[] = [0, 0, 0, 1]): number[] {
  qrel(w.aq, w.aq, tq, p * 4, c * 4);
  out[0] = tq[0];
  out[1] = tq[1];
  out[2] = tq[2];
  out[3] = tq[3];
  return out;
}

/** unit direction a -> b (rig space) */
export function segDir(w: PoseWorld, a: number, b: number, out: number[] = [0, 0, 0]): number[] {
  const x = w.wp[b * 3] - w.wp[a * 3], y = w.wp[b * 3 + 1] - w.wp[a * 3 + 1], z = w.wp[b * 3 + 2] - w.wp[a * 3 + 2];
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

export const segLen = (w: PoseWorld, a: number, b: number) => Math.hypot(w.wp[b * 3] - w.wp[a * 3], w.wp[b * 3 + 1] - w.wp[a * 3 + 1], w.wp[b * 3 + 2] - w.wp[a * 3 + 2]);

/** a rig-space point given in bone i's local frame (model units, scaled by the base scale) */
export function localPoint(w: PoseWorld, i: number, x: number, y: number, z: number, s: number, out: number[] = [0, 0, 0]): number[] {
  qrot(w.wq, x, y, z, out, i * 4);
  out[0] = w.wp[i * 3] + s * out[0];
  out[1] = w.wp[i * 3 + 1] + s * out[1];
  out[2] = w.wp[i * 3 + 2] + s * out[2];
  return out;
}
