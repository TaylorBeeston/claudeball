/**
 * Tiny allocation-free quaternion / vector maths on plain arrays (x, y, z, w), shared by the pose validator (tools/jank) and the runtime
 * constraint layer. No three.js: it runs in Node tests, in the page and in workers alike.
 */
export type Q = Float64Array | number[];
export type V = Float64Array | number[];

export const q = (x = 0, y = 0, z = 0, w = 1): number[] => [x, y, z, w];
export const v = (x = 0, y = 0, z = 0): number[] => [x, y, z];

/** out = a * b (apply b first, then a); out may alias a or b */
export function qmul(a: Q, b: Q, out: Q = [0, 0, 0, 1], ao = 0, bo = 0, oo = 0): Q {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** conjugate (= inverse for unit quaternions) */
export function qinv(a: Q, out: Q = [0, 0, 0, 1], ao = 0, oo = 0): Q {
  out[oo] = -a[ao];
  out[oo + 1] = -a[ao + 1];
  out[oo + 2] = -a[ao + 2];
  out[oo + 3] = a[ao + 3];
  return out;
}

/** out = inverse(a) * b: b expressed in a's frame */
export function qrel(a: Q, b: Q, out: Q = [0, 0, 0, 1], ao = 0, bo = 0): Q {
  const ax = -a[ao], ay = -a[ao + 1], az = -a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** rotate vector v by unit quaternion a */
export function qrot(a: Q, vx: number, vy: number, vz: number, out: V = [0, 0, 0], ao = 0): V {
  const x = a[ao], y = a[ao + 1], z = a[ao + 2], w = a[ao + 3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** rotate by the inverse of a */
export function qrotInv(a: Q, vx: number, vy: number, vz: number, out: V = [0, 0, 0], ao = 0): V {
  const x = -a[ao], y = -a[ao + 1], z = -a[ao + 2], w = a[ao + 3];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

export function qnorm(a: Q, ao = 0): Q {
  const l = Math.hypot(a[ao], a[ao + 1], a[ao + 2], a[ao + 3]) || 1;
  a[ao] /= l;
  a[ao + 1] /= l;
  a[ao + 2] /= l;
  a[ao + 3] /= l;
  return a;
}

/** rotation angle (rad, 0..pi) of a unit quaternion */
export const qangle = (a: Q, ao = 0) => 2 * Math.acos(Math.min(1, Math.abs(a[ao + 3])));

/** angle (rad) between two unit quaternions (shortest) */
export function qdist(a: Q, b: Q, ao = 0, bo = 0): number {
  const d = Math.abs(a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3]);
  return 2 * Math.acos(Math.min(1, d));
}

export function qaxisAngle(ax: number, ay: number, az: number, ang: number, out: Q = [0, 0, 0, 1]): Q {
  const l = Math.hypot(ax, ay, az) || 1, s = Math.sin(ang / 2) / l;
  out[0] = ax * s;
  out[1] = ay * s;
  out[2] = az * s;
  out[3] = Math.cos(ang / 2);
  return out;
}

/** the shortest rotation taking unit vector a to unit vector b */
export function qfromTo(a: V, b: V, out: Q = [0, 0, 0, 1]): Q {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    // opposite: any perpendicular axis
    let px = 0, py = -a[2], pz = a[1];
    if (Math.hypot(px, py, pz) < 1e-6) [px, py, pz] = [a[2], 0, -a[0]];
    return qaxisAngle(px, py, pz, Math.PI, out);
  }
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  out[3] = 1 + d;
  return qnorm(out);
}

/**
 * Swing-twist decomposition of unit quaternion `r` about the unit axis (ax, ay, az): r = swing * twist, twist a rotation about the axis.
 * Returns the signed twist angle (rad, -pi..pi) and fills `swing` when given.
 */
export function twistAngle(r: Q, ax: number, ay: number, az: number, swing?: Q, ro = 0): number {
  const x = r[ro], y = r[ro + 1], z = r[ro + 2], w = r[ro + 3];
  const p = x * ax + y * ay + z * az;
  let tx = ax * p, ty = ay * p, tz = az * p, tw = w;
  const l = Math.hypot(tx, ty, tz, tw);
  if (l < 1e-9) {
    // 180 deg swing: twist is undefined; call it zero
    if (swing) {
      swing[0] = x;
      swing[1] = y;
      swing[2] = z;
      swing[3] = w;
    }
    return 0;
  }
  tx /= l;
  ty /= l;
  tz /= l;
  tw /= l;
  if (swing) {
    // swing = r * inverse(twist)
    const ix = -tx, iy = -ty, iz = -tz, iw = tw;
    swing[0] = w * ix + x * iw + y * iz - z * iy;
    swing[1] = w * iy - x * iz + y * iw + z * ix;
    swing[2] = w * iz + x * iy - y * ix + z * iw;
    swing[3] = w * iw - x * ix - y * iy - z * iz;
  }
  let ang = 2 * Math.atan2(tx * ax + ty * ay + tz * az, tw);
  if (ang > Math.PI) ang -= 2 * Math.PI;
  if (ang < -Math.PI) ang += 2 * Math.PI;
  return ang;
}

/**
 * Yaw (about +Y), pitch (about +X), roll (about +Z) of a rotation, intrinsic Y-X-Z order (three's 'YXZ' Euler): the natural angles of a head or
 * trunk relative to its parent when both use the body axes (+Z forward, +Y up, +X the model's left). Pitch > 0 tips +Z (forward) down.
 */
export function yawPitchRoll(r: Q, out: V = [0, 0, 0], ro = 0): V {
  const x = r[ro], y = r[ro + 1], z = r[ro + 2], w = r[ro + 3];
  // rotation matrix elements used by three's YXZ extraction
  const m13 = 2 * (x * z + w * y), m23 = 2 * (y * z - w * x), m33 = 1 - 2 * (x * x + y * y);
  const m21 = 2 * (x * y + w * z), m22 = 1 - 2 * (x * x + z * z);
  const m11 = 1 - 2 * (y * y + z * z), m31 = 2 * (x * z - w * y);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m23)));
  let yaw: number, roll: number;
  if (Math.abs(m23) < 0.9999999) {
    yaw = Math.atan2(m13, m33);
    roll = Math.atan2(m21, m22);
  } else {
    yaw = Math.atan2(-m31, m11);
    roll = 0;
  }
  out[0] = yaw;
  out[1] = pitch;
  out[2] = roll;
  return out;
}

export const DEG = Math.PI / 180;
