/**
 * The broadcast rigs that used to film the park from behind (promo jank log P1 / P2): the low camera at third base sat behind the
 * third-base dugout for a whole steal, and the home-run camera watched a ball over the batter's eye from behind the block (a black
 * wall). Reads the shipped field / stadium files' solid blocks and checks every base and every fence point.
 */
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseCamera, blocker, clearestCamera, hrBeyond, hrWallCamera, segmentHitsBox, type Box } from '../sightLines';

const root = new URL('../../../', import.meta.url).pathname;
const boxes: Box[] = [];

beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform, EXTTextureWebP]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const names = ['Dugout_1B', 'Dugout_3B', 'DugoutRoof_1B', 'DugoutRoof_3B', 'BattersEye'];
  for (const file of ['field.glb', 'stadium.glb']) {
    const doc = await io.read(`${root}assets/optimized/${file}`);
    for (const node of doc.getRoot().listNodes()) {
      if (!names.includes(node.getName())) continue;
      const m = node.getWorldMatrix();
      const b: Box = { name: node.getName(), min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      for (const prim of node.getMesh()?.listPrimitives() ?? []) {
        const P = prim.getAttribute('POSITION')!;
        for (let i = 0; i < P.getCount(); i++) {
          const p = P.getElement(i, [0, 0, 0]);
          const w = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
          (['x', 'y', 'z'] as const).forEach((k, j) => {
            b.min[k] = Math.min(b.min[k], w[j]);
            b.max[k] = Math.max(b.max[k], w[j]);
          });
        }
      }
      boxes.push(b);
    }
  }
});

describe('sight lines', () => {
  it('finds the blocks in the shipped park', () => {
    expect(boxes.map((b) => b.name).sort()).toEqual(['BattersEye', 'DugoutRoof_1B', 'DugoutRoof_3B', 'Dugout_1B', 'Dugout_3B']);
  });

  it('segment test', () => {
    const b: Box = { min: { x: -1, y: 0, z: 9 }, max: { x: 1, y: 3, z: 11 } };
    expect(segmentHitsBox({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 20 }, b)).toBe(true);
    expect(segmentHitsBox({ x: 5, y: 1, z: 0 }, { x: 5, y: 1, z: 20 }, b)).toBe(false);
    expect(segmentHitsBox({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 9.5 }, b)).toBe(false); // stops short (frac 0.92)
  });

  it('the low camera at every base sees the bag (first and third mirror each other)', () => {
    const layout = JSON.parse(fs.readFileSync(`${root}assets/field_layout.json`, 'utf8')) as { bases: Record<string, [number, number]> };
    const cams: Record<string, { x: number; z: number }> = {};
    for (const [name, [x, z]] of Object.entries(layout.bases)) {
      const base = { x, y: 0, z };
      const cam = baseCamera(base, boxes);
      cams[name] = cam;
      expect(blocker(cam, { x, y: 1, z }, boxes), `${name}: ${JSON.stringify(cam)}`).toBeNull();
    }
    expect(cams.first.x).toBeCloseTo(-cams.third.x, 5);
    expect(cams.first.z).toBeCloseTo(cams.third.z, 5);
  });

  it('the home-run camera sees the fence point and the seats beyond, all round the outfield', () => {
    const layout = JSON.parse(fs.readFileSync(`${root}assets/field_layout.json`, 'utf8')) as { fence: [number, number][] };
    let n = 0;
    for (const [x, z] of layout.fence) {
      const l = Math.hypot(x, z);
      const dir = { x: x / l, z: z / l };
      const side = dir.x >= 0 ? -1 : 1; // the director's preference
      for (const y of [2.6, 6, 12]) {
        const fence = { x, y, z };
        const cam = hrWallCamera(fence, dir, side, boxes);
        const beyond = hrBeyond(fence, dir, boxes);
        expect(blocker(cam, { x, y: Math.max(y, 3), z }, boxes), `fence ${x.toFixed(1)},${z.toFixed(1)} y ${y}`).toBeNull();
        expect(blocker(cam, beyond, boxes), `beyond ${x.toFixed(1)},${z.toFixed(1)} y ${y}`).toBeNull();
        n++;
      }
    }
    expect(n).toBeGreaterThan(60);
  });

  it('the close-play replay camera moves off a line an umpire stands on (promo jank log P7)', () => {
    const bag = { x: -19.4, y: 0.9, z: 19.4 };
    const first = { x: -25.9, y: 1.25, z: 13.9 }, other = { x: -25.9, y: 1.25, z: 24.9 };
    // the umpire half-way along the first camera's sight line for the whole replay
    const ump = [{ x: -22.6, z: 16.7 }];
    const r = clearestCamera([first, other], bag, [ump, ump, ump]);
    expect(r.index).toBe(1);
    expect(r.clearance).toBeGreaterThan(2);
    // nobody in the way: the preferred camera stays
    expect(clearestCamera([first, other], bag, [[{ x: -30, z: 30 }]]).index).toBe(0);
    // someone at the bag is part of the play, not a blocker
    expect(clearestCamera([first, other], bag, [[{ x: -19.6, z: 19.2 }]]).index).toBe(0);
  });
});
