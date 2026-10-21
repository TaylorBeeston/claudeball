/**
 * Can two hands hold the sim's bat? The batter's body is the `swing` clip at the clip time the engine shows (src/engine/gltfCharacter.ts
 * batterTiming), placed as the engine places him (the box, the stance yaw, his height scale, lefties mirrored); both fists are solved onto the
 * sim's actual knob and bat line with the game's arm solver (pose/armIK.ts), exactly as tools/jank/envelope.ts does for one direction.
 * strict = both fists on the handle (< 2 cm) and <= 5 deg past the pronation / wrist range; relaxed = <= 35 deg (envelope.ts '#' / '+').
 */
import path from 'node:path';
import { loadRig, sampleClip, type Clip, type RigFile } from '../jank/glb';
import { B, fk, type PoseWorld } from '../../src/engine/pose/skeleton';
import { restInfo } from '../../src/engine/pose/limits';
import { qrot } from '../../src/engine/pose/qmath';
import { armRest, solveArm } from '../../src/engine/pose/armIK';

export type V3 = { x: number; y: number; z: number };
const sl = (a: ArrayLike<number>, i: number, n: number) => Array.from(a).slice(i * n, i * n + n);
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// the engine's swing timeline (gltfCharacter.ts batterTiming) and stance (stanceYaw, STANCE_OPEN), playerLook.ts's height scale
export const T_LAUNCH = 14 / 24, T_FINISH = 28 / 24, PC = 1 / 2.1;
export const STANCE_OPEN = 0.2, MODEL_HEIGHT = 1.85, BOX_X = 0.72, BOX_Z = 0.15;
export const heightScale = (h: number) => Math.min(1.14, Math.max(0.88, h / MODEL_HEIGHT));

/** the engine's per-side grip state (gltfCharacter.ts armTrack) */
export type Track = Partial<Record<'Left' | 'Right', { pole: number; roll: number; pron?: number; vPole?: number; vRoll?: number }>>;

export interface HoldSample {
  overL: number;
  overR: number;
  missL: number;
  missR: number;
  /** the bat in the drawn body's shoulder frame (envelope.ts) */
  az: number;
  el: number;
  /** the sim's knob from the clip's own knob at that time (m, world) */
  knobOff: number;
  strict: boolean;
  relaxed: boolean;
}

interface Body {
  w: PoseWorld;
  frame: { x: number[]; y: number[]; z: number[] };
  knob: number[];
  axis: number[];
}

export class Holder {
  rig!: RigFile;
  clip!: Clip;
  tContact = 22 / 24;
  private R!: ReturnType<typeof restInfo>;
  private rests!: Record<'Left' | 'Right', ReturnType<typeof armRest>>;
  private fistR!: number[];
  private axisR!: number[];
  private gripTop = 0.135;
  private gripBottom = 0.05;
  private cache = new Map<number, Body>();

  async init(root: string) {
    this.rig = await loadRig(path.join(root, 'assets/optimized/players/player_base.glb'));
    const rw0 = fk(this.rig.rest);
    fk(this.rig.rest, rw0, rw0);
    this.R = restInfo(rw0);
    const R = this.R;
    const g = this.rig.attach.get('Bat_Grip')!;
    this.axisR = qrot(g.q, 0, 1, 0, [0, 0, 0]) as number[];
    const s0 = -dot(g.t, this.axisR);
    this.fistR = [g.t[0] + this.axisR[0] * s0, g.t[1] + this.axisR[1] * s0, g.t[2] + this.axisR[2] * s0];
    this.gripTop = s0;
    this.gripBottom = Math.max(0.02, s0 - 0.085);
    const restOf = (side: 'Left' | 'Right') =>
      armRest(sl(R.dir, B[`${side}Arm`], 3), sl(R.dir, B[`${side}ForeArm`], 3), sl(R.rest.wq, B[`${side}Arm`], 4), sl(R.rest.wq, B[`${side}ForeArm`], 4), sl(R.rest.wq, B[`${side}Hand`], 4), side === 'Left' ? 1 : -1);
    this.rests = { Left: restOf('Left'), Right: restOf('Right') };
    this.clip = this.rig.clips.get('swing')!;
    try {
      const m = (await import(path.join(root, 'assets/players/player_manifest.json'), { with: { type: 'json' } })).default as { clips: Record<string, { events_s?: Record<string, number> }> };
      this.tContact = m.clips.swing?.events_s?.contact ?? this.tContact;
    } catch {
      /* the default */
    }
  }

  /** the clip time the engine shows at progress p of the sim's swing hint (p > 1: the finish, held) */
  clipTime(p: number, finishS = 0): number {
    if (p >= 1) return Math.min(this.clip.duration, T_FINISH + finishS);
    return p < PC ? T_LAUNCH + ((this.tContact - T_LAUNCH) * p) / PC : this.tContact + ((T_FINISH - this.tContact) * (p - PC)) / (1 - PC);
  }

  body(t: number): Body {
    const key = Math.round(t * 4800);
    let b = this.cache.get(key);
    if (b) return b;
    const L = sampleClip(this.clip, Math.min(this.clip.duration - 1e-4, t), this.rig.rest);
    const w = fk(L, undefined, this.R.rest);
    const x = norm(sub(sl(w.wp, B.LeftArm, 3), sl(w.wp, B.RightArm, 3)));
    const up0 = norm(sub(sl(w.wp, B.Spine2, 3), sl(w.wp, B.Hips, 3)));
    const y = norm(sub(up0, x.map((v) => v * dot(up0, x))));
    const z = cross(x, y);
    const qR = sl(w.wq, B.RightHand, 4);
    const fR = qrot(qR, this.fistR[0], this.fistR[1], this.fistR[2]) as number[];
    const HR = sl(w.wp, B.RightHand, 3);
    const ax = norm(qrot(qR, this.axisR[0], this.axisR[1], this.axisR[2]) as number[]);
    const knob = [HR[0] + fR[0] - ax[0] * this.gripTop, HR[1] + fR[1] - ax[1] * this.gripTop, HR[2] + fR[2] - ax[2] * this.gripTop];
    b = { w, frame: { x, y, z }, knob, axis: ax };
    this.cache.set(key, b);
    return b;
  }

  /** rig -> world (the model's transform) */
  static toWorld(p: number[], stance: 'L' | 'R', scale: number, dirOnly = false): V3 {
    const sg = stance === 'R' ? 1 : -1;
    const yaw = sg > 0 ? -Math.PI / 2 + STANCE_OPEN : Math.PI / 2 - STANCE_OPEN;
    const k = dirOnly ? 1 : scale;
    const x = sg * p[0] * k, y = p[1] * k, z = p[2] * k;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: (dirOnly ? 0 : sg * BOX_X) + x * c + z * s, y, z: (dirOnly ? 0 : BOX_Z) - x * s + z * c };
  }

  /** the clip's own bat at clip time t in world space (knob, tip) */
  clipBat(t: number, stance: 'L' | 'R', heightM: number): { knob: V3; tip: V3 } {
    const scale = heightScale(heightM);
    const b = this.body(t);
    const knob = Holder.toWorld(b.knob, stance, scale);
    const d = Holder.toWorld(b.axis, stance, scale, true);
    return { knob, tip: { x: knob.x + d.x * 0.84, y: knob.y + d.y * 0.84, z: knob.z + d.z * 0.84 } };
  }

  /** world -> rig space of a batter standing in the box (the model's inverse: stance yaw, height scale, the lefty mirror) */
  static toRig(p: V3, stance: 'L' | 'R', scale: number, dirOnly = false): number[] {
    const sg = stance === 'R' ? 1 : -1;
    const yaw = sg > 0 ? -Math.PI / 2 + STANCE_OPEN : Math.PI / 2 - STANCE_OPEN;
    const X = dirOnly ? p.x : p.x - sg * BOX_X, Y = p.y, Z = dirOnly ? p.z : p.z - BOX_Z;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = X * c - Z * s, lz = X * s + Z * c;
    const k = dirOnly ? 1 : 1 / scale;
    return [sg * lx * k, Y * k, lz * k];
  }

  /**
   * The sim's bat (world knob and tip) on the body the engine draws at clip time t. With `track` (one per swing, carried frame to frame) the
   * fists are solved the way the engine does it (gltfCharacter.ts armIK): the grip taken at swivel 0 / roll 0 and followed from frame to frame
   * (armIK.ts track mode, dt); without it every swivel and roll is tried (envelope.ts).
   */
  sample(stance: 'L' | 'R', heightM: number, knobW: V3, tipW: V3, t: number, track?: Track, dt = 1 / 60): HoldSample {
    const scale = heightScale(heightM);
    const body = this.body(t);
    const knob = Holder.toRig(knobW, stance, scale);
    const d = norm(Holder.toRig({ x: tipW.x - knobW.x, y: tipW.y - knobW.y, z: tipW.z - knobW.z }, stance, scale, true));
    const w = body.w;
    const solve = (side: 'Left' | 'Right') => {
      const mx = side === 'Right' ? 1 : -1;
      const fist = [mx * this.fistR[0], this.fistR[1], this.fistR[2]], gl = [mx * this.axisR[0], this.axisR[1], this.axisR[2]];
      const sAlong = side === 'Right' ? this.gripTop : this.gripBottom;
      const target = [knob[0] + d[0] * sAlong, knob[1] + d[1] * sAlong, knob[2] + d[2] * sAlong];
      const [a, f, h] = [B[`${side}Arm`], B[`${side}ForeArm`], B[`${side}Hand`]];
      const out = solveArm(this.rests[side], { S: sl(w.wp, a, 3), E: sl(w.wp, f, 3), H: sl(w.wp, h, 3), qUpper: sl(w.wq, a, 4), qFore: sl(w.wq, f, 4), qHand: sl(w.wq, h, 4) }, { target, fist, gripLocal: gl, gripDir: d, ...(track ? { track: track[side] ?? { pole: 0, roll: 0 }, dt } : {}) });
      if (track) track[side] = { pole: out.pole, roll: out.roll, pron: out.pron, vPole: out.vPole, vRoll: out.vRoll };
      return out;
    };
    const l = solve('Left'), r = solve('Right');
    const { x, y, z } = body.frame;
    const az = (Math.atan2(dot(d, x), dot(d, z)) * 180) / Math.PI, el = (Math.asin(Math.max(-1, Math.min(1, dot(d, y)))) * 180) / Math.PI;
    const over = Math.max(l.over, r.over), miss = Math.max(l.miss, r.miss);
    const knobOff = Math.hypot(knob[0] - body.knob[0], knob[1] - body.knob[1], knob[2] - body.knob[2]) * scale;
    return { overL: l.over, overR: r.over, missL: l.miss * scale, missR: r.miss * scale, az, el, knobOff, strict: over <= 5 && miss < 0.02, relaxed: over <= 35 && miss < 0.02 };
  }
}
