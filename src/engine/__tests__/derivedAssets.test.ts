/**
 * The phone texture set (`optimized/players_1k`) is derived from the raw exports (`npm run assets:derive`); derived from stale raw files it ships
 * the previous players to every touch device (it did: 115 clips and no build_heavy while the desktop files had 118). Same clips, same morphs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import shipped from '../../../assets/shipped.json';

function gltfJson(rel: string) {
  const b = readFileSync(new URL(`../../../assets/${rel}`, import.meta.url));
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as { animations?: { name: string }[]; meshes: { name?: string; extras?: { targetNames?: string[] } }[] };
}
const sig = (rel: string) => {
  const j = gltfJson(rel);
  const morphs = new Set<string>();
  for (const m of j.meshes) for (const n of m.extras?.targetNames ?? []) morphs.add(n);
  return { clips: (j.animations ?? []).map((a) => a.name).sort(), morphs: [...morphs].sort() };
};

describe('derived player files match the shipped ones', () => {
  for (const f of (shipped as { players_1k: string[] }).players_1k) {
    it(`players_1k/${f} has the clips and morph targets of players/${f}`, () => {
      const full = sig(`optimized/players/${f}.glb`), small = sig(`optimized/players_1k/${f}.glb`);
      expect(small.clips).toEqual(full.clips);
      expect(small.morphs).toEqual(full.morphs);
    });
  }
});
