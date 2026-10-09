/**
 * Photographic shading for the players, as small patches of three's physical shader (no extra passes):
 *  - skin: a pre-integrated-style wrap of the direct light per colour channel (red scatters furthest, so the terminator turns warm), wider on
 *    thin / strongly curved parts (ears, nose, fingers; the curvature comes from screen-space derivatives of the normal), fading out with distance;
 *  - hair: a Kajiya-Kay anisotropic highlight (two lobes, the second shifted and tinted by the hair colour) along strands that fall with gravity;
 *    translucent hair / stubble cards use alpha-to-coverage (no sorting artefacts) or a hard cutoff without MSAA;
 *  - eyes: a clear-coated sclera plus a cornea shell (see `makeCorneaShell`) with the environment's reflections and the sun as catchlights;
 *  - leather (gloves, cleats, belts): a thin clear coat.
 * Everything is keyed by material name and switched by quality tier, so the low tier keeps the plain materials. The patches live in
 * `ShaderChunk` behind `#ifdef`s: a material opts in through `defines`, so it survives the shadow cascades re-patching `onBeforeCompile`.
 */
import { Color, DoubleSide, Material, MeshPhysicalMaterial, MeshStandardMaterial, ShaderChunk, SkinnedMesh } from 'three';
import type { QualityName } from './quality';
import { POLICY, applyMaterialPolicy } from './materials';

export type ShadingTier = 'off' | 'basic' | 'full';

export const TIER_OF: Record<QualityName, ShadingTier> = { low: 'off', medium: 'basic', high: 'full', ultra: 'full' };

let tier: ShadingTier = 'full';
let msaa = true;
let installed = false;
const registry = new Set<Material>();

const PATCH_MARK = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

const SKIN_GLSL = /* glsl */ `
#ifdef CB_SKIN
	{
		float cbDist = length( geometryPosition );
		float cbFade = 1.0 - smoothstep( CB_SSS_NEAR, CB_SSS_FAR, cbDist );
		if ( cbFade > 0.01 ) {
			#ifdef CB_SSS_CURV
				float cbCurv = length( fwidth( geometryNormal ) ) / max( length( fwidth( geometryPosition ) ), 1e-4 );
				float cbK = clamp( cbCurv * 0.1, 0.2, 1.0 );
			#else
				float cbK = 0.55;
			#endif
			vec3 cbW = vec3( 0.55, 0.24, 0.10 ) * cbK;
			float cbDnl = dot( geometryNormal, directLight.direction );
			vec3 cbWrapped = clamp( ( vec3( cbDnl ) + cbW ) / ( vec3( 1.0 ) + cbW ), 0.0, 1.0 );
			vec3 cbExtra = max( cbWrapped - vec3( dotNL ), vec3( 0.0 ) );
			reflectedLight.directDiffuse += directLight.color * cbExtra * BRDF_Lambert( material.diffuseContribution ) * cbFade * 0.9;
		}
	}
#endif
#ifdef CB_HAIR
	{
		vec3 cbDown = ( viewMatrix * vec4( 0.0, -1.0, 0.0, 0.0 ) ).xyz;
		vec3 cbT = normalize( cbDown - geometryNormal * dot( cbDown, geometryNormal ) + vec3( 1e-5 ) );
		vec3 cbH = normalize( directLight.direction + geometryViewDir );
		float cbTH = dot( cbT, cbH );
		float cbSin = sqrt( max( 0.0, 1.0 - cbTH * cbTH ) );
		vec3 cbT2 = normalize( cbT + geometryNormal * 0.14 );
		float cbTH2 = dot( cbT2, cbH );
		float cbSin2 = sqrt( max( 0.0, 1.0 - cbTH2 * cbTH2 ) );
		float cbLit = smoothstep( -0.15, 0.5, dot( geometryNormal, directLight.direction ) );
		vec3 cbSpec = pow( cbSin, 80.0 ) * vec3( 0.55 ) + pow( cbSin2, 22.0 ) * material.diffuseColor * 0.6;
		reflectedLight.directSpecular += directLight.color * cbSpec * cbLit * 0.4;
	}
#endif
`;

/** Patch the physical light chunk once (idempotent; does nothing, with one warning, if the chunk no longer has the expected line). */
export function installCharacterShading() {
  if (installed) return;
  installed = true;
  const chunk = ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(PATCH_MARK)) {
    console.warn('[shading] the light chunk changed: skin / hair shading disabled');
    return;
  }
  ShaderChunk.lights_physical_pars_fragment = chunk.replace(PATCH_MARK, PATCH_MARK + '\n' + SKIN_GLSL);
}

const defineOn = (m: Material, key: string, value: string | number = '') => {
  const d = ((m as { defines?: Record<string, string | number> }).defines ??= {});
  d[key] = value;
};

const defineOff = (m: Material, key: string) => {
  const d = (m as { defines?: Record<string, string | number> }).defines;
  if (d) delete d[key];
};

/** the defines / properties of a registered material for the current tier */
function configure(m: Material) {
  const kind = m.userData.cbShade as string | undefined;
  if (!kind) return;
  const on = tier !== 'off';
  if (kind === 'skin') {
    if (on) {
      defineOn(m, 'CB_SKIN');
      defineOn(m, 'CB_SSS_NEAR', '10.0');
      defineOn(m, 'CB_SSS_FAR', '34.0');
      if (tier === 'full') defineOn(m, 'CB_SSS_CURV');
      else defineOff(m, 'CB_SSS_CURV');
    } else {
      defineOff(m, 'CB_SKIN');
      defineOff(m, 'CB_SSS_CURV');
    }
  } else if (kind === 'hair') {
    if (on && !m.userData.cbNoSpec) defineOn(m, 'CB_HAIR');
    else defineOff(m, 'CB_HAIR');
    const cards = m.userData.cbCards as boolean;
    if (cards) {
      const s = m as MeshStandardMaterial;
      s.transparent = !on; // translucent cards sort badly: coverage (MSAA) or a hard cutoff instead
      s.alphaTest = on ? 0.4 : 0;
      s.alphaToCoverage = on && msaa;
      s.depthWrite = true;
    }
  } else if (kind === 'leather') {
    // the policy's coat (materials.ts): a faint one on polished cleats and the belt, none on gloves / chest protectors (0.25 everywhere made them plastic)
    const cc = POLICY[m.name.replace(/\.\d+$/, '')]?.clearcoat;
    (m as MeshPhysicalMaterial).clearcoat = on && cc ? cc[0] : 0;
    (m as MeshPhysicalMaterial).clearcoatRoughness = cc ? cc[1] : 0.5;
  } else if (kind === 'eye') {
    // a little wet gloss; strong environment reflections on the eyeball (and the cornea over it) whited the whole eye out under a day sky
    (m as MeshPhysicalMaterial).clearcoat = on ? 0.35 : 0;
    (m as MeshPhysicalMaterial).clearcoatRoughness = 0.05;
    (m as MeshPhysicalMaterial).envMapIntensity = on ? 0.75 : 0.8;
    // a sclera is not paper white (and sits in the lids' shadow): the albedo was glowing next to the skin
    (m as MeshPhysicalMaterial).color.setScalar(0.78);
  }
  m.needsUpdate = true;
}

/** Tag a (freshly built) skin material for the wrap shading. */
export function shadeSkin(m: Material): Material {
  m.userData.cbShade = 'skin';
  registry.add(m);
  configure(m);
  return m;
}

/**
 * Tag a hair / beard / stubble material; strand cards (alpha-tested or translucent textures) get coverage / cutoff edges. `cards: false` keeps a
 * translucent shell blended (stubble: a 40 % film over the skin; as a card its alpha would pass the cutoff everywhere and read as a black beard).
 */
export function shadeHair(m: Material, cards?: boolean, strandSpecular = true): Material {
  const s = m as MeshStandardMaterial;
  m.userData.cbShade = 'hair';
  // the strand highlight runs down the head; on a beard shell (fibres in every direction, lit from below) it reads as a white band
  m.userData.cbNoSpec = !strandSpecular;
  m.userData.cbCards = cards ?? (!!s.transparent || s.alphaTest > 0 || !!s.alphaMap);
  registry.add(m);
  configure(m);
  return m;
}

const upgraded = new Map<Material, Material>();


/** The named material as it should look in this tier: eyes and leather become clear-coated physical materials (cached per source material). */
export function upgradeMaterial(mat: Material): Material {
  const name = mat.name.replace(/\.\d+$/, '');
  const kind = name === 'eye' ? 'eye' : /^(glove|cleats|belt|catcher_gear|batting_glove)$/.test(name) ? 'leather' : null;
  if (!kind) return mat;
  const hit = upgraded.get(mat);
  if (hit) return hit;
  const b = mat as MeshStandardMaterial;
  const pm = new MeshPhysicalMaterial({
    map: b.map, normalMap: b.normalMap, normalScale: b.normalScale?.clone(), roughnessMap: b.roughnessMap, metalnessMap: b.metalnessMap,
    aoMap: b.aoMap, aoMapIntensity: b.aoMapIntensity, roughness: b.roughness, metalness: b.metalness, side: b.side, color: b.color.clone(),
  });
  pm.name = b.name;
  pm.userData = { ...b.userData, cbShade: kind };
  applyMaterialPolicy(pm);
  if (kind === 'eye') {
    // a living eye in daylight: the iris is darker than its pale texture reads under a strong sun (more contrast against the sclera), and the upper
    // eyeball sits in the shadow of the lid and brow (without both, sunlit eyes turned into white discs: the "dead stare")
    pm.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', `#include <map_fragment>
	{ float cbLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ); diffuseColor.rgb *= mix( 0.42, 1.0, smoothstep( 0.32, 0.62, cbLum ) ); }`)
        .replace('#include <opaque_fragment>', `{ vec3 cbUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ); outgoingLight *= 1.0 - 0.5 * smoothstep( 0.0, 0.55, dot( normalize( normal ), cbUp ) ); }
#include <opaque_fragment>`);
    };
    pm.customProgramCacheKey = () => 'cb-eye';
  }
  delete pm.userData.regd;
  registry.add(pm);
  configure(pm);
  upgraded.set(mat, pm);
  return pm;
}

/** Switch every shaded material to a quality tier (materials recompile the next frame). `antialiased`: the render target has MSAA (alpha-to-coverage works). */
export function setShadingQuality(q: QualityName, antialiased: boolean) {
  const t = TIER_OF[q];
  if (t === tier && antialiased === msaa) return;
  tier = t;
  msaa = antialiased;
  for (const m of registry) configure(m);
}

export const shadingTier = () => tier;

/**
 * A thin glassy shell over the eyeballs: reflects the environment and the sun (the catchlights) and bends nothing, but a clear surface
 * over the iris is what separates a living eye from a painted dot. It shares the eye's geometry, morphs and skeleton, pushed out 1.2 mm.
 */
export function makeCorneaShell(eyes: SkinnedMesh): SkinnedMesh {
  const mat = new MeshPhysicalMaterial({
    color: new Color(0xffffff),
    roughness: 0.015,
    metalness: 0,
    transparent: true,
    opacity: 0.12,
    // the sun gives the catchlight; the sky's reflection must stay faint (at 2.4 a day sky turned the eyes into white discs: "dead stare")
    envMapIntensity: 0.9,
    specularIntensity: 1,
    ior: 1.376,
    depthWrite: false,
    side: DoubleSide,
  });
  mat.name = 'cornea';
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed += normalize( objectNormal ) * 0.0012;');
  };
  mat.customProgramCacheKey = () => 'cb-cornea';
  const shell = new SkinnedMesh(eyes.geometry, mat);
  shell.name = 'Eyes_Cornea';
  shell.castShadow = false;
  shell.receiveShadow = false;
  shell.frustumCulled = false;
  shell.renderOrder = 2;
  shell.bind(eyes.skeleton, eyes.bindMatrix);
  return shell;
}
