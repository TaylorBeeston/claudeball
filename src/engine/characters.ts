/**
 * Procedural articulated player rig with an animation state machine.
 *
 * This is the fallback used until Blender-exported skinned glTF characters land
 * (`assets/players/*.glb`); `players.ts` swaps to `GltfPuppet` when they load.
 * Both share the same contract: the sim's position/facing/anim hint drive
 * everything, the rig never moves the player on its own (root motion comes
 * from the sim), and head/arms use lookAt/IK toward sim-reported targets.
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { AnimHint, PlayerRole, PlayerSnap } from './types';
import { HeadLook, lookTarget, type LookTarget } from './headLook';

// ---------------------------------------------------------------------------------- pose
const KEYS = [
  'hipsY', 'hipsRx', 'hipsRy', 'hipsRz', 'spRx', 'spRy', 'spRz', 'nkRx', 'nkRy',
  'lsF', 'lsA', 'lsT', 'leB', 'rsF', 'rsA', 'rsT', 'reB',
  'lhF', 'lhA', 'lkB', 'laF', 'rhF', 'rhA', 'rkB', 'raF',
] as const;
type Key = (typeof KEYS)[number];
export type Pose = Record<Key, number>;

const L_THIGH = 0.46, L_SHIN = 0.46, LEG = L_THIGH + L_SHIN;
const HIP_H = LEG + 0.085;

export const newPose = (): Pose => {
  const p = {} as Pose;
  for (const k of KEYS) p[k] = 0;
  p.lsA = p.rsA = 0.1;
  p.leB = p.reB = 0.2;
  return p;
};

function lerpPose(out: Pose, a: Pose, b: Pose, w: number) {
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * w;
}

function mirrorPose(p: Pose): Pose {
  const m = { ...p };
  const swap = (a: Key, b: Key) => {
    m[a] = p[b];
    m[b] = p[a];
  };
  swap('lsF', 'rsF'); swap('lsA', 'rsA'); swap('lsT', 'rsT'); swap('leB', 'reB');
  swap('lhF', 'rhF'); swap('lhA', 'rhA'); swap('lkB', 'rkB'); swap('laF', 'raF');
  m.hipsRy = -p.hipsRy; m.hipsRz = -p.hipsRz; m.spRy = -p.spRy; m.spRz = -p.spRz; m.nkRy = -p.nkRy;
  m.lsT = -m.lsT; m.rsT = -m.rsT;
  return m;
}

/** Set a leg (hip flex + knee bend) with the foot kept flat; returns pelvis height. */
function leg(p: Pose, side: 'l' | 'r', hF: number, kB: number, abd = 0.05): number {
  if (side === 'l') { p.lhF = hF; p.lkB = kB; p.laF = kB - hF; p.lhA = abd; }
  else { p.rhF = hF; p.rkB = kB; p.raF = kB - hF; p.rhA = abd; }
  return L_THIGH * Math.cos(hF) + L_SHIN * Math.cos(hF - kB);
}
/** Symmetric stance; lowers the pelvis so both feet stay planted. */
function stance(p: Pose, hF: number, kB: number, abd = 0.05) {
  const h = leg(p, 'l', hF, kB, abd);
  leg(p, 'r', hF, kB, abd);
  p.hipsY = h - LEG;
}

const sin = Math.sin, cos = Math.cos, PI = Math.PI;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mixN = (a: number, b: number, t: number) => a + (b - a) * t;

interface Ctx {
  t: number;
  speed: number;
  role: PlayerRole;
  hand: 'L' | 'R';
}

/** Rest/ready pose per role (used by `idle`). */
function idlePose(p: Pose, c: Ctx) {
  const br = sin(c.t * 1.7) * 0.012;
  p.spRx = 0.02 + br;
  switch (c.role) {
    case 'catcher':
      stance(p, 1.45, 2.55, 0.35);
      p.hipsRx = 0.55; p.spRx = 0.35; p.nkRx = -0.25;
      p.lsF = 1.25; p.lsA = 0.05; p.leB = 0.7; // glove out
      p.rsF = 0.2; p.rsA = 0.25; p.reB = 0.9;
      break;
    case 'umpire':
      stance(p, 0.85, 1.4, 0.15);
      p.hipsRx = 0.35; p.spRx = 0.3; p.nkRx = -0.2;
      p.lsF = 0.5; p.rsF = 0.5; p.leB = 0.9; p.reB = 0.9; p.lsA = 0.05; p.rsA = 0.05;
      break;
    case 'pitcher':
      stance(p, 0.06, 0.1);
      p.lsF = 1.05; p.rsF = 1.0; p.lsA = -0.12; p.rsA = -0.12; p.leB = 1.5; p.reB = 1.5; p.spRx = 0.08;
      break;
    case 'batter':
      stance(p, 0.5, 0.95, 0.28);
      p.hipsRx = 0.25; p.spRx = 0.18; p.hipsRy = -0.15; p.spRy = -0.1;
      break;
    case 'runner':
      stance(p, 0.42, 0.85, 0.25);
      p.hipsRx = 0.3; p.spRx = 0.2; p.lsF = 0.4; p.rsF = -0.1; p.leB = 0.9; p.reB = 0.5;
      p.hipsRz = sin(c.t * 2.2) * 0.03;
      break;
    case 'coach':
      stance(p, 0.05, 0.08);
      p.lsA = 0.25; p.rsA = 0.25; p.leB = 0.5; p.reB = 0.5; p.hipsRz = sin(c.t * 0.9) * 0.03;
      break;
    default: {
      // fielder ready position: athletic crouch, hands low & open
      const s = sin(c.t * 1.3) * 0.04;
      stance(p, 0.55 + s, 1.0 + s, 0.22);
      p.hipsRx = 0.32; p.spRx = 0.22;
      p.lsF = 0.8; p.rsF = 0.75; p.lsA = 0.3; p.rsA = 0.3; p.leB = 0.7; p.reB = 0.65;
    }
  }
}

function fillPose(p: Pose, hint: AnimHint, c: Ctx) {
  const t = c.t;
  idlePose(p, c);
  switch (hint) {
    case 'idle':
      break;
    case 'windup': {
      // rocker step, leg lift, hands to chest, drift toward home
      const rock = sstep(0, 0.35, t), lift = sstep(0.35, 0.85, t), drive = sstep(0.85, 1.15, t);
      const pivotH = mixN(0.06, 0.55, lift) * (1 - drive) + drive * 0.2;
      const h = leg(p, 'r', 0.06 + 0.05 * rock, 0.08);
      leg(p, 'l', mixN(0.06, 1.55, lift) * (1 - drive) + 0.5 * drive, mixN(0.1, 1.9, lift) * (1 - drive) + 0.4 * drive, 0.05);
      p.hipsY = h - LEG - 0.06 * lift * (1 - drive);
      p.hipsRx = -0.1 * rock + 0.12 * drive;
      p.hipsRy = 0.6 * lift * (1 - drive) - 0.5 * drive;
      p.spRy = -0.35 * lift * (1 - drive);
      p.spRx = 0.1 * drive;
      void pivotH;
      p.lsF = 1.0 + 0.3 * lift; p.rsF = 1.0 + 0.3 * lift; p.leB = 1.6; p.reB = 1.6; p.lsA = -0.1; p.rsA = -0.1;
      // break hands
      p.rsF = mixN(p.rsF, -0.4, drive); p.rsA = mixN(-0.1, 1.5, drive); p.reB = mixN(1.6, 0.6, drive);
      p.lsF = mixN(p.lsF, 1.3, drive); p.lsA = mixN(-0.1, 0.5, drive);
      break;
    }
    case 'pitch': {
      // arm cocked -> whip -> follow through, front leg plants, torso folds over
      const whip = sstep(0.0, 0.16, t), follow = sstep(0.16, 0.5, t);
      const h = leg(p, 'l', 0.95, 0.35, 0.05);
      leg(p, 'r', mixN(-0.3, 0.35, follow), mixN(0.5, 1.2, follow), 0.05);
      p.hipsY = h - LEG - 0.05;
      p.hipsRy = mixN(-0.6, 0.95, whip);
      p.spRy = mixN(-0.5, 0.75, whip);
      p.spRx = mixN(0.05, 0.75, whip) ;
      p.hipsRx = mixN(-0.05, 0.4, whip);
      p.rsF = mixN(mixN(-0.9, 2.55, whip), 0.5, follow);
      p.rsA = mixN(1.45, 0.25, whip);
      p.reB = mixN(1.6, 0.25, whip) + 0.9 * follow;
      p.lsF = mixN(1.2, 0.3, follow); p.lsA = 0.5; p.leB = 0.9;
      break;
    }
    case 'swing': {
      // load -> stride -> hips fire -> follow through. Arms are IK'd to the bat.
      const load = sstep(0, 0.08, t), fire = sstep(0.06, 0.22, t), fol = sstep(0.22, 0.42, t);
      stance(p, 0.5 + 0.1 * fire, 0.95 - 0.1 * fire, 0.28);
      leg(p, 'l', mixN(0.5, 0.35, fire), mixN(0.95, 0.5, fire), 0.28);
      p.hipsRy = mixN(mixN(-0.15, -0.5, load), 1.15, fire) - 0.15 * fol;
      p.spRy = mixN(mixN(-0.1, -0.35, load), 0.9, fire) + 0.35 * fol;
      p.hipsRx = 0.25 - 0.1 * fire;
      p.spRx = 0.18 - 0.1 * fire;
      p.lsF = 1.2; p.rsF = 1.2; p.leB = 0.9; p.reB = 0.9;
      break;
    }
    case 'run': {
      const stride = 1.0 + 0.12 * c.speed;
      const freq = Math.max(0.6, c.speed / (2 * stride));
      const ph = t * freq * PI * 2;
      const amp = clamp(0.35 + c.speed * 0.09, 0.4, 1.05);
      const lift = clamp(c.speed / 8, 0.25, 1);
      const lh = sin(ph) * amp + 0.15, rh = sin(ph + PI) * amp + 0.15;
      const lk = 0.25 + 1.55 * lift * Math.max(0, cos(ph) * 0.7 + 0.45 * sin(ph - 0.5) * 0);
      const rk = 0.25 + 1.55 * lift * Math.max(0, cos(ph + PI) * 0.7);
      const lh2 = leg(p, 'l', lh, lk, 0.04), rh2 = leg(p, 'r', rh, rk, 0.04);
      p.hipsY = Math.min(lh2, rh2) - LEG - 0.02 + 0.045 * Math.abs(sin(ph * 2 + 0.6)) - 0.03;
      p.hipsRx = clamp(0.08 + c.speed * 0.03, 0.1, 0.35);
      p.spRx = 0.05; p.hipsRy = sin(ph) * 0.18; p.spRy = -sin(ph) * 0.22;
      const aa = amp * 1.15;
      p.lsF = -sin(ph) * aa + 0.1; p.rsF = -sin(ph + PI) * aa + 0.1;
      p.leB = 1.35 + 0.3 * lift; p.reB = 1.35 + 0.3 * lift;
      p.lsA = 0.05; p.rsA = 0.05;
      break;
    }
    case 'field': {
      // scoop: deep crouch, glove low and forward
      const dn = sstep(0, 0.2, t);
      stance(p, mixN(0.55, 1.15, dn), mixN(1.0, 1.85, dn), 0.3);
      p.hipsRx = mixN(0.32, 0.75, dn); p.spRx = mixN(0.22, 0.55, dn); p.nkRx = -0.4 * dn;
      p.lsF = mixN(0.8, 1.55, dn); p.rsF = mixN(0.75, 1.45, dn); p.leB = 0.35; p.reB = 0.4;
      break;
    }
    case 'throw': {
      // step, cock, snap, follow through
      const cock = sstep(0, 0.18, t), snap = sstep(0.18, 0.3, t), fol = sstep(0.3, 0.6, t);
      const h = leg(p, 'l', mixN(0.3, 0.9, snap), mixN(0.5, 0.5, snap), 0.1);
      leg(p, 'r', mixN(0.25, 0.1, snap), 0.5, 0.1);
      p.hipsY = h - LEG - 0.03;
      p.hipsRy = mixN(mixN(0, -0.75, cock), 0.85, snap);
      p.spRy = mixN(mixN(0, -0.6, cock), 0.7, snap);
      p.spRx = mixN(0.05, 0.4, snap);
      p.rsF = mixN(mixN(0.4, -0.7, cock), mixN(2.4, 0.6, fol), snap);
      p.rsA = mixN(0.4, 1.5, cock) * (1 - snap) + 0.2 * snap;
      p.reB = mixN(1.0, 1.65, cock) * (1 - snap) + 0.4 * snap;
      p.lsF = mixN(0.5, 1.5, cock) * (1 - snap) + -0.3 * snap; p.lsA = 0.5; p.leB = 0.7;
      break;
    }
    case 'catch': {
      const up = sstep(0, 0.12, t), dn = sstep(0.25, 0.6, t);
      p.lsF = mixN(mixN(0.8, 2.5, up), 1.2, dn); p.rsF = mixN(mixN(0.75, 2.3, up), 1.0, dn);
      p.lsA = mixN(0.3, 0.12, up); p.rsA = 0.15;
      p.leB = mixN(0.7, 0.25, up); p.reB = mixN(0.65, 0.35, up);
      break;
    }
    case 'slide': {
      const dn = sstep(0, 0.2, t);
      leg(p, 'l', mixN(0.4, 1.35, dn), mixN(0.8, 0.15, dn), 0.05);
      leg(p, 'r', mixN(0.4, 0.5, dn), mixN(0.8, 2.0, dn), 0.05);
      p.hipsY = mixN(0, -0.5, dn);
      p.hipsRx = mixN(0.3, -1.25, dn);
      p.spRx = mixN(0.2, -0.25, dn);
      p.lsF = mixN(0.4, 2.4, dn); p.rsF = mixN(0.1, 2.3, dn); p.lsA = 0.2; p.rsA = 0.2; p.leB = 0.3; p.reB = 0.3;
      break;
    }
    case 'celebrate': {
      const hop = Math.abs(sin(t * 6.2));
      stance(p, 0.25, 0.5);
      p.hipsY += hop * 0.22;
      p.lsF = 2.75; p.rsF = 2.75; p.lsA = 0.35 + 0.15 * sin(t * 9); p.rsA = 0.35 - 0.15 * sin(t * 9); p.leB = 0.2; p.reB = 0.2;
      p.spRx = -0.15;
      break;
    }
  }
}

// ---------------------------------------------------------------------------------- materials
const SKINS = ['#f0c6a0', '#dca47a', '#c08558', '#8a5a3a', '#5d3b26', '#e8b48a'];
const matCache = new Map<string, MeshStandardMaterial>();
function mat(color: string, rough = 0.7, key = color + rough, extra: Partial<MeshStandardMaterial> = {}): MeshStandardMaterial {
  let m = matCache.get(key);
  if (!m) {
    m = new MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });
    matCache.set(key, m);
  }
  return m;
}

/** Callbacks so the environment can register materials with the cascaded shadow system. */
let registerMaterial: (m: Material) => void = () => {};
export function setMaterialRegistrar(fn: (m: Material) => void) {
  registerMaterial = fn;
  for (const m of matCache.values()) fn(m);
}
export const reg = <T extends Material>(m: T): T => {
  if (!(m.userData.regd)) {
    m.userData.regd = true;
    registerMaterial(m);
  }
  return m;
};

// shared geometry
const G = {
  thigh: new CapsuleGeometry(0.095, L_THIGH - 0.13, 4, 10).translate(0, -L_THIGH / 2, 0),
  shin: new CapsuleGeometry(0.068, L_SHIN - 0.12, 4, 10).translate(0, -L_SHIN / 2, 0),
  sock: new CapsuleGeometry(0.07, L_SHIN * 0.55, 3, 10).translate(0, -L_SHIN * 0.7, 0),
  foot: new BoxGeometry(0.1, 0.075, 0.27).translate(0, -0.045, 0.06),
  pelvis: new CapsuleGeometry(0.15, 0.08, 4, 12).rotateZ(Math.PI / 2),
  torso: new CapsuleGeometry(0.155, 0.32, 5, 14).scale(1.12, 1, 0.78),
  belt: new CylinderGeometry(0.168, 0.168, 0.05, 16).scale(1.1, 1, 0.8),
  uArm: new CapsuleGeometry(0.052, 0.21, 4, 8).translate(0, -0.15, 0),
  fArm: new CapsuleGeometry(0.043, 0.2, 4, 8).translate(0, -0.14, 0),
  hand: new SphereGeometry(0.05, 8, 6),
  glove: new SphereGeometry(0.115, 10, 8).scale(0.75, 1, 0.55),
  head: new SphereGeometry(0.105, 16, 12).scale(0.92, 1.12, 1.02),
  neck: new CylinderGeometry(0.05, 0.058, 0.09, 8),
  capDome: new SphereGeometry(0.112, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.95, 1.05, 1.05),
  brim: new CylinderGeometry(0.1, 0.1, 0.012, 16, 1, false, -Math.PI / 2 - 1.05, 2.1).scale(1, 1, 1.22),
  helmet: new SphereGeometry(0.125, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62).scale(1, 1.02, 1.08),
  flap: new BoxGeometry(0.03, 0.09, 0.09),
  chest: new BoxGeometry(0.3, 0.34, 0.11),
  mask: new SphereGeometry(0.12, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1, 1.05, 1.05),
};

export interface Look {
  jersey: string;
  pants: string;
  cap: string;
  sock: string;
  skin: string;
}

const bind = (m: Mesh, cast = true) => {
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
};

export interface PuppetLike {
  root: Object3D;
  team: number;
  setTeam(look: Look, team: number): void;
  update(snap: PlayerSnap, dt: number, env: PuppetEnv): void;
  dispose(): void;
  /** hand attachment for the bat when the sim reports none (glTF characters only) */
  batGrip?: Object3D | null;
  /** midpoint of the shoulder joints in scene space (glTF characters only); used to check the sim's bat is within arm's reach */
  shoulderCenter?(out: Vector3): Vector3 | null;
  /** centre of the face in scene space (glTF characters only): where close-up shots aim */
  faceCenter?(out: Vector3): Vector3 | null;
  /** true while the puppet carries its own ball (glove / hand / transfer): the world ball is then hidden */
  ballHeld?: boolean;
  /** world position of that ball */
  heldBallWorld?(out: Vector3): Vector3 | null;
}

export interface PuppetEnv {
  /** ball world position (scene) or null */
  ball: Vector3 | null;
  /** bat grip targets (scene), null when no bat */
  batGrip: { top: Vector3; bottom: Vector3 } | null;
  /** simulation time in seconds, for idle variety */
  time: number;
  /** ball speed (m/s), 0 when there is no ball */
  ballSpeed?: number;
  /** ball velocity (scene axes) */
  ballVel?: Vector3;
  /** where the pitcher's eyes/hands are (scene): what hitters, catchers and umpires look at while no ball is visible */
  mound?: Vector3 | null;
  /** what happened to this fielder's latest tag: made, or avoided by the runner (null: none in flight) */
  tagOutcome?: (fielderId: string) => 'tag' | 'avoided' | 'attempt' | null;
  /** the runner a fielder's latest tag is aimed at */
  tagRunner?: (fielderId: string) => string | null;
  /** every player's animation hint by id */
  anims?: Map<string, string>;
  /** every player's scene position by id (for tags: where the runner is) */
  positions?: Map<string, Vector3>;
  /** the camera's position (scene): far extras drop to a cheaper animation */
  cameraPos?: { x: number; y: number; z: number };
  /** whoever holds the ball (a fielder mid-transfer / look / toss): where a receiver should turn and hold his glove */
  carrier?: { id: string; role: string; anim: string; pos: Vector3 } | null;
  /** makes a practice bat with a donut for the on-deck batter's hand */
  makeBat?: () => Object3D;
  /** makes a ball for a hand / glove (a clone of the ball model) */
  makeBall?: () => Object3D;
}

const seedFrom = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};

const _v = new Vector3(), _v2 = new Vector3(), _q = new Quaternion(), _down = new Vector3(0, -1, 0);

export class Puppet implements PuppetLike {
  root = new Group();
  team = -2;
  private hips = new Group();
  private spine = new Group();
  private neck = new Group();
  private sh: [Group, Group] = [new Group(), new Group()];
  private el: [Group, Group] = [new Group(), new Group()];
  private hp: [Group, Group] = [new Group(), new Group()];
  private kn: [Group, Group] = [new Group(), new Group()];
  private an: [Group, Group] = [new Group(), new Group()];
  private jersey: Mesh[] = [];
  private pants: Mesh[] = [];
  private capMeshes: Mesh[] = [];
  private sockMeshes: Mesh[] = [];
  private skinMeshes: Mesh[] = [];
  private gloveMesh: Mesh;
  private helmetMesh: Mesh;
  private capGroup = new Group();
  private extras = new Group();
  private pose = newPose();
  private from = newPose();
  private target = newPose();
  private cur: AnimHint = 'idle';
  private curStart = 0;
  private blend = 1;
  private seed: number;
  private look = { yaw: 0, pitch: 0 };
  private headLook = new HeadLook();
  private lookT: LookTarget = { yaw: 0, pitch: 0, valid: false };
  private role: PlayerRole = 'idle' as PlayerRole;
  private ikW = 0;
  private clock = 0;

  constructor(id: string) {
    this.seed = seedFrom(id);
    const r = this.root;
    r.add(this.hips);
    this.hips.position.y = HIP_H;
    const skin = mat(SKINS[Math.floor(this.seed * SKINS.length) % SKINS.length], 0.6);
    // pelvis + legs
    const pel = bind(new Mesh(G.pelvis, mat('#fff', 0.8, 'pants')));
    this.pants.push(pel);
    this.hips.add(pel);
    for (const s of [0, 1]) {
      const sgn = s === 0 ? 1 : -1;
      const hp = this.hp[s];
      hp.position.set(sgn * 0.09, -0.02, 0);
      this.hips.add(hp);
      const th = bind(new Mesh(G.thigh, mat('#fff', 0.8, 'pants')));
      this.pants.push(th);
      hp.add(th);
      const kn = this.kn[s];
      kn.position.y = -L_THIGH;
      hp.add(kn);
      const sh = bind(new Mesh(G.shin, mat('#fff', 0.8, 'pants')));
      this.pants.push(sh);
      kn.add(sh);
      const sk = bind(new Mesh(G.sock, mat('#fff', 0.9, 'sock')));
      this.sockMeshes.push(sk);
      kn.add(sk);
      const an = this.an[s];
      an.position.y = -L_SHIN;
      kn.add(an);
      const ft = bind(new Mesh(G.foot, mat('#111214', 0.55, 'shoe')));
      an.add(ft);
      this.skinMeshes; // (feet are shoes)
    }
    // torso
    this.spine.position.y = 0.06;
    this.hips.add(this.spine);
    const torso = bind(new Mesh(G.torso, mat('#fff', 0.85, 'jersey')));
    torso.position.y = 0.25;
    this.jersey.push(torso);
    this.spine.add(torso);
    const belt = bind(new Mesh(G.belt, mat('#15161a', 0.5, 'belt')));
    belt.position.y = 0.02;
    this.hips.add(belt);
    // neck + head
    this.neck.position.y = 0.6;
    this.spine.add(this.neck);
    const nk = bind(new Mesh(G.neck, skin));
    nk.position.y = 0.02;
    this.skinMeshes.push(nk);
    const head = bind(new Mesh(G.head, skin));
    head.position.y = 0.13;
    this.skinMeshes.push(head);
    this.neck.add(nk, head);
    this.capGroup.position.y = 0.155;
    const dome = bind(new Mesh(G.capDome, mat('#fff', 0.9, 'cap')));
    dome.position.y = -0.03;
    const brim = bind(new Mesh(G.brim, mat('#fff', 0.9, 'cap')));
    brim.position.set(0, -0.02, 0.05);
    this.capMeshes.push(dome, brim);
    this.capGroup.add(dome, brim);
    this.neck.add(this.capGroup);
    this.helmetMesh = bind(new Mesh(G.helmet, mat('#fff', 0.35, 'helmet', { metalness: 0.1 })));
    this.helmetMesh.position.set(0, 0.155, 0);
    const flap = bind(new Mesh(G.flap, this.helmetMesh.material as Material));
    flap.position.set(0.12, -0.04, 0.02);
    this.helmetMesh.add(flap);
    this.helmetMesh.visible = false;
    this.neck.add(this.helmetMesh);
    // arms
    for (const s of [0, 1]) {
      const sgn = s === 0 ? 1 : -1;
      const sh = this.sh[s];
      sh.position.set(sgn * 0.205, 0.5, 0);
      this.spine.add(sh);
      const ua = bind(new Mesh(G.uArm, mat('#fff', 0.85, 'jersey')));
      this.jersey.push(ua);
      sh.add(ua);
      const el = this.el[s];
      el.position.y = -0.3;
      sh.add(el);
      const fa = bind(new Mesh(G.fArm, skin));
      this.skinMeshes.push(fa);
      el.add(fa);
      const hand = bind(new Mesh(G.hand, skin));
      hand.position.y = -0.28;
      this.skinMeshes.push(hand);
      el.add(hand);
    }
    this.gloveMesh = bind(new Mesh(G.glove, mat('#5a3a1f', 0.65, 'glove')));
    this.gloveMesh.position.set(0, -0.32, 0.05);
    this.gloveMesh.visible = false;
    this.el[0].add(this.gloveMesh);
    this.spine.add(this.extras);
    this.applySkin(skin);
  }

  private applySkin(skin: MeshStandardMaterial) {
    for (const m of this.skinMeshes) m.material = skin;
  }

  setTeam(look: Look, team: number) {
    this.team = team;
    const j = mat(look.jersey, 0.85, 'j' + look.jersey), p = mat(look.pants, 0.85, 'p' + look.pants);
    const c = mat(look.cap, 0.9, 'c' + look.cap), s = mat(look.sock, 0.9, 's' + look.sock);
    for (const m of this.jersey) m.material = reg(j);
    for (const m of this.pants) m.material = reg(p);
    for (const m of this.capMeshes) m.material = reg(c);
    for (const m of this.sockMeshes) m.material = reg(s);
    (this.helmetMesh.material as MeshStandardMaterial) = reg(mat(look.cap, 0.3, 'h' + look.cap, { metalness: 0.15 }));
    (this.helmetMesh.children[0] as Mesh).material = this.helmetMesh.material;
    if (look.skin) this.applySkin(reg(mat(look.skin, 0.6, 'k' + look.skin)));
    for (const m of matCache.values()) reg(m);
  }

  private setRoleGear(role: PlayerRole) {
    this.role = role;
    const helmet = role === 'batter' || role === 'runner' || role === 'coach' || role === 'catcher';
    this.helmetMesh.visible = helmet;
    this.capGroup.visible = !helmet && role !== 'umpire';
    this.gloveMesh.visible = ['pitcher', 'first', 'second', 'third', 'short', 'left', 'center', 'right', 'catcher'].includes(role);
    this.gloveMesh.scale.setScalar(role === 'catcher' ? 1.5 : role === 'first' ? 1.25 : 1);
    this.extras.clear();
    if (role === 'catcher' || role === 'umpire') {
      const cp = bind(new Mesh(G.chest, reg(mat(role === 'umpire' ? '#1b1d21' : '#1a2a45', 0.7, 'prot' + role))));
      cp.position.set(0, 0.32, 0.1);
      this.extras.add(cp);
      const mk = bind(new Mesh(G.mask, reg(mat('#1d1f24', 0.4, 'mask', { metalness: 0.3 }))));
      mk.position.set(0, 0.6 + 0.14, 0.06);
      mk.rotation.x = -0.15;
      this.neck.add(mk);
      mk.position.set(0, 0.155, 0.03);
    }
    if (role === 'umpire') {
      // dark uniform
      const dk = reg(mat('#1b1e24', 0.85, 'umpire'));
      for (const m of [...this.jersey, ...this.pants, ...this.sockMeshes]) m.material = dk;
      this.helmetMesh.visible = false;
      this.capGroup.visible = false;
    }
    this.helmetMesh.scale.setScalar(role === 'catcher' ? 1.06 : 1);
    this.helmetMesh.rotation.y = role === 'catcher' ? Math.PI : 0;
  }

  update(snap: PlayerSnap, dt: number, env: PuppetEnv) {
    if (snap.role !== this.role) this.setRoleGear(snap.role);
    this.clock += dt;
    const hand = snap.hand ?? (this.seed < 0.28 ? 'L' : 'R');
    // hints this rig has no dedicated pose for fall back to the nearest one
    const hint: AnimHint = snap.anim === 'trot' || snap.anim === 'run_turn' ? 'run' : snap.anim === 'catch_jump' ? 'catch' : snap.anim;
    if (hint !== this.cur) {
      // capture what is currently displayed and cross-fade into the new clip
      Object.assign(this.from, this.pose);
      this.cur = hint;
      this.curStart = this.clock - (snap.animTime ?? 0);
      this.blend = 0;
    }
    const speed = Math.hypot(snap.vel.x, snap.vel.z);
    const c: Ctx = { t: this.clock - this.curStart, speed, role: snap.role, hand };
    let tp = newPose();
    fillPose(tp, hint, c);
    if (hand === 'L') tp = mirrorPose(tp);
    Object.assign(this.target, tp);
    const fade = hint === 'run' || hint === 'idle' ? 0.16 : 0.09;
    this.blend = Math.min(1, this.blend + dt / fade);
    const w = this.blend * this.blend * (3 - 2 * this.blend);
    lerpPose(this.pose, this.from, this.target, w);
    this.applyPose(this.pose);

    // root & gear
    this.root.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
    // a batter in the box stands sideways, chest toward the plate (the sim's facing is where he looks: at the pitcher)
    const stance = snap.role === 'batter' && (snap.anim === 'idle' || snap.anim === 'swing');
    this.root.rotation.y = stance ? (hand === 'L' ? Math.PI / 2 - 0.2 : -Math.PI / 2 + 0.2) : snap.facing;
    this.root.updateMatrixWorld(true);

    // head lookAt toward the ball (or the mound): clamped, speed-limited, ignored when behind / too close
    let t: LookTarget | null = null;
    const focus = env.ball ?? env.mound ?? null;
    if (focus) {
      _v.copy(focus);
      this.spine.worldToLocal(_v);
      t = lookTarget(_v.x, _v.y - 0.65, _v.z, 0, 0, this.lookT);
    }
    this.headLook.step(t, dt);
    this.look.yaw = this.headLook.yaw;
    this.look.pitch = this.headLook.pitch;
    this.neck.rotation.set(this.pose.nkRx + this.look.pitch - this.spine.rotation.x * 0.3, this.pose.nkRy + this.look.yaw, 0, 'YXZ');

    // arm IK to the bat for the batter
    const wantIK = !!(env.batGrip && snap.role === 'batter');
    this.ikW += ((wantIK ? 1 : 0) - this.ikW) * (1 - Math.exp(-dt * 25));
    if (this.ikW > 0.02 && env.batGrip) {
      this.spine.updateMatrixWorld(true);
      this.solveArm(0, env.batGrip.top, this.ikW, hand === 'R' ? 1 : -1);
      this.solveArm(1, env.batGrip.bottom, this.ikW, hand === 'R' ? 1 : -1);
    }
    // fielder glove reaches for the ball when it is close during a catch / field
    if (env.ball && (hint === 'catch' || hint === 'field') && this.role !== 'batter') {
      this.spine.updateMatrixWorld(true);
      const gi = hand === 'L' ? 1 : 0;
      this.sh[gi].getWorldPosition(_v2);
      const d = _v2.distanceTo(env.ball);
      if (d < 0.66) this.solveArm(gi, env.ball, sstep(0.66, 0.35, d) * 0.9, 1, true);
    }
  }

  private applyPose(p: Pose) {
    this.hips.position.y = HIP_H + p.hipsY;
    this.hips.rotation.set(p.hipsRx, p.hipsRy, p.hipsRz, 'YXZ');
    this.spine.rotation.set(p.spRx, p.spRy, p.spRz, 'YXZ');
    // scene is mirrored vs sim on X only through positions, so character-local signs are unchanged
    this.sh[0].rotation.set(-p.lsF, p.lsT, p.lsA, 'ZYX');
    this.sh[1].rotation.set(-p.rsF, p.rsT, -p.rsA, 'ZYX');
    this.el[0].rotation.set(-p.leB, 0, 0);
    this.el[1].rotation.set(-p.reB, 0, 0);
    this.hp[0].rotation.set(-p.lhF, 0, p.lhA);
    this.hp[1].rotation.set(-p.rhF, 0, -p.rhA);
    this.kn[0].rotation.set(p.lkB, 0, 0);
    this.kn[1].rotation.set(p.rkB, 0, 0);
    this.an[0].rotation.set(-p.laF, 0, 0);
    this.an[1].rotation.set(-p.raF, 0, 0);
  }

  /** Two-bone IK: put the hand of arm `i` on world-space `target`. */
  private solveArm(i: number, target: Vector3, weight: number, poleSign: number, glove = false) {
    const sh = this.sh[i], el = this.el[i];
    const L1 = 0.3, L2 = 0.3 + (glove ? 0.05 : 0);
    const S = sh.getWorldPosition(new Vector3());
    const dir = _v.copy(target).sub(S);
    let d = dir.length();
    if (d < 1e-4) return;
    dir.divideScalar(d);
    d = clamp(d, 0.12, L1 + L2 - 0.004);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // pole: elbows point down and slightly outward
    const out = new Vector3(i === 0 ? 1 : -1, 0, 0).transformDirection(this.spine.matrixWorld);
    const pole = new Vector3(0, -1, 0).addScaledVector(out, 0.5 * poleSign);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const E = S.clone().addScaledVector(dir, a).addScaledVector(pole, h);
    // shoulder aims local -Y at the elbow
    const parent = sh.parent!;
    const eLocal = parent.worldToLocal(E.clone()).sub(sh.position).normalize();
    const qs = _q.setFromUnitVectors(_down, eLocal);
    const qCur = sh.quaternion.clone();
    sh.quaternion.slerpQuaternions(qCur, qs, weight);
    sh.updateMatrixWorld(true);
    const tl = sh.worldToLocal(target.clone());
    const dl = tl.sub(el.position).normalize();
    const qe = new Quaternion().setFromUnitVectors(_down, dl);
    el.quaternion.slerp(qe, weight);
  }

  dispose() {
    this.root.removeFromParent();
  }
}

export { HIP_H };
