/**
 * Node-side access to a player GLB's rig and clips (glTF-Transform, meshopt decoded): the rest pose of the 22 bones, the Armature transform,
 * the attachment empties (Bat_Grip, Ball_Grip, Glove_Pocket, ...) and every clip sampled the way three's AnimationMixer samples it
 * (linear / slerp between keys, step, the first and last key held), so the static and crossfade sweeps need no browser.
 */
import { NodeIO, type Node as GNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { BONES, B, NB, type PoseLocals, newLocals } from '../../src/engine/pose/skeleton';

export interface Track {
  bone: number;
  path: 'rotation' | 'translation';
  times: Float32Array;
  values: Float32Array;
  step: boolean;
}
export interface Clip {
  name: string;
  duration: number;
  tracks: Track[];
}
export interface Attach {
  bone: number;
  /** local transform relative to the bone: rotation (x, y, z, w), translation */
  q: number[];
  t: number[];
}
export interface RigFile {
  file: string;
  rest: PoseLocals;
  clips: Map<string, Clip>;
  attach: Map<string, Attach>;
}

const boneIndex = (name: string) => {
  if (!name.startsWith('mixamorig')) return -1;
  const n = name.replace('mixamorig', '').replace(':', '');
  return (BONES as readonly string[]).indexOf(n);
};

let io: NodeIO | null = null;
export async function loadRig(file: string): Promise<RigFile> {
  if (!io) {
    await MeshoptDecoder.ready;
    io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  }
  const doc = await io.read(file);
  const root = doc.getRoot();
  const rest = newLocals();
  const byNode = new Map<GNode, number>();
  let hips: GNode | null = null;
  for (const n of root.listNodes()) {
    const i = boneIndex(n.getName());
    if (i < 0) continue;
    byNode.set(n, i);
    rest.lq.set(n.getRotation(), i * 4);
    rest.lp.set(n.getTranslation(), i * 3);
    if (i === B.Hips) hips = n;
  }
  if (byNode.size !== NB || !hips) throw new Error(`${file}: found ${byNode.size} of ${NB} rig bones`);
  // the Hips' parent chain (Armature, possibly scaled for the ball kid) up to the scene: its rig-space transform
  const parentOf = (n: GNode) => n.listParents().find((p) => p.propertyType === 'Node') as GNode | undefined;
  let pq = [0, 0, 0, 1], pp = [0, 0, 0], ps = 1;
  for (let p = parentOf(hips); p; p = parentOf(p)) {
    // base = p * base (p is the outer transform)
    const r = p.getRotation(), t = p.getTranslation(), s = p.getScale()[0];
    const [x, y, z, w] = r;
    const rot = (v: number[]) => {
      const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
      return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
    };
    const np = rot(pp.map((c) => c * s));
    pp = [np[0] + t[0], np[1] + t[1], np[2] + t[2]];
    pq = [w * pq[0] + x * pq[3] + y * pq[2] - z * pq[1], w * pq[1] - x * pq[2] + y * pq[3] + z * pq[0], w * pq[2] + x * pq[1] - y * pq[0] + z * pq[3], w * pq[3] - x * pq[0] - y * pq[1] - z * pq[2]];
    ps *= s;
  }
  rest.base.set([...pq, ...pp, ps]);
  const attach = new Map<string, Attach>();
  for (const n of root.listNodes()) {
    const p = parentOf(n);
    const bi = p ? byNode.get(p) : undefined;
    if (bi === undefined || byNode.has(n)) continue;
    attach.set(n.getName(), { bone: bi, q: n.getRotation().slice(), t: n.getTranslation().slice() });
  }
  const clips = new Map<string, Clip>();
  for (const a of root.listAnimations()) {
    const tracks: Track[] = [];
    let dur = 0;
    for (const ch of a.listChannels()) {
      const n = ch.getTargetNode();
      const bi = n ? byNode.get(n) : undefined;
      const path = ch.getTargetPath();
      if (bi === undefined || (path !== 'rotation' && path !== 'translation')) continue;
      const s = ch.getSampler()!;
      const times = new Float32Array(s.getInput()!.getArray()!);
      const acc = s.getOutput()!;
      // normalised integer outputs (KHR_mesh_quantization / meshopt filters) come back as floats from getElement
      const comps = path === 'rotation' ? 4 : 3;
      const values = new Float32Array(acc.getCount() * comps);
      const el: number[] = [];
      for (let i = 0; i < acc.getCount(); i++) values.set(acc.getElement(i, el), i * comps);
      if (s.getInterpolation() === 'CUBICSPLINE') throw new Error(`${a.getName()}: cubic spline tracks are not supported`);
      tracks.push({ bone: bi, path, times, values, step: s.getInterpolation() === 'STEP' });
      dur = Math.max(dur, times[times.length - 1]);
    }
    clips.set(a.getName(), { name: a.getName(), duration: dur, tracks });
  }
  return { file, rest, clips, attach };
}

/** slerp between two keys into out (shortest path, like three's Quaternion.slerpFlat) */
function slerpInto(v: Float32Array, i0: number, i1: number, t: number, out: Float64Array, o: number) {
  let x1 = v[i1], y1 = v[i1 + 1], z1 = v[i1 + 2], w1 = v[i1 + 3];
  const x0 = v[i0], y0 = v[i0 + 1], z0 = v[i0 + 2], w0 = v[i0 + 3];
  slerpRaw(x0, y0, z0, w0, x1, y1, z1, w1, t, out, o);
}

export function slerpRaw(x0: number, y0: number, z0: number, w0: number, x1: number, y1: number, z1: number, w1: number, t: number, out: Float64Array | number[], o: number) {
  let s = 1 - t;
  const cos = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1, dir = cos >= 0 ? 1 : -1, sqrSin = 1 - cos * cos;
  if (sqrSin > Number.EPSILON) {
    const sin = Math.sqrt(sqrSin), len = Math.atan2(sin, cos * dir);
    s = Math.sin(s * len) / sin;
    t = Math.sin(t * len) / sin;
  }
  const tDir = t * dir;
  let x = x0 * s + x1 * tDir, y = y0 * s + y1 * tDir, z = z0 * s + z1 * tDir, w = w0 * s + w1 * tDir;
  if (s === 1 - t) {
    const f = 1 / Math.hypot(x, y, z, w);
    x *= f;
    y *= f;
    z *= f;
    w *= f;
  }
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
}

/** Pose of `clip` at time t (clamped to the clip): bones the clip does not animate keep `base`'s values. */
export function sampleClip(clip: Clip, t: number, base: PoseLocals, out: PoseLocals = newLocals()): PoseLocals {
  out.lq.set(base.lq);
  out.lp.set(base.lp);
  out.base.set(base.base);
  for (const tr of clip.tracks) {
    const { times, values } = tr;
    const c = tr.path === 'rotation' ? 4 : 3;
    const dst = tr.path === 'rotation' ? out.lq : out.lp;
    const o = tr.bone * c;
    const n = times.length;
    if (t <= times[0] || n === 1) {
      for (let k = 0; k < c; k++) dst[o + k] = values[k];
      continue;
    }
    if (t >= times[n - 1]) {
      for (let k = 0; k < c; k++) dst[o + k] = values[(n - 1) * c + k];
      continue;
    }
    // binary search for the key interval
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (times[m] <= t) lo = m;
      else hi = m;
    }
    if (tr.step) {
      for (let k = 0; k < c; k++) dst[o + k] = values[lo * c + k];
      continue;
    }
    const a = (t - times[lo]) / (times[hi] - times[lo]);
    if (c === 4) slerpInto(values, lo * 4, hi * 4, a, dst as Float64Array, o);
    else for (let k = 0; k < 3; k++) dst[o + k] = values[lo * 3 + k] + (values[hi * 3 + k] - values[lo * 3 + k]) * a;
  }
  return out;
}

/** three's mixer blend of two poses (crossfade): from-weight 1 - w, to-weight w; rotations slerp (shortest), translations lerp */
export function blendLocals(a: PoseLocals, b: PoseLocals, w: number, out: PoseLocals = newLocals()): PoseLocals {
  for (let i = 0; i < NB; i++) {
    const o = i * 4;
    slerpRaw(a.lq[o], a.lq[o + 1], a.lq[o + 2], a.lq[o + 3], b.lq[o], b.lq[o + 1], b.lq[o + 2], b.lq[o + 3], w, out.lq, o);
    for (let k = 0; k < 3; k++) out.lp[i * 3 + k] = a.lp[i * 3 + k] + (b.lp[i * 3 + k] - a.lp[i * 3 + k]) * w;
  }
  out.base.set(a.base);
  return out;
}
