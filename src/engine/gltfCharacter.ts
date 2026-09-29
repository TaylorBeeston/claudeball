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
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterTemplate } from './assets';
import type { AnimHint, PlayerRole, PlayerSnap } from './types';
import { reg, type Look, type PuppetEnv, type PuppetLike } from './characters';
import { HeadLook, lookTarget, maxLookStep, type LookTarget } from './headLook';

const LOOPING = new Set(['idle', 'run', 'trot', 'run_turn', 'field_ready', 'celebrate', 'catcher_crouch', 'batting_stance']);
const FIELDERS = new Set<PlayerRole>(['first', 'second', 'third', 'short', 'left', 'center', 'right']);
const SKINS = ['#f0c6a0', '#dca47a', '#c08558', '#8a5a3a', '#5d3b26', '#e8b48a'];

/** Preferred clip per hint, then fallbacks for clips that a given GLB may not contain (older exports). */
function clipCandidates(hint: AnimHint, role: PlayerRole): string[] {
  switch (hint) {
    case 'windup': return ['windup'];
    case 'pitch': return ['pitch'];
    case 'swing': return ['swing'];
    case 'run': return ['run'];
    case 'trot': return ['trot', 'run'];
    case 'run_turn': return ['run_turn', 'run'];
    case 'field': case 'catch': return ['field_catch'];
    case 'catch_jump': return ['catch_jump', 'field_catch'];
    case 'throw': return ['throw'];
    case 'slide': return ['slide'];
    case 'celebrate': return ['celebrate', 'idle'];
    default:
      // frame 0 of the swing is the batting stance (held, see update) until a dedicated `batting_stance` clip exists
      if (role === 'batter') return ['batting_stance', 'swing'];
      if (role === 'catcher') return ['catcher_crouch'];
      if (role === 'pitcher') return ['idle'];
      if (FIELDERS.has(role)) return ['field_ready', 'idle'];
      return ['idle'];
  }
}

/** Yaw (rad, direction = (sin f, cos f)) a batter's body faces in the box: chest toward the plate, a little open to the pitcher. */
export const STANCE_OPEN = 0.2;
export function stanceYaw(hand: 'L' | 'R' | undefined): number {
  // righties stand on the third-base side (+X) facing -X, lefties on the first-base side (-X) facing +X
  return hand === 'L' ? Math.PI / 2 - STANCE_OPEN : -Math.PI / 2 + STANCE_OPEN;
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
    const b = base as MeshStandardMaterial;
    const name = b.name.replace(/\.\d+$/, '');
    const fabric = /^uniform_/.test(name);
    const skin = name === 'skin' || name === 'face';
    if (fabric || skin) {
      // fabric sheen / skin rim (cheap subsurface look) via MeshPhysicalMaterial
      const pm = new MeshPhysicalMaterial({
        map: b.map, normalMap: b.normalMap, normalScale: b.normalScale.clone(), roughnessMap: b.roughnessMap, metalnessMap: b.metalnessMap,
        aoMap: b.aoMap, aoMapIntensity: b.aoMapIntensity, roughness: b.roughness, metalness: b.metalness, side: b.side,
      });
      pm.sheen = fabric ? 0.7 : 0.45;
      pm.sheenRoughness = fabric ? 0.55 : 0.75;
      pm.sheenColor = new Color(fabric ? 0xffffff : 0xff9a80);
      pm.name = b.name;
      m = pm;
    } else m = b.clone();
    m.userData = {};
    m.color = new Color(color);
    reg(m);
    matCache.set(key, m);
  }
  return m;
}

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _q = new Quaternion(), _q2 = new Quaternion();
const _m = new Matrix4(), _s = new Vector3();
const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);

/**
 * All bone math happens in "rig space": the space inside the character's model node, i.e. with the model's mirror (lefties are
 * `scale.x = -1`) divided out. Quaternions extracted from a mirrored world matrix are meaningless (that is what threw heads and
 * arms around on mirrored players), while `inverse(model) * bone` is always a proper rotation.
 */
export class Rig {
  private inv = new Matrix4();
  constructor(private model: Object3D) {}
  /** call after the world matrices changed (once per solve step) */
  refresh() {
    this.model.updateWorldMatrix(true, false);
    this.inv.copy(this.model.matrixWorld).invert();
  }
  toRig(worldPoint: Vector3, out: Vector3) {
    return out.copy(worldPoint).applyMatrix4(this.inv);
  }
  pos(o: Object3D, out: Vector3) {
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(_m.multiplyMatrices(this.inv, o.matrixWorld));
  }
  quat(o: Object3D, out: Quaternion) {
    o.updateWorldMatrix(true, false);
    _m.multiplyMatrices(this.inv, o.matrixWorld).decompose(_s, out, _s);
    return out;
  }
  /** Rotate `bone` by the rig-space rotation `qd` (weighted). */
  rotate(bone: Object3D, qd: Quaternion, w = 1) {
    const boneQ = this.quat(bone, new Quaternion());
    const parentQ = bone.parent ? this.quat(bone.parent, new Quaternion()) : new Quaternion();
    const local = parentQ.invert().multiply(qd.clone().multiply(boneQ));
    bone.quaternion.slerp(local, w);
    bone.updateMatrixWorld(true);
  }
  /** Point `bone` (whose child is `child`) so the bone→child direction goes toward the rig-space `target`. */
  aim(bone: Object3D, child: Object3D, target: Vector3, w = 1) {
    this.pos(bone, _a);
    this.pos(child, _b);
    const cur = _b.sub(_a).normalize();
    const des = _c.copy(target).sub(_a).normalize();
    this.rotate(bone, _q.setFromUnitVectors(cur, des), w);
  }
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
  private headLook = new HeadLook();
  private rig: Rig;
  private lookT: LookTarget = { yaw: 0, pitch: 0, valid: false };
  private bodyYaw = 0;
  private bodyYawSet = false;
  /** last frame's look step (rad) and the largest seen; read by the frame-stepping checks */
  lookStep = 0;
  maxLookStep = 0;
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
    this.rig = new Rig(this.model);
    for (const n of ['Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm']) {
      const b = this.bones[n];
      if (b) this.clipPose.set(b, b.quaternion.clone());
    }
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

  /** First candidate clip this GLB actually has (falls back to idle). */
  private resolveClip(hint: AnimHint, role: PlayerRole): string {
    for (const n of clipCandidates(hint, role)) if (this.actions.has(n)) return n;
    return 'idle';
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
    // walking up to / away from the box swings the head from forward to the stance's over-the-shoulder look: blend that slowly
    const stanceBlend = snap.role === 'batter' && (name === 'swing' || name === 'batting_stance' || this.currentName === 'swing' || this.currentName === 'batting_stance');
    if (this.current) this.current.crossFadeTo(a, stanceBlend ? 0.3 : LOOPING.has(name) ? 0.2 : 0.1, false);
    this.current = a;
    this.currentName = name;
  }

  /**
   * Left-handers are the right-handed model mirrored across X (`scale.x = -1`). The jersey digits are skinned quads, so they cannot
   * be flipped on their own: instead the texture is flipped inside its cell and the two quads swap digits.
   */
  private mirrored = false;
  private setMirrored(m: boolean) {
    if (m === this.mirrored && this.model.scale.x === (m ? -1 : 1)) return;
    this.mirrored = m;
    this.model.scale.x = m ? -1 : 1;
    this.numberSet = -1;
    this.setNumber(this.numberValue);
  }
  private numberValue: number | undefined;

  /** Jersey number quads: two textured digits (cells of number_digits.png; defaults tens=2, ones=7). */
  private setNumber(n: number | undefined) {
    this.numberValue = n;
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
        const uv = mesh.geometry.getAttribute('uv');
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < (uv?.count ?? 0); i++) {
          lo = Math.min(lo, uv.getX(i));
          hi = Math.max(hi, uv.getX(i));
        }
        mesh.userData.uvSpan = Number.isFinite(lo) ? lo + hi : 0;
        mesh.userData.repeatX = m.map ? m.map.repeat.x : 1;
      }
      const m = mesh.userData.numMat as MeshStandardMaterial;
      mesh.material = m;
      if (m.map) {
        const r = mesh.userData.repeatX as number;
        const off = (digit - def) / 10;
        if (this.mirrored) {
          m.map.repeat.x = -r;
          m.map.offset.x = off + (mesh.userData.uvSpan as number) * r;
        } else {
          m.map.repeat.x = r;
          m.map.offset.x = off;
        }
        m.map.needsUpdate = true;
      }
    };
    const show = v >= 0;
    const t = Math.floor(v / 10) % 10, o = v % 10;
    if (this.mirrored) {
      apply(tens, o, 2, show);
      apply(ones, t, 7, show && v >= 10);
    } else {
      apply(tens, t, 2, show && v >= 10);
      apply(ones, o, 7, show);
    }
  }

  update(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    this.setNumber(snap.number);
    this.setMirrored(snap.hand === 'L');
    const name = this.resolveClip(snap.anim, snap.role);
    if (snap.anim !== this.lastHint || name !== this.currentName) {
      this.lastHint = snap.anim;
      this.play(name, snap);
    }
    const stanceHeld = snap.role === 'batter' && (snap.anim === 'idle' || snap.anim === 'swing');
    if (stanceHeld && snap.anim === 'idle' && this.currentName === 'swing' && this.current) {
      this.current.timeScale = 0; // no dedicated stance clip: hold frame 0 of the swing
      this.current.time = 0;
    } else if ((name === 'run' || name === 'trot' || name === 'run_turn') && this.current) {
      const sp = Math.hypot(snap.vel.x, snap.vel.z);
      const nominal = name === 'trot' ? 2.2 : 4.5; // foot speed of the trot clip is 2.2 m/s
      this.current.timeScale = Math.min(1.8, Math.max(0.5, sp / nominal));
    } else if (this.current) this.current.timeScale = 1;
    // sim-driven clip time: when the sim reports progress through a one-shot animation, seek to it
    if (this.current && snap.animProgress !== undefined && !LOOPING.has(this.currentName)) {
      const dur = this.current.getClip().duration;
      this.current.paused = false;
      this.current.timeScale = 0;
      this.current.time = Math.min(dur - 0.001, Math.max(0, snap.animProgress * dur));
    }
    // ROOT CAUSE of the spinning heads: three's mixer only writes a bone when the clip value changed since last frame, so on a held
    // pose (stance frame 0, paused / progress-seeked clips) our look / IK rotation from the previous frame stayed on the bone and
    // was applied again on top, every frame. Put every bone we modify back to its clip pose before the mixer runs.
    for (const [bone, q] of this.clipPose) bone.quaternion.copy(q);
    this.mixer.update(dt);
    for (const [bone, q] of this.clipPose) q.copy(bone.quaternion);

    // Body yaw. In the box the sim turns the batter toward the pitcher (its `facing` is a look direction), but a hitter stands
    // sideways, chest toward the plate, and only turns his head. Everywhere else the sim's facing is the body's.
    const wantYaw = stanceHeld ? stanceYaw(snap.hand) : snap.facing;
    if (!this.bodyYawSet) {
      this.bodyYaw = wantYaw;
      this.bodyYawSet = true;
    } else {
      let d = wantYaw - this.bodyYaw;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      const maxTurn = stanceHeld || this.wasStance ? 9 * dt : Infinity; // ease between the walk-up / run facing and the stance
      this.bodyYaw += Math.abs(d) > maxTurn ? Math.sign(d) * maxTurn : d;
    }
    this.wasStance = stanceHeld || (this.wasStance && Math.abs(wantYaw - this.bodyYaw) > 0.01);
    this.root.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
    this.root.rotation.y = this.bodyYaw;
    this.root.updateMatrixWorld(true);
    this.rig.refresh();

    // arm IK: batter's hands follow the sim's bat
    const wantIK = !!(env.batGrip && snap.role === 'batter');
    // grab the sim's bat almost at once (the swing starts abruptly), let go smoothly
    this.ikW += ((wantIK ? 1 : 0) - this.ikW) * (1 - Math.exp(-dt * (wantIK ? 90 : 25)));
    if (this.ikW > 0.02 && env.batGrip) {
      // the hand nearest the knob is the model's Left hand for both batting sides (lefties are mirrored)
      this.solveArm('Left', env.batGrip.bottom, this.ikW);
      this.solveArm('Right', env.batGrip.top, this.ikW);
    }
    this.lookAt(snap, dt, env);
  }
  private wasStance = false;
  private warnedLook = false;
  /** bones modified after the mixer (look-at, arm IK) → their pose as the clip left them this frame */
  private clipPose = new Map<Bone, Quaternion>();

  shoulderCenter(out: Vector3): Vector3 | null {
    const l = this.bones.LeftArm, r = this.bones.RightArm;
    if (!l || !r) return null;
    return out.copy(l.getWorldPosition(new Vector3())).add(r.getWorldPosition(new Vector3())).multiplyScalar(0.5);
  }

  private solveArm(side: 'Left' | 'Right', targetWorld: Vector3, w: number) {
    const arm = this.bones[`${side}Arm`], fore = this.bones[`${side}ForeArm`], hand = this.bones[`${side}Hand`];
    if (!arm || !fore || !hand) return;
    const rig = this.rig;
    const target = rig.toRig(targetWorld, new Vector3());
    const S = rig.pos(arm, new Vector3());
    const E0 = rig.pos(fore, new Vector3());
    const H0 = rig.pos(hand, new Vector3());
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
    rig.aim(arm, fore, E, w);
    rig.aim(fore, hand, target, w);
  }

  /**
   * Head look-at, done in rig space relative to the upper spine: the target's yaw/pitch is clamped to human limits, ignored when
   * it is behind the player / too close / the player is idling with a dead ball, and eased with a speed-limited critically
   * damped spring (see headLook.ts). The yaw is shared between the spine, neck and head.
   */
  private lookAt(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    const head = this.bones.Head, neck = this.bones.Neck, spine = this.bones.Spine2 ?? this.bones.Spine1;
    if (!head || !neck || !spine) return;
    const rig = this.rig;
    // idle players with nothing moving forget the ball and look ahead
    const still = (snap.anim === 'idle' || snap.anim === 'celebrate') && Math.hypot(snap.vel.x, snap.vel.z) < 0.3;
    const live = env.ball && !(still && (env.ballSpeed ?? 99) < 0.5 && snap.role !== 'batter' && snap.role !== 'catcher' && snap.role !== 'umpire');
    const focus = live ? env.ball : env.mound ?? null;
    let t: LookTarget | null = null;
    if (focus) {
      const hp = rig.pos(head, _a);
      const fp = rig.toRig(focus, _b);
      const dv = fp.sub(hp);
      // into the upper spine's frame (its clip pose, before any look rotation): lean / twist of the torso is respected
      const sq = rig.quat(spine, _q).invert();
      dv.applyQuaternion(sq);
      // where the clip itself already points the head (relative to the same spine frame), so we only add the difference
      const hq = rig.quat(head, _q2).premultiply(sq);
      _c.set(0, 0, 1).applyQuaternion(hq);
      const cy = Math.atan2(_c.x, _c.z), cp = Math.atan2(-_c.y, Math.hypot(_c.x, _c.z));
      t = lookTarget(dv.x, dv.y, dv.z, cy, cp, this.lookT);
    }
    const hl = this.headLook;
    hl.step(t, dt);
    this.lookStep = hl.lastStep;
    this.maxLookStep = Math.max(this.maxLookStep, hl.lastStep);
    // debug assertion: the look offset can never move faster than its speed cap (a spike here means a target or spring bug)
    if (import.meta.env?.DEV && hl.lastStep > maxLookStep(Math.min(dt, 0.1)) * 1.01 && !this.warnedLook) {
      this.warnedLook = true;
      console.error(`[head-look] ${snap.id} moved ${hl.lastStep.toFixed(3)} rad in one step (cap ${maxLookStep(dt).toFixed(3)})`);
    }
    if (Math.abs(hl.yaw) < 1e-4 && Math.abs(hl.pitch) < 1e-4) return;
    const { spine: spineYaw, neckHeadYaw } = hl.split();
    // yaw about the spine frame's up axis, pitch about its left/right axis; neck 40 %, head 60 %
    const apply = (bone: Object3D, yaw: number, pitch: number) => {
      const S = rig.quat(spine, new Quaternion()); // re-read: the spine twist above changes the frame the neck and head turn in
      _q2.setFromAxisAngle(UP, yaw).multiply(_q.setFromAxisAngle(RIGHT, pitch));
      rig.rotate(bone, S.clone().multiply(_q2).multiply(S.clone().invert()));
    };
    if (Math.abs(spineYaw) > 1e-4) apply(spine, spineYaw, 0);
    apply(neck, neckHeadYaw * 0.4, hl.pitch * 0.4);
    apply(head, neckHeadYaw * 0.6, hl.pitch * 0.6);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
