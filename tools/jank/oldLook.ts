/**
 * The look-at as it was before t-0028 (gltfCharacter.ts lookAt up to 65ddd5f), as a pose pass for A/B sweeps only (JANK_OLD_LOOK=1): yaw / pitch
 * measured and applied in the upper spine's own frame. In a ready crouch that frame leans 40-70 deg forward, so the turn rolled the head onto a
 * shoulder. Not used by the game.
 */
import { qinv, qmul, qrot, qaxisAngle, type V } from '../../src/engine/pose/qmath';
import { B, PARENT, type PoseLocals, type PoseWorld, fk, newWorld } from '../../src/engine/pose/skeleton';
import type { RestInfo } from '../../src/engine/pose/limits';

const W = newWorld();
const sl = (a: Float64Array, i: number, n: number) => Array.from(a.subarray(i * n, i * n + n));
function setRig(L: PoseLocals, w: PoseWorld, R: RestInfo, i: number, q: number[]) {
  const p = PARENT[i];
  L.lq.set(qmul(qinv(sl(w.wq, p, 4)), q), i * 4);
  fk(L, w, R.rest);
}

export function oldLookInput(L: PoseLocals, R: RestInfo, target: V) {
  const w = fk(L, W, R.rest);
  const sInv = qinv(sl(w.wq, B.Spine2, 4));
  const h = B.Head * 3;
  const d = qrot(sInv, target[0] - w.wp[h], target[1] - w.wp[h + 1], target[2] - w.wp[h + 2]);
  const c = qrot(qmul(sInv, sl(w.wq, B.Head, 4)), 0, 0, 1);
  return { dx: d[0], dy: d[1], dz: d[2], clipYaw: Math.atan2(c[0], c[2]), clipPitch: Math.atan2(-c[1], Math.hypot(c[0], c[2])), chest: 0 };
}

export function oldApplyLook(L: PoseLocals, R: RestInfo, neckHeadYaw: number, pitch: number, spineYaw: number) {
  const w = fk(L, W, R.rest);
  const apply = (i: number, yaw: number, p: number) => {
    const S = sl(w.wq, B.Spine2, 4);
    const d = qmul(qmul(S, qmul(qaxisAngle(0, 1, 0, yaw), qaxisAngle(1, 0, 0, p))), qinv(S));
    setRig(L, w, R, i, qmul(d, sl(w.wq, i, 4)) as number[]);
  };
  if (Math.abs(spineYaw) > 1e-4) apply(B.Spine2, spineYaw, 0);
  apply(B.Neck, neckHeadYaw * 0.4, pitch * 0.4);
  apply(B.Head, neckHeadYaw * 0.6, pitch * 0.6);
}
