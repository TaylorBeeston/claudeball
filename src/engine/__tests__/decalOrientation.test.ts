/**
 * Jersey text orientation ("numbers / names on jerseys tend to be upside down or mirrored"): read the shipped player file's decal meshes and check where
 * the canvas's top-left corner lands on the body for the engine's texture settings, for a right-handed (plain) and a left-handed (mirrored) model.
 */
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { DECAL_FLIP_Y } from '../jerseyText';

type V3 = [number, number, number];
interface Decal { pos: V3[]; uv: [number, number][] }
const decals = new Map<string, Decal>();

beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(new URL('../../../assets/optimized/players/player_base.glb', import.meta.url).pathname);
  for (const node of doc.getRoot().listNodes()) {
    if (!/^Jersey_.*Decal$/.test(node.getName())) continue;
    const prim = node.getMesh()!.listPrimitives()[0];
    const P = prim.getAttribute('POSITION')!, U = prim.getAttribute('TEXCOORD_0')!;
    // the pack step quantizes positions with one scene-wide volume: the node's own matrix brings them back to model space
    const m = node.getWorldMatrix();
    const d: Decal = { pos: [], uv: [] };
    for (let i = 0; i < P.getCount(); i++) {
      const p = P.getElement(i, []) as number[];
      d.pos.push([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]);
      d.uv.push(U.getElement(i, []) as [number, number]);
    }
    decals.set(node.getName(), d);
  }
});

/** the model-space point under texture coordinate (u, v): the vertex nearest in UV */
function at(d: Decal, u: number, v: number): V3 {
  let best = 0, bd = Infinity;
  d.uv.forEach((t, i) => {
    const e = (t[0] - u) ** 2 + (t[1] - v) ** 2;
    if (e < bd) { bd = e; best = i; }
  });
  return d.pos[best];
}
/**
 * Where the canvas's top-left and top-right pixels end up, as (x, y) seen by a viewer looking at the decal along `look` (model space, +Y up),
 * for a model mirrored across X or not. three's texture lookup: canvas row 0 is at v = 1 when flipY, at v = 0 otherwise.
 */
function canvasCorners(d: Decal, look: V3, mirrored: boolean, mirrorDrawn: boolean) {
  const vTop = DECAL_FLIP_Y ? 1 : 0;
  // the canvas is drawn mirrored for lefties (`TextureKey.mirror`): its left edge is at u = 1
  const uLeft = mirrorDrawn ? 1 : 0;
  const tl = at(d, uLeft, vTop), tr = at(d, 1 - uLeft, vTop), bl = at(d, uLeft, 1 - vTop);
  const mx = (p: V3): V3 => (mirrored ? [-p[0], p[1], p[2]] : p);
  // viewer's right = look x up
  const right: V3 = [-look[2], 0, look[0]];
  const sx = (p: V3) => mx(p)[0] * right[0] + mx(p)[2] * right[2];
  return { leftToRight: sx(tr) > sx(tl), topAbove: mx(tl)[1] > mx(bl)[1] };
}

describe('jersey decals read the right way round', () => {
  const views: Record<string, V3> = {
    Jersey_BackNameDecal: [0, 0, 1], // seen from behind: looking toward +Z
    Jersey_BackNumberDecal: [0, 0, 1],
    Jersey_FrontNumberDecal: [0, 0, -1], // from the front
    Jersey_SleeveNumberDecal: [-1, 0, 0], // the left sleeve, from the player's left
  };
  it('the file has the four decals', () => expect([...decals.keys()].sort()).toEqual(Object.keys(views).sort()));
  for (const [name, look] of Object.entries(views)) {
    it(`${name}: upright and left-to-right on a right-hander`, () => {
      const c = canvasCorners(decals.get(name)!, look, false, false);
      expect(c.topAbove).toBe(true);
      expect(c.leftToRight).toBe(true);
    });
    it(`${name}: upright and left-to-right on a left-hander (model mirrored, canvas drawn mirrored)`, () => {
      // a lefty's sleeve number sits on the other arm: look at it from the other side
      const l: V3 = name === 'Jersey_SleeveNumberDecal' ? [1, 0, 0] : look;
      const c = canvasCorners(decals.get(name)!, l, true, true);
      expect(c.topAbove).toBe(true);
      expect(c.leftToRight).toBe(true);
    });
  }
});
