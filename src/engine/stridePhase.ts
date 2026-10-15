/**
 * Feet on the sim's footsteps. The sim models each player's stride (src/sim/stride.ts): which foot lands next and how far through
 * the step he is, and it counts a base as touched only when a footstrike lands on the bag. Here the locomotion clips are laid on
 * that stride, so the foot drawn coming down is the footstrike the sim counted: each clip's touchdown times are measured once
 * from the clip (like `stanceFootSpeed`), and the clip time is put between the last touchdown and the next one by the sim's phase.
 *
 * Also: the slide / dive clips carry forward root motion (the hips travel ~1.6 m) while the sim already moves the sliding body, so
 * that forward travel is taken out of them here and the hips stay on the sim's position.
 *
 * Interim: phase B2 of the realism plan (stride warping, foot locking) supersedes the phase lock.
 */
import { AnimationClip, AnimationMixer, Object3D, Vector3, VectorKeyframeTrack } from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface Touchdowns {
  /** clip seconds at which the left / right foot comes down */
  L: number;
  R: number;
  duration: number;
}

const cache = new WeakMap<AnimationClip, Touchdowns | null>();

/** The clip's two touchdowns: a foot's sole (the lower of ankle and toe) dropping to the ground after being in the air. */
export function touchdowns(scene: Object3D, clip: AnimationClip): Touchdowns | null {
  if (cache.has(clip)) return cache.get(clip)!;
  let out: Touchdowns | null = null;
  try {
    const s = SkeletonUtils.clone(scene);
    const find = (re: RegExp) => {
      let o: Object3D | null = null;
      s.traverse((x) => {
        if (!o && re.test(x.name)) o = x;
      });
      return o as Object3D | null;
    };
    const parts = { LF: find(/LeftFoot$/), RF: find(/RightFoot$/), LT: find(/LeftToeBase$/), RT: find(/RightToeBase$/) };
    if (parts.LF && parts.RF) {
      const mixer = new AnimationMixer(s);
      const act = mixer.clipAction(clip);
      act.play();
      const N = 96;
      const h: number[][] = [[], []];
      const v = new Vector3();
      const y = (o: Object3D | null) => (o ? v.setFromMatrixPosition(o.matrixWorld).y : Infinity);
      for (let i = 0; i < N; i++) {
        act.time = (i / N) * clip.duration;
        mixer.update(0);
        s.updateMatrixWorld(true);
        h[0].push(Math.min(y(parts.LF), y(parts.LT)));
        h[1].push(Math.min(y(parts.RF), y(parts.RT)));
      }
      const ground = Math.min(...h[0], ...h[1]);
      const td = [-1, -1];
      for (let k = 0; k < 2; k++) {
        for (let i = 0; i < N; i++) {
          const prev = h[k][(i - 1 + N) % N] - ground, cur = h[k][i] - ground;
          if (cur < 0.03 && prev >= 0.03) {
            td[k] = (i / N) * clip.duration;
            break;
          }
        }
      }
      if (td[0] >= 0 && td[1] >= 0) out = { L: td[0], R: td[1], duration: clip.duration };
      mixer.stopAllAction();
      mixer.uncacheClip(clip);
    }
  } catch {
    out = null;
  }
  cache.set(clip, out);
  return out;
}

/**
 * The clip time for the sim's stride: `next` is the foot (0 left, 1 right, as the sim counts it on the player) that lands at phase 1,
 * the other one landed at phase 0. A mirrored (left-handed) model shows the clip's right foot as its left.
 */
export function strideClipTime(td: Touchdowns, next: 0 | 1, phase: number, mirrored: boolean): number {
  const clipNext = mirrored ? 1 - next : next;
  const tNext = clipNext === 0 ? td.L : td.R;
  const tPrev = clipNext === 0 ? td.R : td.L;
  let span = tNext - tPrev;
  if (span <= 0) span += td.duration;
  const t = tPrev + Math.min(1, Math.max(0, phase)) * span;
  return t % td.duration;
}

/** Clips whose forward travel the sim already moves the body through. */
export const SIM_DRIVEN_TRAVEL = /^(slide_feet|slide_head|slide_hook_left|slide_hook_right|dive_back)$/;

const stripped = new WeakSet<AnimationClip>();

/**
 * Take the root's travel along the ground (x, z: forward and sideways) out of a clip, keeping its height: the hips stay over the
 * sim's position, the limbs keep their reach from the hips. Done once per (shared) clip.
 */
export function stripGroundTravel(clip: AnimationClip): void {
  if (stripped.has(clip)) return;
  stripped.add(clip);
  for (const tr of clip.tracks) {
    if (!(tr instanceof VectorKeyframeTrack) || !/Hips\.position$/.test(tr.name)) continue;
    const v = tr.values;
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
}
