/**
 * The playing surface's look on top of the field asset's textures (which are flat and saturated: an orange infield, a yellow-green lawn), as small
 * patches of the standard material, so they cost nothing extra in draw calls:
 *   - dirt / mound / cut-outs: clay colour (less orange, a little greyer), large soft patches of damp (darker) and dry (lighter, dustier) clay,
 *     fine grain, and faint rake lines across the infield;
 *   - grass: a cooler, less saturated green with soft large-scale tone variation (the mowing stripes are the asset's vertex colours);
 *   - warning track: the same grain as the dirt, darker.
 * All variation is in world space (metres), so it does not repeat with the 4 m texture tile.
 */
import type { Material } from 'three';

const NOISE = /* glsl */ `
float cbHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float cbNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cbHash(i), cbHash(i + vec2(1.0, 0.0)), f.x), mix(cbHash(i + vec2(0.0, 1.0)), cbHash(i + vec2(1.0, 1.0)), f.x), f.y); }
float cbFbm(vec2 p){ return cbNoise(p) * 0.55 + cbNoise(p * 2.07 + 13.1) * 0.3 + cbNoise(p * 4.13 + 7.7) * 0.15; }
`;

type Kind = 'dirt' | 'grass' | 'track';

const FRAG: Record<Kind, string> = {
  dirt: /* glsl */ `
    {
      vec2 w = vCbWorld.xz;
      float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      // clay: browner and a little lighter than the asset's orange (real infield clay is about sRGB 155 / 102 / 68)
      diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 0.84) * vec3(0.93, 1.06, 1.3);
      float damp = smoothstep(0.42, 0.78, cbFbm(w * 0.09));
      float dry = smoothstep(0.55, 0.85, cbFbm(w * 0.21 + 31.0));
      diffuseColor.rgb *= mix(1.0, 0.8, damp);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(1.18, 1.05, 0.92), dry * 0.22);
      // grain and faint rake lines (closely spaced ridges, slightly wavy)
      float g = cbNoise(w * 38.0) * 0.6 + cbNoise(w * 91.0) * 0.4;
      float rake = sin((w.x + w.y) * 18.0 + cbNoise(w * 1.3) * 3.0) * 0.5 + 0.5;
      diffuseColor.rgb *= 0.93 + 0.12 * g - 0.035 * rake;
    }`,
  grass: /* glsl */ `
    {
      vec2 w = vCbWorld.xz;
      float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      // a cooler, less saturated lawn
      diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 0.88) * vec3(0.98, 1.0, 1.04);
      float tone = cbFbm(w * 0.05);
      diffuseColor.rgb *= 0.92 + 0.16 * tone;
      diffuseColor.rgb *= 0.95 + 0.08 * cbNoise(w * 7.0);
    }`,
  track: /* glsl */ `
    {
      vec2 w = vCbWorld.xz;
      float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 0.75);
      diffuseColor.rgb *= 0.9 + 0.14 * (cbNoise(w * 40.0) * 0.6 + cbNoise(w * 97.0) * 0.4);
      diffuseColor.rgb *= 0.92 + 0.12 * cbFbm(w * 0.15);
    }`,
};

/** which patch a field material gets (by its glTF material name), or null */
export function fieldKind(materialName: string): Kind | null {
  const n = materialName.replace(/\.\d+$/, '');
  return n === 'dirt' ? 'dirt' : n === 'grass' ? 'grass' : n === 'track' ? 'track' : null;
}

/** the `onBeforeCompile` patch for a field material (pass to `Environment.register`) */
export function fieldPatch(kind: Kind): (s: unknown) => void {
  return (s: unknown) => {
    const shader = s as { vertexShader: string; fragmentShader: string };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCbWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCbWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCbWorld;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG[kind]}`);
  };
}

/** a distinct program per kind (the patched source differs while the materials look alike to three's cache) */
export function tagField(m: Material, kind: Kind) {
  m.customProgramCacheKey = () => `cb-field-${kind}`;
}

/**
 * Material fixes by name for the park's own pieces (applied when the field / stadium glTF is adopted): dugout interiors were near-black boxes, the
 * roofs flat light-grey slabs, and the lamp banks black from behind (their emissive panels are double-sided; the back is now a grey housing).
 */
export function tuneParkMaterial(m: Material): ((shader: unknown) => void) | undefined {
  const s = m as Material & { color?: { setRGB(r: number, g: number, b: number): void; multiplyScalar(k: number): void }; emissive?: { setRGB(r: number, g: number, b: number): void }; roughness?: number; metalness?: number };
  const n = m.name.replace(/\.\d+$/, '');
  if (n === 'dugout_interior') {
    s.color?.setRGB(0.2, 0.19, 0.18);
    s.emissive?.setRGB(0.035, 0.032, 0.028); // the dugout's own lights
  } else if (n === 'dugout_roof') {
    s.color?.setRGB(0.07, 0.075, 0.085);
    s.roughness = 0.75;
  } else if (n === 'dugout_concrete') {
    s.color?.multiplyScalar(0.72);
  } else if (n === 'stadium_light') {
    m.customProgramCacheKey = () => 'cb-lamp-bank';
    s.metalness = 0.3;
    m.needsUpdate = true;
    // returned as the patch for Environment.register (which owns onBeforeCompile for the cascaded shadows)
    return (shader: unknown) => {
      const sh = shader as { fragmentShader: string };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = vec3(0.3, 0.31, 0.33);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (!gl_FrontFacing) totalEmissiveRadiance = vec3(0.0);');
    };
  }
  m.needsUpdate = true;
  return undefined;
}
