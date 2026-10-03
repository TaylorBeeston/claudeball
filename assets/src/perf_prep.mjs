// Prepares a player GLB for the KTX2 / meshopt optimize step (see perf_all.sh):
//   node perf_prep.mjs <in.glb> <out.glb> <lod>      (needs GT_MODULES = a dir with node_modules of @gltf-transform/core|extensions|functions and sharp)
//   - material `face` is merged into `skin` (same atlas; the engine tints both with one shared clone anyway)
//   - single-sided (backface culling) for closed / thick parts: halves the rasterised triangles of those meshes and fixes shadow-map self shadowing
//   - textures are decoded from WebP, clamped to the texture budget of the LOD and written as PNG (toktx needs PNG / JPEG)
//   - LOD1: normal / ORM textures of the body materials are dropped (flat shading at distance), everything else <= 512 px
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.env.GT_MODULES || process.env.HOME + '/tools/gt', 'x.js'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const sharp = require('sharp');
const { joinPrimitives } = require('@gltf-transform/functions');
const [, , inp, outp, lodArg] = process.argv; const lod = Number(lodArg || 0);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp); const root = doc.getRoot();
// ---- materials
const mats = new Map(root.listMaterials().map((m) => [m.getName(), m]));
const skin = mats.get('skin'), face = mats.get('face');
if (skin && face) { for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) if (p.getMaterial() === face) p.setMaterial(skin); face.dispose(); }
const SINGLE = new Set(['skin', 'cleats', 'belt', 'buckle', 'button', 'spikes', 'sole', 'glove', 'glove_laces', 'laces', 'mask', 'mask_pad', 'helmet', 'eye', 'cornea', 'jersey_decal_name', 'jersey_decal_backnum', 'jersey_decal_frontnum', 'jersey_decal_sleevenum', 'batting_glove', 'catcher_gear', 'cap_logo']);
for (const m of root.listMaterials()) if (SINGLE.has(m.getName())) m.setDoubleSided(false);
if (lod >= 1) for (const mesh of root.listMeshes()) {                                   // primitives that now share a material (skin + face) become one draw call
  const by = new Map(); for (const p of mesh.listPrimitives()) { const k = p.getMaterial()?.getName() + '|' + p.listSemantics().join(','); (by.get(k) || by.set(k, []).get(k)).push(p); }
  for (const g of by.values()) if (g.length > 1) { const j = joinPrimitives(g); g.forEach((p) => { mesh.removePrimitive(p); p.dispose(); }); mesh.addPrimitive(j); }
}
if (lod >= 1) for (const m of root.listMaterials()) if (['skin'].includes(m.getName())) { m.setNormalTexture(null); m.setOcclusionTexture(null); m.setMetallicRoughnessTexture(null); }
// ---- textures
const CAP = lod >= 1 ? { default: 512 } : { skin_albedo: 2048, skin_normal: 2048, skin_orm: 1024, eye_albedo: 1024, default: 1024 };
let before = 0, after = 0;
for (const tex of root.listTextures()) {
  const name = tex.getName(); const img = tex.getImage(); if (!img) continue; before += img.byteLength;
  const cap = CAP[name] ?? CAP.default; let s = sharp(Buffer.from(img)); const meta = await s.metadata();
  if (Math.max(meta.width, meta.height) > cap) s = s.resize({ width: meta.width >= meta.height ? cap : undefined, height: meta.height > meta.width ? cap : undefined, kernel: 'lanczos3' });
  const png = await s.png({ compressionLevel: 6 }).toBuffer(); tex.setImage(new Uint8Array(png)); tex.setMimeType('image/png'); after += png.byteLength;
}
for (const ext of root.listExtensionsUsed()) if (ext.extensionName === 'EXT_texture_webp') ext.dispose();
await io.write(outp, doc);
console.log(JSON.stringify({ in: inp, out: outp, lod, textures: root.listTextures().length, png_bytes: after }));
