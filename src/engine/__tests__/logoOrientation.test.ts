/**
 * Cap / helmet logo orientation ("a letter on a helmet upside down"): the stitched logo patches are plain textured meshes, so a left-hander's mirrored
 * model (`scale.x = -1`) showed the C reversed, which reads as a C turned upside down. Check the shipped patches' UV layout and that the engine's
 * flipped material puts the texture's left edge back on the viewer's left once the model is mirrored.
 */
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { MeshStandardMaterial, Texture, Vector2 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { mirroredLogoMaterial } from '../gltfCharacter';

/** per patch: the slope of texture u against model x (model +X = the character's left = the viewer's right when he faces the camera) */
const slope = new Map<string, number>();

beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(new URL('../../../assets/optimized/players/player_base.glb', import.meta.url).pathname);
  for (const node of doc.getRoot().listNodes()) {
    if (!/^Gear_(Cap|Helmet)Logo$/.test(node.getName())) continue;
    const prim = node.getMesh()!.listPrimitives()[0];
    const P = prim.getAttribute('POSITION')!, U = prim.getAttribute('TEXCOORD_0')!;
    const m = node.getWorldMatrix();
    let sxu = 0, sxx = 0, mx = 0, mu = 0;
    const xs: number[] = [], us: number[] = [];
    for (let i = 0; i < P.getCount(); i++) {
      const p = P.getElement(i, [0, 0, 0]);
      xs.push(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
      us.push(U.getElement(i, [0, 0])[0]);
    }
    for (let i = 0; i < xs.length; i++) { mx += xs[i] / xs.length; mu += us[i] / us.length; }
    for (let i = 0; i < xs.length; i++) { sxu += (xs[i] - mx) * (us[i] - mu); sxx += (xs[i] - mx) ** 2; }
    slope.set(node.getName(), sxu / sxx);
  }
});

/** texture u sampled at patch u for a material's map (three's uv transform: offset + repeat * u, no rotation) */
const sampled = (mat: MeshStandardMaterial, u: number) => {
  const t = mat.map!;
  t.updateMatrix();
  return new Vector2(u, 0.5).applyMatrix3(t.matrix).x;
};

describe('cap and helmet logos read the right way round', () => {
  it('the patches run u from the viewer\'s left to his right on the plain (right-handed) model', () => {
    expect([...slope.keys()].sort()).toEqual(['Gear_CapLogo', 'Gear_HelmetLogo']);
    for (const [, k] of slope) expect(k).toBeGreaterThan(0);
  });
  it('the mirrored model\'s material samples the texture flipped, so the letter is not reversed', () => {
    const src = new MeshStandardMaterial({ map: new Texture(), normalMap: new Texture() });
    const m = mirroredLogoMaterial(src) as MeshStandardMaterial;
    expect(m).not.toBe(src);
    expect(mirroredLogoMaterial(src)).toBe(m); // one shared copy for every left-hander
    expect(src.map!.repeat.x).toBe(1); // the right-handers' material is untouched
    for (const u of [0, 0.25, 1]) expect(sampled(m, u)).toBeCloseTo(1 - u, 6);
    expect(m.normalMap!.repeat.x).toBe(-1);
    // mirrored: model x -> -x, so texture u now falls toward the viewer's left; flipping u restores left-to-right reading
    for (const [, k] of slope) expect(-k * (sampled(m, 1) - sampled(m, 0))).toBeGreaterThan(0);
  });
});
