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
import { AnimationClip } from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterTemplate, GearSets } from './assets';
import type { AnimHint, PlayerRole, PlayerSnap } from './types';
import { reg, type Look, type PuppetEnv, type PuppetLike } from './characters';
import { HeadLook, lookTarget, maxLookStep, type LookTarget } from './headLook';
import { swivelElbow, torsoClearance, torsoVolume, type TorsoVolume, type V3 } from './armClear';
import { computeLook, hashString, type PlayerLook } from './playerLook';
import { deliveryClip, deliveryClipTime, gripFor, pitchBallPlace, planDelivery, windupSeconds, type BallPlace, type DeliveryEvents, type DeliveryPlan } from './pitchTiming';

const LOOPING = new Set(['idle', 'run', 'trot', 'run_turn', 'walk', 'field_ready', 'field_ready_infield', 'field_ready_outfield', 'field_ready_hands_knees', 'celebrate', 'catcher_crouch', 'batting_stance', 'pitcher_rock', 'pitcher_set', 'ump_ready']);
const FIELDERS = new Set<PlayerRole>(['first', 'second', 'third', 'short', 'left', 'center', 'right']);
const SKINS = ['#f0c6a0', '#dca47a', '#c08558', '#8a5a3a', '#5d3b26', '#e8b48a'];

/** Preferred clip per hint, then fallbacks for clips that a given GLB may not contain (older exports). */
export function clipCandidates(hint: AnimHint, role: PlayerRole): string[] {
  switch (hint) {
    case 'windup': return ['windup'];
    case 'pitch': return ['pitch'];
    case 'swing': return ['swing'];
    case 'run': return ['run'];
    case 'trot': return ['trot', 'run'];
    case 'run_turn': return ['run_turn', 'run'];
    case 'field': case 'catch': return ['field_catch'];
    case 'catch_jump': return ['catch_jump', 'field_catch'];
    case 'walk': return ['walk', 'trot', 'run'];
    case 'transfer': return ['transfer', ...idleFor(role)];
    case 'toss': return ['toss', 'throw'];
    case 'catch_pitch': case 'catch_throw': case 'catch_stretch': case 'catch_fly': case 'catch_backhand': return [hint, 'field_catch'];
    case 'field_grounder': return ['field_grounder', 'field_catch'];
    case 'tag_glove': case 'tag_hand': return [hint, 'field_catch'];
    case 'slide_feet': case 'slide_head': case 'slide_hook_left': case 'slide_hook_right': return [hint, 'slide'];
    case 'dive_back': return ['dive_back', 'slide'];
    case 'catcher_block': return ['catcher_block', 'catcher_crouch'];
    case 'ump_strike': case 'ump_strike_swinging': case 'ump_ball': case 'ump_safe': case 'ump_out': case 'ump_foul': case 'ump_fair': case 'ump_homerun': case 'ump_time': return [hint, 'idle'];
    case 'ump_ready': return ['ump_ready', 'idle'];
    case 'throw': return ['throw'];
    case 'slide': return ['slide'];
    case 'celebrate': return ['celebrate', 'idle'];
    default: return idleFor(role);
  }
}

/** the standing pose of a role between plays (frame 0 of the swing is the batting stance until a `batting_stance` clip exists) */
function idleFor(role: PlayerRole): string[] {
  if (role === 'batter') return ['batting_stance', 'swing'];
  if (role === 'catcher') return ['catcher_crouch'];
  if (role === 'pitcher') return ['idle'];
  if (role === 'first' || role === 'second' || role === 'third' || role === 'short') return ['field_ready_infield', 'field_ready', 'idle'];
  if (role === 'left' || role === 'center' || role === 'right') return ['field_ready_outfield', 'field_ready', 'idle'];
  return ['idle'];
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

/**
 * Ground speed (m/s) at which a locomotion clip's stance foot stops sliding: the median backward speed of a foot that is on the
 * ground, measured from the clip itself once (so it stays right when the clips are re-authored). Playing the clip at
 * `speed / stanceFootSpeed` keeps the feet planted.
 */
const footSpeedCache = new WeakMap<AnimationClip, number>();
export function stanceFootSpeed(scene: Object3D, clip: AnimationClip, fallback: number): number {
  const hit = footSpeedCache.get(clip);
  if (hit !== undefined) return hit;
  let result = fallback;
  try {
    // measured on a throwaway clone: posing the template or a live puppet would leave stale bone poses behind (the mixer skips unchanged bones)
    scene = SkeletonUtils.clone(scene);
    const feet: Object3D[] = [];
    scene.traverse((o) => {
      if (/(Left|Right)Foot$/.test(o.name)) feet.push(o);
    });
    if (feet.length === 2) {
      const mixer = new AnimationMixer(scene);
      const act = mixer.clipAction(clip);
      act.play();
      const N = 48;
      const zs: number[][] = [[], []], ys: number[][] = [[], []];
      const v = new Vector3();
      for (let i = 0; i < N; i++) {
        act.time = (i / N) * clip.duration * 0.999;
        mixer.update(0);
        scene.updateMatrixWorld(true);
        feet.forEach((f, k) => {
          v.setFromMatrixPosition(f.matrixWorld);
          ys[k].push(v.y);
          zs[k].push(v.z);
        });
      }
      const dt = clip.duration / N;
      const sp: number[] = [];
      for (let k = 0; k < 2; k++) for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        if (ys[k][i] < 0.12 && ys[k][j] < 0.12) sp.push(-(zs[k][j] - zs[k][i]) / dt);
      }
      sp.sort((a, b) => a - b);
      if (sp.length > 6) result = Math.max(0.3, sp[Math.floor(sp.length * 0.6)]);
      mixer.stopAllAction();
      mixer.uncacheClip(clip);
    }
  } catch {
    /* keep the fallback */
  }
  footSpeedCache.set(clip, result);
  return result;
}

type GearKind = 'field' | 'batter' | 'catcher';
const gearKindOf = (role: PlayerRole): GearKind => (role === 'batter' || role === 'runner' || role === 'coach' ? 'batter' : role === 'catcher' ? 'catcher' : 'field');
const HAIR_NODES = ['Gear_Hair', 'Gear_Hair_Buzz', 'Gear_Hair_Curly', 'Gear_Hair_Long'];
const FACIAL_NODES = ['Gear_Beard_Stubble', 'Gear_Beard_Full', 'Gear_Goatee', 'Gear_Mustache'];
const JERSEY_NODES = ['Jersey', 'Jersey_ShortSleeve', 'Jersey_Sleeveless'];
const PANTS_NODES = ['Pants', 'Pants_Long'];
const TRIM_WHITE = '#f2f2ee', TRIM_BLACK = '#17181b';

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
  private nodes = new Map<string, Object3D>();
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
  /** per-player look (null for the fixed umpire file) */
  look: PlayerLook | null = null;
  private gearKind: GearKind | null = null;
  private bodyScale = 1;
  // pitching
  private dlv: { ev: DeliveryEvents; plan: DeliveryPlan; dur: number; grip: string } | null = null;
  private ballObj: Object3D | null = null;
  private ballPlace: BallPlace | 'none' | 'transfer' = 'none';
  private ballGrip = 'Ball_Grip';
  ballHeld = false;
  private torso: TorsoVolume = torsoVolume(undefined);
  /** smallest elbow-to-trunk clearance (m) this frame and over the puppet's life; negative = an elbow inside the torso */
  elbowClear = Infinity;
  minElbowClear = Infinity;
  private warnedElbow = false;
  /** the clip time the pitching state machine is seeking to (null: not driving the clip) */
  pitchClipTime: number | null = null;

  constructor(private tpl: CharacterTemplate, snap: PlayerSnap, private gearSets: GearSets = {}) {
    const id = snap.id;
    this.model = SkeletonUtils.clone(tpl.scene);
    this.root.add(this.model);
    this.model.traverse((o) => {
      if (o.name) this.nodes.set(o.name, o);
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
    const h = hashString(id);
    this.skin = SKINS[h % SKINS.length];
    if (tpl.full) {
      this.look = computeLook(snap.physique, snap.appearance, h);
      this.skin = this.look.skin;
      this.bodyScale = this.look.scale;
      this.applyMorphs(this.look.morphs);
      this.torso = torsoVolume(this.look.morphs);
      this.applyGear(gearKindOf(snap.role));
    } else {
      // fixed-look files (umpires): keep their configuration, hair hidden under caps / helmets
      const hair = this.nodes.get('Gear_Hair') ?? this.nodes.get('Face_Hair');
      if (hair && (this.nodes.get('Gear_Cap') || this.nodes.get('Gear_Helmet'))) hair.visible = false;
    }
  }

  private applyMorphs(morphs: Record<string, number>) {
    for (const m of this.meshes) {
      const dict = (m as Mesh).morphTargetDictionary, inf = (m as Mesh).morphTargetInfluences;
      if (!dict || !inf) continue;
      for (const k in morphs) {
        const i = dict[k];
        if (i !== undefined) inf[i] = morphs[k];
      }
    }
  }

  /**
   * Which optional nodes are visible: the role's pre-configured look (from the role-specific files' extras) plus this player's own
   * hair / beard / sleeve length / accessories. Re-run when his role class changes (batter → fielder etc.).
   */
  private applyGear(kind: GearKind) {
    if (!this.look || kind === this.gearKind) return;
    this.gearKind = kind;
    const L = this.look;
    const defaults = this.gearSets[kind] ?? this.gearSets.field ?? this.tpl.defaults;
    for (const [name, o] of this.nodes) {
      const grp = o.userData?.cb_group;
      if (grp === undefined || grp === 'hand') continue;
      o.visible = defaults.has(name);
    }
    const show = (name: string, on: boolean) => {
      const o = this.nodes.get(name);
      if (o) o.visible = on;
    };
    // clothes variants
    if (this.nodes.get('Jersey')?.visible || this.nodes.get('Jersey_ShortSleeve')?.visible || this.nodes.get('Jersey_Sleeveless')?.visible) {
      for (const n of JERSEY_NODES) show(n, n === L.jerseyNode);
    }
    for (const n of PANTS_NODES) show(n, n === L.pantsNode);
    // head: hair only when no cap / helmet covers it; beard, mustache, eye black on top
    const headwear = !!(this.nodes.get('Gear_Cap')?.visible || this.nodes.get('Gear_Helmet')?.visible);
    for (const n of HAIR_NODES) show(n, !headwear && n === L.hairNode);
    for (const n of FACIAL_NODES) show(n, n === L.facialNode);
    show('Gear_EyeBlack', L.eyeBlack && kind !== 'catcher');
    // arms
    show('Gear_Wristband_L', L.wristbands.L);
    show('Gear_Wristband_R', L.wristbands.R);
    show('Gear_ArmSleeve_L', L.armSleeves.L && kind !== 'batter');
    show('Gear_ArmSleeve_R', L.armSleeves.R && kind !== 'batter');
    // hands: fist (bat, glove hand) unless the pitcher is gripping a ball
    this.setGripHand(false);
    this.materialsDirty = true;
  }
  private materialsDirty = false;
  private lastLook: { look: Look; team: number } | null = null;

  private setGripHand(ball: boolean) {
    const fist = this.nodes.get('Hand_R'), claw = this.nodes.get('Hand_R_Ball');
    if (!claw) return; // umpire-style files: Hand_R is the only hand
    if (fist) fist.visible = !ball;
    claw.visible = ball;
  }

  setTeam(look: Look, team: number) {
    this.team = team;
    this.lastLook = { look, team };
    const L = this.look;
    const trimOf = (c: 'trim' | 'white' | 'black') => (c === 'trim' ? look.sock : c === 'white' ? TRIM_WHITE : TRIM_BLACK);
    const map: Record<string, string> = {
      uniform_jersey: look.jersey, uniform_pants: look.pants, uniform_socks: look.sock, uniform_undershirt: look.sock, cap: look.cap, helmet: look.cap, piping: look.sock,
    };
    if (L) {
      map.hair = L.hairColor;
      map.stubble = L.hairColor;
      map.wristband = trimOf(L.wristbandColor);
      map.arm_sleeve = trimOf(L.sleeveColor);
      map.batting_glove = L.battingGlove;
    }
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
    this.materialsDirty = false;
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
  private mirrorSet = false;
  private setMirrored(m: boolean) {
    if (this.mirrorSet && m === this.mirrored) return;
    const changed = m !== this.mirrored;
    this.mirrorSet = true;
    this.mirrored = m;
    // uniform scale from the player's height, mirrored across X for left-handers
    this.model.scale.set(m ? -this.bodyScale : this.bodyScale, this.bodyScale, this.bodyScale);
    if (changed) {
      this.numberSet = -1;
      this.setNumber(this.numberValue);
    }
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

  /** Locomotion hint adjusted to the real speed: creeping players walk, they do not slide in a stance. */
  private moveHint(snap: PlayerSnap): AnimHint {
    const sp = Math.hypot(snap.vel.x, snap.vel.z);
    // no walk clip in older GLBs: the (slowed) trot is the next best thing to a slide in a stance
    const slow: AnimHint | null = this.actions.has('walk') ? 'walk' : this.actions.has('trot') ? 'trot' : null;
    if (slow && (snap.anim === 'run' || snap.anim === 'trot') && sp < 1.9) return slow;
    if (slow && snap.anim === 'idle' && sp > (slow === 'walk' ? 0.3 : 0.6) && snap.role !== 'batter' && snap.role !== 'umpire' && snap.role !== 'catcher') return slow;
    return snap.anim;
  }

  /**
   * Pitching: which delivery clip (style × windup / stretch), where it is, and where the ball is. The sim's windup ends exactly at
   * release, so the rock / set pose is held and the delivery is timed so its release frame lands on that moment (see pitchTiming.ts).
   * Returns null when the pitcher has no delivery info or the GLB lacks the clips (the old `windup` / `pitch` clips take over).
   */
  private pitcherPlan(snap: PlayerSnap): { name: string; time: number | null; place: BallPlace | 'none' } | null {
    const d = snap.delivery;
    if (!d) return null;
    const idle = d.fromStretch && this.actions.has('pitcher_set') ? 'pitcher_set' : this.actions.has('pitcher_rock') ? 'pitcher_rock' : null;
    if (!idle) return null;
    if (snap.anim === 'windup' || snap.anim === 'pitch') {
      if (snap.anim === 'windup' && (!this.dlv || this.lastHint !== 'windup')) {
        const ev = deliveryClip(d.style, d.fromStretch);
        if (!this.actions.has(ev.clip)) return null;
        const dur = snap.animDur ?? windupSeconds(d.tempo, d.fromStretch, snap.ratings?.holding ?? 50);
        this.dlv = { ev, plan: planDelivery(dur, ev.release), dur, grip: gripFor(snap.pitchType) };
      }
      const dl = this.dlv;
      if (!dl) return null;
      if (snap.anim === 'windup') {
        const t = deliveryClipTime(dl.plan, (snap.animProgress ?? 0) * dl.dur);
        return t === null ? { name: idle, time: null, place: 'glove' } : { name: dl.ev.clip, time: t, place: pitchBallPlace(t, dl.ev) };
      }
      // follow-through: the sim's `pitch` hint runs 0.5 s after the release
      return { name: dl.ev.clip, time: dl.ev.release + (snap.animProgress ?? 0) * 0.5 * dl.plan.speed, place: 'world' };
    }
    this.dlv = null;
    if (snap.anim === 'idle') return { name: idle, time: null, place: snap.hasBall ? 'glove' : 'none' };
    return null;
  }

  update(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    this.setNumber(snap.number);
    this.setMirrored(snap.hand === 'L');
    if (this.look) this.applyGear(gearKindOf(snap.role));
    const pit = snap.role === 'pitcher' ? this.pitcherPlan(snap) : null;
    const hint = this.moveHint(snap);
    const name = pit ? pit.name : this.resolveClip(hint, snap.role);
    this.pitchClipTime = pit ? pit.time : null;
    if (snap.anim !== this.lastHint || name !== this.currentName || (hint !== snap.anim && hint !== this.lastMoveHint)) {
      this.play(name, snap);
    }
    this.lastHint = snap.anim;
    this.lastMoveHint = hint;
    const stanceHeld = snap.role === 'batter' && (snap.anim === 'idle' || snap.anim === 'swing');
    const sp = Math.hypot(snap.vel.x, snap.vel.z);
    const locomotion = name === 'run' || name === 'trot' || name === 'run_turn' || name === 'walk';
    if (pit && pit.time !== null && this.current) {
      // seek: the delivery clip is placed exactly on the sim's timeline
      const dur = this.current.getClip().duration;
      this.current.paused = false;
      this.current.timeScale = 0;
      this.current.time = Math.min(dur - 0.001, Math.max(0, pit.time));
    } else if (stanceHeld && snap.anim === 'idle' && this.currentName === 'swing' && this.current) {
      this.current.timeScale = 0; // no dedicated stance clip: hold frame 0 of the swing
      this.current.time = 0;
    } else if (locomotion && this.current) {
      // no foot sliding: play the clip at (ground speed / the speed its stance foot moves back at)
      const fallback = name === 'trot' ? 2.2 : name === 'walk' ? 1.4 : 1.6;
      const foot = stanceFootSpeed(this.tpl.scene, this.current.getClip(), fallback);
      this.current.timeScale = Math.min(name === 'walk' ? 1.7 : 2.4, Math.max(0.4, sp / foot));
    } else if (this.current) this.current.timeScale = name === 'toss' ? 0.75 : 1;
    // sim-driven clip time: when the sim reports progress through a one-shot animation, seek to it
    if (!pit && this.current && snap.animProgress !== undefined && !LOOPING.has(this.currentName)) {
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
      // turning is limited to ~540 deg/s (a runner does not spin on the spot); the stance transition is a little slower still
      const maxTurn = (stanceHeld || this.wasStance ? 9 : 9.4) * dt;
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
    this.reachIK(snap, env, dt);
    this.lookAt(snap, dt, env);
    this.clearElbows(snap);
    let place: BallPlace | 'none' | 'transfer' = pit ? pit.place : snap.anim === 'transfer' ? 'transfer' : 'none';
    if (place === 'none' && snap.hasBall && snap.role !== 'batter' && snap.role !== 'runner' && snap.role !== 'umpire') {
      // a fielder who holds the ball has it in the glove pocket; while he throws it stays in his hand until the sim releases it
      place = snap.anim === 'throw' || snap.anim === 'toss' ? 'hand' : 'glove';
    }
    this.updateHeldBall(snap, env, place, dt);
  }
  private wasStance = false;
  private lastMoveHint: AnimHint | '' = '';
  private warnedLook = false;
  /** bones modified after the mixer (look-at, arm IK) → their pose as the clip left them this frame */
  private clipPose = new Map<Bone, Quaternion>();

  private static readonly CATCH_HINTS = new Set<AnimHint>(['catch', 'field', 'catch_pitch', 'catch_throw', 'catch_stretch', 'catch_fly', 'catch_backhand', 'field_grounder', 'catch_jump']);
  private gloveW = 0;
  private gloveClosed = 0;

  /**
   * Reaching for a ball or a runner: the glove hand goes to where the sim says the ball will meet the glove (`gloveTarget`), so the pocket is
   * at the ball at the catch instant, and closes on it; a tag sweeps the glove (or bare hand) through the nearest opposing runner.
   */
  private reachIK(snap: PlayerSnap, env: PuppetEnv, dt: number) {
    const catching = GltfPuppet.CATCH_HINTS.has(snap.anim) && !!snap.gloveTarget;
    const tagging = snap.anim === 'tag_glove' || snap.anim === 'tag_hand';
    const p = snap.animProgress ?? 0.5;
    let target: Vector3 | null = null;
    let side: 'Left' | 'Right' = 'Left';
    let w = 0;
    if (catching) {
      target = new Vector3(snap.gloveTarget!.x, snap.gloveTarget!.y, snap.gloveTarget!.z);
      // reach out through the first half of the catch, then hold the pocket on the ball
      w = p < 0.15 ? p / 0.15 : 1;
    } else if (tagging && env.positions) {
      let best = 1e9;
      for (const [id, pos] of env.positions) {
        if (id === snap.id) continue;
        const d = Math.hypot(pos.x - snap.pos.x, pos.z - snap.pos.z);
        if (d < best && d < 2.6) {
          best = d;
          target = new Vector3(pos.x, 0.5, pos.z);
        }
      }
      side = snap.anim === 'tag_hand' ? 'Right' : 'Left';
      w = Math.sin(Math.PI * Math.min(1, Math.max(0, p))) ;
    }
    this.gloveW += ((target ? w : 0) - this.gloveW) * (1 - Math.exp(-dt * 40));
    if (target && this.gloveW > 0.02) {
      const hand = this.bones[`${side}Hand`];
      const pocket = side === 'Left' ? this.nodes.get('Glove_Pocket') : null;
      if (hand) {
        // put the POCKET (not the wrist) on the target: a few passes, since the pocket offset turns with the hand
        const goal = target;
        for (let it = 0; it < 3; it++) {
          this.rig.refresh();
          const hw = hand.getWorldPosition(new Vector3());
          const off = pocket ? pocket.getWorldPosition(new Vector3()).sub(hw) : new Vector3();
          this.solveArm(side, goal.clone().sub(off), this.gloveW);
        }
      }
    }
    // the glove closes as the ball arrives (optional `glove_closed` morph on the glove mesh)
    const closing = catching && p > 0.55 ? 1 : snap.hasBall && snap.role !== 'pitcher' ? 1 : 0;
    this.gloveClosed += (closing - this.gloveClosed) * 0.35;
    const glove = this.nodes.get('Gear_Glove') as Mesh | undefined;
    const gi = glove?.morphTargetDictionary?.glove_closed;
    if (glove && gi !== undefined && glove.morphTargetInfluences) glove.morphTargetInfluences[gi] = this.gloveClosed;
  }

  /**
   * Keep both elbows outside the torso (the trunk grows with the build morphs): an elbow that ended up inside, from the clip pose or from
   * the batter's hand IK, is pushed out radially and the forearm re-aimed at the hand, which stays where it was. Records the clearance.
   */
  private clearElbows(snap: PlayerSnap) {
    const spine = this.bones.Spine2;
    if (!spine) return;
    const rig = this.rig;
    this.rig.refresh();
    const Ps = rig.pos(spine, new Vector3());
    const Qi = rig.quat(spine, new Quaternion()).invert();
    let worst = Infinity;
    for (const side of ['Left', 'Right'] as const) {
      const arm = this.bones[`${side}Arm`], fore = this.bones[`${side}ForeArm`], hand = this.bones[`${side}Hand`];
      if (!arm || !fore || !hand) continue;
      const E = rig.pos(fore, new Vector3());
      const loc = E.clone().sub(Ps).applyQuaternion(Qi);
      let clear = torsoClearance(loc.x, loc.y, loc.z, this.torso);
      if (clear < 0.008 && !(globalThis as { __noElbowFix?: boolean }).__noElbowFix) {
        // swivel the elbow around the shoulder→hand axis: the hand stays where the clip / IK put it, only the elbow leaves the trunk
        const S = rig.pos(arm, new Vector3());
        const H = rig.pos(hand, new Vector3());
        const tmp = new Vector3();
        const clearAt = (p: V3) => {
          tmp.set(p[0], p[1], p[2]).sub(Ps).applyQuaternion(Qi);
          return torsoClearance(tmp.x, tmp.y, tmp.z, this.torso);
        };
        const r = swivelElbow([S.x, S.y, S.z], [H.x, H.y, H.z], [E.x, E.y, E.z], clearAt, 0.02);
        if (r.angle !== 0) {
          rig.aim(arm, fore, new Vector3(r.elbow[0], r.elbow[1], r.elbow[2]), 1);
          rig.aim(fore, hand, H, 1);
        }
        clear = r.clear;
      }
      worst = Math.min(worst, clear);
    }
    this.elbowClear = worst;
    this.minElbowClear = Math.min(this.minElbowClear, worst);
    if (import.meta.env?.DEV && worst < -0.04 && !this.warnedElbow) {
      this.warnedElbow = true;
      console.error(`[elbow] ${snap.id} elbow ${(-worst * 100).toFixed(1)} cm inside the torso (${snap.anim})`);
    }
  }

  /**
   * The ball a pitcher carries before release (in the glove until the hand break, then gripped in the throwing hand, whose claw mesh
   * replaces the fist) and the ball a fielder moves from glove to hand during a `transfer`. While the puppet has it the world ball is hidden.
   */
  private catchOff = new Vector3();
  private updateHeldBall(snap: PlayerSnap, env: PuppetEnv, place: BallPlace | 'none' | 'transfer', dt = 1 / 60) {
    const want = place === 'glove' || place === 'hand' || place === 'transfer';
    this.ballHeld = want && !!env.makeBall;
    if (this.look) this.setGripHand(place === 'hand');
    if (!this.ballHeld) {
      if (this.ballObj) this.ballObj.visible = false;
      this.ballPlace = 'none';
      return;
    }
    if (!this.ballObj) this.ballObj = env.makeBall!();
    const ball = this.ballObj;
    ball.visible = true;
    const pocket = this.nodes.get('Glove_Pocket');
    const grip = this.nodes.get(this.dlv?.grip ?? 'Ball_Grip') ?? this.nodes.get('Ball_Grip');
    if (!pocket || !grip) {
      this.ballHeld = false;
      ball.visible = false;
      return;
    }
    // real size and handedness whatever the player's height scale / mirror
    ball.scale.set((this.mirrored ? -1 : 1) / this.bodyScale, 1 / this.bodyScale, 1 / this.bodyScale);
    let target: Object3D | null = place === 'glove' ? pocket : place === 'hand' ? grip : null;
    let u = 0;
    if (place === 'transfer') {
      const p = snap.animProgress ?? 0;
      u = p <= 0.3 ? 0 : p >= 0.7 ? 1 : ((p - 0.3) / 0.4) * ((p - 0.3) / 0.4) * (3 - 2 * ((p - 0.3) / 0.4));
      if (u <= 0.001) target = pocket;
      else if (u >= 0.999) target = grip;
    }
    if (target) {
      if (ball.parent !== target) target.add(ball);
      if (place === 'glove' && this.ballPlace === 'none' && env.ball) {
        // the ball has just arrived in the glove: start from where the sim's ball is and let it settle into the pocket (no pop)
        target.updateWorldMatrix(true, false);
        const local = target.worldToLocal(env.ball.clone());
        this.catchOff.copy(local.length() < 1 ? local : this.catchOff.set(0, 0, 0));
      }
      ball.position.copy(this.catchOff);
      this.catchOff.multiplyScalar(Math.exp(-dt * 45));
      ball.quaternion.identity();
    } else {
      // mid-transfer: carried across in the model's own space
      if (ball.parent !== this.model) this.model.add(ball);
      this.rig.refresh();
      const a = this.rig.pos(pocket, new Vector3()), b = this.rig.pos(grip, new Vector3());
      ball.position.lerpVectors(a, b, u);
      ball.quaternion.identity();
    }
    this.ballPlace = place;
  }

  heldBallWorld(out: Vector3): Vector3 | null {
    if (!this.ballHeld || !this.ballObj) return null;
    this.ballObj.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.ballObj.matrixWorld);
  }

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
    this.ballObj?.removeFromParent();
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}

