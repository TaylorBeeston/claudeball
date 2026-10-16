/**
 * Human joint ranges, measured on anatomical frames (skeleton.ts): every joint as clinically meaningful angles (degrees) with the range a
 * real body allows. One table for the pose validator (tools/jank) and the runtime constraint layer.
 *
 * Conventions (body axes, +Z forward, +Y up, +X the model's left; `side` = +1 left limb, -1 right limb):
 * - hinge flexion (elbow, knee): the angle between the two segments, positive when the distal one swings toward its flexion side (elbow:
 *   anterior, +Z of the upper arm's frame; knee: posterior), negative = hyperextension (bending backwards). `off`: out of the hinge plane.
 * - twist: rotation of the child about the child segment's rest direction (swing-twist decomposition of the joint rotation).
 * - head / spine: yaw, pitch (> 0 = flexion, looking / bending down), roll of the child frame relative to the parent frame.
 */
import { DEG, qrotInv, twistAngle, qangle, type Q, type V } from './qmath';
import { B, NB, type PoseWorld, jointRot, segDir } from './skeleton';

export interface RestInfo {
  rest: PoseWorld;
  /** rest unit direction of each bone toward its main child (rig space = body axes at rest) */
  dir: Float64Array;
  /** rest segment lengths (model units, base scale included) */
  len: Float64Array;
}

/** the child that defines each bone's segment direction (-1: none) */
export const SEG_CHILD: number[] = (() => {
  const c = new Array<number>(NB).fill(-1);
  c[B.Hips] = B.Spine;
  c[B.Spine] = B.Spine1;
  c[B.Spine1] = B.Spine2;
  c[B.Spine2] = B.Neck;
  c[B.Neck] = B.Head;
  for (const s of ['Left', 'Right'] as const) {
    c[B[`${s}Shoulder`]] = B[`${s}Arm`];
    c[B[`${s}Arm`]] = B[`${s}ForeArm`];
    c[B[`${s}ForeArm`]] = B[`${s}Hand`];
    c[B[`${s}UpLeg`]] = B[`${s}Leg`];
    c[B[`${s}Leg`]] = B[`${s}Foot`];
    c[B[`${s}Foot`]] = B[`${s}ToeBase`];
  }
  return c;
})();

export function restInfo(rest: PoseWorld): RestInfo {
  const dir = new Float64Array(NB * 3), len = new Float64Array(NB);
  const d = [0, 0, 0];
  for (let i = 0; i < NB; i++) {
    const c = SEG_CHILD[i];
    if (c < 0) {
      // hand: continue the forearm; head: up
      if (i === B.Head) dir.set([0, 1, 0], i * 3);
      continue;
    }
    segDir(rest, i, c, d);
    dir.set(d, i * 3);
    len[i] = Math.hypot(rest.wp[c * 3] - rest.wp[i * 3], rest.wp[c * 3 + 1] - rest.wp[i * 3 + 1], rest.wp[c * 3 + 2] - rest.wp[i * 3 + 2]);
  }
  // the hand points along its forearm
  for (const s of ['Left', 'Right'] as const) dir.set(dir.subarray(B[`${s}ForeArm`] * 3, B[`${s}ForeArm`] * 3 + 3), B[`${s}Hand`] * 3);
  return { rest, dir, len };
}

export interface Limit {
  key: string;
  lo: number;
  hi: number;
  /** what a violation looks like, for the report */
  label: string;
}

/** degrees */
export const JOINT_LIMITS: Limit[] = [];
const lim = (key: string, lo: number, hi: number, label: string) => JOINT_LIMITS.push({ key, lo, hi, label });
for (const s of ['L', 'R']) {
  lim(`elbow${s}.flex`, -8, 155, 'elbow bends backwards / past full flexion');
  lim(`elbow${s}.off`, -25, 25, 'elbow bends sideways out of its hinge');
  lim(`forearm${s}.pron`, -100, 100, 'forearm over-twisted: pronation (> 0) / supination (< 0) from neutral (thumb forward with the arm hanging)');
  lim(`wrist${s}.split`, 0, 45, 'twist not shared between forearm and hand (the wrist wrings like a towel)');
  lim(`wrist${s}.swing`, 0, 85, 'wrist bent too far');
  lim(`shoulder${s}.post`, 0, 65, 'upper arm too far behind the body');
  lim(`shoulder${s}.behind`, 0, 15, 'upper arm swung behind and across the back');
  lim(`shoulder${s}.twist`, -120, 120, 'upper arm over-twisted');
  lim(`clavicle${s}.swing`, 0, 40, 'shoulder girdle dislocated');
  lim(`knee${s}.flex`, -8, 155, 'knee bends backwards / past full flexion');
  lim(`knee${s}.off`, -20, 20, 'knee bends sideways out of its hinge');
  lim(`knee${s}.twist`, -40, 40, 'shin over-twisted');
  lim(`hip${s}.flex`, -35, 135, 'thigh too far behind / in front');
  lim(`hip${s}.abd`, -35, 60, 'thigh too far out / across');
  lim(`hip${s}.twist`, -55, 55, 'thigh over-twisted');
  lim(`ankle${s}.swing`, 0, 60, 'ankle bent too far');
  lim(`ankle${s}.twist`, -35, 35, 'foot twisted about the shin');
}
lim('neck.yaw', -80, 80, 'head turned too far (neck + head vs chest)');
lim('neck.pitch', -70, 65, 'head tipped too far up / down');
lim('neck.roll', -45, 45, 'head tilted too far sideways');
lim('spine.yaw', -50, 50, 'trunk twisted too far (chest vs pelvis)');
lim('spine.pitch', -35, 80, 'trunk bent too far forward / back');
lim('spine.roll', -40, 40, 'trunk bent too far sideways');

/** degrees the rig's rest pose is pronated from neutral */
const PRON_REST = 20;
const tq = [0, 0, 0, 1], tv = [0, 0, 0], ypr = [0, 0, 0], d = [0, 0, 0], sw = [0, 0, 0, 1];

/**
 * Axial rotation (yaw: twist about +Y) and the swing split into pitch (about +X, > 0 = flexion, tipping forward / looking down) and roll (about
 * +Z): swing-twist, so unlike Euler angles it stays well defined when the trunk leans far forward under a level head.
 */
export function axialSwing(r: Q, out: V): V {
  out[0] = twistAngle(r, 0, 1, 0, sw);
  const s = Math.hypot(sw[0], sw[2]);
  const ang = 2 * Math.atan2(s, Math.abs(sw[3])) * Math.sign(sw[3] || 1);
  out[1] = s > 1e-9 ? (ang * sw[0]) / s : 0;
  out[2] = s > 1e-9 ? (ang * sw[2]) / s : 0;
  return out;
}

function hinge(w: PoseWorld, R: RestInfo, upper: number, mid: number, end: number, flexZ: number, out: Record<string, number>, k: string) {
  const ux = R.dir[upper * 3], uy = R.dir[upper * 3 + 1], uz = R.dir[upper * 3 + 2];
  // the flexion side (anterior / posterior) made perpendicular to the upper segment
  const dz = flexZ - flexZ * uz * uz;
  let nx = -flexZ * uz * ux, ny = -flexZ * uz * uy, nz = dz;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const ax = uy * nz - uz * ny, ay = uz * nx - ux * nz, az = ux * ny - uy * nx;
  segDir(w, mid, end, d);
  qrotInv(w.aq, d[0], d[1], d[2], tv, upper * 4);
  out[`${k}.flex`] = Math.atan2(tv[0] * nx + tv[1] * ny + tv[2] * nz, tv[0] * ux + tv[1] * uy + tv[2] * uz) / DEG;
  out[`${k}.off`] = Math.asin(Math.max(-1, Math.min(1, tv[0] * ax + tv[1] * ay + tv[2] * az))) / DEG;
}

function twistOf(w: PoseWorld, R: RestInfo, p: number, c: number, axisBone: number): number {
  jointRot(w, p, c, tq);
  return twistAngle(tq, R.dir[axisBone * 3], R.dir[axisBone * 3 + 1], R.dir[axisBone * 3 + 2]) / DEG;
}
function swingOf(w: PoseWorld, R: RestInfo, p: number, c: number, axisBone: number): number {
  jointRot(w, p, c, tq);
  const sw = [0, 0, 0, 1];
  twistAngle(tq, R.dir[axisBone * 3], R.dir[axisBone * 3 + 1], R.dir[axisBone * 3 + 2], sw);
  return qangle(sw) / DEG;
}

/** Every joint angle of the pose (degrees), keyed like JOINT_LIMITS. */
export function measureJoints(w: PoseWorld, R: RestInfo, out: Record<string, number> = {}): Record<string, number> {
  for (const [s, side] of [['L', 1], ['R', -1]] as const) {
    const S = s === 'L' ? 'Left' : 'Right';
    const sh = B[`${S}Shoulder`], arm = B[`${S}Arm`], fore = B[`${S}ForeArm`], hand = B[`${S}Hand`];
    const up = B[`${S}UpLeg`], leg = B[`${S}Leg`], foot = B[`${S}Foot`];
    hinge(w, R, arm, fore, hand, 1, out, `elbow${s}`);
    // the rig has no twist bones: the clips share pronation between the forearm and the hand bone (each carries about half)
    const tf = twistOf(w, R, arm, fore, fore), th = twistOf(w, R, fore, hand, fore);
    // pronation from neutral, > 0 = pronated (thumb turning down / in) on either side: the rest pose is ~20 deg pronated from the idle's
    // thumbs-forward neutral (measured on `idle`), and the twist's sign is mirrored between the sides
    let pr = -side * (tf + th) + PRON_REST;
    pr -= 360 * Math.round(pr / 360);
    out[`forearm${s}.pron`] = pr;
    out[`wrist${s}.split`] = Math.abs(th - tf);
    out[`wrist${s}.swing`] = swingOf(w, R, fore, hand, fore);
    // upper arm direction in the chest's frame
    segDir(w, arm, fore, d);
    qrotInv(w.aq, d[0], d[1], d[2], tv, B.Spine2 * 4);
    out[`shoulder${s}.post`] = Math.asin(Math.max(0, Math.min(1, -tv[2]))) / DEG;
    const medial = -side * tv[0];
    out[`shoulder${s}.behind`] = tv[1] > -0.75 && medial > 0 && tv[2] < 0 ? Math.asin(Math.min(1, Math.min(medial, -tv[2]))) / DEG : 0;
    out[`shoulder${s}.twist`] = twistOf(w, R, B.Spine2, arm, arm);
    jointRot(w, B.Spine2, sh, tq);
    out[`clavicle${s}.swing`] = qangle(tq) / DEG;
    hinge(w, R, up, leg, foot, -1, out, `knee${s}`);
    out[`knee${s}.twist`] = twistOf(w, R, up, leg, leg);
    segDir(w, up, leg, d);
    qrotInv(w.aq, d[0], d[1], d[2], tv, B.Hips * 4);
    out[`hip${s}.flex`] = Math.atan2(tv[2], -tv[1]) / DEG;
    out[`hip${s}.abd`] = Math.asin(Math.max(-1, Math.min(1, side * tv[0]))) / DEG;
    out[`hip${s}.twist`] = twistOf(w, R, B.Hips, up, up);
    out[`ankle${s}.swing`] = swingOf(w, R, leg, foot, leg);
    out[`ankle${s}.twist`] = twistOf(w, R, leg, foot, leg);
  }
  jointRot(w, B.Spine2, B.Head, tq);
  axialSwing(tq, ypr);
  out['neck.yaw'] = ypr[0] / DEG;
  out['neck.pitch'] = ypr[1] / DEG;
  out['neck.roll'] = ypr[2] / DEG;
  jointRot(w, B.Hips, B.Spine2, tq);
  axialSwing(tq, ypr);
  out['spine.yaw'] = ypr[0] / DEG;
  out['spine.pitch'] = ypr[1] / DEG;
  out['spine.roll'] = ypr[2] / DEG;
  return out;
}

/** how far (degrees) a measured angle is outside its limit (0 inside) */
export const excess = (l: Limit, v: number) => (v > l.hi ? v - l.hi : v < l.lo ? l.lo - v : 0);
