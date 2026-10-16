/**
 * Where the feet and hands are in the shipped player clips: reads `player_base.glb`, samples a clip's skeleton by forward
 * kinematics (no three.js, no textures) and prints the model-space positions of the feet, toes, hands and hips.
 *
 *   npx tsx tools/contact/clipfeet.ts [clip ...]          (default: the locomotion and slide clips)
 *   npx tsx tools/contact/clipfeet.ts --json              machine-readable touchdowns
 *
 * Model space: +Z forward (the way the player faces), +X his LEFT, +Y up, origin on the ground under the root.
 * For a locomotion clip it lists each footstrike: the time, and the foot's forward / sideways offset from the root (the hips'
 * ground point) at touchdown. For any other clip it prints a 12-row table over its duration.
 */
import { NodeIO, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

type V3 = [number, number, number];
type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q: Q, v: V3): V3 => {
  const u: V3 = [q[0], q[1], q[2]], s = q[3];
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const c: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return [0, 1, 2].map((k) => 2 * dot * u[k] + (s * s - uu) * v[k] + 2 * s * c[k]) as V3;
};
const slerp = (a: Q, b: Q, t: number): Q => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? (b.map((x) => -x) as Q) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r = a.map((x, k) => x + (bb[k] - x) * t) as Q;
    const l = Math.hypot(...r);
    return r.map((x) => x / l) as Q;
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, k) => wa * x + wb * bb[k]) as Q;
};

export interface Rig {
  nodes: Node[];
  parent: Map<Node, Node | null>;
  clips: Map<string, { duration: number; tracks: { node: Node; path: string; t: Float32Array | number[]; v: number[][] }[] }>;
}

export async function loadRig(path = new URL('../../assets/optimized/players/player_base.glb', import.meta.url).pathname): Promise<Rig> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(path);
  const root = doc.getRoot();
  const nodes = root.listNodes();
  const parent = new Map<Node, Node | null>();
  for (const n of nodes) for (const c of n.listChildren()) parent.set(c, n);
  for (const n of nodes) if (!parent.has(n)) parent.set(n, null);
  const clips: Rig['clips'] = new Map();
  for (const a of root.listAnimations()) {
    const tracks = a.listChannels().map((ch) => {
      const s = ch.getSampler()!;
      const inp = s.getInput()!, out = s.getOutput()!;
      const n = out.getElementSize();
      const t = Array.from(inp.getArray()!);
      const v: number[][] = [];
      for (let i = 0; i < out.getCount(); i++) v.push(out.getElement(i, new Array(n).fill(0)));
      return { node: ch.getTargetNode()!, path: ch.getTargetPath()!, t, v };
    });
    const duration = Math.max(...tracks.map((tr) => tr.t[tr.t.length - 1] ?? 0));
    clips.set(a.getName(), { duration, tracks });
  }
  return { nodes, parent, clips };
}

/** World (model-space) positions of the named nodes at time t of a clip. */
export function poseAt(rig: Rig, clip: string, t: number, names: string[]): Record<string, V3> {
  const c = rig.clips.get(clip);
  if (!c) throw new Error(`no clip ${clip}`);
  const local = new Map<Node, { T: V3; R: Q; S: V3 }>();
  for (const n of rig.nodes) local.set(n, { T: n.getTranslation() as V3, R: n.getRotation() as Q, S: n.getScale() as V3 });
  for (const tr of c.tracks) {
    const ts = tr.t as number[];
    let i = 0;
    while (i < ts.length - 1 && ts[i + 1] <= t) i++;
    const j = Math.min(ts.length - 1, i + 1);
    const f = j === i ? 0 : Math.min(1, Math.max(0, (t - ts[i]) / (ts[j] - ts[i])));
    const L = local.get(tr.node)!;
    if (tr.path === 'rotation') L.R = slerp(tr.v[i] as Q, tr.v[j] as Q, f);
    else if (tr.path === 'translation') L.T = tr.v[i].map((x, k) => x + (tr.v[j][k] - x) * f) as V3;
    else if (tr.path === 'scale') L.S = tr.v[i].map((x, k) => x + (tr.v[j][k] - x) * f) as V3;
  }
  const world = new Map<Node, { T: V3; R: Q; S: V3 }>();
  const solve = (n: Node): { T: V3; R: Q; S: V3 } => {
    const hit = world.get(n);
    if (hit) return hit;
    const L = local.get(n)!;
    const p = rig.parent.get(n);
    let W = L;
    if (p) {
      const P = solve(p);
      const ts: V3 = [L.T[0] * P.S[0], L.T[1] * P.S[1], L.T[2] * P.S[2]];
      const r = qrot(P.R, ts);
      W = { T: [P.T[0] + r[0], P.T[1] + r[1], P.T[2] + r[2]], R: qmul(P.R, L.R), S: [P.S[0] * L.S[0], P.S[1] * L.S[1], P.S[2] * L.S[2]] };
    }
    world.set(n, W);
    return W;
  };
  const out: Record<string, V3> = {};
  for (const name of names) {
    const n = rig.nodes.find((x) => x.getName() === name || x.getName().endsWith(`:${name}`) || x.getName().endsWith(name));
    if (n) out[name] = solve(n).T;
  }
  return out;
}

export interface Strike { t: number; foot: 'L' | 'R'; fwd: number; side: number }

/** Footstrikes of a looping locomotion clip: a foot whose height drops to the ground after being in the air; its offset from the hips' ground point. */
export function strikesOf(rig: Rig, clip: string, n = 96): { duration: number; strikes: Strike[]; ground: number } {
  const c = rig.clips.get(clip)!;
  const names = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'Hips'];
  const ps = Array.from({ length: n }, (_, i) => poseAt(rig, clip, (i / n) * c.duration, names));
  // the sole: the lower of the ankle and the toe
  const sole = (p: Record<string, V3>, s: 'Left' | 'Right') => Math.min(p[`${s}Foot`]?.[1] ?? 9, p[`${s}ToeBase`]?.[1] ?? 9);
  const ground = Math.min(...ps.flatMap((p) => [sole(p, 'Left'), sole(p, 'Right')]));
  const strikes: Strike[] = [];
  for (const s of ['Left', 'Right'] as const) {
    const h = ps.map((p) => sole(p, s) - ground);
    for (let i = 0; i < n; i++) {
      const prev = h[(i - 1 + n) % n];
      if (h[i] < 0.03 && prev >= 0.03) {
        const p = ps[i];
        const f = p[`${s}Foot`], hp = p.Hips;
        strikes.push({ t: (i / n) * c.duration, foot: s === 'Left' ? 'L' : 'R', fwd: f[2] - hp[2], side: f[0] - hp[0] });
      }
    }
  }
  strikes.sort((a, b) => a.t - b.t);
  return { duration: c.duration, strikes, ground };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const want = argv.filter((a) => !a.startsWith('--'));
  const rig = await loadRig();
  const loco = ['walk', 'trot', 'jog', 'run', 'run_sprint', 'run_turn', 'run_turn_sprint'];
  const clips = want.length ? want : [...loco, 'slide_feet', 'slide_head', 'slide_hook_left', 'slide_hook_right', 'dive_back'];
  const res: Record<string, unknown> = {};
  for (const clip of clips) {
    if (!rig.clips.has(clip)) {
      console.log(`${clip}: not in the GLB`);
      continue;
    }
    if (loco.includes(clip)) {
      const s = strikesOf(rig, clip);
      res[clip] = s;
      if (!json) {
        console.log(`${clip} (${s.duration.toFixed(3)} s):`);
        for (const k of s.strikes) console.log(`  ${k.foot} at ${k.t.toFixed(3)} s  fwd ${k.fwd.toFixed(3)}  side ${k.side.toFixed(3)}`);
      }
      continue;
    }
    const c = rig.clips.get(clip)!;
    const names = ['Hips', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftHand', 'RightHand', 'Head'];
    const rows = Array.from({ length: 13 }, (_, i) => {
      const t = (i / 12) * c.duration;
      return { t, p: poseAt(rig, clip, t, names) };
    });
    res[clip] = rows;
    if (json) continue;
    console.log(`${clip} (${c.duration.toFixed(3)} s): z forward of the root origin (hips' z in brackets), m`);
    const f = (v?: V3) => (v ? `${v[2].toFixed(2).padStart(5)}/${v[1].toFixed(2)}` : '   -   ');
    console.log('     t   hips(z/y)   Ltoe      Rtoe      Lhand     Rhand     head');
    for (const r of rows) console.log(`  ${r.t.toFixed(2)}  ${f(r.p.Hips)}  ${f(r.p.LeftToeBase)}  ${f(r.p.RightToeBase)}  ${f(r.p.LeftHand)}  ${f(r.p.RightHand)}  ${f(r.p.Head)}`);
  }
  if (json) console.log(JSON.stringify(res, null, 1));
}
