/**
 * Per-player appearance, worked out from what the sim reports (physique, appearance indices, seed): height scale, body / head morph
 * influences, skin tone, hair, facial hair and small accessories. Pure functions (no three.js) so they are unit-testable; the glTF puppet
 * applies the result to the character's morph targets, node visibility and materials. Deterministic: the same player always looks the same.
 */
export interface PhysiqueSnap {
  heightM: number;
  weightKg: number;
  build: 'lean' | 'athletic' | 'stocky' | 'heavy';
}
export interface AppearanceSnap {
  skin: number;
  hairColor: number;
  hairStyle: number;
  facialHair: number;
  seed: number;
}

/** sRGB skin tones of `players/player_manifest.json`, light to dark (the last two are extra light / medium variants). */
export const SKIN_TONES = ['#f4d2b8', '#e8bb98', '#d8a276', '#c48858', '#a96c44', '#8c5836', '#6f4229', '#573220', '#f0c8ad', '#dcaa84'];
export const HAIR_COLORS: Record<string, string> = {
  black: '#0d0c0b', dark_brown: '#241a12', brown: '#3c2a1c', chestnut: '#5a3a20', auburn: '#6a3820', blond: '#b08a48', light_blond: '#d2b070', gray: '#8a8580', white: '#d6d0c8', red: '#8a4020',
};
/** the model's nominal height (m): a player's `heightM / MODEL_HEIGHT` is his uniform scale */
export const MODEL_HEIGHT = 1.85;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const hashString = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export interface PlayerLook {
  /** uniform scale from the player's height */
  scale: number;
  /** morph target name → influence (0..1) */
  morphs: Record<string, number>;
  skin: string;
  hairColor: string;
  /** which hair node (`Gear_Hair`, `Gear_Hair_Buzz`, …) */
  hairNode: string;
  /** facial hair node or null */
  facialNode: string | null;
  jerseyNode: 'Jersey' | 'Jersey_ShortSleeve' | 'Jersey_Sleeveless';
  pantsNode: 'Pants' | 'Pants_Long';
  eyeBlack: boolean;
  wristbands: { L: boolean; R: boolean };
  armSleeves: { L: boolean; R: boolean };
  /** accessory colours (css) */
  wristbandColor: 'trim' | 'white' | 'black';
  sleeveColor: 'trim' | 'white' | 'black';
  battingGlove: string;
}

const HAIR_BY_INDEX = ['black', 'dark_brown', 'brown', 'blond', 'red', 'gray'];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * @param seedExtra extra entropy (the player id hash) for players that carry no sim seed
 */
export function computeLook(physique: PhysiqueSnap | undefined, app: AppearanceSnap | undefined, seedExtra = 0): PlayerLook {
  const seed = ((app?.seed ?? 0) ^ seedExtra) >>> 0;
  const rnd = mulberry32(seed || 1);
  const ph = physique ?? { heightM: MODEL_HEIGHT, weightKg: 88, build: 'athletic' as const };

  // ---- body -------------------------------------------------------------------------------
  const scale = clamp(ph.heightM / MODEL_HEIGHT, 0.88, 1.14);
  const bmi = ph.weightKg / (ph.heightM * ph.heightM);
  // most players are athletic-average, a good number heavier, a few lanky or truly muscular (t-0014: "everyone has the same very fit build"):
  // the sim's BMI drives the morphs, the seed adds a little definition on some of the athletic ones
  let lean = 0, stocky = 0, muscular = 0, heavy = 0;
  switch (ph.build) {
    case 'lean': lean = 0.55; break;
    case 'athletic': muscular = 0.12 + 0.3 * rnd(); break;
    case 'stocky': stocky = 0.45; break;
    case 'heavy': stocky = 0.35; heavy = 0.45; break;
  }
  if (bmi < 23.5) lean = clamp(lean + (23.5 - bmi) * 0.25, 0, 1);
  if (bmi > 25.5) stocky = clamp(stocky + (bmi - 25.5) * 0.12, 0, 1);
  if (bmi > 28) heavy = clamp(heavy + (bmi - 28) * 0.16, 0, 1);
  // conflicting body morphs cancel: keep the dominant one
  if (lean > 0 && stocky + heavy > 0) {
    if (lean >= stocky + heavy) { lean -= stocky + heavy; stocky = heavy = 0; } else { stocky = Math.max(0, stocky - lean); lean = 0; }
  }
  if (stocky + heavy > 0.5) muscular *= 0.3;
  if (heavy > 0.5) stocky = Math.min(stocky, 0.5);
  const jit = () => (rnd() - 0.5) * 0.16;
  const morphs: Record<string, number> = {
    build_lean: clamp(lean + (lean > 0 ? jit() : 0), 0, 1),
    build_stocky: clamp(stocky + (stocky > 0 ? jit() : 0), 0, 1),
    build_muscular: clamp(muscular + (muscular > 0 ? jit() : 0), 0, 1),
    build_heavy: clamp(heavy + (heavy > 0 ? jit() : 0), 0, 1),
  };
  // heavier people carry it in the face too
  const faceFat = clamp(heavy * 0.7 + stocky * 0.25, 0, 0.8);

  // ---- head (all from the seed) --------------------------------------------------------------
  const hw = rnd(), hv = rnd();
  morphs.head_narrow = hw < 0.35 ? 0.15 + hv * 0.65 : 0;
  morphs.head_wide = hw >= 0.35 && hw < 0.7 ? 0.15 + hv * 0.65 : 0;
  morphs.jaw_square = Math.pow(rnd(), 1.4) * 0.9;
  morphs.nose_large = Math.pow(rnd(), 1.6) * 0.9;
  morphs.ears_large = Math.pow(rnd(), 1.6) * 0.9;
  if (faceFat > 0.05) morphs.cheeks_full = faceFat;

  // ---- skin / hair -----------------------------------------------------------------------------
  // the sim's 0..5 (light → dark) spread over the 10 tones, the seed picks the neighbour within the band
  const sk = clamp(Math.round(app?.skin ?? 1), 0, 5);
  const bands: number[][] = [[0, 8], [1, 8, 9], [2, 9], [3, 9], [4, 5], [5, 6, 7]];
  const band = bands[sk];
  const skin = SKIN_TONES[band[Math.floor(rnd() * band.length) % band.length]];
  const hc = HAIR_BY_INDEX[clamp(Math.round(app?.hairColor ?? 1), 0, 5)];
  const hairKey = hc === 'blond' && rnd() < 0.4 ? 'light_blond' : hc === 'gray' && rnd() < 0.3 ? 'white' : hc === 'brown' && rnd() < 0.4 ? 'chestnut' : hc === 'red' && rnd() < 0.3 ? 'auburn' : hc;
  const hairColor = HAIR_COLORS[hairKey];
  const hs = clamp(Math.round(app?.hairStyle ?? 1), 0, 3);
  const hairNode = ['Gear_Hair_Buzz', 'Gear_Hair', 'Gear_Hair_Curly', 'Gear_Hair_Long'][hs];
  const ff = clamp(Math.round(app?.facialHair ?? 0), 0, 2);
  const beardPick = rnd();
  const facialNode = ff === 0 ? null : ff === 1 ? 'Gear_Beard_Stubble' : beardPick < 0.55 ? 'Gear_Beard_Full' : beardPick < 0.8 ? 'Gear_Goatee' : 'Gear_Mustache';

  // ---- clothes / accessories ------------------------------------------------------------------------
  const rj = rnd();
  const jerseyNode = rj < 0.08 ? 'Jersey_ShortSleeve' : rj < 0.11 ? 'Jersey_Sleeveless' : 'Jersey';
  const pantsNode = rnd() < 0.14 ? 'Pants_Long' : 'Pants';
  const eyeBlack = rnd() < 0.16;
  const wb = rnd(), wbSide = rnd();
  const wristbands = { L: wb < 0.22 || (wb < 0.3 && wbSide < 0.5), R: wb < 0.22 || (wb < 0.3 && wbSide >= 0.5) };
  const sl = rnd(), slSide = rnd();
  const armSleeves = { L: sl < 0.14 && slSide < 0.5, R: sl < 0.14 && slSide >= 0.5 };
  const pick3 = (r: number): 'trim' | 'white' | 'black' => (r < 0.45 ? 'trim' : r < 0.75 ? 'white' : 'black');
  const wristbandColor = pick3(rnd());
  const sleeveColor = pick3(rnd());
  const battingGlove = ['#f0efe8', '#1c1c1e', '#8c8f95', '#b8322a'][Math.floor(rnd() * 4) % 4];

  return { scale, morphs, skin, hairColor, hairNode, facialNode, jerseyNode, pantsNode, eyeBlack, wristbands, armSleeves, wristbandColor, sleeveColor, battingGlove };
}
