/**
 * Line of sight for the broadcast cameras (pure maths, no three.js): the park's solid blocks (the batter's eye, the dugouts and
 * their roofs) as boxes, a segment test against them, and the rigs that must not film them from behind: the low camera at a base
 * and the home-run camera at the wall. Each rig tries its preferred placement first and moves (other side, higher, further) until
 * it sees its subject.
 */
export interface P3 {
  x: number;
  y: number;
  z: number;
}
export interface Box {
  name?: string;
  min: P3;
  max: P3;
}

const inBox = (p: P3, b: Box, pad = 0) => p.x >= b.min.x - pad && p.x <= b.max.x + pad && p.y >= b.min.y - pad && p.y <= b.max.y + pad && p.z >= b.min.z - pad && p.z <= b.max.z + pad;

/** does the segment a -> a + frac (b - a) pass through the box? (slab method) */
export function segmentHitsBox(a: P3, b: P3, box: Box, frac = 0.92): boolean {
  let t0 = 0, t1 = frac;
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < box.min[k] || a[k] > box.max[k]) return false;
      continue;
    }
    let ta = (box.min[k] - a[k]) / d, tb = (box.max[k] - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** the first box between the camera and its subject (null = a clear view); a camera inside a box is blocked by it */
export function blocker(cam: P3, subject: P3, boxes: readonly Box[]): Box | null {
  for (const b of boxes) if (inBox(cam, b, 0.3) || segmentHitsBox(cam, subject, b)) return b;
  return null;
}

/** the first candidate that sees every subject, else the first candidate */
export function firstClear(candidates: P3[], subjects: P3[], boxes: readonly Box[]): P3 {
  for (const c of candidates) if (subjects.every((s) => !blocker(c, s, boxes))) return c;
  return candidates[0];
}

/**
 * The low camera at a base: out from the infield's centre past the bag, and to the side toward the outfield (for first AND third base;
 * it used to swing toward home on the third-base side, into the dugout), at 2.4 m.
 */
export function baseCamera(base: P3, boxes: readonly Box[]): P3 {
  const cx = 0, cz = 19.4;
  let ox = base.x - cx, oz = base.z - cz;
  const l = Math.hypot(ox, oz);
  if (l < 1) (ox = 0), (oz = 1);
  else (ox /= l), (oz /= l);
  // perpendicular, turned toward the outfield (+Z); for second base / home either side is fine
  let px = oz, pz = -ox;
  if (pz < 0 || (Math.abs(pz) < 1e-6 && px < 0)) (px = -px), (pz = -pz);
  const cands: P3[] = [];
  for (const [out, side] of [[11, 6], [9, 7], [13, 9], [7, 4], [11, -6]] as const) cands.push({ x: base.x + ox * out + px * side, y: 2.4, z: base.z + oz * out + pz * side });
  return firstClear(cands, [{ x: base.x, y: 1.0, z: base.z }], boxes);
}

/**
 * The home-run camera: the ball leaving the park in profile, from inside the fence, 26 m to the side of where it crossed and 12 m
 * back toward the plate. `side` = the preferred side (+1 / -1 along the perpendicular). It has to see the fence point and the seats
 * beyond it, so a ball over the batter's eye is filmed from the side the block does not hide, or from higher up.
 */
export function hrWallCamera(fence: P3, dir: { x: number; z: number }, side: number, boxes: readonly Box[]): P3 {
  const px = dir.z, pz = -dir.x;
  const cands: P3[] = [];
  for (const h of [5.5, 9, 14, 20, 27])
    for (const s of [side, -side])
      for (const back of [12, 20]) cands.push({ x: fence.x + px * 26 * s - dir.x * back, y: h, z: fence.z + pz * 26 * s - dir.z * back });
  return firstClear(cands, [{ x: fence.x, y: Math.max(fence.y, 3), z: fence.z }, hrBeyond(fence, dir, boxes)], boxes);
}

/** where the ball is a moment after clearing the fence: 12 m on and 4 m up, or just over a block it is flying over (the batter's eye) */
export function hrBeyond(fence: P3, dir: { x: number; z: number }, boxes: readonly Box[]): P3 {
  const p = { x: fence.x + dir.x * 12, y: Math.max(fence.y, 4) + 4, z: fence.z + dir.z * 12 };
  for (const b of boxes) if (p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z && p.y <= b.max.y) p.y = b.max.y + 2;
  return p;
}

/** horizontal distance from point p to the segment a-b (the part of it from `from` to `to` of its length) */
function distToSegmentXZ(p: { x: number; z: number }, a: P3, b: P3, from = 0, to = 1): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const u = Math.min(to, Math.max(from, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(a.x + dx * u - p.x, a.z + dz * u - p.z);
}

/**
 * Of the candidate cameras, the one whose view of `focus` stays clearest of the people who are not the subject (the base umpire,
 * the base coach) over a whole replay: `blockers[f]` are their positions in frame f. The first candidate wins when it keeps them
 * `enough` metres off the sight line (the near 15 % and the last 1.5 m before the subject do not count: someone right at the bag
 * is part of the play, someone beside the lens is out of frame).
 */
export function clearestCamera(candidates: P3[], focus: P3, blockers: { x: number; z: number }[][], enough = 0.9): { cam: P3; clearance: number; index: number } {
  let best = { cam: candidates[0], clearance: -1, index: 0 };
  candidates.forEach((cam, index) => {
    const len = Math.hypot(focus.x - cam.x, focus.z - cam.z) || 1;
    const to = Math.max(0.15, 1 - 1.5 / len);
    let worst = Infinity;
    for (const fr of blockers) for (const p of fr) worst = Math.min(worst, distToSegmentXZ(p, cam, focus, 0.15, to));
    if (index === 0 && worst >= enough) best = { cam, clearance: worst, index };
    else if (best.clearance < enough && worst > best.clearance) best = { cam, clearance: worst, index };
  });
  return best;
}
