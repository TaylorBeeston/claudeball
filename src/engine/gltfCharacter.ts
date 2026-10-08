/**
 * Skinned glTF player (Blender export, Mixamo-named 22-bone rig) driven by the sim's animation
 * hints through an AnimationMixer. Root motion is the sim's position; head lookAt and arm IK
 * (batter's hands to the sim's bat) are applied on top of the mixer output each frame.
 */
import { FEATHERED, addEdgeAttribute } from './facialHair';
import {
  AnimationAction,
  AnimationMixer,
  Bone,
  Color,
  BufferAttribute,
  BufferGeometry,
  Group,
  LoopOnce,
  LoopRepeat,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Object3D,
  Quaternion,
  Sphere,
  Vector3,
} from 'three';
import { AnimationClip, SkinnedMesh } from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FLAGS } from './flags';
import { perf } from './perf';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CharacterTemplate, GearSets, PlayerManifest } from './assets';
import type { AnimHint, PlayerRole, PlayerSnap } from './types';
import { reg, type Look, type PuppetEnv, type PuppetLike } from './characters';
import { readyGlove, receiveReady } from './receiveReady';
import { makeOnDeckBat } from './ondeckProp';
import { DECAL_NODES, JerseyTextures, decalRange, jerseyPrint, jerseyQuality, type DecalKind } from './jerseyText';
import { makeCorneaShell, shadeHair, shadeSkin, shadingTier, upgradeMaterial } from './characterShading';
import { HeadLook, lookTarget, maxLookStep, type LookTarget } from './headLook';
import { armHeadClearance, headVolume, swivelElbow, torsoClearance, torsoVolume, type HeadVolume, type TorsoVolume, type V3 } from './armClear';
import { computeLook, hashString, type PlayerLook } from './playerLook';
import { deliveryClip, deliveryClipTime, gripFor, pitchBallPlace, planDelivery, windupSeconds, type BallPlace, type DeliveryEvents, type DeliveryPlan } from './pitchTiming';

const LOOPING = new Set(['idle', 'run', 'trot', 'jog', 'run_sprint', 'run_turn', 'run_turn_sprint', 'walk', 'field_ready', 'field_ready_infield', 'field_ready_outfield', 'field_ready_hands_knees', 'celebrate', 'catcher_crouch', 'batting_stance', 'pitcher_rock', 'pitcher_set', 'ump_ready', 'ump_set_base', 'bench_sit', 'ondeck_ready', 'ondeck_stretch', 'coach_ready', 'coach_go_loop', 'ballkid_sit', 'catch_ready']);
const FIELDERS = new Set<PlayerRole>(['first', 'second', 'third', 'short', 'left', 'center', 'right']);
/** roles that are scenery rather than play: they drop to level of detail 1 when far from the camera */
export const AMBIENT_ROLES = new Set<PlayerRole>(['bench', 'manager', 'pitchcoach', 'ballkid', 'batboy', 'coach1b', 'coach3b', 'coach', 'ondeck']);
export const LOD1_DISTANCE = 42;
/** `lodK` (1 / (2 tan(fov / 2))) of a 40 deg lens, the reference the decal ranges are measured for */
const LOD_K_NORMAL = 1 / (2 * Math.tan((40 * Math.PI) / 360));
/**
 * Parts that cast no shadow: tiny details, thin cards and things hidden under other parts. Every caster is one more draw call in each shadow cascade,
 * so only the shapes that read in a shadow (body, head, hair, jersey, pants, cap / helmet, cleats, hands, gloves, gear) remain.
 */
const NO_SHADOW = /^(Eyes|Gear_Buttons|Gear_Piping|Gear_Laces|Gear_Soles|Gear_BeltBuckle|Gear_Number_|Gear_Glove.*Laces|Gear_EyeBlack|Gear_Wristband|Gear_Beard_Stubble|Gear_Mustache|Gear_Eyebrows|Gear_Eyelashes|Gear_CapLogo|Gear_Spikes|Gear_Collar|Undershirt|Gear_Belt$|Socks|Gear_Goatee|Jersey_.*Decal)/;
/** parts left out of the merged shadow / depth proxy (alpha cards and the like: they would need an alpha-tested depth material) */
const PROXY_SKIP = /^(Gear_Hair|Face_Hair|Gear_Beard|Hair|Eyes_Cornea)/;
/** one shared material for every proxy: it never draws colour (the proxy is only visible during the shadow and the GTAO depth/normal passes) */
const proxyMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
proxyMaterial.name = 'shadow_proxy';
/** parts the GTAO depth/normal prepass skips: details, cards and thin layers (the proxy stands in for none of them: they are simply not part of the occlusion) */
const GBUF_SKIP = /^(Eyes|Gear_Buttons|Gear_Piping|Gear_Laces|Gear_Soles|Gear_BeltBuckle|Gear_Number_|Gear_Glove.*Laces|Gear_EyeBlack|Gear_Wristband|Gear_Beard|Gear_Mustache|Gear_Eyebrows|Gear_Eyelashes|Gear_CapLogo|Gear_Spikes|Gear_Collar|Undershirt|Gear_Belt|Socks|Gear_Goatee|Gear_Hair|Face_Hair|Hair)/;
/** puppet level of detail: parts dropped from tier 1 (small on screen) and from tier 2 (tiny), by mesh name; the rest always draws */
const LOD_TIER1 = /^(Eyes_Cornea|Gear_Eyebrows|Gear_Eyelashes|Gear_Buttons|Gear_Piping|Gear_BeltBuckle|Gear_Soles|Gear_Spikes|Gear_Wristband|Gear_EyeBlack|Gear_Beard_Stubble|Gear_Mustache|Gear_Glove.*Laces|Gear_CapLogo|Jersey_(BackName|FrontNumber|SleeveNumber)Decal)/;
const LOD_TIER2 = /^(Jersey_BackNumberDecal|Eyes$|Gear_Belt$|Gear_Collar|Undershirt|Gear_Number_|Gear_Goatee|Gear_ArmSleeve)/;
/** layer bit the camera does not see: a part moved there is skipped by the main pass, the GTAO prepass and every shadow cascade without touching `visible` */
const HIDDEN_LAYERS = 1 << 1;
/** roles and moments that must always be animated in full (they hold or interact with the ball / bat): everyone else may be simplified when unseen or tiny */
function puppetIsKey(snap: PlayerSnap, env: PuppetEnv): boolean {
  if (snap.role === 'batter' || snap.role === 'runner' || snap.role === 'pitcher' || snap.role === 'catcher' || snap.role === 'ondeck') return true;
  if (snap.hasBall || snap.gloveTarget || env.carrier?.id === snap.id) return true;
  return /^(catch|throw|tag|transfer|dive|slide|field|toss)/.test(snap.anim);
}
/** the culling sphere of a puppet (see `setCullBounds`): centre height and radius, metres */
const CULL_CENTER_Y = 0.95;
const CULL_RADIUS = 2.1;

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
    case 'toss': return ['throw_casual', 'toss', 'throw'];
    case 'throw_casual': return ['throw_casual', 'throw'];
    case 'toss_underhand': return ['toss_underhand', 'ballkid_toss', 'throw_casual', 'throw'];
    case 'toss_sidearm_short': return ['toss_sidearm_short', 'throw_casual', 'throw'];
    case 'roll_ball': return ['roll_ball', 'toss_underhand', 'ballkid_toss', 'throw_casual'];
    case 'catch_pitch': case 'catch_throw': case 'catch_stretch': case 'catch_fly': case 'catch_fly_run': case 'catch_line_drive': case 'catch_comebacker': case 'catch_backhand': return [hint, 'field_catch'];
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
    // the side cast: each falls back to the nearest existing clip until its own clip is in the files
    case 'bench_sit': return ['bench_sit', 'idle'];
    case 'ondeck_ready': return ['ondeck_ready', 'idle'];
    case 'ondeck_swing': return ['ondeck_swing', 'swing'];
    case 'coach_ready': case 'coach_signs': return [hint, 'coach_ready', 'idle'];
    case 'coach_stop': return ['coach_stop', 'ump_time', 'idle'];
    case 'coach_go': case 'coach_advance': case 'coach_go_loop': return [hint, 'celebrate', 'idle'];
    case 'bench_cheer': case 'bench_stand_up': return [hint, 'bench_sit', 'idle'];
    case 'catch_ready': return ['catch_ready', ...idleFor(role)];
    case 'pitcher_catch_toss': return ['pitcher_catch_toss', 'catch_throw', 'field_catch'];
    case 'ballkid_idle': return ['ballkid_idle', 'idle']; // standing: never a seated clip (that sat the bat boy on thin air)
    case 'coach_slide': return ['coach_slide', 'ump_safe', 'idle'];
    case 'ballkid_sit': return ['ballkid_sit', 'bench_sit', 'idle'];
    case 'ballkid_run': return ['ballkid_run', 'jog', 'run'];
    case 'ballkid_pickup': return ['ballkid_pickup', 'field_grounder', 'idle'];
    case 'batter_step_in': return ['batter_step_in', 'walk'];
    case 'batter_practice_swing': return ['batter_practice_swing', 'ondeck_swing', 'swing'];
    case 'batter_adjust': return ['batter_adjust', ...idleFor('batter')];
    case 'batter_step_out': return ['batter_step_out', ...idleFor('batter')];
    case 'catcher_signs': case 'catcher_signal_infield': return [hint, 'catcher_crouch'];
    case 'pitcher_shake_off': case 'pitcher_nod': case 'pitcher_step_off': case 'pitcher_rosin': case 'pitcher_adjust': case 'pitcher_look_runner': return [hint, 'pitcher_set', 'idle'];
    case 'mound_talk': case 'mound_talk_listen': return [hint, 'idle'];
    case 'manager_walk': return ['manager_walk', 'walk'];
    case 'manager_signal': return ['manager_signal', 'coach_signs', 'idle'];
    case 'pitcher_handoff': return ['pitcher_handoff', 'idle'];
    case 'warmup_pitch': return ['warmup_pitch', 'throw_casual', 'throw'];
    case 'bullpen_throw': return ['bullpen_throw', 'throw_casual', 'throw'];
    case 'umpire_brush_plate': return ['ump_brush_plate', 'idle'];
    case 'ump_new_ball': return ['ump_new_ball', 'ump_time', 'idle'];
    case 'ump_huddle': return ['ump_huddle', 'idle'];
    case 'ballkid_toss': return ['ballkid_toss', 'throw_casual', 'throw'];
    default: return idleFor(role);
  }
}

/** throwing motions: the ball is in the throwing hand until the sim releases it, and the clip is laid so its release frame lands on that moment */
const THROW_HINTS = new Set<string>(['throw', 'toss', 'throw_casual', 'toss_underhand', 'toss_sidearm_short', 'roll_ball']);

/**
 * A base umpire while a pitch comes: he stays upright and relaxed. The `ump_set_base` clip holds its hands out in the air in a stiff claw crouch, and the
 * fielders' hands-on-knees set bends the neck back hard once the head looks up at the ball; neither reads as an umpire.
 */
const BASE_UMP_SET = ['idle'];
/** Body morphs for the people in fixed-look files (no sim physique): umpires and managers / pitching coaches mostly average to heavy, base coaches
 * anything, the bat boy slim. Deterministic per person (`h` = hash of the id). */
export function crewBuild(role: PlayerRole, h: number): Record<string, number> | null {
  const u = (h % 1000) / 1000, v = ((h >>> 10) % 1000) / 1000;
  if (role === 'umpire') return { build_heavy: 0.15 + 0.65 * u, build_stocky: 0.2 + 0.4 * v, build_muscular: 0, cheeks_full: 0.2 + 0.5 * u };
  if (role === 'manager' || role === 'pitchcoach') return { build_heavy: 0.3 + 0.6 * u, build_stocky: 0.3 + 0.3 * v, build_muscular: 0, cheeks_full: 0.3 + 0.4 * u };
  if (role === 'coach1b' || role === 'coach3b') return u < 0.4 ? { build_lean: 0.3 * v, build_muscular: 0.1 } : { build_heavy: 0.6 * u, build_stocky: 0.3 + 0.3 * v, build_muscular: 0 };
  if (role === 'batboy') return { build_lean: 0.4 + 0.3 * u };
  return null;
}

/** the seat height the seated clips are made for (their root is the ground below the seat centre) */
const SIT_SEAT = 0.45;

/** the standing pose of a role between plays (frame 0 of the swing is the batting stance until a `batting_stance` clip exists) */
function idleFor(role: PlayerRole): string[] {
  if (role === 'batter') return ['batting_stance', 'swing'];
  if (role === 'catcher') return ['catcher_crouch'];
  if (role === 'pitcher') return ['idle'];
  if (role === 'first' || role === 'second' || role === 'third' || role === 'short') return ['field_ready_infield', 'field_ready', 'idle'];
  if (role === 'left' || role === 'center' || role === 'right') return ['field_ready_outfield', 'field_ready', 'idle'];
  return ['idle'];
}

/** hints whose pose is meant to be stationary: when the player is nonetheless travelling, the legs must follow the ground speed (no sliding in a ready pose) */
const STATIC_HINTS = new Set<string>(['idle', 'ump_ready', 'ump_time', 'ondeck_ready', 'coach_ready', 'ballkid_sit', 'ballkid_idle', 'bench_sit', 'catch_ready', 'transfer', 'mound_talk', 'mound_talk_listen', 'umpire_brush_plate', 'ump_new_ball', 'ump_huddle', 'field_ready']);
/** gaits with their own foot speed: kept while the speed fits them, replaced by a faster gait above this */
const WALKISH_HINTS = new Set<string>(['walk', 'manager_walk', 'ballkid_run', 'batter_step_in']);

/**
 * Should locomotion override the sim's pose hint? Whenever the ground speed is clearly above a standing sway: stationary hints from ~0.45 m/s (0.9 for the
 * batter, catcher, pitcher and umpires, who shuffle in their routines; less once a gait is already playing), walking hints once they are faster than a walk can
 * keep up with (the walk clip's feet do ~1.4-2.4 m/s), a transfer only when really travelling.
 */
export function wantsGait(hint: string, role: string, speed: number, gaitOn: boolean): boolean {
  if (STATIC_HINTS.has(hint)) {
    if (hint === 'transfer') return speed > (gaitOn ? 1.4 : 2.0);
    const shuffler = role === 'batter' || role === 'catcher' || role === 'pitcher' || role === 'umpire';
    return speed > (shuffler ? (gaitOn ? 0.5 : 0.9) : gaitOn ? 0.3 : 0.45);
  }
  if (WALKISH_HINTS.has(hint)) return speed > (gaitOn ? 2.3 : 2.6);
  return false;
}

/** Yaw (rad, direction = (sin f, cos f)) a batter's body faces in the box: chest toward the plate, a little open to the pitcher. */
export const STANCE_OPEN = 0.2;
export function stanceYaw(hand: 'L' | 'R' | undefined): number {
  // righties stand on the third-base side (+X) facing -X, lefties on the first-base side (-X) facing +X
  return hand === 'L' ? Math.PI / 2 - STANCE_OPEN : -Math.PI / 2 + STANCE_OPEN;
}

export function templateNameFor(snap: PlayerSnap): string {
  switch (snap.role) {
    case 'batter': case 'runner': case 'coach': case 'coach1b': case 'coach3b': case 'ondeck': return 'player_batter';
    case 'batboy': case 'manager': case 'pitchcoach': return 'player_coach';
    case 'ballkid': return 'player_ballkid';
    case 'catcher': return 'player_catcher';
    case 'umpire': return 'player_umpire';
    default: return snap.team === 1 ? 'player_home' : 'player_away';
  }
}

/** every puppet's name / number textures, shared and kept across games */
export const jerseyTextures = new JerseyTextures();
const decalMats = new WeakMap<object, MeshStandardMaterial>();
function decalMaterial(tpl: Material | undefined, tex: import('three').Texture): MeshStandardMaterial {
  let m = decalMats.get(tex);
  if (!m) {
    const b = tpl as MeshStandardMaterial | undefined;
    m = b && b.isMeshStandardMaterial ? b.clone() : new MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    m.userData = {};
    m.map = tex;
    m.color = new Color(0xffffff);
    m.transparent = true;
    m.alphaTest = 0.02;
    m.depthWrite = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    m.name = 'jersey_decal';
    reg(m);
    const mm = m;
    tex.addEventListener('dispose', () => mm.dispose());
    decalMats.set(tex, m);
  }
  return m;
}

const eyeBlackMats = new WeakMap<Material, Material>();
function eyeBlackMaterial(src: Material): Material {
  let m = eyeBlackMats.get(src);
  if (!m) {
    const c = src.clone() as MeshStandardMaterial;
    c.transparent = true;
    c.depthWrite = false;
    c.opacity = 0.82;
    c.roughness = 0.95;
    c.color = new Color(0x161616);
    (c.defines ??= {}).CB_FEATHER = '0.007';
    reg(c);
    eyeBlackMats.set(src, (m = c));
  }
  return m;
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
    if (skin) shadeSkin(m);
    if (name === 'hair_beard') {
      // the beard / mustache / goatee shells fade out over their last millimetres (see facialHair.ts) instead of ending in a hard line
      m.alphaTest = 0.4;
      (m.defines ??= {}).CB_FEATHER = '0.006';
    }
    if (name === 'stubble') {
      m.transparent = true;
      m.depthWrite = false;
      shadeHair(m, false, false);
    }
    if (name === 'hair_beard') shadeHair(m, true, false);
    if (name === 'hair') shadeHair(m);
    m.color = new Color(color);
    // the fibre texture is dark on top of the hair colour: a beard read as a black mask; lift it toward the scalp hair's value
    if (name === 'hair_beard') m.color.multiplyScalar(1.6);
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
const gearKindOf = (role: PlayerRole): GearKind => (role === 'batter' || role === 'runner' || role === 'coach' || role === 'coach1b' || role === 'coach3b' || role === 'ondeck' ? 'batter' : role === 'catcher' ? 'catcher' : 'field');
const HAIR_NODES = ['Gear_Hair', 'Gear_Hair_Buzz', 'Gear_Hair_Curly', 'Gear_Hair_Long'];
const FACIAL_NODES = ['Gear_Beard_Stubble', 'Gear_Beard_Full', 'Gear_Goatee', 'Gear_Mustache'];
const JERSEY_NODES = ['Jersey', 'Jersey_ShortSleeve', 'Jersey_Sleeveless'];
const PANTS_NODES = ['Pants', 'Pants_Long'];
/** The four glove kinds of `player_base.glb`: glove, laces and pocket nodes. */
type GloveKind = 'infield' | 'outfield' | 'first' | 'catcher';
const GLOVES: Record<GloveKind, { glove: string; laces: string; pocket: string }> = {
  infield: { glove: 'Gear_Glove', laces: 'Gear_Glove_Laces', pocket: 'Glove_Pocket' },
  outfield: { glove: 'Gear_Glove_Outfield', laces: 'Gear_Glove_Outfield_Laces', pocket: 'Glove_Pocket_Outfield' },
  first: { glove: 'Gear_Glove_FirstBase', laces: 'Gear_Glove_FirstBase_Laces', pocket: 'Glove_Pocket_FirstBase' },
  catcher: { glove: 'Gear_Glove_Catcher', laces: 'Gear_Glove_Catcher_Laces', pocket: 'Glove_Pocket_Catcher' },
};
export function gloveKindFor(role: PlayerRole): GloveKind | null {
  switch (role) {
    case 'catcher': return 'catcher';
    case 'first': return 'first';
    case 'left': case 'center': case 'right': return 'outfield';
    case 'pitcher': case 'second': case 'third': case 'short': return 'infield';
    default: return null; // runners, coaches, bench, ball kids, umpires and any role the engine does not know: no glove
  }
}
const TRIM_WHITE = '#f2f2ee', TRIM_BLACK = '#17181b';

/**
 * The merged geometry of `parts` (position, normal, skin attributes only; skin indices remapped to `ref`'s bone order by bone name), cached on the template
 * per variant set so every puppet that wears the same parts shares it. null when the parts cannot be merged (different skeletons, odd attributes).
 */
function proxyGeometry(tpl: object, key: string, parts: SkinnedMesh[], ref: SkinnedMesh): BufferGeometry | null {
  const holder = tpl as { __proxy?: Map<string, BufferGeometry | null> };
  const cache = (holder.__proxy ??= new Map());
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const refNames = ref.skeleton.bones.map((b) => b.name);
  const list: BufferGeometry[] = [];
  let ok = true;
  for (const m of parts) {
    const g = m.geometry;
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw || m.bindMatrix.equals(ref.bindMatrix) === false) {
      ok = false;
      break;
    }
    const map = m.skeleton.bones.map((b) => refNames.indexOf(b.name));
    if (map.some((i) => i < 0)) {
      ok = false;
      break;
    }
    // (read through the accessors: the meshopt-compressed files store quantised, normalised integers)
    const f = (a: { count: number; itemSize: number; getComponent(i: number, c: number): number }, size: number) => {
      const out = new Float32Array(a.count * size);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) out[i * size + c] = a.getComponent(i, c);
      return out;
    };
    const idx = new Uint16Array(si.count * 4);
    for (let i = 0; i < si.count; i++) for (let c = 0; c < 4; c++) idx[i * 4 + c] = map[si.getComponent(i, c)] ?? 0;
    const n = new BufferGeometry();
    n.setAttribute('position', new BufferAttribute(f(pos, 3), 3));
    n.setAttribute('normal', nor ? new BufferAttribute(f(nor, 3), 3) : new BufferAttribute(new Float32Array(pos.count * 3), 3));
    n.setAttribute('skinIndex', new BufferAttribute(idx, 4));
    n.setAttribute('skinWeight', new BufferAttribute(f(sw, 4), 4));
    if (g.index) {
      const ix = new Uint32Array(g.index.count);
      for (let i = 0; i < ix.length; i++) ix[i] = g.index.getX(i);
      n.setIndex(new BufferAttribute(ix, 1));
    }
    list.push(n);
  }
  let merged: BufferGeometry | null = null;
  if (ok && list.length) {
    merged = mergeGeometries(list, false);
    if (merged) {
      merged.computeBoundingSphere();
      merged.name = 'shadow_proxy';
    }
  }
  for (const g of list) g.dispose();
  cache.set(key, merged);
  return merged;
}

/** the darker of two team colours for the catcher's gear (white gear reads as plaster), navy when both are light */
function gearColor(a: string, b: string): string {
  const lum = (h: string) => {
    const c = new Color(h);
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  };
  const d = lum(a) <= lum(b) ? a : b;
  return lum(d) > 0.35 ? '#1d2a44' : d;
}

/** metres per geometry unit of a (possibly quantized) mesh: its bind matrix's scale, over the model's own (the player's height) */
function edgeUnit(m: Mesh): number {
  const sk = m as SkinnedMesh;
  const k = sk.isSkinnedMesh ? sk.bindMatrix.getMaxScaleOnAxis() : m.matrixWorld.getMaxScaleOnAxis();
  return k > 0 ? k : 1;
}

export class GltfPuppet implements PuppetLike {
  root = new Group();
  /** (set in the constructor) this puppet's matrices are updated by the puppet itself, not by the scene-wide pass in `renderer.render` */
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
  private gearKind: string | null = null;
  private umpBase = false;
  /** this player's pocket empty and the nodes the glove morphs live on */
  private pocket: Object3D | null = null;
  private gloveNodes: Object3D[] = [];
  private variant: string | null = null;
  private animClock = 0;
  private cc: { arrive: number; name: string; target: Vector3 } | null = null;
  /** glove target inferred from the ball's flight when the sim reports none (the catcher receiving a pitch) */
  private inferredGlove: Vector3 | null = null;
  private slideCount = 0;
  private bodyScale = 1;
  // pitching
  private dlv: { ev: DeliveryEvents; plan: DeliveryPlan; dur: number; grip: string } | null = null;
  private ballObj: Object3D | null = null;
  private ballPlace: BallPlace | 'none' | 'transfer' = 'none';
  private ballGrip = 'Ball_Grip';
  ballHeld = false;
  /** the jersey's name / number decal meshes of this file (none until the assets ship them: the digit quads stay) */
  private decals: Partial<Record<DecalKind, Mesh>> = {};
  private decalTemplate: Material | undefined;
  private decalKey = '';
  /** glassy cornea shells over the eyes (visible only in the full tier, near the camera) */
  private cornea: Object3D[] = [];
  private torso: TorsoVolume = torsoVolume(undefined);
  private headVol: HeadVolume = headVolume(undefined);
  private headVolHelmet: HeadVolume = headVolume(undefined, true);
  private headVolCap: HeadVolume = headVolume(undefined, false);
  /** smallest arm-to-head clearance (m) over the puppet's life; negative = an elbow or forearm inside the head */
  headClearWorst = Infinity;
  headClear = Infinity;
  private warnedHead = false;
  /** smallest elbow-to-trunk clearance (m) this frame and over the puppet's life; negative = an elbow inside the torso */
  elbowClear = Infinity;
  minElbowClear = Infinity;
  private warnedElbow = false;
  /** the clip time the pitching state machine is seeking to (null: not driving the clip) */
  pitchClipTime: number | null = null;

  constructor(private tpl: CharacterTemplate, snap: PlayerSnap, private gearSets: GearSets = {}, private manifest?: PlayerManifest) {
    this.umpBase = snap.role === 'umpire' && !!snap.position && snap.position !== 'HP';
    const id = snap.id;
    this.root.matrixWorldAutoUpdate = !!FLAGS.nomatrix;
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
        // tiny details add draw calls to every shadow cascade and cast no visible shadow of their own
        m.castShadow = !NO_SHADOW.test(m.name);
        m.receiveShadow = true;
        this.meshes.push(m);
      }
    });
    // eyes and leather become clear-coated materials; every eye gets a glassy cornea shell (drawn only when the tier and the distance ask for it)
    for (const m of [...this.meshes]) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const next = mats.map((mat) => {
        const u = upgradeMaterial(mat);
        if (u !== mat) reg(u);
        return u;
      });
      m.material = Array.isArray(m.material) ? next : next[0];
      // the files carry their own cornea shell: the engine's (below) replaces it (two glossy layers over the iris whited the eyes out)
      if (m.name === 'Eyes_Cornea') {
        m.removeFromParent();
        this.meshes.splice(this.meshes.indexOf(m), 1);
        this.nodes.delete('Eyes_Cornea');
        continue;
      }
      if (m.name === 'Eyes' && (m as SkinnedMesh).isSkinnedMesh && m.parent) {
        const shell = makeCorneaShell(m as SkinnedMesh);
        shell.visible = false;
        m.parent.add(shell);
        this.cornea.push(shell);
        this.meshes.push(shell);
      }
    }
    for (const k of Object.keys(DECAL_NODES) as DecalKind[]) {
      const n = this.nodes.get(DECAL_NODES[k]) as Mesh | undefined;
      if (n && n.isMesh) {
        this.decals[k] = n;
        this.decalTemplate ??= (Array.isArray(n.material) ? n.material[0] : n.material) as Material;
        n.visible = false;
        n.castShadow = false;
      }
    }
    this.setCullBounds();
    for (const m of this.meshes) if (FEATHERED.test(m.name) || m.name === 'Gear_EyeBlack') addEdgeAttribute(m.geometry, edgeUnit(m));
    // eye black is a matte grease smear that thins out at its edges, not an opaque black bar on the cheek
    const eb = this.nodes.get('Gear_EyeBlack') as Mesh | undefined;
    if (eb && !Array.isArray(eb.material)) eb.material = eyeBlackMaterial(eb.material);
    for (const m of this.meshes) {
      const t = LOD_TIER1.test(m.name) ? 1 : LOD_TIER2.test(m.name) ? 2 : 0;
      if (t) this.lodParts.push({ m, tier: t });
      // the simplified geometry (same mesh names, skeleton, uv layout and morph targets; a third of the triangles) for the small / distant tiers
      const lg = tpl.lodGeo?.get(m.name);
      const sk = m as SkinnedMesh;
      if (lg && (FEATHERED.test(m.name) || m.name === 'Gear_EyeBlack')) addEdgeAttribute(lg, edgeUnit(m));
      if (lg && sk.isSkinnedMesh && m.name !== 'Eyes_Cornea' && lg.morphAttributes.position?.length === m.geometry.morphAttributes.position?.length) this.lodSwap.push({ m, full: m.geometry, lod: lg });
    }
    this.rig = new Rig(this.model);
    for (const n of ['Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm']) {
      const b = this.bones[n];
      if (b) this.clipPose.set(b, b.quaternion.clone());
    }
    this.mixer = new AnimationMixer(this.model);
    for (const [name, clip] of tpl.clips) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(this.isLoop(name) ? LoopRepeat : LoopOnce, Infinity);
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
      this.headVolHelmet = headVolume(this.look.morphs, true);
      this.headVolCap = headVolume(this.look.morphs, false);
      this.headVol = this.headVolCap;
      this.applyGear(gearKindOf(snap.role), snap.role);
      this.assertUniformHead(snap.id);
      this.rebuildProxy();
    } else {
      // fixed-look files (umpires, coaches, ball kids): show exactly the nodes the file marks as its default look (glTF has no visibility flag,
      // so optional caps / helmets / lineup cards would all be on), the bat boy wears the coach's file with a cap instead of the helmet
      if (tpl.defaults.size) {
        for (const [name, o] of this.nodes) {
          const grp = o.userData?.cb_group;
          if (grp === undefined || grp === 'hand') continue;
          o.visible = tpl.defaults.has(name);
        }
      }
      if (snap.role === 'batboy') {
        const helmet = this.nodes.get('Gear_Helmet'), cap = this.nodes.get('Gear_Cap');
        if (helmet) helmet.visible = false;
        if (cap) cap.visible = true;
      }
      // umpires, managers and coaches are not athletes: ordinary builds, many of them heavy (the files bake one body, so it is set here per person)
      const crew = crewBuild(snap.role, h);
      if (crew) {
        this.applyMorphs(crew);
        this.torso = torsoVolume(crew);
      }
      // hair hidden under caps / helmets
      const hair = this.nodes.get('Gear_Hair') ?? this.nodes.get('Face_Hair');
      if (hair && (this.nodes.get('Gear_Cap') || this.nodes.get('Gear_Helmet'))) hair.visible = false;
      this.rebuildProxy();
    }
  }

  /**
   * Skinned meshes are culled by a fixed sphere around the standing body instead of the bind-pose bounds (which the animation leaves behind), so the
   * main pass, the GTAO prepass and every shadow cascade skip a puppet that is out of view; an unculled puppet costs ~25 draw calls in each of them.
   * The sphere is in the mesh's local space (the same as the model's at rest, where the skeleton root is the origin) and reaches an extended arm or a slide.
   */
  private setCullBounds() {
    this.model.updateMatrixWorld(true);
    for (const m of this.meshes) {
      m.frustumCulled = !FLAGS.nocull;
      const sk = m as SkinnedMesh;
      if (!sk.isSkinnedMesh) continue;
      const k = Math.max(1e-3, m.matrixWorld.getMaxScaleOnAxis());
      const c = new Vector3(0, CULL_CENTER_Y, 0).applyMatrix4(new Matrix4().copy(m.matrixWorld).invert());
      sk.boundingSphere = new Sphere(c, CULL_RADIUS / k);
    }
  }

  // ---- shadow / depth proxy ------------------------------------------------------------------------------------------------
  // Every visible body part is its own skinned draw call, and the shadow cascades, the tower-spot shadows and the GTAO depth/normal prepass each draw
  // the whole puppet again (~25 calls x 5 passes x 47 players). The parts that matter for a shadow or an ambient-occlusion depth are merged into ONE
  // skinned mesh (same skeleton, no uvs / morphs, cached per template and variant set) that is visible only in those passes.
  private proxy: SkinnedMesh | null = null;
  private proxyKey = '';

  private chainVisible(o: Object3D): boolean {
    for (let n: Object3D | null = o; n && n !== this.root; n = n.parent) if (!n.visible) return false;
    return true;
  }

  private rebuildProxy() {
    if (FLAGS.noproxy) {
      for (const m of this.meshes) m.castShadow = !NO_SHADOW.test(m.name);
      return;
    }
    const parts: SkinnedMesh[] = [];
    for (const m of this.meshes) {
      const sk = m as SkinnedMesh;
      if (!sk.isSkinnedMesh || NO_SHADOW.test(m.name) || PROXY_SKIP.test(m.name) || !this.chainVisible(m)) continue;
      parts.push(sk);
    }
    const key = parts.map((q) => q.name).sort().join('|');
    if (key === this.proxyKey) return;
    this.proxyKey = key;
    const old = this.proxy;
    this.proxy = null;
    if (old) {
      old.removeFromParent();
      old.skeleton = undefined as never;
    }
    const ref = parts.find((q) => q.name === 'Body_Skin') ?? parts[0];
    const geo = ref ? proxyGeometry(this.tpl, key, parts, ref) : null;
    for (const m of this.meshes) m.castShadow = !geo && !NO_SHADOW.test(m.name);
    if (!geo || !ref) return;
    const px = new SkinnedMesh(geo, proxyMaterial);
    px.name = 'ShadowProxy';
    px.castShadow = true;
    px.receiveShadow = false;
    px.visible = false;
    px.frustumCulled = true;
    px.bind(ref.skeleton, ref.bindMatrix);
    px.boundingSphere = new Sphere(new Vector3(0, CULL_CENTER_Y, 0), CULL_RADIUS * 1.1);
    // a left-hander's model is mirrored (scale.x = -1), which flips the triangle winding three draws with: the proxy must be mirrored the same way
    px.scale.x = this.mirrored ? -1 : 1;
    this.root.add(px);
    this.proxy = px;
  }

  /** parts hidden during the GTAO prepass (they are visible parts; restored afterwards) */
  private gbufHidden: Object3D[] = [];

  /**
   * The render phase: 'main' (everything as usual), 'shadow' (the merged proxy is visible; the parts themselves cast nothing) and 'gbuf' (the GTAO depth /
   * normal prepass: the body shapes draw, the small details that cannot move an occlusion value are hidden). `visible` is put back by the next 'main'.
   */
  phase(p: 'main' | 'shadow' | 'gbuf') {
    // three updates a skeleton only when one of its meshes is projected into the main pass: a puppet culled there (out of the picture) would cast its
    // shadow with a stale pose, so the proxy's skeleton is brought up to date here
    if (this.proxy && p === 'shadow') this.proxy.skeleton.update();
    if (this.proxy) this.proxy.visible = p === 'shadow';
    if (p === 'gbuf') {
      this.gbufHidden.length = 0;
      // small distant players (tier 1 and 2) leave no mark in an ambient-occlusion / depth-of-field buffer (the contact-shadow quad anchors them): they are left out;
      // the close ones draw their body shapes only
      const tiny = this.lodTier >= 1;
      for (const m of this.meshes) {
        if (m.visible && m.layers.mask === 1 && (tiny || GBUF_SKIP.test(m.name))) {
          m.visible = false;
          this.gbufHidden.push(m);
        }
      }
    } else if (this.gbufHidden.length) {
      for (const m of this.gbufHidden) m.visible = true;
      this.gbufHidden.length = 0;
    }
  }

  /** parts that drop out at a level of detail (see `LOD_TIER1`) */
  private lodParts: { m: Mesh; tier: number }[] = [];
  private lodSwap: { m: Mesh; full: BufferGeometry; lod: BufferGeometry }[] = [];
  private lodGeoOn = false;
  /** current level of detail: 0 full, 1 no micro details, 2 only the body shapes */
  lodTier = 0;

  lodReset() {
    this.lodTier = 0;
    for (const p of this.lodParts) p.m.layers.mask = 1;
    this.useLodGeometry(false);
  }

  /** pick the level of detail from how much of the picture the player fills (hysteresis so the edge does not flicker) */
  private updateLod(snap: PlayerSnap, env: PuppetEnv) {
    let want = 0;
    const cam = env.cameraPos;
    if (cam && env.lodK && env.lodCut) {
      const d = Math.max(1, Math.hypot(cam.x - snap.pos.x, cam.y - snap.pos.y - 1, cam.z - snap.pos.z));
      const size = (1.85 * env.lodK) / d;
      const [c1, c2] = env.lodCut;
      const g = this.lodTier;
      want = size < c2 * (g === 2 ? 1.2 : 1) ? 2 : size < c1 * (g >= 1 ? 1.2 : 1) ? 1 : 0;
    }
    if (want === this.lodTier) return;
    this.lodTier = want;
    for (const p of this.lodParts) p.m.layers.mask = want >= p.tier ? HIDDEN_LAYERS : 1;
    this.useLodGeometry(want >= 1);
  }

  /** swap the simplified geometry in (small / distant players) or the full one back */
  useLodGeometry(on: boolean) {
    if (on === this.lodGeoOn || FLAGS.nolodgeo) return;
    this.lodGeoOn = on;
    for (const s of this.lodSwap) s.m.geometry = on ? s.lod : s.full;
  }

  /** conehead guard: the head's world scale must be uniform (clips carry unit scale tracks, the body scale is uniform); warns once in dev */
  private assertUniformHead(id: string) {
    if (!import.meta.env?.DEV) return;
    const head = this.bones.Head;
    if (!head) return;
    this.model.updateMatrixWorld(true);
    const s = new Vector3().setFromMatrixScale(head.matrixWorld);
    const hi = Math.max(s.x, s.y, s.z), lo = Math.min(s.x, s.y, s.z);
    if (lo <= 0 || hi / lo > 1.02) console.error(`[head-scale] ${id} head bone scale is not uniform (${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)})`);
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
  private applyGear(kind: GearKind, role: PlayerRole) {
    const gk = gloveKindFor(role);
    const key = `${kind}:${gk}`;
    if (!this.look || key === this.gearKind) return;
    this.gearKind = key;
    const L = this.look;
    // the coach and ball-kid files carry their own pre-configured outfits (helmet and uniform, polo and shorts)
    const own = this.tpl.name === 'player_coach' || this.tpl.name === 'player_ballkid';
    const defaults = own ? this.tpl.defaults : this.gearSets[kind] ?? this.gearSets.field ?? this.tpl.defaults;
    for (const [name, o] of this.nodes) {
      const grp = o.userData?.cb_group;
      if (grp === undefined || grp === 'hand') continue;
      o.visible = defaults.has(name);
    }
    const show = (name: string, on: boolean) => {
      const o = this.nodes.get(name);
      if (o) o.visible = on;
    };
    // the bat boy: the coach's uniform with a cap instead of the helmet
    if (role === 'batboy') {
      show('Gear_Helmet', false);
      show('Gear_Cap', true);
    }
    // clothes variants
    if (!own && (this.nodes.get('Jersey')?.visible || this.nodes.get('Jersey_ShortSleeve')?.visible || this.nodes.get('Jersey_Sleeveless')?.visible)) {
      for (const n of JERSEY_NODES) show(n, n === L.jerseyNode);
    }
    if (!own) for (const n of PANTS_NODES) show(n, n === L.pantsNode);
    // head: hair only when no cap / helmet covers it; beard, mustache, eye black on top
    const headwear = !!(this.nodes.get('Gear_Cap')?.visible || this.nodes.get('Gear_Helmet')?.visible);
    for (const n of HAIR_NODES) show(n, !headwear && n === L.hairNode);
    for (const n of FACIAL_NODES) show(n, n === L.facialNode && role !== 'ballkid');
    show('Gear_EyeBlack', L.eyeBlack && kind !== 'catcher');
    // arms
    if (!own) {
      show('Gear_Wristband_L', L.wristbands.L);
      show('Gear_Wristband_R', L.wristbands.R);
    }
    show('Gear_ArmSleeve_L', L.armSleeves.L && kind !== 'batter');
    show('Gear_ArmSleeve_R', L.armSleeves.R && kind !== 'batter');
    // gloves: each role wears its own (infield, outfield, first-base mitt, catcher's mitt), with its own pocket
    for (const g of Object.values(GLOVES)) {
      show(g.glove, false);
      show(g.laces, false);
    }
    this.pocket = this.nodes.get('Glove_Pocket') ?? null;
    this.gloveNodes = [];
    if (gk) {
      const g = GLOVES[gk];
      show(g.glove, !!this.nodes.get(g.glove));
      show(g.laces, !!this.nodes.get(g.laces));
      this.pocket = this.nodes.get(g.pocket) ?? this.pocket;
      for (const n of [g.glove, g.laces, 'Hand_L_Open']) {
        const o = this.nodes.get(n);
        if (o) this.gloveNodes.push(o);
      }
    }
    // hands: the glove hand is the open hand inside the glove (batters keep the fist); the throwing hand is the ball-ready claw except for batters
    const openHand = this.nodes.get('Hand_L_Open');
    if (openHand) {
      show('Hand_L', !gk);
      show('Hand_L_Open', false); // the hand inside a glove is never seen (a draw call and 1k triangles per fielder); its glove morphs still run
    }
    if (this.nodes.get('Hand_R_Ball')) {
      show('Hand_R', kind === 'batter');
      show('Hand_R_Ball', false);
      show('Hand_R_Relaxed', kind !== 'batter');
    }
    if (this.nodes.get('Hand_L_Relaxed')) show('Hand_L_Relaxed', !gk && kind !== 'batter');
    if (!gk && kind !== 'batter' && this.nodes.get('Hand_L_Relaxed')) show('Hand_L', false);
    this.handShown = { R: '', L: '' };
    this.materialsDirty = true;
  }
  private materialsDirty = false;
  private lastLook: { look: Look; team: number } | null = null;

  setTeam(look: Look, team: number) {
    this.team = team;
    this.lastLook = { look, team };
    const L = this.look;
    const trimOf = (c: 'trim' | 'white' | 'black') => (c === 'trim' ? look.sock : c === 'white' ? TRIM_WHITE : TRIM_BLACK);
    const map: Record<string, string> = {
      uniform_jersey: look.jersey, uniform_pants: look.pants, uniform_socks: look.sock, uniform_undershirt: look.sock, cap: look.cap, helmet: look.cap, piping: look.sock,
      // the catcher's chest protector and shin guards in the team colour (they were near-black); umpires keep theirs dark (see `dark` below)
      catcher_gear: gearColor(look.cap, look.jersey),
    };
    if (L) {
      map.hair = L.hairColor;
      map.stubble = L.hairColor;
      map.hair_beard = L.hairColor;
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
  /** the manifest says whether a clip loops (the new non-pitch clips are listed there); the built-in set covers older manifests */
  private isLoop(name: string): boolean {
    const c = this.manifest?.clips[name];
    return c && c.loop !== undefined ? !!c.loop : LOOPING.has(name);
  }

  private resolveClip(hint: AnimHint, role: PlayerRole): string {
    // the set position: the plate umpire's slot crouch, a base umpire's hands-on-knees set (`idle` is the relaxed stand between pitches)
    if (role === 'umpire' && hint === 'ump_ready' && this.umpBase) for (const n of BASE_UMP_SET) if (this.actions.has(n)) return n;
    for (const n of clipCandidates(hint, role)) if (this.actions.has(n)) return n;
    return 'idle';
  }

  private play(name: string, snap: PlayerSnap) {
    const a = this.actions.get(name) ?? this.actions.get('idle');
    if (!a || a === this.current) return;
    a.reset();
    let t = snap.animTime ?? 0;
    // a throw starts so its release frame meets the sim's release (`releaseIn`); the sim starts most motions that long ahead, a play's quick throw later
    const rel = THROW_HINTS.has(snap.anim) && snap.releaseIn !== undefined ? this.manifest?.clips[name]?.events_s?.release : undefined;
    if (rel !== undefined) t = Math.max(0, rel - (snap.releaseIn ?? 0));
    a.time = Math.min(t, Math.max(0, a.getClip().duration - 0.001));
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    // walking up to / away from the box swings the head from forward to the stance's over-the-shoulder look: blend that slowly
    const stanceBlend = snap.role === 'batter' && (name === 'swing' || name === 'batting_stance' || this.currentName === 'swing' || this.currentName === 'batting_stance');
    if (this.current) this.current.crossFadeTo(a, stanceBlend ? 0.3 : this.isLoop(name) ? 0.2 : 0.1, false);
    this.current = a;
    this.currentName = name;
    // the plate umpire's whisk broom is out only while he brushes the plate
    const broom = this.nodes.get('Umpire_Broom');
    if (broom) broom.visible = name === 'ump_brush_plate';
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
    if (this.proxy) this.proxy.scale.x = m ? -1 : 1;
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
      mesh.userData.show = show;
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

  private gait = '';
  /** stance-foot speed (m/s) of a locomotion clip: the manifest's designed value, else measured from the clip */
  private footSpeedOf(name: string, clipDefault: number): number {
    const m = this.manifest?.clips[name]?.footSpeed;
    if (m) return m;
    const a = this.actions.get(name);
    return a ? stanceFootSpeed(this.tpl.scene, a.getClip(), clipDefault) : clipDefault;
  }

  /**
   * The locomotion clip for the ground speed: walk / trot / jog / run / sprint, each played at speed / its stance-foot speed so the feet do not
   * skate; the neighbour gait takes over (cross-fade) when it fits better, with hysteresis so a player at a gait boundary does not flicker.
   * A turn at speed uses the turning clips. Returns null when the player is not moving on the ground.
   */
  private locomotionClip(snap: PlayerSnap, override = false): string | null {
    const sp = Math.hypot(snap.vel.x, snap.vel.z);
    const hint = snap.anim;
    const moving = override || hint === 'run' || hint === 'trot' || hint === 'run_turn';
    if (!moving) {
      this.gait = '';
      return null;
    }
    if (hint === 'run_turn') {
      const t = sp > 6 && this.actions.has('run_turn_sprint') ? 'run_turn_sprint' : 'run_turn';
      if (this.actions.has(t)) return t;
    }
    const fallbackFeet: Record<string, number> = { walk: 1.42, trot: 2.2, jog: 3.5, run: 5, run_sprint: 7 };
    const gaits = Object.keys(fallbackFeet).filter((g) => this.actions.has(g));
    if (!gaits.length) return null;
    const err = (g: string) => Math.abs(Math.log(Math.max(0.05, sp) / this.footSpeedOf(g, fallbackFeet[g])));
    let best = gaits[0];
    for (const g of gaits) if (err(g) < err(best)) best = g;
    if (this.gait && gaits.includes(this.gait) && err(this.gait) < err(best) + 0.14) best = this.gait;
    this.gait = best;
    return best;
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

  /**
   * The catcher receiving a pitch, worked out from the ball's flight so that it does not depend on the sim reporting a catch: when the ball
   * is about a third of a second from the mitt, the matching `catch_pitch*` clip starts so that its catch frame lands on the arrival, and the
   * mitt is reached to where the ball will be. Returns the clip and its time, or null.
   */
  private catcherCatch(snap: PlayerSnap, env: PuppetEnv): { name: string; time: number } | null {
    const catchT = this.manifest?.clips.catch_pitch?.events_s?.catch ?? 7 / 24;
    const b = env.ball, v = env.ballVel;
    if (!this.cc && b && v && v.z < -18) {
      const mz = snap.pos.z + 0.45;
      const dz = b.z - mz;
      if (dz > 0 && Math.abs(b.x - snap.pos.x) < 1.6) {
        const tArr = dz / -v.z;
        if (tArr < catchT + 0.03) {
          const y = Math.max(0.05, b.y + v.y * tArr - 4.905 * tArr * tArr);
          const name = y < 0.55 ? 'catch_pitch_low' : y > 1.05 ? 'catch_pitch_high' : 'catch_pitch';
          this.cc = { arrive: this.animClock + tArr, name: this.actions.has(name) ? name : 'catch_pitch', target: new Vector3(b.x + v.x * tArr, y, mz) };
        }
      }
    }
    const c = this.cc;
    // the pitch was hit (or otherwise turned away) before it reached the mitt: no catch
    if (c && v && this.animClock < c.arrive - 0.02 && v.z > -6) this.cc = null;
    if (!this.cc || !c || !this.actions.has(c.name)) {
      this.cc = null;
      this.inferredGlove = null;
      return null;
    }
    const time = catchT + (this.animClock - c.arrive);
    const dur = this.actions.get(c.name)!.getClip().duration;
    if (time > dur - 0.02) {
      this.cc = null;
      this.inferredGlove = null;
      return null;
    }
    this.inferredGlove = time > 0 && time < 0.55 ? c.target : null;
    return { name: c.name, time: Math.max(0, time) };
  }

  private reachShift = new Vector3();
  /** longest lunge (m): a tag is a dive at a runner, a catch a step */
  private lungeMax = 0.8;
  private reachStep(target: Vector3 | null, side: 'Left' | 'Right', dt: number) {
    const want = new Vector3();
    const sh = this.bones[`${side}Arm`], fore = this.bones[`${side}ForeArm`], hand = this.bones[`${side}Hand`];
    if (target && this.gloveW > 0.02 && sh && fore && hand) {
      this.refreshMatrices();
      const S = sh.getWorldPosition(new Vector3()).sub(this.reachShift);
      const E = fore.getWorldPosition(new Vector3()), H = hand.getWorldPosition(new Vector3());
      const pocket = side === 'Left' ? this.pocket : null;
      const off = pocket ? pocket.getWorldPosition(new Vector3()).sub(H) : new Vector3();
      const goal = target.clone().sub(off);
      const reach = (S.distanceTo(E.clone().sub(this.reachShift)) + E.distanceTo(H)) * 0.97;
      const dy = goal.y - S.y;
      const hx = goal.x - S.x, hz = goal.z - S.z;
      const hd = Math.hypot(hx, hz);
      const allowed = Math.sqrt(Math.max(0, reach * reach - dy * dy));
      const excess = hd - allowed;
      // above reach: a hop (the feet leave the ground a little); beyond it sideways: a lunge of up to ~0.8 m
      const lift = dy > reach ? Math.min(0.45, dy - reach) : 0;
      if ((excess > 0 && hd > 1e-4) || lift > 0) want.set(hd > 1e-4 && excess > 0 ? (hx / hd) * Math.min(this.lungeMax, excess) : 0, lift, hd > 1e-4 && excess > 0 ? (hz / hd) * Math.min(this.lungeMax, excess) : 0).multiplyScalar(this.gloveW);
    }
    this.reachShift.lerp(want, 1 - Math.exp(-dt * 22));
    if (this.reachShift.lengthSq() > 1e-8) {
      this.root.position.add(this.reachShift);
      this.refreshMatrices();
      this.rig.refresh();
    }
  }

  /**
   * A target beyond the arm's reach: lean the trunk toward it (a stretch), up to about 25 degrees, so the shoulder comes closer; the arm IK then
   * finishes the reach. The lean fades in with the reach weight.
   */
  private reachLean(hand: Bone, pocket: Object3D | null, side: 'Left' | 'Right', goalWorld: Vector3, w: number) {
    const sh = this.bones[`${side}Arm`], fore = this.bones[`${side}ForeArm`], base = this.bones.Spine, s1 = this.bones.Spine1, s2 = this.bones.Spine2;
    if (!sh || !fore || !base || !s1 || !s2) return;
    const rig = this.rig;
    rig.refresh();
    const hw = hand.getWorldPosition(new Vector3());
    const off = pocket ? pocket.getWorldPosition(new Vector3()).sub(hw) : new Vector3();
    const goal = rig.toRig(goalWorld.clone().sub(off), new Vector3());
    const S = rig.pos(sh, new Vector3()), E = rig.pos(fore, new Vector3()), H = rig.pos(hand, new Vector3());
    const reach = S.distanceTo(E) + E.distanceTo(H) - 0.03;
    const excess = S.distanceTo(goal) - reach;
    if (excess <= 0) return;
    const B = rig.pos(base, new Vector3());
    const a = S.clone().sub(B), g = goal.clone().sub(B);
    const ang = Math.min(0.44, (excess / Math.max(0.3, a.length())) * 1.15) * Math.min(1, w);
    const axis = new Vector3().crossVectors(a, g);
    if (axis.lengthSq() < 1e-8) return;
    axis.normalize();
    const q = new Quaternion().setFromAxisAngle(axis, ang / 2);
    rig.rotate(s1, q);
    rig.rotate(s2, q);
  }

  private lowPitch = false;
  private swingSeen = false;
  /** Latches, when a swing starts, whether the pitch is going to cross the plate below ~0.75 m (predicted from the ball's flight). */
  private trackPitchHeight(snap: PlayerSnap, env: PuppetEnv) {
    const swinging = snap.role === 'batter' && snap.anim === 'swing';
    if (!swinging) {
      this.swingSeen = false;
      if (snap.role !== 'batter' || snap.anim === 'idle') this.lowPitch = false;
      return;
    }
    if (this.swingSeen) return;
    this.swingSeen = true;
    const b = env.ball, v = env.ballVel;
    if (b && v && v.z < -8 && b.z > 0) {
      const t = b.z / -v.z;
      const y = b.y + v.y * t - 4.905 * t * t;
      this.lowPitch = y < 0.75;
    } else this.lowPitch = false;
  }

  private tagLatch: { hint: string; p: number | null } = { hint: '', p: null };
  /** progress through the tag hint at which the sim announced the result (contact), latched; the clip's contact frame is laid on it */
  private trackTag(snap: PlayerSnap, env: PuppetEnv) {
    const tagging = snap.anim === 'tag_glove' || snap.anim === 'tag_hand';
    if (!tagging) {
      this.tagLatch = { hint: '', p: null };
      return;
    }
    if (this.tagLatch.hint !== snap.anim) this.tagLatch = { hint: snap.anim, p: null };
    const out = env.tagOutcome?.(snap.id);
    if (this.tagLatch.p === null && (out === 'tag' || out === 'avoided')) this.tagLatch.p = Math.min(0.8, Math.max(0.25, snap.animProgress ?? 0.56));
  }

  /**
   * Catch and tag clips laid on the sim's timeline so their event frame is the sim's moment: a catch hint starts the clip's catch-frame time
   * before the ball arrives (`catchIn` counts down to it; afterwards `animT` = 0.5 at the catch), a tag's contact is at `animT` ≈ 0.45.
   */
  private eventPlan(snap: PlayerSnap, name: string): { name: string; time: number; place: 'none' } | null {
    const c = this.manifest?.clips[name];
    if (!c || !this.actions.has(name)) return null;
    const p = snap.animProgress;
    if (p === undefined) return null;
    if ((snap.anim.startsWith('catch_') && snap.anim !== 'catch_ready') || snap.anim === 'field_grounder' || snap.anim === 'pitcher_catch_toss') {
      const tc = c.events_s?.catch;
      if (!tc) return null;
      const t = snap.gloveTarget && snap.catchIn !== undefined && snap.catchIn > 0 ? tc - snap.catchIn : p * 2 * tc;
      return { name, time: Math.min(c.duration_s - 0.001, Math.max(0, t)), place: 'none' };
    }
    if (snap.anim.startsWith('ump_') && snap.anim !== 'ump_ready') {
      // a gesture plays at natural speed from the call: the sim holds the hint ~1.3 s (0.6 s for a ball), the peak comes at the clip's event time
      const hintDur = snap.anim === 'ump_ball' ? 0.6 : 1.3;
      return { name, time: Math.min(c.duration_s - 0.001, Math.max(0, p * hintDur)), place: 'none' };
    }
    if (snap.anim === 'tag_glove' || snap.anim === 'tag_hand') {
      const tc = c.events_s?.contact;
      if (!tc) return null;
      const pe = this.tagLatch.p ?? 0.56; // the sim fires `tag` / `tagAvoided` at the clip's contact frame: about animT 0.45-0.6 of the tag hint
      const t = p < pe ? (p / pe) * tc : tc + ((p - pe) / (1 - pe)) * (c.duration_s - tc);
      return { name, time: Math.min(c.duration_s - 0.001, Math.max(0, t)), place: 'none' };
    }
    return null;
  }

  /**
   * Which catching / fielding / sliding clip a generic hint means, decided once when the hint starts (from where the ball is relative to
   * the fielder), so the mitt meets the ball the way that ball is actually coming.
   */
  private pickVariant(snap: PlayerSnap, env: PuppetEnv): string | null {
    const has = (n: string) => this.actions.has(n);
    const h = snap.anim;
    if (snap.role === 'umpire') return null;
    // the sim names the kind of catch; the height of the glove target picks the low / high version of the clip
    const gy = snap.gloveTarget?.y;
    if (gy !== undefined) {
      if (h === 'catch_throw') return gy < 0.6 && has('catch_throw_low') ? 'catch_throw_low' : gy > 1.75 && has('catch_throw_high') ? 'catch_throw_high' : null;
      if (h === 'catch_pitch') return gy < 0.55 && has('catch_pitch_low') ? 'catch_pitch_low' : gy > 1.05 && has('catch_pitch_high') ? 'catch_pitch_high' : null;
    }
    if (h === 'slide') {
      const r = (hashString(snap.id) + this.slideCount++ * 2654435761) >>> 0;
      const u = (r % 1000) / 1000;
      const pick = u < 0.55 ? 'slide_feet' : u < 0.67 ? 'slide_hook_left' : u < 0.79 ? 'slide_hook_right' : 'slide_head';
      return has(pick) ? pick : null;
    }
    if (h === 'toss') return has('throw_casual') ? 'throw_casual' : null;
    if (h !== 'catch' && h !== 'field') return null;
    const ball = env.ball;
    const by = ball ? ball.y : 1.2;
    const speed = env.ballSpeed ?? 0;
    // ball offset to the player's glove side (left of his facing for a right-hander)
    const f = snap.facing;
    const left = { x: Math.cos(f), z: -Math.sin(f) };
    const lateral = ball ? ((ball.x - snap.pos.x) * left.x + (ball.z - snap.pos.z) * left.z) * (snap.hand === 'L' ? -1 : 1) : 0;
    let pick: string;
    if (snap.role === 'catcher') pick = by < 0.55 ? 'catch_pitch_low' : by > 1.05 ? 'catch_pitch_high' : 'catch_pitch';
    else if (snap.role === 'pitcher') pick = speed > 14 || h === 'field' ? 'catch_comebacker' : 'pitcher_catch_toss';
    else if (h === 'field' || by < 0.7) pick = lateral < -0.8 ? 'field_grounder_backhand' : 'field_grounder';
    else if (by > 2.3) pick = Math.hypot(snap.vel.x, snap.vel.z) > 3.5 ? 'catch_fly_run' : 'catch_fly';
    else if (speed > 26) pick = 'catch_line_drive';
    else if (snap.role === 'first') pick = 'catch_stretch';
    else pick = by > 1.7 ? 'catch_throw_high' : by < 0.9 ? 'catch_throw_low' : 'catch_throw';
    if (lateral < -0.8 && (pick === 'catch_throw' || pick === 'catch_line_drive') && has('catch_backhand')) pick = 'catch_backhand';
    return has(pick) ? pick : null;
  }

  update(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    const tAll = perf.t();
    // an unimportant puppet outside the picture is advanced every other frame (and then without look-at / IK, at a quarter of the animation rate):
    // nothing about him can be seen, only his shadow might reach into the picture
    this.offscreen = false;
    if (env.frustum && !FLAGS.noskip && !puppetIsKey(snap, env)) {
      this.cullSphere.center.set(snap.pos.x, snap.pos.y + 1, snap.pos.z);
      if (!env.frustum.intersectsSphere(this.cullSphere)) {
        this.skipAcc += dt;
        if ((this.skipN = (this.skipN + 1) & 1)) {
          this.root.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
          if (perf.on) perf.sub('pup.total', tAll);
          return;
        }
        dt = this.skipAcc;
        this.skipAcc = 0;
        this.offscreen = true;
      }
    }
    this.updateInner(snap, dt, env);
    // the scene-wide matrix pass skips puppets (see the constructor): bring the whole tree up to date once, after every bone has been moved
    this.refreshMatrices();
    if (perf.on) perf.sub('pup.total', tAll);
  }
  /**
   * Bring the whole tree up to date. Three skips a node's own world matrix when its `matrixWorldAutoUpdate` is false (that flag is how the root keeps the
   * scene-wide pass out of the subtree), so the root's is composed here, then the children are updated from it.
   */
  private refreshMatrices() {
    const r = this.root;
    if (FLAGS.nomatrix) return r.updateMatrixWorld(true);
    r.updateMatrix();
    if (r.parent) r.matrixWorld.multiplyMatrices(r.parent.matrixWorld, r.matrix);
    else r.matrixWorld.copy(r.matrix);
    r.updateMatrixWorld(true);
  }
  private offscreen = false;
  private skipAcc = 0;
  private skipN = 0;
  private cullSphere = new Sphere(new Vector3(), 2.6);

  private updateInner(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    this.setNumber(snap.number);
    if (snap.anim !== this.lastHint) this.variant = this.pickVariant(snap, env);
    this.setMirrored(snap.hand === 'L');
    if (this.look) {
      this.applyGear(gearKindOf(snap.role), snap.role);
      this.rebuildProxy(); // (a no-op unless the set of visible parts changed)
    }
    this.animClock += dt;
    const pit0 = snap.role === 'pitcher' && !(snap.anim === 'idle' && Math.hypot(snap.vel.x, snap.vel.z) > 0.9) ? this.pitcherPlan(snap) : null;
    // the catcher's catch is inferred from the ball's flight only when the sim reports none (no glove target, no catch hint)
    const realCatch = !!snap.gloveTarget || snap.anim === 'catch_pitch';
    if (realCatch) {
      this.cc = null;
      this.inferredGlove = null;
    }
    const cin = snap.role === 'catcher' && snap.anim === 'idle' && !realCatch ? this.catcherCatch(snap, env) : null;
    // the catcher's inferred catch is driven like the pitcher's delivery: a clip time on the sim's ball timeline
    const speed0 = Math.hypot(snap.vel.x, snap.vel.z);
    const gaitOver = wantsGait(snap.anim, snap.role, speed0, this.gaitOn) && snap.anim !== 'catch_pitch';
    this.gaitOn = gaitOver;
    const hint = gaitOver ? snap.anim : this.moveHint(snap);
    const loco = (pit0 && !gaitOver) || snap.anim === 'catch_pitch' ? null : this.locomotionClip(snap, gaitOver);
    const baseName = gaitOver && loco ? loco : this.variant && hint === snap.anim ? this.variant : loco ?? this.resolveClip(hint, snap.role);
    this.trackTag(snap, env);
    const pit = pit0 ?? (cin ? { name: cin.name, time: cin.time, place: (snap.hasBall ? 'glove' : 'none') as BallPlace | 'none' } : this.eventPlan(snap, baseName));
    const name = pit ? pit.name : baseName;
    this.pitchClipTime = pit ? pit.time : null;
    if (snap.anim !== this.lastHint || name !== this.currentName || (hint !== snap.anim && hint !== this.lastMoveHint)) {
      this.play(name, snap);
    }
    this.lastHint = snap.anim;
    this.lastMoveHint = hint;
    const stanceHeld = !gaitOver && snap.role === 'batter' && (snap.anim === 'idle' || snap.anim === 'swing' || snap.anim === 'batter_practice_swing' || snap.anim === 'batter_adjust' || snap.anim === 'batter_step_out');
    const sp = Math.hypot(snap.vel.x, snap.vel.z);
    const locomotion = name === 'run' || name === 'trot' || name === 'jog' || name === 'run_sprint' || name === 'run_turn' || name === 'run_turn_sprint' || name === 'walk';
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
      // no foot sliding: play the clip at (ground speed / the speed its stance foot moves back at); the gaits above already keep this near 1
      const fallback = name === 'trot' ? 2.2 : name === 'walk' ? 1.42 : name === 'jog' ? 3.5 : name.endsWith('sprint') ? 7 : 5;
      const foot = this.footSpeedOf(name, fallback);
      this.current.timeScale = Math.min(name === 'walk' ? 1.7 : 1.8, Math.max(0.4, sp / foot));
    } else if (this.current) this.current.timeScale = name === 'toss' ? 0.75 : 1;
    // sim-driven clip time: when the sim reports progress through a one-shot animation, seek to it
    if (!pit && this.current && snap.animProgress !== undefined && !this.isLoop(this.currentName)) {
      const dur = this.current.getClip().duration;
      this.current.paused = false;
      this.current.timeScale = 0;
      this.current.time = Math.min(dur - 0.001, Math.max(0, snap.animProgress * dur));
    }
    // ROOT CAUSE of the spinning heads: three's mixer only writes a bone when the clip value changed since last frame, so on a held
    // pose (stance frame 0, paused / progress-seeked clips) our look / IK rotation from the previous frame stayed on the bone and
    // was applied again on top, every frame. Put every bone we modify back to its clip pose before the mixer runs.
    for (const [bone, q] of this.clipPose) bone.quaternion.copy(q);
    // LOD1: seated / standing extras far from the camera animate at half rate and skip look-at and IK
    const lod1 = this.offscreen || (AMBIENT_ROLES.has(snap.role) && !!env.cameraPos && Math.hypot(env.cameraPos.x - snap.pos.x, env.cameraPos.z - snap.pos.z) > LOD1_DISTANCE) || (this.lodTier >= 2 && !FLAGS.noskip && !puppetIsKey(snap, env));
    this.lod1 = lod1;
    this.updateLod(snap, env);
    if (this.cornea.length) {
      const near = !!env.cameraPos && Math.hypot(env.cameraPos.x - snap.pos.x, env.cameraPos.z - snap.pos.z) < 12; // close-ups only: each shell is a draw call
      const vis = shadingTier() === 'full' && !lod1 && near;
      for (const c of this.cornea) c.visible = vis;
    }
    const tMix = perf.t();
    if (lod1) {
      this.lodAcc += dt;
      this.lodFlip = !this.lodFlip;
      if (this.lodFlip) {
        this.mixer.update(this.lodAcc);
        this.lodAcc = 0;
      }
    } else {
      this.mixer.update(dt + this.lodAcc);
      this.lodAcc = 0;
    }
    if (perf.on) perf.sub('pup.mixer', tMix);
    for (const [bone, q] of this.clipPose) q.copy(bone.quaternion);

    // Body yaw. In the box the sim turns the batter toward the pitcher (its `facing` is a look direction), but a hitter stands
    // sideways, chest toward the plate, and only turns his head. Everywhere else the sim's facing is the body's.
    const ready = this.updateReady(snap, env, dt);
    // travelling in a stationary pose (a gait chosen by speed): the body faces where it is going
    const wantYaw = stanceHeld ? stanceYaw(snap.hand) : ready && this.readyW > 0.35 ? ready.yaw : gaitOver && speed0 > 0.9 ? Math.atan2(snap.vel.x, snap.vel.z) : snap.facing;
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
    // seated, the clip puts the seat 0.45 m up for the nominal 1.85 m body; a player scaled by his height sits on the same seat: keep the seat where it is
    const seat = this.currentName === 'bench_sit' ? SIT_SEAT * (1 - this.bodyScale) : 0;
    this.root.position.set(snap.pos.x, snap.pos.y + seat, snap.pos.z);
    this.root.rotation.y = this.bodyYaw;
    const tMat = perf.t();
    this.refreshMatrices();
    if (perf.on) perf.sub('pup.matrix', tMat);
    this.updateProp(snap, env);
    this.updateDecals(snap, env, lod1);
    if (lod1) {
      this.updateHeldBall(snap, env, snap.hasBall ? 'hand' : 'none', dt);
      this.updateHands(snap);
      return;
    }
    this.rig.refresh();

    // the head / spine look rotates the shoulders, so it goes first; the arms then reach for the bat, ball or runner from where the shoulders ended up
    const tLook = perf.t();
    this.lookAt(snap, dt, env);
    if (perf.on) perf.sub('pup.look', tLook);
    const tIk = perf.t();
    // arm IK: batter's hands follow the sim's bat
    const wantIK = !!(env.batGrip && snap.role === 'batter');
    // grab the sim's bat almost at once (the swing starts abruptly), let go smoothly
    // where even the swivelled elbow cannot get out of the torso (hands the sim placed too close to the body), fade the bat IK toward the clip pose
    this.trackPitchHeight(snap, env);
    // a low pitch: the hitter's hands come down and the clip's own pose is the better guide than hands pinned to the sim's bat
    const ikWant = Math.min(this.elbowClear < -0.005 ? 0.25 : 1, this.lowPitch ? 0.3 : 1);
    this.ikFade += (ikWant - this.ikFade) * (1 - Math.exp(-dt * (ikWant < 1 ? 14 : 5)));
    this.ikW += ((wantIK ? this.ikFade : 0) - this.ikW) * (1 - Math.exp(-dt * (wantIK ? 90 : 25)));
    if (this.ikW > 0.02 && env.batGrip) {
      // the hand nearest the knob is the model's Left hand for both batting sides (lefties are mirrored)
      this.solveArm('Left', env.batGrip.bottom, this.ikW);
      this.solveArm('Right', env.batGrip.top, this.ikW);
    }
    this.reachIK(snap, env, dt);
    this.clearElbows(snap);
    if (perf.on) perf.sub('pup.ik', tIk);
    let place: BallPlace | 'none' | 'transfer' = pit ? pit.place : snap.anim === 'transfer' ? 'transfer' : 'none';
    if (place === 'none' && snap.hasBall && snap.role !== 'batter' && snap.role !== 'runner' && snap.role !== 'umpire') {
      // a fielder who holds the ball has it in the glove pocket; while he throws it stays in his hand until the sim releases it
      place = THROW_HINTS.has(snap.anim) || snap.role === 'ballkid' ? 'hand' : 'glove';
    }
    this.updateHeldBall(snap, env, place, dt);
    this.updateHands(snap);
    this.updateFace(snap, dt);
  }

  // ---- face ---------------------------------------------------------------------------------------------------------------
  private lookGoal: LookTarget | null = null;
  private eyeYaw = 0;
  private eyePitch = 0;
  private face: { meshes: Mesh[]; blinkAt: number; blinkT: number; sacAt: number; sacYaw: number; sacPitch: number; base: Record<string, number>; cur: Record<string, number>; clock: number } | null = null;
  /**
   * The face is alive (t-0014: "faces look weird, like uncanny valley": the expression morphs were never driven, so every face stared without blinking):
   * blinks at natural random intervals (2.5-6 s, ~0.15 s each), the eyes lead the head to its look target with small saccades, a relaxed per-person
   * baseline (a hint of a smile, brows not knitted), focus on the pitch (batter, pitcher, catcher), an effort face on swings / throws / slides, smiles
   * celebrating. Only for close players (detail tier 0); the morphs are the files' MPFB expression keys (mouth_open kept <= 0.6).
   */
  private updateFace(snap: PlayerSnap, dt: number) {
    if (this.lodTier > 0) return;
    if (!this.face) {
      const meshes: Mesh[] = [];
      for (const m of this.meshes) {
        const d = (m as Mesh).morphTargetDictionary;
        if (d && (d.eyes_blink !== undefined || d.eyes_look_left !== undefined || d.smile !== undefined)) meshes.push(m as Mesh);
      }
      if (!meshes.length) return;
      const h = hashString(snap.id + ':face');
      const r = (k: number) => ((h >>> (k * 3)) % 997) / 997;
      this.face = {
        meshes, blinkAt: 0.5 + 3 * r(1), blinkT: -1, sacAt: 0, sacYaw: 0, sacPitch: 0, clock: 0,
        base: { smile: 0.04 + 0.14 * r(2), brow_raise: 0.12 + 0.16 * r(3), brow_furrow: 0, mouth_open: 0.02 + 0.05 * r(4), mouth_pucker: 0 },
        cur: { eyes_blink: 0, smile: 0, brow_raise: 0, brow_furrow: 0, mouth_open: 0, mouth_pucker: 0, eyes_look_left: 0, eyes_look_right: 0, eyes_look_up: 0, eyes_look_down: 0 },
      };
    }
    const F = this.face;
    F.clock += dt;
    // blink: close 0.06 s, open 0.10 s; the next one 2.5-6 s later (sometimes a double blink)
    if (F.blinkT < 0 && F.clock >= F.blinkAt) F.blinkT = 0;
    let blink = 0;
    if (F.blinkT >= 0) {
      F.blinkT += dt;
      blink = F.blinkT < 0.06 ? F.blinkT / 0.06 : Math.max(0, 1 - (F.blinkT - 0.06) / 0.1);
      if (F.blinkT > 0.16) {
        F.blinkT = -1;
        const u = (Math.sin(F.clock * 12.9898 + hashString(snap.id)) * 43758.5453) % 1;
        const v = Math.abs(u);
        F.blinkAt = F.clock + (v < 0.12 ? 0.25 : 2.5 + 3.5 * v);
      }
    }
    // micro-saccades: a small new fixation offset every 0.5-1.8 s
    if (F.clock >= F.sacAt) {
      const v = Math.abs((Math.sin(F.clock * 78.233 + 1.7) * 43758.5453) % 1), w = Math.abs((Math.sin(F.clock * 39.425 + 0.3) * 24634.6345) % 1);
      F.sacYaw = (v - 0.5) * 0.09;
      F.sacPitch = (w - 0.5) * 0.06;
      F.sacAt = F.clock + 0.5 + 1.3 * w;
    }
    const EYE = (22 * Math.PI) / 180, EYE_V = (18 * Math.PI) / 180;
    const ey = Math.max(-1, Math.min(1, (this.eyeYaw + F.sacYaw) / EYE)), ep = Math.max(-1, Math.min(1, (this.eyePitch + F.sacPitch) / EYE_V));
    // the situation
    const a = snap.anim;
    const want: Record<string, number> = { ...F.base, eyes_blink: blink, eyes_look_left: Math.max(0, ey), eyes_look_right: Math.max(0, -ey), eyes_look_down: Math.max(0, ep), eyes_look_up: Math.max(0, -ep) };
    const focus = (snap.role === 'batter' && a === 'idle') || a === 'windup' || (snap.role === 'catcher' && a === 'idle') || a === 'catcher_signs';
    if (focus) { want.brow_furrow = 0.22; want.brow_raise = 0.02; want.smile = 0; want.mouth_open = 0.02; }
    if (a === 'swing' || a === 'pitch' || a === 'throw' || a.startsWith('slide') || a === 'catch_jump' || a === 'dive_back') { want.brow_furrow = 0.55; want.brow_raise = 0; want.mouth_open = 0.35; want.smile = 0.2; }
    if (a === 'celebrate' || a === 'bench_cheer' || a === 'coach_go') { want.smile = 0.75; want.mouth_open = 0.45; want.brow_raise = 0.35; want.brow_furrow = 0; }
    if (a.startsWith('mound_talk') || a === 'manager_signal') { want.mouth_open = 0.12 + 0.12 * Math.abs(Math.sin(F.clock * 9)); }
    want.mouth_open = Math.min(0.6, want.mouth_open);
    // ease toward it (blinks and eye moves are fast, expressions slower)
    for (const k in want) {
      const fast = k === 'eyes_blink' || k.startsWith('eyes_look');
      const rate = fast ? 1 : 1 - Math.exp(-dt * 6);
      F.cur[k] = (F.cur[k] ?? 0) + (want[k] - (F.cur[k] ?? 0)) * rate;
    }
    for (const m of F.meshes) {
      const d = m.morphTargetDictionary!, inf = m.morphTargetInfluences!;
      for (const k in F.cur) {
        const i = d[k];
        if (i !== undefined) inf[i] = F.cur[k];
      }
    }
    // the cornea shells share the eyes' morphs
    for (const c of this.cornea) {
      const cm = c as Mesh, eyes = this.nodes.get('Eyes') as Mesh | undefined;
      if (cm.morphTargetInfluences && eyes?.morphTargetInfluences) for (let i = 0; i < cm.morphTargetInfluences.length; i++) cm.morphTargetInfluences[i] = eyes.morphTargetInfluences[i] ?? 0;
    }
  }

  // ---- hands --------------------------------------------------------------------------------------------------------------
  /** the sim's sign sequence for the pitch being called (`signs_given`), shown on the catcher's fingers */
  private signSeq: number[] | null = null;
  setSigns(seq: number[]) {
    this.signSeq = seq.length ? seq.slice() : null;
  }
  private handShown = { R: '', L: '' };
  /**
   * Which hand mesh shows (the rig has no finger bones; the files carry posed variants): the right hand is the ball claw while it holds the ball, the
   * fist on the bat (batters, the on-deck hitter) and while the catcher puts down signs (the fingers_n morphs extend n fingers), relaxed otherwise; the left
   * is in the glove, on the bat, or relaxed. It used to be the claw on every fielder, pitcher and catcher all game, with the sign morphs never driven.
   */
  private updateHands(snap: PlayerSnap) {
    const fist = this.nodes.get('Hand_R'), claw = this.nodes.get('Hand_R_Ball'), relaxed = this.nodes.get('Hand_R_Relaxed');
    if (!claw && !relaxed) return; // fixed-look files: their one Hand_R is already the right pose for the role
    const bat = snap.role === 'batter' || snap.role === 'ondeck';
    const signs = this.currentName === 'catcher_signs' || this.currentName === 'catcher_signs_runner_on';
    const ball = this.ballPlace === 'hand' || this.ballPlace === 'transfer';
    const r = ball && claw ? 'ball' : bat || signs || !relaxed ? 'fist' : 'relaxed';
    if (r !== this.handShown.R) {
      this.handShown.R = r;
      if (fist) fist.visible = r === 'fist';
      if (claw) claw.visible = r === 'ball';
      if (relaxed) relaxed.visible = r === 'relaxed';
    }
    if (fist) this.driveSignFingers(fist as Mesh, signs);
    const lFist = this.nodes.get('Hand_L'), lRelaxed = this.nodes.get('Hand_L_Relaxed');
    const gloved = this.gloveNodes.length > 0 && !!this.gloveNodes[0].visible;
    const l = gloved ? 'glove' : bat || !lRelaxed ? 'fist' : 'relaxed';
    if (l !== this.handShown.L) {
      this.handShown.L = l;
      if (lFist) lFist.visible = l === 'fist';
      if (lRelaxed) lRelaxed.visible = l === 'relaxed';
    }
  }
  /** the catcher's signs: the clip's flash windows (manifest `finger_keys`: [frame, n]) show the sim's sequence, n fingers extended (`fingers_n`), else a fist */
  private driveSignFingers(hand: Mesh, signs: boolean) {
    const dict = hand.morphTargetDictionary, infl = hand.morphTargetInfluences;
    if (!dict || !infl) return;
    let n = 0;
    if (signs && this.current) {
      const keys = (this.manifest?.clips[this.currentName] as { finger_keys?: [number, number][] } | undefined)?.finger_keys ?? [];
      const f = this.current.time * 24;
      let flash = -1, k = 0;
      for (const [fr, v] of keys) {
        if (fr > f) break;
        k = v;
        if (v > 0) flash++;
      }
      if (k > 0) {
        const seq = this.signSeq;
        const v = seq ? seq[flash <= 0 ? 0 : Math.min(seq.length - 1, seq.length > 1 ? 2 : 0)] : k;
        n = v >= 1 && v <= 4 ? v : 0; // a 5 (change-up / splitter) is the closed fist
      }
    }
    for (let i = 1; i <= 4; i++) {
      const j = dict[`fingers_${i}`];
      if (j === undefined) continue;
      const want = i === n ? 1 : 0;
      infl[j] += (want - infl[j]) * 0.6; // ~1 frame blend, as the clip's keys say
      if (Math.abs(infl[j] - want) < 0.01) infl[j] = want;
    }
  }
  /** distant extra: animates at half rate without look-at / IK (level of detail 1) */
  lod1 = false;
  private lodAcc = 0;
  private lodFlip = false;
  private prop: Object3D | null = null;

  /** the on-deck batter's bat with a donut: the model's own `Bat_Donut` when it has one, else a plain bat and ring in his hand */
  private updateProp(snap: PlayerSnap, env: PuppetEnv) {
    const want = snap.role === 'ondeck';
    const donut = this.nodes.get('Bat_Donut');
    if (donut) donut.visible = want;
    if (!want && !this.prop) return;
    if (want && !this.prop && this.batGrip) {
      this.prop = env.makeBat ? env.makeBat() : makeOnDeckBat(!!donut);
      this.batGrip.add(this.prop);
    }
    if (this.prop) this.prop.visible = want;
  }

  /**
   * Last name and number on the jersey: textures come from the shared cache (a substitution just looks up another), are applied when the player,
   * his colours, his handedness or the quality change, and the decals are drawn only within their range of the camera (the old digit quads
   * stand in for the back number whenever the decal is not shown).
   */
  private updateDecals(snap: PlayerSnap, env: PuppetEnv, lod1: boolean) {
    const kinds = Object.keys(this.decals) as DecalKind[];
    if (!kinds.length) return;
    const look = this.lastLook?.look;
    const q = jerseyQuality();
    const mirror = this.mirrored;
    const printed = snap.team >= 0 && !!look && (snap.name !== undefined || snap.number !== undefined);
    const key = printed ? `${snap.name}|${snap.number}|${look!.jersey}|${look!.sock}|${mirror}|${q}` : '';
    if (key !== this.decalKey) {
      this.decalKey = key;
      const print = printed ? jerseyPrint(snap.name, snap.number, look!.jersey, look!.sock, q, mirror) : {};
      for (const k of kinds) {
        const mesh = this.decals[k]!;
        const spec = print[k];
        mesh.userData.hasPrint = !!spec;
        if (spec) mesh.material = decalMaterial(this.decalTemplate, jerseyTextures.get(spec));
      }
    }
    // the ranges are for a normal lens (~40 deg): a telephoto (the centre-field pitch camera, 9 deg at 120 m) magnifies, so the distance is
    // scaled by the lens's magnification, like the detail tiers
    const zoom = env.lodK ? Math.max(1, env.lodK / LOD_K_NORMAL) : 1;
    const d = env.cameraPos ? Math.hypot(env.cameraPos.x - snap.pos.x, env.cameraPos.z - snap.pos.z) / zoom : 0;
    for (const k of kinds) {
      const mesh = this.decals[k]!;
      mesh.visible = !lod1 && !!mesh.userData.hasPrint && d < decalRange(k, q);
    }
    const back = this.decals.backNumber;
    const digitsOff = !!back && back.visible;
    for (const m of [this.numMeshes.tens, this.numMeshes.ones]) if (m) m.visible = (m.userData.show ?? true) && !digitsOff;
  }

  private wasStance = false;
  private lastMoveHint: AnimHint | '' = '';
  /** a gait chosen by speed is overriding a stationary hint (hysteresis for `wantsGait`) */
  private gaitOn = false;
  private ikFade = 1;
  private warnedLook = false;
  /** bones modified after the mixer (look-at, arm IK) → their pose as the clip left them this frame */
  private clipPose = new Map<Bone, Quaternion>();

  private static readonly CATCH_HINTS = new Set<AnimHint>(['catch', 'field', 'catch_pitch', 'catch_throw', 'catch_stretch', 'catch_fly', 'catch_fly_run', 'catch_line_drive', 'catch_backhand', 'catch_comebacker', 'field_grounder', 'catch_jump', 'pitcher_catch_toss']);
  private gloveW = 0;
  private readyW = 0;
  private readyGlovePos: { x: number; y: number; z: number } | null = null;
  private readyLook: Vector3 | null = null;

  /** easing for the waiting pose (glove up, turned toward the thrower); returns the yaw to face while it is on */
  private updateReady(snap: PlayerSnap, env: PuppetEnv, dt: number): { yaw: number } | null {
    const c = env.carrier && env.carrier.id !== snap.id ? env.carrier : null;
    const dist = c ? Math.hypot(c.pos.x - snap.pos.x, c.pos.z - snap.pos.z) : 0;
    const on = receiveReady({
      hint: snap.anim === 'catch_ready',
      role: snap.role,
      anim: snap.anim,
      hasBall: !!snap.hasBall,
      carrier: c ? { role: c.role, anim: c.anim, distance: dist } : null,
      liveBall: (env.ballSpeed ?? 0) > 14,
      incoming: !!snap.gloveTarget && (snap.catchIn ?? 0) < 1.2,
    });
    // up in about a quarter second, down a little slower; a catch clip (own hint) takes over the glove from there
    this.readyW += ((on ? 1 : 0) - this.readyW) * (1 - Math.exp(-dt * (on ? 9 : 6)));
    if (this.readyW < 0.01) {
      this.readyGlovePos = null;
      this.readyLook = null;
      return null;
    }
    const to = c ? c.pos : env.ball ?? (snap.gloveTarget ? new Vector3(snap.gloveTarget.x, snap.gloveTarget.y, snap.gloveTarget.z) : null);
    if (!to) return null;
    if (snap.gloveTarget) this.readyGlovePos = { x: snap.gloveTarget.x, y: snap.gloveTarget.y, z: snap.gloveTarget.z };
    else this.readyGlovePos = readyGlove(snap.pos, to, snap.hand ?? 'R', this.readyGlovePos ?? undefined);
    (this.readyLook ??= new Vector3()).set(to.x, to.y + 1.2, to.z);
    return { yaw: Math.atan2(to.x - snap.pos.x, to.z - snap.pos.z) };
  }
  private lastGlove: { x: number; y: number; z: number } | null = null;
  private gloveClosed = 0;

  /**
   * Reaching for a ball or a runner: the glove hand goes to where the sim says the ball will meet the glove (`gloveTarget`), so the pocket is
   * at the ball at the catch instant, and closes on it; a tag sweeps the glove (or bare hand) through the nearest opposing runner.
   */
  private reachIK(snap: PlayerSnap, env: PuppetEnv, dt: number) {
    let gt = snap.gloveTarget ?? (this.inferredGlove ? { x: this.inferredGlove.x, y: this.inferredGlove.y, z: this.inferredGlove.z } : undefined);
    // the sim drops the glove target at the catch itself: the glove stays where the ball is for the rest of the catch (the give), then relaxes
    const inCatchHint = GltfPuppet.CATCH_HINTS.has(snap.anim);
    if (gt) this.lastGlove = { x: gt.x, y: gt.y, z: gt.z };
    else if (!inCatchHint) this.lastGlove = null;
    const held = !gt && inCatchHint && !!this.lastGlove && (snap.animProgress ?? 0.5) < 1;
    if (held) gt = this.lastGlove!;
    const catching = (GltfPuppet.CATCH_HINTS.has(snap.anim) || this.inferredGlove !== null) && !!gt;
    const tagging = snap.anim === 'tag_glove' || snap.anim === 'tag_hand';
    const p = snap.animProgress ?? 0.5;
    let target: Vector3 | null = null;
    let side: 'Left' | 'Right' = 'Left';
    let w = 0;
    if (catching) {
      target = new Vector3(gt!.x, gt!.y, gt!.z);
      // reach out through the first half of the catch, then hold the pocket on the ball
      w = held ? Math.max(0, Math.min(1, (0.95 - p) / 0.3)) : p < 0.15 ? p / 0.15 : 1;
    } else if (this.readyW > 0.02 && this.readyGlovePos) {
      // glove out for a throw that has not left the thrower's hand yet
      target = new Vector3(this.readyGlovePos.x, this.readyGlovePos.y, this.readyGlovePos.z);
      w = this.readyW;
    } else if (tagging && env.positions) {
      // the runner the sim named in the tag event, else the nearest other player within reach
      let rid = env.tagRunner?.(snap.id) ?? null;
      if (!rid || !env.positions.has(rid)) {
        rid = null;
        let best = 1e9;
        for (const [id, pos] of env.positions) {
          if (id === snap.id) continue;
          const d = Math.hypot(pos.x - snap.pos.x, pos.z - snap.pos.z);
          if (d < best && d < 2.6) {
            best = d;
            rid = id;
          }
        }
      }
      const rp = rid ? env.positions.get(rid) : null;
      if (rp) {
        // through the runner: chest height for a runner on his feet, near the ground for a slider
        const ra = (rid && env.anims?.get(rid)) || '';
        target = new Vector3(rp.x, /slide|dive|pop/.test(ra) ? 0.2 : 0.8, rp.z);
      }
      side = snap.anim === 'tag_hand' ? 'Right' : 'Left';
      // the sweep peaks at the moment the sim announces the result (contact), then relaxes
      const pe = this.tagLatch.p ?? 0.56;
      const pp = Math.min(1, Math.max(0, p));
      w = pp < pe ? Math.sin((Math.PI / 2) * (pp / pe)) : Math.cos((Math.PI / 2) * ((pp - pe) / Math.max(0.05, 1 - pe)));
      if (target && env.tagOutcome?.(snap.id) === 'avoided') {
        // the runner slid / dodged out of the way: the sweep goes through the space he was in, a half metre to the side of him
        const dx = target.x - snap.pos.x, dz = target.z - snap.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        target.x += (-dz / l) * 0.55;
        target.z += (dx / l) * 0.55;
        target.y = 0.3;
      }
    }
    this.gloveW += ((target ? w : 0) - this.gloveW) * (1 - Math.exp(-dt * 40));
    // a target beyond arm's reach: a lunge (the body steps / leans toward it, at most ~0.45 m) before the trunk lean and the arm finish the reach
    this.lungeMax = tagging ? 1.05 : 0.8;
    this.reachStep(target, side, dt);
    if (target && this.gloveW > 0.02) {
      const hand = this.bones[`${side}Hand`];
      const pocket = side === 'Left' ? this.pocket ?? this.nodes.get('Glove_Pocket') ?? null : null;
      if (hand) {
        // put the POCKET (not the wrist) on the target: a few passes, since the pocket offset turns with the hand
        const goal = target;
        this.reachLean(hand, pocket, side, goal, this.gloveW);
        for (let it = 0; it < 4; it++) {
          this.rig.refresh();
          const hw = hand.getWorldPosition(new Vector3());
          const off = pocket ? pocket.getWorldPosition(new Vector3()).sub(hw) : new Vector3();
          this.solveArm(side, goal.clone().sub(off), this.gloveW);
        }
      }
    }
    this.driveGlove(snap);
  }

  /**
   * glove_open / glove_closed morphs. Catch clips carry `glove_closed_keys` in the manifest ([frame, weight] pairs: 0 before the catch, 1 at
   * the catch frame, held through the give, released a few frames later), evaluated at the clip's own time; otherwise the glove closes on a ball it holds.
   */
  private driveGlove(snap: PlayerSnap) {
    if (!this.gloveNodes.length) return;
    const keys = this.manifest?.clips[this.currentName]?.glove_closed_keys;
    let closed = 0, open = 0;
    if (keys && keys.length && this.current) {
      const f = this.current.time * 24;
      if (f <= keys[0][0]) closed = keys[0][1];
      else if (f >= keys[keys.length - 1][0]) closed = keys[keys.length - 1][1];
      else {
        for (let i = 1; i < keys.length; i++) {
          if (f <= keys[i][0]) {
            const [f0, w0] = keys[i - 1], [f1, w1] = keys[i];
            closed = w0 + ((w1 - w0) * (f - f0)) / Math.max(1e-6, f1 - f0);
            break;
          }
        }
      }
      open = 1 - closed;
    } else if (snap.hasBall && snap.role !== 'batter') closed = 0.6;
    this.gloveClosed += (closed - this.gloveClosed) * 0.6;
    for (const o of this.gloveNodes) {
      const m = o as Mesh;
      const inf = m.morphTargetInfluences, dict = m.morphTargetDictionary;
      if (!inf || !dict) continue;
      if (dict.glove_closed !== undefined) inf[dict.glove_closed] = this.gloveClosed;
      if (dict.glove_open !== undefined) inf[dict.glove_open] = open * (1 - this.gloveClosed);
    }
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
    // a helmet (batters, runners) is a bigger head than a cap
    this.headVol = snap.role === 'batter' || snap.role === 'runner' ? this.headVolHelmet : this.headVolCap;
    // head sphere centre in rig space (the head bone's own axes: +Y up, +Z forward)
    const headB = this.bones.Head;
    let hc = Infinity;
    let headC: V3 | null = null;
    if (headB) {
      const hp = rig.pos(headB, new Vector3());
      const hq = rig.quat(headB, new Quaternion());
      const off = new Vector3(0, this.headVol.up, this.headVol.fwd).applyQuaternion(hq);
      headC = [hp.x + off.x, hp.y + off.y, hp.z + off.z];
    }
    for (const side of ['Left', 'Right'] as const) {
      const arm = this.bones[`${side}Arm`], fore = this.bones[`${side}ForeArm`], hand = this.bones[`${side}Hand`];
      if (!arm || !fore || !hand) continue;
      const E = rig.pos(fore, new Vector3());
      const loc = E.clone().sub(Ps).applyQuaternion(Qi);
      const Sp = rig.pos(arm, new Vector3());
      const Hp = rig.pos(hand, new Vector3());
      const headClear = (e: V3) => (headC ? armHeadClearance([Sp.x, Sp.y, Sp.z], e, [Hp.x, Hp.y, Hp.z], headC, this.headVol) : Infinity);
      let clear = Math.min(torsoClearance(loc.x, loc.y, loc.z, this.torso), headClear([E.x, E.y, E.z]));
      if (clear < 0.008 && !(globalThis as { __noElbowFix?: boolean }).__noElbowFix) {
        // swivel the elbow around the shoulder→hand axis: the hand stays where the clip / IK put it, only the elbow leaves the trunk
        const S = rig.pos(arm, new Vector3());
        const H = rig.pos(hand, new Vector3());
        const tmp = new Vector3();
        const clearAt = (p: V3) => {
          tmp.set(p[0], p[1], p[2]).sub(Ps).applyQuaternion(Qi);
          return Math.min(torsoClearance(tmp.x, tmp.y, tmp.z, this.torso), headClear(p));
        };
        const r = swivelElbow([S.x, S.y, S.z], [H.x, H.y, H.z], [E.x, E.y, E.z], clearAt, 0.02);
        if (r.angle !== 0) {
          rig.aim(arm, fore, new Vector3(r.elbow[0], r.elbow[1], r.elbow[2]), 1);
          rig.aim(fore, hand, H, 1);
        }
        clear = r.clear;
      }
      worst = Math.min(worst, clear);
      if (headC) {
        // what is left after the fix, measured from the final bone positions (the number the per-frame assertion watches)
        const E2 = rig.pos(fore, new Vector3()), H2 = rig.pos(hand, new Vector3());
        hc = Math.min(hc, armHeadClearance([Sp.x, Sp.y, Sp.z], [E2.x, E2.y, E2.z], [H2.x, H2.y, H2.z], headC, this.headVol));
      }
    }
    this.elbowClear = worst;
    this.headClear = hc;
    this.headClearWorst = Math.min(this.headClearWorst, hc);
    if (import.meta.env?.DEV && hc < -0.03 && !this.warnedHead) {
      this.warnedHead = true;
      console.error(`[head] ${snap.id} arm ${(-hc * 100).toFixed(1)} cm inside the head (${snap.anim})`);
    }
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
    if (!this.ballHeld) {
      if (this.ballObj) this.ballObj.visible = false;
      this.ballPlace = 'none';
      return;
    }
    if (!this.ballObj) this.ballObj = env.makeBall!();
    const ball = this.ballObj;
    ball.visible = true;
    const pocket = this.pocket ?? this.nodes.get('Glove_Pocket');
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

  faceCenter(out: Vector3): Vector3 | null {
    const head = this.bones.Head;
    if (!head) return null;
    this.refreshMatrices();
    this.rig.refresh();
    const p = this.rig.pos(head, new Vector3());
    const q = this.rig.quat(head, new Quaternion());
    // the face sits a hand above the head bone and a little forward (head-local +Y up, +Z forward)
    p.add(new Vector3(0, 0.105, 0.05).applyQuaternion(q));
    return out.copy(p).applyMatrix4(this.model.matrixWorld);
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
    const focus = this.readyLook && this.readyW > 0.35 ? this.readyLook : live ? env.ball : env.mound ?? null;
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
      // running, the head stays near level and only glances at the ball (a sprinting runner turned his head 50 deg to a fly ball, which on his leaning
      // trunk threw it back);
      // a fielder chasing a catch keeps his look (he tracks the ball over his shoulder)
      const sp = Math.hypot(snap.vel.x, snap.vel.z);
      if (t.valid && sp > 2.5 && !snap.gloveTarget) {
        const k = Math.min(1, (sp - 2.5) / 2);
        // (a yaw about the forward-leaning spine axis also tips the head back: at a sprint only ~20 deg each way)
        const upMax = 0.6 - 0.34 * k, yawMax = 1.0 - 0.65 * k;
        t.pitch = Math.max(t.pitch, -upMax);
        t.yaw = Math.max(-yawMax, Math.min(yawMax, t.yaw));
      }
    }
    this.lookGoal = t && t.valid ? t : null;
    const hl = this.headLook;
    hl.step(t, dt);
    // what the head has not turned yet, the eyes cover (they lead the head)
    if (this.lookGoal) {
      this.eyeYaw = this.lookGoal.yaw - hl.yaw;
      this.eyePitch = this.lookGoal.pitch - hl.pitch;
    } else this.eyeYaw = this.eyePitch = 0;
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

  /**
   * A still picture of this person for an off-screen render (the crowd atlas, `crowdAtlas.ts`): plain clothes instead of the role's gear (no glove,
   * decals, numbers, belt or eye black), a cap or the given hair style, the clip held at time `t`, the model at the origin facing +Z at full detail.
   * Returns false when the clip does not exist. Only for puppets that never join the game.
   */
  poseStill(clip: string, t: number, o: { cap: boolean; hair?: string; jersey?: string }): boolean {
    const a = this.actions.get(clip);
    if (!a) return false;
    const show = (name: string, on: boolean) => {
      const n = this.nodes.get(name);
      if (n) n.visible = on;
    };
    for (const [name, n] of this.nodes) {
      if (/^(Gear_Glove|Gear_Number_|Gear_Belt|Gear_EyeBlack|Gear_Helmet|Gear_Wristband|Gear_ArmSleeve|Gear_CatcherMask|Gear_ChestProtector|Gear_ShinGuard|Gear_LineupCard|Gear_Jacket|Hand_L_Open|Hand_R_Ball|Jersey_.*Decal|Gear_Hair)/.test(name)) n.visible = false;
    }
    // fans' hands hang relaxed (the fists are bat grips)
    const relaxed = !!this.nodes.get('Hand_R_Relaxed');
    show('Hand_L', !relaxed);
    show('Hand_R', !relaxed);
    show('Hand_L_Relaxed', relaxed);
    show('Hand_R_Relaxed', relaxed);
    show('Gear_Cap', o.cap);
    if (!o.cap) show(o.hair ?? this.look?.hairNode ?? 'Gear_Hair', true);
    if (o.jersey) for (const n of JERSEY_NODES) show(n, n === o.jersey);
    // a t-shirt shows bare arms
    if (o.jersey === 'Jersey_ShortSleeve') show('Undershirt', false);
    for (const c of this.cornea) c.visible = true;
    this.mixer.stopAllAction();
    a.reset();
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    a.time = Math.min(t, a.getClip().duration - 1e-3);
    this.mixer.update(0);
    this.model.scale.setScalar(this.bodyScale);
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.matrixWorldAutoUpdate = true;
    this.root.updateMatrixWorld(true);
    for (const m of this.meshes) m.frustumCulled = false;
    return true;
  }

  dispose() {
    this.ballObj?.removeFromParent();
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}

