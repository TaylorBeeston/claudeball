/**
 * The broadcast microphone array, pure maths (unit-tested). A TV crew never mixes the cameras' audio: the A1 mixes fixed microphones
 * placed around the park (a parabolic dish behind home plate, shotguns at the bases, boundary mics on the outfield wall, mics hung
 * over the stands for the crowd, one in the dugout, a "house" pair high behind home) and the picture cuts over that fixed mix.
 *
 * Coordinates are the sim's (metres): origin at home plate, +Y up, +Z toward centre field, +X toward THIRD base (first base is at -X).
 *
 * Every park sound has a position; each mic picks it up with
 *   - distance attenuation: inverse distance with a floor (`ref`: closer than that is the same level),
 *   - propagation delay at 343 m/s (relative to the mic that hears it first, so the closest mic is in sync with the picture),
 *   - air absorption: a far tier (low-passed) beyond `FAR_M`, also used for off-axis pickup of directional mics (they colour off axis),
 *   - the polar pattern (omni, cardioid family, shotgun, parabolic, boundary) toward the mic's aim point,
 *   - a proximity effect (bass boost) for directional mics within a metre of a source.
 *
 * The stereo image is fixed and matches the main camera, the classic centre-field "pitch" shot (telephoto from behind the pitcher,
 * looking in at the plate): seen from there third base is on screen RIGHT and first base on screen LEFT. The telephoto camera looks
 * almost straight down -Z, so screen x is close to sim X: a mic's pan is its X over `PAN_WIDTH`, signed by `PAN_SIGN` (flip that one
 * constant to mirror the whole image, e.g. for a high-home main camera).
 */
import type { Vec3 } from '../types';

export const SPEED_OF_SOUND = 343;
/** +1: third base (+X) on the right, as seen from the centre-field camera; -1 mirrors the image */
export const PAN_SIGN = 1;
/** |x| in metres that pans fully to one side */
export const PAN_WIDTH = 62;
/** beyond this distance a pickup takes the mic's far (air-absorbed, darker) input */
export const FAR_M = 42;

export type Pattern = 'omni' | 'cardioid' | 'supercardioid' | 'hypercardioid' | 'shotgun' | 'parabolic' | 'boundary';
export type MicGroup = 'field' | 'crowd' | 'house';
/** how the strip is equalised (the mic's own colour) */
export type MicTone = 'parabolic' | 'shotgun' | 'boundary' | 'crowd' | 'dugout' | 'house';

export type MicId =
  | 'plate'
  | 'first'
  | 'third'
  | 'infield'
  | 'wall_lf'
  | 'wall_cf'
  | 'wall_rf'
  | 'dugout'
  | 'crowd_home'
  | 'crowd_3b'
  | 'crowd_1b'
  | 'crowd_lf'
  | 'crowd_rf'
  | 'crowd_upper'
  | 'house_l'
  | 'house_r';

export interface MicDef {
  id: MicId;
  label: string;
  pos: Vec3;
  /** the point the mic is aimed at */
  aim: Vec3;
  pattern: Pattern;
  group: MicGroup;
  tone: MicTone;
  /** the fader, dB: what the A1 sets so the mic's own subject sits at a common level */
  faderDb: number;
  /** inverse-distance floor, m */
  ref: number;
  /** send into the venue reverb (0..1): far, crowd and house mics are wetter */
  reverb: number;
  /** kept on phones (the low-power array) */
  low: boolean;
  /** pan override (-1..1); else from the position */
  pan?: number;
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** wall distance at an angle (the park's outfield: 100.6 m down the lines, 121.9 m to centre) */
export function wallDistance(x: number, z: number): number {
  const phi = Math.atan2(x, z);
  const a = Math.min(1, Math.abs(phi) / (Math.PI / 4));
  return 100.6 + (121.9 - 100.6) * (1 - a * a);
}
const wallPoint = (deg: number, r = 0, y = 1.5): Vec3 => {
  const p = (deg * Math.PI) / 180;
  const d = wallDistance(Math.sin(p), Math.cos(p)) + r;
  return v(Math.sin(p) * d, y, Math.cos(p) * d);
};

/** first base and third base (90 ft square) */
export const BASES = { first: v(-19.4, 0, 19.4), second: v(0, 0, 38.8), third: v(19.4, 0, 19.4), mound: v(0, 0.25, 18.4), plate: v(0, 0, 0) };

/**
 * The mic plot. Field mics aim at their subject; crowd mics hang over the stands and aim away from the field into the seats (they hear
 * the crowd near, and the field and the PA from behind, dark and late); the house pair sits high behind home and hears everything.
 */
export const MICS: MicDef[] = [
  { id: 'plate', label: 'Parabolic, behind home plate', pos: v(0, 1.2, -17), aim: v(0, 0.9, 0.5), pattern: 'parabolic', group: 'field', tone: 'parabolic', faderDb: 14, ref: 2, reverb: 0.05, low: true },
  { id: 'first', label: 'Shotgun, first base', pos: v(-27, 0.6, 15), aim: BASES.first, pattern: 'shotgun', group: 'field', tone: 'shotgun', faderDb: 9, ref: 2, reverb: 0.08, low: true },
  { id: 'third', label: 'Shotgun, third base', pos: v(27, 0.6, 15), aim: BASES.third, pattern: 'shotgun', group: 'field', tone: 'shotgun', faderDb: 9, ref: 2, reverb: 0.08, low: true },
  { id: 'infield', label: 'Boundary, second base / mound', pos: v(0, 0.05, 30), aim: v(0, 5, 25), pattern: 'boundary', group: 'field', tone: 'boundary', faderDb: 6, ref: 3, reverb: 0.1, low: false },
  { id: 'wall_lf', label: 'Boundary, left-field wall', pos: wallPoint(28, -0.3, 1.5), aim: v(30, 1, 60), pattern: 'boundary', group: 'field', tone: 'boundary', faderDb: 4, ref: 3, reverb: 0.2, low: false },
  { id: 'wall_cf', label: 'Boundary, centre-field wall', pos: wallPoint(0, -0.3, 1.5), aim: v(0, 1, 60), pattern: 'boundary', group: 'field', tone: 'boundary', faderDb: 4, ref: 3, reverb: 0.2, low: true },
  { id: 'wall_rf', label: 'Boundary, right-field wall', pos: wallPoint(-28, -0.3, 1.5), aim: v(-30, 1, 60), pattern: 'boundary', group: 'field', tone: 'boundary', faderDb: 4, ref: 3, reverb: 0.2, low: false },
  { id: 'dugout', label: 'Shotgun, home dugout (3B side)', pos: v(20.5, 1.6, 0.5), aim: v(18.7, 0.6, 2.5), pattern: 'shotgun', group: 'field', tone: 'dugout', faderDb: 0, ref: 1.5, reverb: 0.05, low: false },
  { id: 'crowd_home', label: 'Crowd, behind home (lower bowl)', pos: v(0, 12, -28), aim: v(0, 6, -36), pattern: 'cardioid', group: 'crowd', tone: 'crowd', faderDb: 0, ref: 6, reverb: 0.25, low: true },
  { id: 'crowd_3b', label: 'Crowd, third-base side', pos: v(40, 12, 12), aim: v(48, 6, 14), pattern: 'cardioid', group: 'crowd', tone: 'crowd', faderDb: 0, ref: 6, reverb: 0.25, low: true },
  { id: 'crowd_1b', label: 'Crowd, first-base side', pos: v(-40, 12, 12), aim: v(-48, 6, 14), pattern: 'cardioid', group: 'crowd', tone: 'crowd', faderDb: 0, ref: 6, reverb: 0.25, low: true },
  { id: 'crowd_lf', label: 'Crowd, left-field bleachers', pos: v(60, 13, 100), aim: v(68, 8, 112), pattern: 'cardioid', group: 'crowd', tone: 'crowd', faderDb: -1, ref: 6, reverb: 0.35, low: false },
  { id: 'crowd_rf', label: 'Crowd, right-field bleachers', pos: v(-60, 13, 100), aim: v(-68, 8, 112), pattern: 'cardioid', group: 'crowd', tone: 'crowd', faderDb: -1, ref: 6, reverb: 0.35, low: false },
  { id: 'crowd_upper', label: 'Crowd, upper deck', pos: v(0, 30, -40), aim: v(0, 26, -52), pattern: 'supercardioid', group: 'crowd', tone: 'crowd', faderDb: -2, ref: 8, reverb: 0.4, low: false },
  { id: 'house_l', label: 'House pair, left (1B side)', pos: v(-4, 22, -36), aim: v(-30, 0, 50), pattern: 'cardioid', group: 'house', tone: 'house', faderDb: 2, ref: 10, reverb: 0.45, low: true, pan: -0.85 * PAN_SIGN },
  { id: 'house_r', label: 'House pair, right (3B side)', pos: v(4, 22, -36), aim: v(30, 0, 50), pattern: 'cardioid', group: 'house', tone: 'house', faderDb: 2, ref: 10, reverb: 0.45, low: true, pan: 0.85 * PAN_SIGN },
];

export const micsFor = (lowPower: boolean) => (lowPower ? MICS.filter((m) => m.low) : MICS);

/** the static pan of a mic (or of any point in the park, for the TV image) */
export function panOf(p: Vec3): number {
  return Math.max(-0.95, Math.min(0.95, (PAN_SIGN * p.x) / PAN_WIDTH));
}
export const micPan = (m: MicDef) => m.pan ?? panOf(m.pos);

/** polar response at angle theta (radians off the aim axis): 0..1 (boundary: a hemisphere) */
export function polar(pattern: Pattern, cosT: number): number {
  switch (pattern) {
    case 'omni':
      return 1;
    case 'cardioid':
      return Math.max(0.03, 0.5 + 0.5 * cosT);
    case 'supercardioid':
      return Math.max(0.03, Math.abs(0.37 + 0.63 * cosT));
    case 'hypercardioid':
      return Math.max(0.03, Math.abs(0.25 + 0.75 * cosT));
    case 'shotgun':
      // a narrow front lobe (an interference tube) with a small rear lobe
      return Math.max(0.06, Math.pow(Math.max(0, 0.5 + 0.5 * cosT), 3));
    case 'parabolic':
      // a dish: very narrow at speech / crack frequencies, about +20 dB of acoustic gain on axis (in the fader), little off axis
      return Math.max(0.025, Math.pow(Math.max(0, 0.5 + 0.5 * cosT), 8));
    case 'boundary':
      // a plate on a surface: half-space omni, much less from behind the surface
      return cosT >= 0 ? 1 : Math.max(0.15, 1 + cosT * 0.85);
  }
}

export interface Pickup {
  mic: MicId;
  /** linear gain including the fader */
  gain: number;
  /** seconds after the mic that hears the source first */
  delay: number;
  /** take the far (air-absorbed / off-axis) input */
  far: boolean;
  /** dB of low-frequency boost from the proximity effect (0 when not close) */
  proximityDb: number;
  /** distance, m */
  dist: number;
}

const dbToGain = (d: number) => Math.pow(10, d / 20);

/** one mic hearing one source (delay is absolute here: distance / c) */
export function pickupOne(m: MicDef, src: Vec3): Pickup {
  const dx = src.x - m.pos.x, dy = src.y - m.pos.y, dz = src.z - m.pos.z;
  const dist = Math.max(0.05, Math.hypot(dx, dy, dz));
  const ax = m.aim.x - m.pos.x, ay = m.aim.y - m.pos.y, az = m.aim.z - m.pos.z;
  const al = Math.max(1e-6, Math.hypot(ax, ay, az));
  const cosT = (dx * ax + dy * ay + dz * az) / (dist * al);
  const pol = polar(m.pattern, cosT);
  const att = m.ref / Math.max(m.ref, dist);
  const directional = m.pattern !== 'omni' && m.pattern !== 'boundary';
  const proximityDb = directional && dist < 1 ? 6 * (1 - dist) : 0;
  return {
    mic: m.id,
    gain: att * pol * dbToGain(m.faderDb),
    delay: dist / SPEED_OF_SOUND,
    far: dist > FAR_M || (directional && cosT < 0.35),
    proximityDb,
    dist,
  };
}

/**
 * The pickups that matter for a source: every mic, the `k` strongest kept (plus any within 1 dB of the last one kept, so a mirrored
 * pair is never split; none more than `floorDb` under the strongest), delays relative to the earliest kept mic.
 */
export function pickups(src: Vec3, mics: MicDef[] = MICS, k = 3, floorDb = -30): Pickup[] {
  const all = mics.map((m) => pickupOne(m, src)).sort((a, b) => b.gain - a.gain);
  const top = all[0]?.gain ?? 0;
  let n = Math.min(k, all.length);
  // a tie at the cut (a source on the centre line between a mirrored pair) keeps both: the image must not lean to one side
  while (n < all.length && n > 0 && all[n].gain >= all[n - 1].gain * dbToGain(-1)) n++;
  const kept = all.slice(0, n).filter((p) => p.gain > 0 && p.gain >= top * dbToGain(floorDb));
  const t0 = Math.min(...kept.map((p) => p.delay));
  return kept.map((p) => ({ ...p, delay: p.delay - t0 }));
}

/** the stereo position a source ends up at in the mix: the gain-weighted pan of the mics that hear it (for tests and the debug panel) */
export function imageOf(ps: Pickup[], mics: MicDef[] = MICS): number {
  let s = 0, w = 0;
  for (const p of ps) {
    const m = mics.find((x) => x.id === p.mic);
    if (!m) continue;
    s += micPan(m) * p.gain * p.gain;
    w += p.gain * p.gain;
  }
  return w > 0 ? s / w : 0;
}

// ---- where the park's sounds come from -------------------------------------------------------------------------------------

export type ZoneId = 'backstop' | 'home_side' | 'line_3b' | 'line_1b' | 'lf_bleachers' | 'rf_bleachers' | 'upper_deck';

export interface Zone {
  id: ZoneId;
  label: string;
  /** centre of the section, and how far its seats spread (for one-shots placed at random in it) */
  pos: Vec3;
  spread: number;
  /** share of home fans (the rest root for the visitors: the visiting dugout is on the first-base side) */
  home: number;
  /** relative size (how much of the crowd's sound it makes) */
  size: number;
}

export const ZONES: Zone[] = [
  { id: 'backstop', label: 'Behind home plate', pos: v(0, 6, -30), spread: 14, home: 0.75, size: 1 },
  { id: 'home_side', label: 'Home-side infield (3B)', pos: v(34, 7, 4), spread: 12, home: 0.92, size: 1 },
  { id: 'line_3b', label: 'Third-base line', pos: v(52, 8, 42), spread: 14, home: 0.85, size: 0.9 },
  { id: 'line_1b', label: 'First-base side (visitors)', pos: v(-40, 7, 24), spread: 16, home: 0.5, size: 1 },
  { id: 'lf_bleachers', label: 'Left-field bleachers', pos: v(64, 9, 108), spread: 16, home: 0.8, size: 0.8 },
  { id: 'rf_bleachers', label: 'Right-field bleachers', pos: v(-64, 9, 108), spread: 16, home: 0.6, size: 0.8 },
  { id: 'upper_deck', label: 'Upper deck', pos: v(0, 26, -50), spread: 30, home: 0.72, size: 1.1 },
];

/** phones: four zones (behind home, third-base side, first-base side, outfield); each full zone folds into one of them */
export const LOW_ZONES: ZoneId[] = ['backstop', 'home_side', 'line_1b', 'lf_bleachers'];
export const LOW_FOLD: Record<ZoneId, ZoneId> = { backstop: 'backstop', upper_deck: 'backstop', home_side: 'home_side', line_3b: 'home_side', line_1b: 'line_1b', lf_bleachers: 'lf_bleachers', rf_bleachers: 'lf_bleachers' };

export const zone = (id: ZoneId) => ZONES.find((z) => z.id === id)!;

/** the zone a left/right position (-1..1, screen left .. right) of the crowd model points at */
export function zoneForPan(pan: number, far = false): ZoneId {
  const p = pan * PAN_SIGN; // +: third-base side
  if (far) return p > 0.1 ? 'lf_bleachers' : p < -0.1 ? 'rf_bleachers' : 'upper_deck';
  if (p > 0.55) return 'line_3b';
  if (p > 0.15) return 'home_side';
  if (p < -0.15) return 'line_1b';
  return 'backstop';
}

/** the order a wave goes round the stands (right to left on the screen and back) */
export const WAVE_ORDER: ZoneId[] = ['line_1b', 'backstop', 'home_side', 'line_3b', 'lf_bleachers', 'rf_bleachers'];

/** PA loudspeaker clusters: where the PA voice, the organ and the park music come out (electronic delay, s, and level) */
export interface Speaker {
  id: string;
  pos: Vec3;
  /** the delay line in the PA processor (delay towers are aligned to the main cluster for the seats they cover) */
  delay: number;
  gain: number;
}

export const SPEAKERS: Speaker[] = [
  { id: 'main', pos: v(62, 14, 92), delay: 0, gain: 1 }, // the main cluster on the scoreboard, left-centre
  { id: 'home', pos: v(0, 17, -36), delay: 0.012, gain: 0.8 }, // under the upper-deck facade behind home
  { id: 'line_3b', pos: v(42, 15, 14), delay: 0.034, gain: 0.55 }, // distributed fills under the roof
  { id: 'line_1b', pos: v(-42, 15, 14), delay: 0.041, gain: 0.55 },
];

/** where a source sits for a few fixed things */
export const PLACES = {
  umpire: v(0, 1.7, -1.6),
  dugoutHome: v(18.7, 0.8, 2.5),
  dugoutAway: v(-18.7, 0.8, 2.5),
};
