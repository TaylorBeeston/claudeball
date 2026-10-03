#!/usr/bin/env node
/**
 * Derived runtime assets (run after `assets/optimize.sh`; `npm run assets:derive`):
 *
 *  1. assets/optimized/players_1k/<file>.glb  - the player files the game spawns, with textures capped at 1024 px (skin, fabric), 512 px for the small maps (phones: roughly a
 *     fifth of the texture memory). Built from the raw exports in assets/players/ with the same optimize flags as optimize.sh.
 *  2. assets/optimized/lod/player_base_geo.glb - geometry only (positions, normals, uvs, skin weights, morph targets) of the simplified (lod1) player_base: no
 *     textures, no animations. The engine swaps these meshes in for small / distant players (same mesh names, same skeleton, same uv layout, so the
 *     full-detail materials fit), a third of the triangles.
 *
 *  3. assets/optimized/players/gear_defaults.json - the nodes the role files show by default, so the engine need not download three whole player files for them.
 *
 * `assets/derived.json` records the sha1 of the sources, so `vite build` can warn when a source changed and these were not regenerated.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const A = (...p) => path.join(root, 'assets', ...p);
const shipped = JSON.parse(fs.readFileSync(A('shipped.json'), 'utf8'));
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const derived = { sources: {} };

// 1. 1k texture variants
fs.mkdirSync(A('optimized/players_1k'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-derive-'));
for (const f of shipped.players_1k) {
  const src = A('players', `${f}.glb`), out = A('optimized/players_1k', `${f}.glb`), mid = path.join(tmp, `${f}.glb`);
  console.log(`[derive] ${f}: textures -> 1024 / 512 px`);
  // (resize the raw export first and compress once at the end: re-encoding meshopt geometry twice would be lossy)
  // the small, high-count maps (hair cards, leather, plastic, rubber, teeth, tongue, beard, brows, lashes) go to 512 px: the player is never close enough to tell
  execFileSync('npx', ['--yes', '@gltf-transform/cli', 'resize', src, mid, '--width', '512', '--height', '512', '--pattern', '{hair_*,teeth_*,tongue_*,leather_*,plastic_*,rubber_*,beard_*,eyebrow*,eyelash*}'], { stdio: 'inherit' });
  execFileSync('npx', ['--yes', '@gltf-transform/cli', 'optimize', mid, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024', '--simplify', 'false', '--palette', 'false', '--join', 'false', '--flatten', 'false', '--prune', 'false'], { stdio: 'inherit' });
  derived.sources[`players/${f}.glb`] = sha(src);
}
fs.rmSync(tmp, { recursive: true, force: true });

// 2. geometry-only lod of player_base
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const lodSrc = A('optimized/lod1/player_base.glb');
const doc = await io.read(lodSrc);
const root3 = doc.getRoot();
for (const a of root3.listAnimations()) a.dispose();
for (const m of root3.listMaterials()) {
  m.setBaseColorTexture(null).setNormalTexture(null).setOcclusionTexture(null).setEmissiveTexture(null).setMetallicRoughnessTexture(null);
}
for (const t of root3.listTextures()) t.dispose();
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
fs.mkdirSync(A('optimized/lod'), { recursive: true });
await io.write(A('optimized/lod/player_base_geo.glb'), doc);
derived.sources['optimized/lod1/player_base.glb'] = sha(lodSrc);
console.log(`[derive] lod geometry: ${(fs.statSync(A('optimized/lod/player_base_geo.glb')).size / 1048576).toFixed(2)} MB`);

// 3. which parts the role files show by default (`cb_default`): the engine used to load three whole player files just to read this
const gear = {};
for (const [key, file] of [['field', 'player_home'], ['batter', 'player_batter'], ['catcher', 'player_catcher']]) {
  const d = await io.read(A('optimized/players', `${file}.glb`));
  gear[key] = d.getRoot().listNodes().filter((n) => { const e = n.getExtras(); return e && (e.cb_default === 1 || e.cb_default === true); }).map((n) => n.getName());
  derived.sources[`optimized/players/${file}.glb`] = sha(A('optimized/players', `${file}.glb`));
}
fs.writeFileSync(A('optimized/players/gear_defaults.json'), JSON.stringify(gear) + '\n');
console.log('[derive] gear defaults:', Object.entries(gear).map(([k, v]) => `${k} ${v.length}`).join(', '));

fs.writeFileSync(A('derived.json'), JSON.stringify(derived, null, 1) + '\n');
console.log('[derive] done');
