/**
 * The materials policy covers every material the shipped GLBs carry, and its values are physically plausible for their kind
 * ("their clothes are shiny and smooth, they really shouldn't be").
 */
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform, EXTMeshGPUInstancing, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { POLICY, TEX_ROUGH, type MaterialKind } from '../materials';

/** materials that keep the file's values on purpose: skin / eyes / hair cards / mouth are tuned in characterShading.ts and the face pass; the
 * stadium's light sources and the legacy box crowd (hidden; the impostor crowd replaces it) are not surfaces to audit */
const EXEMPT = /^(skin|face|eye|cornea|eyebrow|eyelash|teeth|tongue|stubble|hair_beard|hair_.*|lod_cloth|stadium_light|crowd_(skin|cloth)_\d+|ball_.*_unused)$/;

const FILES = ['players/player_base.glb', 'players/player_umpire.glb', 'players/player_coach.glb', 'players/player_ballkid.glb', 'field.glb', 'stadium.glb', 'bat.glb', 'ball.glb'];
const names = new Set<string>();
beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu, KHRTextureTransform, EXTMeshGPUInstancing, KHRMaterialsEmissiveStrength])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  for (const f of FILES) {
    const doc = await io.read(new URL(`../../../assets/optimized/${f}`, import.meta.url).pathname);
    for (const m of doc.getRoot().listMaterials()) names.add(m.getName().replace(/\.\d+$/, ''));
  }
}, 120000);

const RANGE: Partial<Record<MaterialKind, { rough: [number, number]; metal: [number, number] }>> = {
  fabric: { rough: [0.7, 1], metal: [0, 0] },
  leather: { rough: [0.4, 0.75], metal: [0, 0] },
  rubber: { rough: [0.7, 1], metal: [0, 0] },
  plastic: { rough: [0.25, 0.6], metal: [0, 0] },
  metal: { rough: [0.15, 0.6], metal: [1, 1] },
  painted: { rough: [0.4, 0.8], metal: [0, 0.3] },
  wood: { rough: [0.35, 0.7], metal: [0, 0] },
  concrete: { rough: [0.8, 1], metal: [0, 0] },
  grass: { rough: [0.7, 0.95], metal: [0, 0] },
  clay: { rough: [0.8, 1], metal: [0, 0] },
  paint: { rough: [0.55, 1], metal: [0, 0] },
  vinyl: { rough: [0.5, 0.85], metal: [0, 0] },
  glass: { rough: [0, 0.15], metal: [0, 0] },
  net: { rough: [0.8, 1], metal: [0, 0] },
};

describe('materials policy', () => {
  it('read the files', () => expect(names.size).toBeGreaterThan(40));

  it('every material in the shipped GLBs has a policy entry or is exempt on purpose', () => {
    const missing = [...names].filter((n) => !POLICY[n] && !EXEMPT.test(n) && n !== '');
    expect(missing).toEqual([]);
  });

  it('values are plausible for the kind of surface (cloth fully diffuse, no metal but metal, glass smooth...)', () => {
    for (const [name, p] of Object.entries(POLICY)) {
      const r = RANGE[p.kind];
      if (!r || p.rough === undefined) continue;
      expect(p.rough, name).toBeGreaterThanOrEqual(r.rough[0]);
      expect(p.rough, name).toBeLessThanOrEqual(r.rough[1]);
      expect(p.metal ?? 0, name).toBeGreaterThanOrEqual(r.metal[0]);
      expect(p.metal ?? 0, name).toBeLessThanOrEqual(r.metal[1]);
      if (p.kind === 'fabric') {
        expect(p.clearcoat?.[0] ?? 0, name).toBe(0);
        expect(p.sheen?.[0] ?? 0, name).toBeLessThanOrEqual(0.2); // a faint fuzz, never the white haze (0.7) the jerseys had
      }
    }
  });

  it('every roughness-mapped policy entry knows its map mean (the factor is target / mean)', () => {
    for (const n of Object.keys(TEX_ROUGH)) {
      if (EXEMPT.test(n)) continue; // (skin keeps its own values; its mean is recorded for the audit)
      expect(POLICY[n], n).toBeDefined();
      expect(TEX_ROUGH[n]).toBeGreaterThan(0.1);
    }
  });
});
