/**
 * The promo's shots: real moments from real simulated games (found by `promo:scout`, `tempo=standard`), each a camera path (keys with
 * easing, subjects the camera follows, lens, focus, slow-motion ramp) or a stretch of the game's own broadcast (director cameras, HUD).
 * Times are sim seconds of that seed's game; `anchor` is the moment itself (contact, catch, call), which sim-keyed cameras and ramps count from.
 * Coordinates: metres, home plate at the origin, +Z toward centre field, +X toward third base (a right-handed batter stands at +X).
 */
import type { PromoShot } from './capture';
import type { CamKey, V3 } from '../../src/promo/cameraPath';

const director = (replays = true, broll = false) => ({ mode: 'director' as const, replays, broll });
const path = (keys: CamKey[], keysIn: 'out' | 'sim' = 'out') => ({ mode: 'path' as const, keys, keysIn });
const at = (s: string, off: V3 = [0, 0, 0], lag = 0) => ({ at: s, off, lag });

// ---- the games -------------------------------------------------------------------------------------------------------------
/** seed 162: tied 7-7 in the bottom of the 9th, Zach Fisher's walk-off: 111 mph, 37 deg, 393 ft, 15 m over the wall (contact 5752.462) */
const WALKOFF = { seed: 162, contact: 5752.462, windup: 5750.925, release: 5752.083, homeRun: 5758.292 };
/** seed 40: Evan Sanders, bottom of the 1st, 123.8 mph off the bat, 392 ft into the upper deck (contact 619.796) */
const BOMB = { seed: 40, contact: 619.796, release: 619.383, homeRun: 624.45 };
/** seed 28: a 100.6 mph four-seamer, strike three swinging, bottom of the 9th (release 4476.887, in the mitt 4477.300) */
const HEAT = { seed: 28, release: 4476.887, catch: 4477.3, windup: 4475.717 };
/** seed 35: the right fielder climbs the wall and takes a home run away (leap 228.404, catch 228.554) */
const ROB = { seed: 35, contact: 222.733, leap: 228.404, catch: 228.554, fielder: 'BUF-home-b8' };
/** seed 197: single to right, the right fielder throws the batter out at first by 0.02 s (catch at first 4861.683) */
const BANG = { seed: 197, contact: 4857.654, out: 4861.683 };

export const SHOTS: PromoShot[] = [
  // ---- cold open (night) ------------------------------------------------------------------------------------------------------
  {
    id: 'open-aerial', note: 'night aerial, slow orbit over the park', seed: WALKOFF.seed, tod: 'night', start: 5738, anchor: 5738, dur: 5.5,
    camera: path([
      { t: 0, pos: { orbit: [0, 0, 55], r: 150, h: 92, deg: 215 }, look: [0, 4, 48], fov: 42, ease: 'linear' },
      { t: 5.5, pos: { orbit: [0, 0, 55], r: 136, h: 74, deg: 175 }, look: [0, 4, 48], fov: 40 },
    ]),
  },
  {
    id: 'open-crane', note: 'crane down behind the plate to the pitcher set under the lights', seed: WALKOFF.seed, tod: 'night', start: 5749.2, anchor: WALKOFF.windup, dur: 4,
    camera: path([
      { t: 0, pos: [5, 15, -26], look: [0, 3, 20], fov: 34, aperture: 0 },
      { t: 4, pos: [3.4, 1.7, -7.8], look: [0, 1.5, 18.4], fov: 22, aperture: 0.35, focus: at('pitcher', [0, 1.6, 0]) },
    ]),
  },
  {
    id: 'open-face', note: 'the walk-off hitter in the box, telephoto, rack focus', seed: WALKOFF.seed, tod: 'night', start: 5747.5, anchor: WALKOFF.windup, dur: 3,
    camera: path([
      { t: 0, pos: { at: 'face:batter', off: [0.5, 0.05, 2.6], local: true, lag: 0.3 }, look: at('face:batter', [0, 0, 0], 0.2), fov: 15, aperture: 1.1 },
      { t: 3, pos: { at: 'face:batter', off: [0.35, 0.03, 2.2], local: true, lag: 0.3 }, look: at('face:batter', [0, 0, 0], 0.2), fov: 14, aperture: 1.1 },
    ]),
  },
  // ---- build: what's real -------------------------------------------------------------------------------------------------------
  {
    id: 'pitch-flight', note: 'a 100.6 mph four-seamer tracked from the first-base side in slow motion', seed: HEAT.seed, tod: 'day', start: HEAT.release - 0.3, anchor: HEAT.release, dur: 3.2, simDt: 1 / 240,
    ramp: [{ sim: -0.3, speed: 1 }, { sim: -0.05, speed: 0.22 }, { sim: 0.5, speed: 0.22 }, { sim: 0.7, speed: 1 }],
    camera: path([
      { t: -0.3, pos: at('ball', [-3.2, 0.1, 0.4], 0.04), look: at('ball', [0, 0, -0.7], 0.02), fov: 32, aperture: 0.6, focus: at('ball') },
      { t: 0.5, pos: at('ball', [-2.8, 0.15, 0.2], 0.04), look: at('ball', [0, 0, -0.5], 0.02), fov: 30, aperture: 0.6, focus: at('ball') },
    ], 'sim'),
  },
  {
    id: 'pitch-mitt', note: 'long lens on the mitt from in front: strike three arrives', seed: HEAT.seed, tod: 'day', start: HEAT.catch - 0.35, anchor: HEAT.catch, dur: 2.2, simDt: 1 / 240,
    ramp: [{ sim: -0.35, speed: 0.6 }, { sim: -0.12, speed: 0.12 }, { sim: 0.15, speed: 0.12 }, { sim: 0.3, speed: 0.5 }],
    camera: path([
      { t: -0.35, pos: [-1.3, 0.85, 9], look: [0.12, 0.68, -0.8], fov: 6.5, aperture: 0.9 },
      { t: 0.3, pos: [-1.3, 0.85, 8.6], look: [0.12, 0.68, -0.8], fov: 6, aperture: 0.9 },
    ], 'sim'),
  },
  { id: 'strikeout-hud', note: 'the broadcast: pitch cam, tracker, strike three', seed: HEAT.seed, tod: 'day', start: HEAT.windup - 0.6, anchor: HEAT.catch, dur: 4.5, hud: true, camera: director(false) },
  {
    id: 'contact-bomb', note: 'ultra slow motion: bat meets ball, 123.8 mph off the bat', seed: BOMB.seed, tod: 'day', start: BOMB.contact - 0.6, anchor: BOMB.contact, dur: 4.5, simDt: 1 / 240,
    ramp: [{ sim: -0.6, speed: 1 }, { sim: -0.16, speed: 0.06 }, { sim: 0.06, speed: 0.06 }, { sim: 0.35, speed: 0.8 }],
    camera: path([
      { t: -0.6, pos: [1.5, 0.8, 1.9], look: [-0.1, 0.74, 0.95], fov: 19, aperture: 0.8 },
      { t: 0.4, pos: [1.25, 0.78, 1.6], look: [-0.1, 0.72, 0.95], fov: 16, aperture: 0.8 },
    ], 'sim'),
  },
  {
    id: 'bomb-flight', note: 'the bomb climbing into the upper deck', seed: BOMB.seed, tod: 'day', start: BOMB.contact + 0.05, anchor: BOMB.contact, dur: 3.5,
    camera: path([
      { t: 0, pos: [-1.5, 2.2, -9], look: at('ball', [0, 0, 0], 0.12), fov: 32, aperture: 0 },
      { t: 3.5, pos: [-1.0, 2.6, -8], look: at('ball', [0, 0, 0], 0.12), fov: 20, aperture: 0 },
    ]),
  },
  {
    id: 'robbed', note: 'the right fielder climbs the wall and robs a home run', seed: ROB.seed, tod: 'day', start: ROB.leap - 2.4, anchor: ROB.leap, dur: 4.6,
    ramp: [{ sim: -2.4, speed: 1 }, { sim: -0.5, speed: 1 }, { sim: -0.25, speed: 0.3 }, { sim: 0.35, speed: 0.3 }, { sim: 0.7, speed: 1 }],
    camera: path([
      { t: -2.4, pos: [-6, 1.7, 100], look: at(`id:${ROB.fielder}`, [0, 1.2, 0], 0.15), fov: 15, aperture: 0.5, focus: at(`id:${ROB.fielder}`, [0, 1.5, 0], 0.15) },
      { t: 0.8, pos: [-7.5, 1.6, 106], look: at(`id:${ROB.fielder}`, [0, 2.0, 0], 0.15), fov: 12, aperture: 0.5, focus: at(`id:${ROB.fielder}`, [0, 2.0, 0], 0.15) },
    ], 'sim'),
  },
  { id: 'bang-first', note: 'bang-bang at first: the broadcast, the call, the CLOSE PLAY slow-motion replay', seed: BANG.seed, tod: 'dusk', start: BANG.contact - 1.4, anchor: BANG.out, dur: 22, hud: true, camera: director(true) },
  // ---- drop: the montage ----------------------------------------------------------------------------------------------------------
  { id: 'bomb-broadcast', note: 'the home-run sequence as the broadcast plays it (wall, crowd, trot, plate, replay) + fireworks', seed: BOMB.seed, tod: 'dusk', start: BOMB.release - 1.6, anchor: BOMB.homeRun, dur: 40, hud: true, camera: director(true) },
  {
    id: 'triple-play', note: 'a 5-4-3 triple play: behind the plate, following the ball round the horn', seed: 23, tod: 'dusk', start: 440.0, anchor: 441.4, dur: 4.6,
    camera: path([
      { t: 0, pos: [0, 8.5, -21], look: at('ball', [0, 0, 0], 0.3), fov: 30, aperture: 0 },
      { t: 4.6, pos: [0, 8, -19], look: at('ball', [0, 0, 0], 0.3), fov: 30, aperture: 0 },
    ]),
  },
  { id: 'steal-third', note: 'stolen base: slide into third', seed: 4, tod: 'day', start: 491.5, anchor: 493.95, dur: 4, camera: path([{ t: 0, pos: [27, 0.9, 27], look: [17, 0.6, 18], fov: 34, aperture: 0.5 }, { t: 4, pos: [26, 0.8, 25.5], look: [19.4, 0.5, 19.4], fov: 26, aperture: 0.5 }]) },
  { id: 'double-play', note: 'the pivot at second', seed: 4, tod: 'day', start: 1762.4, anchor: 1763.67, dur: 3.4, camera: path([{ t: 0, pos: [-9, 1.3, 47], look: [0, 0.9, 38.8], fov: 17, aperture: 0.5 }, { t: 3.4, pos: [-8.5, 1.2, 46], look: [-3, 0.9, 36], fov: 22, aperture: 0.5 }]) },
  { id: 'pickoff', note: 'pickoff at night, the broadcast', seed: 157, tod: 'night', start: 3055.5, anchor: 3062.1, dur: 12, hud: true, camera: director(true) },
  { id: 'inside-park', note: 'inside-the-park home run: the broadcast', seed: 48, tod: 'day', start: 2444.5, anchor: 2460.97, dur: 22, hud: true, camera: director(true) },
  { id: 'face-card', note: 'B-roll face close-up with the name card (20-80 ratings)', seed: ROB.seed, tod: 'day', start: 215.2, anchor: 216, dur: 4, hud: true, camera: director(false, true) },
  // ---- runs on a phone: the same game in a phone-portrait viewport (touch, the mobile HUD layout) ----------------------------------
  { id: 'phone-portrait', note: 'the broadcast on a phone: portrait viewport, mobile HUD', seed: WALKOFF.seed, tod: 'night', start: WALKOFF.windup - 1.5, anchor: WALKOFF.contact, dur: 8, hud: true, viewport: { w: 412, h: 892, dpr: 2.625 }, touch: true, audio: false, camera: director(false) },
  // ---- climax: the walk-off (night) ------------------------------------------------------------------------------------------
  {
    id: 'wo-pitcher', note: 'the 3-1 pitch: over the pitcher from centre field', seed: WALKOFF.seed, tod: 'night', start: WALKOFF.windup + 0.2, anchor: WALKOFF.release, dur: 2.2,
    camera: path([{ t: 0, pos: [-1.2, 3.2, 48], look: [0, 1.2, 0], fov: 9, aperture: 0.25, focus: at('pitcher', [0, 1.5, 0]) }, { t: 2.2, pos: [-1.2, 3.1, 47], look: [0, 1.2, 0], fov: 8.5, aperture: 0.25, focus: [0, 1.2, 0] }]),
  },
  {
    id: 'wo-contact', note: 'walk-off contact, ultra slow motion', seed: WALKOFF.seed, tod: 'night', start: WALKOFF.contact - 0.45, anchor: WALKOFF.contact, dur: 4.2, simDt: 1 / 240,
    ramp: [{ sim: -0.45, speed: 1 }, { sim: -0.14, speed: 0.06 }, { sim: 0.07, speed: 0.06 }, { sim: 0.4, speed: 0.9 }],
    camera: path([
      { t: -0.45, pos: [-1.9, 1.0, 1.7], look: [0.4, 0.95, 0.6], fov: 30, aperture: 0.7 },
      { t: 0.45, pos: [-1.4, 0.95, 1.3], look: [0.3, 1.0, 0.7], fov: 27, aperture: 0.7 },
    ], 'sim'),
  },
  {
    id: 'wo-flight', note: 'the ball over the wall in left-centre, high behind the plate (its booth track runs under the whole climax)', seed: WALKOFF.seed, tod: 'night', start: WALKOFF.contact + 0.1, anchor: WALKOFF.homeRun, dur: 10,
    camera: path([
      { t: 0, pos: [-3, 9, -24], look: at('ball', [0, 0, 0], 0.25), fov: 40, aperture: 0 },
      { t: 6.2, pos: [-2, 8, -21], look: at('ball', [0, 0, 0], 0.25), fov: 30, aperture: 0 },
    ]),
  },
  {
    id: 'wo-fireworks', note: 'fireworks over centre field, the crowd up', seed: WALKOFF.seed, tod: 'night', start: WALKOFF.homeRun + 0.6, anchor: WALKOFF.homeRun, dur: 5,
    camera: path([{ t: 0, pos: [-6, 3.5, -16], look: [2, 28, 110], fov: 50 }, { t: 5, pos: [-4, 3.0, -13], look: [2, 34, 110], fov: 46 }]),
  },
  { id: 'wo-broadcast', note: 'the walk-off as the broadcast plays it: trot, the plate, the celebration', seed: WALKOFF.seed, tod: 'night', start: WALKOFF.homeRun - 0.5, anchor: WALKOFF.homeRun, dur: 34, hud: true, camera: director(true) },
];

/**
 * The vertical cut's shots: the same moments re-shot in a portrait viewport (its own camera work: the lens opened up for the tall
 * frame, which shows less across), plus per-shot changes where the framing needs them.
 */
const VFOV: Record<string, number> = { 'open-face': 1.0, 'pitch-mitt': 1.1, 'wo-pitcher': 1.2, 'contact-bomb': 1.25, 'wo-contact': 1.25 };
export const VSHOTS: PromoShot[] = SHOTS.filter((s) => s.id !== 'phone-portrait').map((s) => {
  const k = VFOV[s.id] ?? 1.4;
  const camera = s.camera.mode === 'path' ? { ...s.camera, keys: s.camera.keys.map((key) => ({ ...key, fov: Math.min(80, (key.fov ?? 40) * k) })) } : s.camera;
  return { ...s, id: `v-${s.id}`, portrait: true, camera };
});
