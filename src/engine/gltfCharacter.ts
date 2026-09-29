/**
 * Skinned glTF player (Blender export, Mixamo-named 22-bone rig) driven by the sim's animation
 * hints through an AnimationMixer. Root motion is the sim's position; head lookAt and arm IK
 * (batter's hands to the sim's bat) are applied on top of the mixer output each frame.
 */
import {
  AnimationAction,
  AnimationMixer,
  Bone,
  Color,
  Group,
  LoopOnce,
  LoopRepeat,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterTemplate } from './assets';
import type { AnimHint, PlayerRole, PlayerSnap } from './types';
import { reg, type Look, type PuppetEnv, type PuppetLike } from './characters';

const LOOPING = new Set(['idle', 'run', 'field_ready', 'celebrate', 'catcher_crouch']);
const FIELDERS = new Set<PlayerRole>(['first', 'second', 'third', 'short', 'left', 'center', 'right']);
const SKINS = ['#f0c6a0', '#dca47a', '#c08558', '#8a5a3a', '#5d3b26', '#e8b48a'];

function clipFor(hint: AnimHint, role: PlayerRole): string {
  switch (hint) {
    case 'windup': return 'windup';
    case 'pitch': return 'pitch';
    case 'swing': return 'swing';
    case 'run': return 'run';
    case 'field': case 'catch': return 'field_catch';
    case 'throw': return 'throw';
    case 'slide': return 'slide';
    case 'celebrate': return 'celebrate';
    default:
      if (role === 'batter') return 'swing'; // frame 0 of the swing is the batting stance (held, see update)
      if (role === 'catcher') return 'catcher_crouch';
      if (FIELDERS.has(role) || role === 'pitcher') return role === 'pitcher' ? 'idle' : 'field_ready';
      return 'idle';
  }
}

export function templateNameFor(snap: PlayerSnap): string {
  switch (snap.role) {
    case 'batter': case 'runner': case 'coach': return 'player_batter';
    case 'catcher': return 'player_catcher';
    case 'umpire': return 'player_umpire';
    default: return snap.team === 1 ? 'player_home' : 'player_away';
  }
}

const matCache = new Map<string, MeshStandardMaterial>();
function tinted(base: Material, key: string, color: string): MeshStandardMaterial {
  let m = matCache.get(key);
  if (!m) {
    m = (base as MeshStandardMaterial).clone();
    m.userData = {};
    m.color = new Color(color);
    reg(m);
    matCache.set(key, m);
  }
  return m;
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _q = new Quaternion(), _q2 = new Quaternion();
const UP = new Vector3(0, 1, 0);

/** Rotate a bone in world space by qDelta. */
function rotateWorld(bone: Object3D, qDelta: Quaternion, w = 1) {
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(_q);
  _q2.copy(qDelta).premultiply(_q.clone().identity());
  const target = _q2.multiply(_q); // qDelta * qWorld
  const parentQ = bone.parent ? bone.parent.getWorldQuaternion(new Quaternion()).invert() : new Quaternion();
  const local = parentQ.multiply(target);
  bone.quaternion.slerp(local, w);
}

/** Point `bone` (whose child is `child`) so the bone→child direction goes toward `target`. */
function aimBone(bone: Object3D, child: Object3D, target: Vector3, w = 1) {
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(true, false);
  bone.getWorldPosition(_a);
  child.getWorldPosition(_b);
  const cur = _b.sub(_a).normalize();
  const des = _c.copy(target).sub(_a).normalize();
  rotateWorld(bone, new Quaternion().setFromUnitVectors(cur, des), w);
  bone.updateMatrixWorld(true);
}

export class GltfPuppet implements PuppetLike {
  root = new Group();
  team = -2;
  private model: Object3D;
  private mixer: AnimationMixer;
  private actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  private currentName = '';
  private lastHint: AnimHint | '' = '';
  private bones: Record<string, Bone> = {};
  private meshes: Mesh[] = [];
  private look = { yaw: 0, pitch: 0 };
  private ikW = 0;
  private skin: string;
  private numberSet = -1;
  /** empty at the batter's hands (origin = bat knob, +Y = barrel) */
  batGrip: Object3D | null = null;
  private numMeshes: { tens?: Mesh; ones?: Mesh } = {};

  constructor(private tpl: CharacterTemplate, id: string) {
    this.model = SkeletonUtils.clone(tpl.scene);
    this.root.add(this.model);
    this.model.traverse((o) => {
      if (o.name === 'Bat_Grip') this.batGrip = o;
      if (o.name === 'Gear_Number_Tens') this.numMeshes.tens = o as Mesh;
      if (o.name === 'Gear_Number_Ones') this.numMeshes.ones = o as Mesh;
      if ((o as Bone).isBone) this.bones[o.name.replace('mixamorig', '').replace(':', '')] = o as Bone;
      const m = o as Mesh;
      if (m.isMesh) {
        for (const mt of Array.isArray(m.material) ? m.material : [m.material]) reg(mt);
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        this.meshes.push(m);
      }
    });
    // hair is hidden under caps / helmets
    const hair = this.model.getObjectByName('Gear_Hair') ?? this.model.getObjectByName('Face_Hair');
    if (hair && (this.model.getObjectByName('Gear_Cap') || this.model.getObjectByName('Gear_Helmet'))) hair.visible = false;
    this.mixer = new AnimationMixer(this.model);
    for (const [name, clip] of tpl.clips) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(LOOPING.has(name) ? LoopRepeat : LoopOnce, Infinity);
      a.clampWhenFinished = true;
      this.actions.set(name, a);
    }
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    this.skin = SKINS[h % SKINS.length];
  }

  setTeam(look: Look, team: number) {
    this.team = team;
    const map: Record<string, string> = {
      uniform_jersey: look.jersey, uniform_pants: look.pants, uniform_socks: look.sock, uniform_undershirt: look.sock, cap: look.cap, helmet: look.cap,
    };
    const dark = team === -1;
    for (const m of this.meshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const next = mats.map((mat) => {
        const n = mat.name.replace(/\.\d+$/, '');
        if (dark && ['uniform_jersey', 'uniform_pants', 'uniform_socks'].includes(n)) return mat; // umpire files come pre-colored
        if (n === 'skin' || n === 'face') return tinted(mat, `${this.tpl.scene.uuid}:skin:${this.skin}`, this.skin);
        if (map[n] && !(dark && n !== 'cap')) return tinted(mat, `${this.tpl.scene.uuid}:${n}:${map[n]}`, map[n]);
        return mat;
      });
      m.material = Array.isArray(m.material) ? next : next[0];
    }
  }

  private play(name: string, snap: PlayerSnap) {
    const a = this.actions.get(name) ?? this.actions.get('idle');
    if (!a || a === this.current) return;
    a.reset();
    const t = snap.animTime ?? 0;
    a.time = Math.min(t, Math.max(0, a.getClip().duration - 0.001));
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    if (this.current) this.current.crossFadeTo(a, name === 'run' || LOOPING.has(name) ? 0.2 : 0.1, false);
    this.current = a;
    this.currentName = name;
  }

  /** Jersey number quads: two textured digits (cells of number_digits.png; defaults tens=2, ones=7). */
  private setNumber(n: number | undefined) {
    const v = n ?? -1;
    if (v === this.numberSet) return;
    this.numberSet = v;
    const { tens, ones } = this.numMeshes;
    const apply = (mesh: Mesh | undefined, digit: number, def: number, show: boolean) => {
      if (!mesh) return;
      mesh.visible = show;
      if (!show) return;
      const base = mesh.material as MeshStandardMaterial;
      if (!mesh.userData.numMat) {
        const m = base.clone();
        m.userData = {};
        if (m.map) m.map = m.map.clone();
        mesh.userData.numMat = m;
        reg(m);
      }
      const m = mesh.userData.numMat as MeshStandardMaterial;
      mesh.material = m;
      if (m.map) {
        m.map.offset.x = (digit - def) / 10;
        m.map.needsUpdate = true;
      }
    };
    const show = v >= 0;
    apply(tens, Math.floor(v / 10) % 10, 2, show && v >= 10);
    apply(ones, v % 10, 7, show);
  }

  update(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    this.setNumber(snap.number);
    this.model.scale.x = snap.hand === 'L' ? -1 : 1;
    const name = clipFor(snap.anim, snap.role);
    if (snap.anim !== this.lastHint || name !== this.currentName) {
      this.lastHint = snap.anim;
      this.play(name, snap);
    }
    if (snap.role === 'batter' && snap.anim === 'idle' && this.current) {
      this.current.timeScale = 0;
      this.current.time = 0;
    } else if (name === 'run' && this.current) {
      const sp = Math.hypot(snap.vel.x, snap.vel.z);
      this.current.timeScale = Math.min(1.8, Math.max(0.5, sp / 4.5));
    } else if (this.current) this.current.timeScale = 1;
    // sim-driven clip time: when the sim reports progress through a one-shot animation, seek to it
    if (this.current && snap.animProgress !== undefined && !LOOPING.has(this.currentName)) {
      const dur = this.current.getClip().duration;
      this.current.paused = false;
      this.current.timeScale = 0;
      this.current.time = Math.min(dur - 0.001, Math.max(0, snap.animProgress * dur));
    }
    this.mixer.update(dt);

    this.root.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
    this.root.rotation.y = snap.facing;
    this.root.updateMatrixWorld(true);

    // arm IK: batter's hands follow the sim's bat
    const wantIK = !!(env.batGrip && snap.role === 'batter');
    this.ikW += ((wantIK ? 1 : 0) - this.ikW) * (1 - Math.exp(-dt * 25));
    if (this.ikW > 0.02 && env.batGrip) {
      // the hand nearest the knob is the model's Left hand for both batting sides (lefties are mirrored)
      this.solveArm('Left', env.batGrip.bottom, this.ikW);
      this.solveArm('Right', env.batGrip.top, this.ikW);
    }
    this.lookAt(env.ball, dt, snap.role);
  }

  private solveArm(side: 'Left' | 'Right', target: Vector3, w: number) {
    const arm = this.bones[`${side}Arm`], fore = this.bones[`${side}ForeArm`], hand = this.bones[`${side}Hand`];
    if (!arm || !fore || !hand) return;
    const S = arm.getWorldPosition(new Vector3());
    const E0 = fore.getWorldPosition(new Vector3());
    const H0 = hand.getWorldPosition(new Vector3());
    const L1 = S.distanceTo(E0), L2 = E0.distanceTo(H0);
    const dir = target.clone().sub(S);
    let d = dir.length();
    if (d < 1e-4) return;
    dir.divideScalar(d);
    d = Math.min(Math.max(d, 0.1), L1 + L2 - 0.005);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // keep the elbow where the animation put it: pole = current elbow offset from the shoulder→target line
    const pole = E0.clone().sub(S);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(0, -1, 0);
    pole.normalize();
    const E = S.clone().addScaledVector(dir, a).addScaledVector(pole, h);
    aimBone(arm, fore, E, w);
    aimBone(fore, hand, target, w);
  }

  private lookAt(ball: Vector3 | null, dt: number, role: PlayerRole) {
    const head = this.bones.Head, neck = this.bones.Neck;
    if (!head || !neck) return;
    let yaw = 0, pitch = 0.02;
    if (ball && role !== 'pitcher' || (ball && role === 'pitcher')) {
      const hp = head.getWorldPosition(new Vector3());
      const d = ball.clone().sub(hp);
      // into root-local space
      const inv = this.root.getWorldQuaternion(new Quaternion()).invert();
      d.applyQuaternion(inv);
      yaw = Math.atan2(d.x, d.z);
      pitch = Math.atan2(-d.y, Math.hypot(d.x, d.z));
    }
    yaw = Math.max(-1.1, Math.min(1.1, yaw));
    pitch = Math.max(-0.6, Math.min(0.7, pitch));
    const k = 1 - Math.exp(-dt * 9);
    this.look.yaw += (yaw - this.look.yaw) * k;
    this.look.pitch += (pitch - this.look.pitch) * k;
    const rootQ = this.root.getWorldQuaternion(new Quaternion());
    const right = new Vector3(1, 0, 0).applyQuaternion(rootQ);
    const qy = new Quaternion().setFromAxisAngle(UP, this.look.yaw);
    const qp = new Quaternion().setFromAxisAngle(right, this.look.pitch);
    // body already faces the play in many clips; add only a portion so the neck does not over-rotate
    const q = qy.multiply(qp);
    const half = new Quaternion().identity().slerp(q, 0.4);
    const rest = new Quaternion().identity().slerp(q, 0.6);
    rotateWorld(neck, half);
    rotateWorld(head, rest);
    this.root.updateMatrixWorld(true);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
