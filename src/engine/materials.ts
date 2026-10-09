/**
 * The materials policy: one physically plausible set of values per named material in the GLBs (players, field, stadium, bat, ball), applied once to
 * every material at load. The textures themselves were measured and are fine (`docs/materials-audit.md`: the ORM maps' roughness / metalness
 * channels are clean and keep their means down the mip chain); what was wrong were the factors and the engine's shading extras:
 *  - every uniform fabric had a white `sheen` of 0.7: a milky white haze over saturated cloth, strongest from afar where the knit normal detail has
 *    mipped away (the user: "up close it looked really good, from afar the reflections look weird / off");
 *  - plastic / vinyl / concrete / clay / painted steel with glossy texture roughness (0.25-0.55) and a clear coat on every piece of leather.
 * Roughness: with a roughness map the shader uses `roughness x map.g`, so the factor is `target / measured map mean` (TEX_ROUGH); without a map the
 * target is the value. Normal strength is absolute (the GLB's normalScale is replaced).
 */
import { Color, type Material, type MeshPhysicalMaterial, type MeshStandardMaterial } from 'three';

export type MaterialKind = 'fabric' | 'leather' | 'rubber' | 'skin' | 'plastic' | 'metal' | 'painted' | 'wood' | 'concrete' | 'grass' | 'clay' | 'paint' | 'vinyl' | 'glass' | 'emissive' | 'hair' | 'eye' | 'net';

export interface MaterialPolicy {
  kind: MaterialKind;
  /** mean roughness the surface should have (the map keeps its relative variation) */
  rough?: number;
  metal?: number;
  normal?: number;
  /** fabric fuzz: intensity, roughness; the sheen colour is the fabric's own (set with the team colour) */
  sheen?: [number, number];
  clearcoat?: [number, number];
  env?: number;
  /** multiply the albedo (a light texture painted dark) */
  colorScale?: number;
}

/** measured mean of the roughness map's G channel per material (mip 0; the 16x16 mip agrees within 0.01): see docs/materials-audit.md */
export const TEX_ROUGH: Record<string, number> = {
  concrete: 0.52, steel: 0.41, Seats_T1_mat: 0.36, Seats_T2_mat: 0.36, Seats_T3_mat: 0.36, wall_padding: 0.37, skin: 0.56, cleats: 0.37, arm_sleeve: 0.83,
  batting_glove: 0.37, belt: 0.4, cap: 0.83, catcher_gear: 0.25, uniform_undershirt: 0.92, glove: 0.47, glove_laces: 0.4, piping: 0.92, sole: 0.59,
  wristband: 0.92, uniform_jersey: 0.92, uniform_pants: 0.83, uniform_socks: 0.83, base_white: 0.83, dirt: 0.66, plate_white: 0.59, dugout_concrete: 0.52,
  dugout_wood: 0.33, dugout_padding: 0.37, dugout_steel: 0.41, grass: 0.71, track: 0.54, bat_wood: 0.5,
};

export const POLICY: Record<string, MaterialPolicy> = {
  // ---- players: cloth is diffuse; a faint sheen in the cloth's own colour (no white haze), knit normals moderate so far players do not shimmer
  uniform_jersey: { kind: 'fabric', rough: 0.9, metal: 0, normal: 1.2, sheen: [0.12, 0.9] },
  uniform_undershirt: { kind: 'fabric', rough: 0.85, metal: 0, normal: 1.0, sheen: [0.15, 0.85] },
  uniform_pants: { kind: 'fabric', rough: 0.88, metal: 0, normal: 1.2, sheen: [0.12, 0.9] },
  uniform_socks: { kind: 'fabric', rough: 0.9, metal: 0, normal: 1.2, sheen: [0.12, 0.9] },
  cap: { kind: 'fabric', rough: 0.88, metal: 0, normal: 1.2 },
  arm_sleeve: { kind: 'fabric', rough: 0.72, metal: 0, normal: 0.6 },
  piping: { kind: 'fabric', rough: 0.88, metal: 0 },
  wristband: { kind: 'fabric', rough: 0.95, metal: 0 },
  jersey_decal: { kind: 'fabric', rough: 0.8, metal: 0 },
  jersey_decal_name: { kind: 'fabric', rough: 0.8, metal: 0 },
  jersey_decal_backnum: { kind: 'fabric', rough: 0.8, metal: 0 },
  jersey_decal_frontnum: { kind: 'fabric', rough: 0.8, metal: 0 },
  jersey_decal_sleevenum: { kind: 'fabric', rough: 0.8, metal: 0 },
  jersey_number: { kind: 'fabric', rough: 0.8, metal: 0 },
  cap_logo: { kind: 'fabric', rough: 0.8, metal: 0 },
  // leather: semi-matte with grain; polished cleats and the belt keep a faint coat
  glove: { kind: 'leather', rough: 0.58, metal: 0, clearcoat: [0.08, 0.5] },
  glove_laces: { kind: 'leather', rough: 0.6, metal: 0 },
  batting_glove: { kind: 'leather', rough: 0.62, metal: 0, clearcoat: [0, 0.5] },
  cleats: { kind: 'leather', rough: 0.45, metal: 0, clearcoat: [0.15, 0.4] },
  belt: { kind: 'leather', rough: 0.5, metal: 0, clearcoat: [0.1, 0.45] },
  catcher_gear: { kind: 'plastic', rough: 0.48, metal: 0, clearcoat: [0, 0.5] },
  sole: { kind: 'rubber', rough: 0.82, metal: 0 },
  spikes: { kind: 'metal', rough: 0.35, metal: 1 },
  buckle: { kind: 'metal', rough: 0.3, metal: 1 },
  button: { kind: 'plastic', rough: 0.42, metal: 0 },
  // a glossy ABS shell, not a mirror
  helmet: { kind: 'plastic', rough: 0.27, metal: 0, env: 0.85 },
  // powder-coated steel cage
  mask: { kind: 'painted', rough: 0.5, metal: 0 },
  mask_pad: { kind: 'fabric', rough: 0.9, metal: 0 },
  eyeblack: { kind: 'paint', rough: 0.95, metal: 0 },
  hair: { kind: 'hair', rough: 0.55, metal: 0 },
  // ---- bat, ball, donut
  bat_wood: { kind: 'wood', rough: 0.45, metal: 0 },
  ball_leather: { kind: 'leather', rough: 0.65, metal: 0 },
  ball_thread: { kind: 'fabric', rough: 0.8, metal: 0 },
  donut: { kind: 'rubber', rough: 0.8, metal: 0 },
  // ---- field: grass has a broad sheen, never plastic; clay, track and chalk are matte
  grass: { kind: 'grass', rough: 0.82, metal: 0 },
  dirt: { kind: 'clay', rough: 0.9, metal: 0, normal: 0.35 },
  track: { kind: 'clay', rough: 0.92, metal: 0 },
  chalk: { kind: 'paint', rough: 0.95, metal: 0 },
  base_white: { kind: 'fabric', rough: 0.85, metal: 0 },
  plate_white: { kind: 'rubber', rough: 0.8, metal: 0 },
  rubber_white: { kind: 'rubber', rough: 0.8, metal: 0 },
  pole_yellow: { kind: 'paint', rough: 0.6, metal: 0 },
  // ---- stadium
  concrete: { kind: 'concrete', rough: 0.9, metal: 0 },
  dugout_concrete: { kind: 'concrete', rough: 0.9, metal: 0 },
  steel: { kind: 'painted', rough: 0.6, metal: 0.25 },
  // the dugout's rail and roof posts: painted dark (as bare metal they reflected the dark pit and read black; as light paint they glared)
  dugout_steel: { kind: 'painted', rough: 0.55, metal: 0, colorScale: 0.2 },
  Seats_T1_mat: { kind: 'plastic', rough: 0.52, metal: 0 },
  Seats_T2_mat: { kind: 'plastic', rough: 0.52, metal: 0 },
  Seats_T3_mat: { kind: 'plastic', rough: 0.52, metal: 0 },
  wall_padding: { kind: 'vinyl', rough: 0.62, metal: 0 },
  dugout_padding: { kind: 'vinyl', rough: 0.62, metal: 0 },
  dugout_wood: { kind: 'wood', rough: 0.58, metal: 0 },
  wall_yellow_line: { kind: 'paint', rough: 0.75, metal: 0 },
  ad_boards: { kind: 'vinyl', rough: 0.72, metal: 0 },
  fascia_dark: { kind: 'paint', rough: 0.72, metal: 0 },
  canopy: { kind: 'painted', rough: 0.68, metal: 0.1 },
  dugout_roof: { kind: 'paint', rough: 0.78, metal: 0 },
  dugout_roof_fascia: { kind: 'paint', rough: 0.72, metal: 0 },
  press_glass: { kind: 'glass', rough: 0.06, metal: 0 },
  scoreboard_screen: { kind: 'emissive', rough: 0.4, metal: 0 },
  batters_eye: { kind: 'paint', rough: 0.95, metal: 0 },
  backstop_net: { kind: 'net', rough: 0.9, metal: 0 },
  dugout_interior: { kind: 'paint', rough: 0.9, metal: 0 },
};

/** Apply the policy to one material (idempotent: the policy values replace the GLB's, they do not compound). Returns whether it had an entry. */
export function applyMaterialPolicy(mat: Material): boolean {
  const name = mat.name.replace(/\.\d+$/, '');
  const p = POLICY[name];
  if (!p) return false;
  const m = mat as MeshStandardMaterial & Partial<MeshPhysicalMaterial>;
  if (p.rough !== undefined && 'roughness' in m) m.roughness = m.roughnessMap ? p.rough / (TEX_ROUGH[name] ?? 1) : p.rough;
  if (p.metal !== undefined && 'metalness' in m) m.metalness = p.metal;
  if (p.normal !== undefined && m.normalScale) m.normalScale.setScalar(p.normal);
  if (p.env !== undefined) m.envMapIntensity = p.env;
  if (p.colorScale !== undefined && m.color && !m.userData.cbScaled) {
    m.color.multiplyScalar(p.colorScale);
    m.userData.cbScaled = true;
  }
  if ((m as MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    const pm = m as MeshPhysicalMaterial;
    pm.sheen = p.sheen ? p.sheen[0] : 0;
    if (p.sheen) pm.sheenRoughness = p.sheen[1];
    if (p.clearcoat) {
      pm.clearcoat = p.clearcoat[0];
      pm.clearcoatRoughness = p.clearcoat[1];
    }
  }
  m.userData.cbPolicy = p.kind;
  m.needsUpdate = true;
  return true;
}

/** The fabric's sheen is its own colour, a little lighter (a white sheen read as a milky haze on saturated jerseys). */
export function fabricSheenColor(m: MeshPhysicalMaterial, base: Color): void {
  if (!m.isMeshPhysicalMaterial || !m.sheen) return;
  m.sheenColor = base.clone().lerp(new Color(1, 1, 1), 0.25);
}
