/**
 * Static and crossfade sweeps (Node, no browser): every clip of every shipped player file sampled at 60 Hz through the pose validator, and every
 * clip-to-clip transition the game was seen to make (tools/jank/transitions.json, logged by the game sweep) blended the way three's mixer
 * cross-fades. Clips are measured raw: no look-at, IK or other runtime override (the game sweep measures those).
 *
 * Joint angles are measured in rig space, so a mirrored (left-handed) player measures exactly like a right-handed one and body-build morphs
 * do not change them: the sweep runs each clip once per file. The bat clips run a second time mirrored as a self-test of the world-space bat
 * and foot checks (the counts must match).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadRig, sampleClip, blendLocals, type RigFile } from './glb';
import { B, type PoseLocals, newLocals, localPoint, fk, newWorld } from '../../src/engine/pose/skeleton';
import { qrot } from '../../src/engine/pose/qmath';
import { newTrack, rigInfo, validateFrame, type BatIn, type RigInfo, type Violation, toWorld } from './validate';
import { Agg, type Snapshot } from './agg';
import { AIRBORNE, BALLISTIC, BAT_CLIPS, LOCOMOTION, clipFlags } from './clips';
export { AIRBORNE, BALLISTIC, BAT_CLIPS, LOCOMOTION, clipFlags };

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const FPS = 60;

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MIRROR = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const flat = () => 0;

/** a bat on Bat_Grip (the right hand) in world space */
export function gripBat(L: PoseLocals, rig: RigInfo, model: number[], hands: { L: boolean; R: boolean }): BatIn {
  const w = fk(L, newWorld());
  const base = L.base[7];
  const k = localPoint(w, B.RightHand, rig.att.batKnob[0], rig.att.batKnob[1], rig.att.batKnob[2], base, [0, 0, 0]);
  const a = qrot(w.wq, rig.att.batAxis[0], rig.att.batAxis[1], rig.att.batAxis[2], [0, 0, 0], B.RightHand * 4) as number[];
  const ms = Math.hypot(model[0], model[1], model[2]);
  const tipR = [k[0] + (a[0] * 0.86) / ms, k[1] + (a[1] * 0.86) / ms, k[2] + (a[2] * 0.86) / ms];
  return { state: 'static', knob: toWorld(model, k[0], k[1], k[2], [0, 0, 0]), tip: toWorld(model, tipR[0], tipR[1], tipR[2], [0, 0, 0]), hands };
}

export async function loadFiles(files: string[]): Promise<{ name: string; rig: RigFile; info: RigInfo }[]> {
  const out = [];
  for (const f of files) {
    const rig = await loadRig(path.join(ROOT, 'assets/optimized/players', `${f}.glb`));
    const g = rig.attach.get('Bat_Grip');
    if (!g) throw new Error(`${f}: no Bat_Grip`);
    out.push({ name: f, rig, info: rigInfo(rig.rest, g) });
  }
  return out;
}

export function shippedPlayers(): string[] {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/shipped.json'), 'utf8')).players;
}

/** sweep one clip (looping clips get a wrap-around tail so a pop at the loop point counts) */
export function sweepClip(agg: Agg, file: string, rig: RigFile, info: RigInfo, clipName: string, loop: boolean, mirrored = false) {
  const clip = rig.clips.get(clipName)!;
  const fl = clipFlags(clipName);
  const tr = newTrack();
  const v: Violation[] = [];
  const L = newLocals();
  const model = mirrored ? MIRROR : IDENT;
  const n = Math.max(1, Math.round(clip.duration * FPS));
  const tail = loop ? 3 : 0;
  const src = mirrored ? `static-mirror` : 'static';
  for (let i = 0; i <= n + tail; i++) {
    const t = i <= n ? i / FPS : (i - n) / FPS;
    sampleClip(clip, Math.min(t, clip.duration), rig.rest, L);
    const bh = BAT_CLIPS[clipName];
    const bat = bh ? gripBat(L, info, model, bh) : null;
    validateFrame({ L, model, ground: flat, dt: i === 0 ? 0 : 1 / FPS, ...fl, bat }, info, tr, v);
    agg.add(src, file, clipName, v, 1 / FPS, () => ({ ...snap(L, model, { file, clip: clipName, t, mirrored }), bat: bat && { knob: bat.knob, tip: bat.tip } }));
  }
}

export function snap(L: PoseLocals, model: ArrayLike<number>, ctx: Record<string, unknown>): Snapshot {
  return { lq: Array.from(L.lq, (x) => +x.toFixed(5)), lp: Array.from(L.lp, (x) => +x.toFixed(4)), base: Array.from(L.base), model: Array.from(model), ctx };
}

export interface Transition {
  file?: string;
  from: string;
  to: string;
  /** time in the from-clip when the fade starts (s) */
  fromT: number;
  /** time in the to-clip at the start (s) */
  toT: number;
  fade: number;
  n?: number;
}

/**
 * One cross-fade the way three plays it: the old action keeps playing (looping or clamped) at weight 1 - k, the new one from toT at k, k linear
 * over `fade` s; a frame counts as `blend` when the blended pose breaks a limit that neither clip breaks at that instant.
 */
export function sweepFade(agg: Agg, file: string, rig: RigFile, info: RigInfo, tx: Transition, loops: Set<string>) {
  const A = rig.clips.get(tx.from), Bc = rig.clips.get(tx.to);
  if (!A || !Bc) return;
  const fl = clipFlags(tx.to);
  const trBlend = newTrack(), trA = newTrack(), trB = newTrack();
  const vb: Violation[] = [], va: Violation[] = [], vB: Violation[] = [];
  const LA = newLocals(), LB = newLocals(), L = newLocals();
  const n = Math.ceil((tx.fade + 0.1) * FPS);
  const at = (c: typeof A, t: number) => (loops.has(c.name) ? t % Math.max(1e-6, c.duration) : Math.min(t, c.duration));
  const key = `${tx.from} > ${tx.to}`;
  // the frame before the fade starts, so a pop on the first blended frame is seen
  for (let i = -2; i <= n; i++) {
    const t = Math.max(0, i) / FPS;
    sampleClip(A, at(A, tx.fromT + i / FPS), rig.rest, LA);
    sampleClip(Bc, at(Bc, tx.toT + t), rig.rest, LB);
    const k = i < 0 ? 0 : Math.min(1, t / Math.max(1e-6, tx.fade));
    blendLocals(LA, LB, k, L);
    const dt = i === -2 ? 0 : 1 / FPS;
    const bat = BAT_CLIPS[tx.to] && BAT_CLIPS[tx.from] ? gripBat(L, info, IDENT, BAT_CLIPS[tx.to]) : null;
    validateFrame({ L, model: IDENT, ground: flat, dt, ...fl, locomotion: fl.locomotion || LOCOMOTION.has(tx.from), airborne: fl.airborne || AIRBORNE.test(tx.from), ballistic: fl.ballistic || BALLISTIC.test(tx.from), bat }, info, trBlend, vb);
    validateFrame({ L: LA, model: IDENT, ground: flat, dt, ...clipFlags(tx.from) }, info, trA, va);
    validateFrame({ L: LB, model: IDENT, ground: flat, dt, ...fl }, info, trB, vB);
    // only what the blend itself adds: a violation kind neither endpoint has this frame (or a worse one)
    const worst = new Map<string, number>();
    for (const x of [...va, ...vB]) worst.set(x.kind, Math.max(worst.get(x.kind) ?? 0, x.excess));
    const own = vb.filter((x) => x.excess > (worst.get(x.kind) ?? 0) + (x.kind.startsWith('joint') ? 3 : 0.01));
    agg.add('fade', file, key, own, 1 / FPS, () => snap(L, IDENT, { file, clip: key, from: tx.from, to: tx.to, fromT: tx.fromT, toT: tx.toT, fade: tx.fade, t, k }));
  }
}

export async function runStatic(files: string[], manifestLoops: Set<string>, agg = new Agg()): Promise<Agg> {
  for (const { name, rig, info } of await loadFiles(files)) {
    for (const c of rig.clips.keys()) {
      sweepClip(agg, name, rig, info, c, manifestLoops.has(c));
      if (BAT_CLIPS[c]) sweepClip(agg, name, rig, info, c, manifestLoops.has(c), true);
    }
  }
  return agg;
}

export function manifestLoops(): Set<string> {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/players/player_manifest.json'), 'utf8'));
  return new Set(Object.entries(m.clips as Record<string, { loop?: boolean }>).filter(([, c]) => c.loop).map(([k]) => k));
}
