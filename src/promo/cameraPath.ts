/**
 * The promo's declarative camera paths (pure maths, no three.js): keyframes with easing for position, look-at, lens, roll, focus and
 * aperture, where a point is either fixed or follows a subject of the game (the ball, a player by role or id, his face, the bat) with an
 * offset, optionally smoothed; an orbit around a point is a key too. Plus a speed ramp for slow motion keyed by sim time.
 *
 *   { t: 0, pos: [0, 1.2, -6], look: { at: 'batter', off: [0, 1.3, 0] }, fov: 24, focus: 'look', aperture: 0.8, ease: 'inOut' }
 *   { t: 2, pos: { orbit: { at: 'batter' }, r: 4, h: 1.4, deg: 120 }, look: { at: 'face:batter' }, fov: 18 }
 *
 * Subjects: `ball`, `bat` (the knob end), a role (`batter`, `pitcher`, `catcher`, `first` … `right`, `runner`, `umpire`), `id:<player id>`,
 * `face:<role|id>` (the centre of his face), `glove:<role|id>` (where the ball will meet his glove while a catch is coming, else his chest),
 * `fielder` (the fielder nearest the ball). The resolver is supplied by the runtime.
 */
export type V3 = [number, number, number];
export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'hold' | 'smooth';

export interface Follow {
  at: string;
  /** offset added to the subject (world axes, or the subject's facing frame with `local`: x = his left, z = ahead) */
  off?: V3;
  local?: boolean;
  /** critically damped smoothing time, seconds (0 = locked on) */
  lag?: number;
}
export interface Orbit {
  orbit: V3 | Follow;
  /** horizontal radius, height above the centre and azimuth (deg, 0 = from +Z toward the centre, i.e. standing in centre field) */
  r: number;
  h: number;
  deg: number;
}
export type PointSpec = V3 | Follow | Orbit;

export interface CamKey {
  /** seconds from the start of the shot (output time, or sim time with `keys: 'sim'`) */
  t: number;
  pos: PointSpec;
  look: PointSpec;
  /** vertical field of view, degrees */
  fov?: number;
  roll?: number;
  /** the focus distance: 'look' (default) = the look-at point, a subject point, or metres */
  focus?: 'look' | PointSpec | number;
  /** depth-of-field strength in the engine's units (0 = everything sharp, ~0.5 a normal shallow look, 1.2 a long-lens portrait) */
  aperture?: number;
  /** easing of the move FROM this key to the next */
  ease?: Ease;
}

export interface CamSample {
  pos: V3;
  look: V3;
  fov: number;
  roll: number;
  focus: number;
  aperture: number;
}

export type Resolve = (subject: string) => { p: V3; facing?: number } | null;

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerp3 = (a: V3, b: V3, u: number): V3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];

export function ease(e: Ease | undefined, u: number): number {
  u = Math.min(1, Math.max(0, u));
  switch (e ?? 'inOut') {
    case 'linear':
      return u;
    case 'in':
      return u * u * u;
    case 'out':
      return 1 - (1 - u) ** 3;
    case 'hold':
      return 0;
    case 'smooth':
      return u * u * (3 - 2 * u);
    default:
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
  }
}

const isV3 = (p: unknown): p is V3 => Array.isArray(p) && p.length === 3;
const isOrbit = (p: PointSpec): p is Orbit => !isV3(p) && 'orbit' in p;

/** keeps the smoothing state of followed subjects between frames (one per path) */
export class PathState {
  private sm = new Map<string, { p: V3; v: V3 }>();
  /** critically damped spring toward `target` over `lag` seconds */
  smooth(key: string, target: V3, lag: number, dt: number): V3 {
    if (!lag || lag <= 0) return target;
    let s = this.sm.get(key);
    if (!s) {
      s = { p: [...target] as V3, v: [0, 0, 0] };
      this.sm.set(key, s);
      return s.p;
    }
    const w = 2 / lag;
    const x = w * dt;
    const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    for (let i = 0; i < 3; i++) {
      const c = s.p[i] - target[i];
      const tmp = (s.v[i] + w * c) * dt;
      s.v[i] = (s.v[i] - w * tmp) * k;
      s.p[i] = target[i] + (c + tmp) * k;
    }
    return [...s.p] as V3;
  }
}

export function point(spec: PointSpec, resolve: Resolve, state: PathState, key: string, dt: number): V3 | null {
  if (isV3(spec)) return spec;
  if (isOrbit(spec)) {
    const c = point(spec.orbit, resolve, state, key + '/c', dt);
    if (!c) return null;
    const a = (spec.deg * Math.PI) / 180;
    return [c[0] + Math.sin(a) * spec.r, c[1] + spec.h, c[2] + Math.cos(a) * spec.r];
  }
  const s = resolve(spec.at);
  if (!s) return null;
  const o = spec.off ?? [0, 0, 0];
  let p: V3;
  if (spec.local && s.facing !== undefined) {
    // his facing frame: z ahead (sin f, cos f), x to his left (cos f, -sin f) ... in this right-handed frame +X is toward third
    const f = s.facing;
    const fx = Math.sin(f), fz = Math.cos(f);
    const lx = fz, lz = -fx;
    p = [s.p[0] + lx * o[0] + fx * o[2], s.p[1] + o[1], s.p[2] + lz * o[0] + fz * o[2]];
  } else p = [s.p[0] + o[0], s.p[1] + o[1], s.p[2] + o[2]];
  return state.smooth(key, p, spec.lag ?? 0, dt);
}

/** an orbit between two orbit keys around the same centre interpolates the angle (and radius / height), not the chord */
function orbitBlend(a: Orbit, b: Orbit, u: number): Orbit {
  return { orbit: a.orbit, r: lerp(a.r, b.r, u), h: lerp(a.h, b.h, u), deg: lerp(a.deg, b.deg, u) };
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The camera at time `t` along `keys` (sorted by t). Points that cannot be resolved this frame (a hidden ball) hold their last value. */
export class CameraPath {
  private state = new PathState();
  private last: CamSample | null = null;
  private lastPts = new Map<string, V3>();
  constructor(readonly keys: CamKey[]) {
    if (!keys.length) throw new Error('camera path without keys');
    this.keys = [...keys].sort((a, b) => a.t - b.t);
  }

  private pt(spec: PointSpec, key: string, dt: number, resolve: Resolve): V3 {
    const p = point(spec, resolve, this.state, key, dt);
    if (p) {
      this.lastPts.set(key, p);
      return p;
    }
    return this.lastPts.get(key) ?? [0, 2, 0];
  }

  sample(t: number, dt: number, resolve: Resolve): CamSample {
    const k = this.keys;
    let i = 0;
    while (i < k.length - 1 && k[i + 1].t <= t) i++;
    const a = k[i];
    const b = k[Math.min(i + 1, k.length - 1)];
    const u = b === a ? 0 : ease(a.ease, (t - a.t) / (b.t - a.t));
    let pos: V3;
    if (isOrbit(a.pos) && isOrbit(b.pos) && JSON.stringify(a.pos.orbit) === JSON.stringify(b.pos.orbit)) pos = this.pt(orbitBlend(a.pos, b.pos, u), 'pos', dt, resolve);
    else pos = lerp3(this.pt(a.pos, `pos${i}`, dt, resolve), this.pt(b.pos, `pos${i + 1}`, dt, resolve), u);
    const look = lerp3(this.pt(a.look, `look${i}`, dt, resolve), this.pt(b.look, `look${i + 1}`, dt, resolve), u);
    const fov = lerp(a.fov ?? 40, b.fov ?? a.fov ?? 40, u);
    const roll = lerp(a.roll ?? 0, b.roll ?? a.roll ?? 0, u);
    const aperture = lerp(a.aperture ?? 0, b.aperture ?? a.aperture ?? 0, u);
    const fd = (f: CamKey['focus'], j: number) => (f === undefined || f === 'look' ? dist(pos, look) : typeof f === 'number' ? f : dist(pos, this.pt(f, `focus${j}`, dt, resolve)));
    const focus = lerp(fd(a.focus, i), fd(b.focus, i + 1), u);
    this.last = { pos, look, fov, roll, focus, aperture };
    return this.last;
  }
}

/** slow motion: the sim speed at a sim time (relative to the shot's anchor), linear between points, constant outside */
export interface RampPoint {
  sim: number;
  speed: number;
}
export function rampAt(ramp: RampPoint[] | undefined, simRel: number): number {
  if (!ramp?.length) return 1;
  if (simRel <= ramp[0].sim) return ramp[0].speed;
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i], b = ramp[i + 1];
    if (simRel <= b.sim) return lerp(a.speed, b.speed, (simRel - a.sim) / Math.max(1e-6, b.sim - a.sim));
  }
  return ramp[ramp.length - 1].speed;
}
