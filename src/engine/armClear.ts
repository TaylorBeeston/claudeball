/**
 * Elbow clearance: keeps an arm's elbow outside the torso. The torso is approximated by an ellipse (half width, half depth) around the
 * spine axis in the upper spine's frame, over the height band of the ribcage and belly; the ellipse grows with the body-build morphs.
 * Pure maths so it is unit-testable; the puppet applies it after the arm IK / clip pose.
 */
export interface TorsoVolume {
  /** half width (m, along the shoulder line) and half depth (m, front-back) of the trunk in the spine frame */
  halfW: number;
  halfD: number;
  /** height band (spine-frame y, m) the trunk occupies */
  yMin: number;
  yMax: number;
  /** trunk centre offset forward (spine-frame z, m) */
  zOff: number;
}

export function torsoVolume(morphs: Record<string, number> | undefined): TorsoVolume {
  const m = morphs ?? {};
  const lean = m.build_lean ?? 0, stocky = m.build_stocky ?? 0, musc = m.build_muscular ?? 0, heavy = m.build_heavy ?? 0;
  return {
    halfW: 0.165 * (1 + 0.32 * stocky + 0.16 * musc - 0.1 * lean + 0.36 * heavy),
    halfD: 0.115 * (1 + 0.42 * stocky + 0.1 * musc - 0.08 * lean + 0.55 * heavy),
    yMin: -0.5,
    yMax: 0.1,
    zOff: 0.012,
  };
}

/** Normalised radius of a point in the spine frame: < 1 is inside the trunk. Points outside the height band are never inside. */
export function torsoRadius(x: number, y: number, z: number, v: TorsoVolume): number {
  if (y < v.yMin || y > v.yMax) return Infinity;
  return Math.hypot(x / v.halfW, (z - v.zOff) / v.halfD);
}

/** Metres outside the trunk surface along the radial direction (negative: inside, i.e. penetration). */
export function torsoClearance(x: number, y: number, z: number, v: TorsoVolume): number {
  const r = torsoRadius(x, y, z, v);
  if (!Number.isFinite(r)) return Infinity;
  const ex = x, ez = z - v.zOff;
  const len = Math.hypot(ex, ez);
  if (len < 1e-6) return -Math.min(v.halfW, v.halfD);
  // radius of the ellipse in this direction
  const rad = len / r;
  return len - rad;
}

/**
 * Push a point that is inside the trunk (or closer than `margin`) radially out to the surface plus `margin`.
 * `side` (+1 the model's left arm at +X, -1 right) breaks the tie when the point is on the spine axis. Returns [x, z].
 */
export function pushOutsideTorso(x: number, y: number, z: number, v: TorsoVolume, side: 1 | -1, margin = 0.02): [number, number] {
  const r = torsoRadius(x, y, z, v);
  if (!Number.isFinite(r)) return [x, z];
  const need = 1 + margin / Math.min(v.halfW, v.halfD);
  if (r >= need) return [x, z];
  let ex = x / v.halfW, ez = (z - v.zOff) / v.halfD;
  if (r < 1e-4) {
    ex = side;
    ez = 0;
  } else {
    ex /= r;
    ez /= r;
  }
  // blend the push so it fades in smoothly over the margin band (no snapping when the elbow grazes the surface)
  return [ex * need * v.halfW, ez * need * v.halfD + v.zOff];
}

export type V3 = [number, number, number];

/** The head (with its cap or helmet) as a sphere: radius and where its centre sits relative to the head bone (head-local axes, m). */
export interface HeadVolume {
  radius: number;
  up: number;
  fwd: number;
}

export function headVolume(morphs: Record<string, number> | undefined, helmet = true): HeadVolume {
  const m = morphs ?? {};
  const wide = m.head_wide ?? 0, narrow = m.head_narrow ?? 0;
  // skull ~0.115 m, wider / narrower morphs change it a little; a helmet adds a centimetre or two all round
  return { radius: 0.115 * (1 + 0.08 * wide - 0.05 * narrow) + (helmet ? 0.025 : 0.012), up: 0.095, fwd: 0.015 };
}

/** Metres between a point and the head sphere surface (negative: inside). */
export function headClearance(p: V3, centre: V3, v: HeadVolume): number {
  return Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) - v.radius;
}

/**
 * Clearance of the whole arm's elbow end from the head: the elbow itself and the middle of both arm segments (the hand is allowed
 * near the head: a batter's top hand may be level with his ear).
 */
export function armHeadClearance(S: V3, E: V3, H: V3, centre: V3, v: HeadVolume): number {
  const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return Math.min(headClearance(E, centre, v), headClearance(mid(S, E), centre, v), headClearance(mid(E, H), centre, v));
}


/**
 * Swivel the elbow around the shoulder→hand axis (the hand stays exactly where it is, both bone lengths are kept) to the nearest angle at
 * which `clearance(elbow)` is at least `margin`. If no angle gets there, the best one is returned. Angles are searched outward from the
 * current elbow, alternating sides, in `step` radians.
 */
export function swivelElbow(S: V3, H: V3, E: V3, clearance: (p: V3) => number, margin = 0.015, step = (7 * Math.PI) / 180): { elbow: V3; angle: number; clear: number } {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
  const sh = sub(H, S);
  const L = len(sh);
  const cur = clearance(E);
  if (L < 1e-6 || cur >= margin) return { elbow: E, angle: 0, clear: cur };
  const n: V3 = [sh[0] / L, sh[1] / L, sh[2] / L];
  const se = sub(E, S);
  const a = dot(se, n);
  const v: V3 = [se[0] - n[0] * a, se[1] - n[1] * a, se[2] - n[2] * a];
  const r = len(v);
  if (r < 1e-6) return { elbow: E, angle: 0, clear: cur };
  const u: V3 = [v[0] / r, v[1] / r, v[2] / r];
  const w = cross(n, u);
  const at = (th: number): V3 => {
    const c = Math.cos(th) * r, s = Math.sin(th) * r;
    return [S[0] + n[0] * a + u[0] * c + w[0] * s, S[1] + n[1] * a + u[1] * c + w[1] * s, S[2] + n[2] * a + u[2] * c + w[2] * s];
  };
  let best = { elbow: E, angle: 0, clear: cur };
  for (let k = 1; k * step <= Math.PI; k++) {
    for (const sgn of [1, -1]) {
      const th = sgn * k * step;
      const p = at(th);
      const c = clearance(p);
      if (c >= margin) return { elbow: p, angle: th, clear: c };
      if (c > best.clear) best = { elbow: p, angle: th, clear: c };
    }
  }
  return best;
}
