// Measures the runtime budget of every optimized player file: triangles, draw calls, morph memory, texture bytes (file / estimated GPU) -> players/player_budgets.json
//   node perf_budget.mjs <assets dir>        (GT_MODULES as in perf_prep.mjs)
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
const require = createRequire(path.join(process.env.GT_MODULES || process.env.HOME + '/tools/gt', 'x.js'));
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptDecoder } = require('meshoptimizer');
await MeshoptDecoder.ready;
const dir = process.argv[2] || '.';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const ktxDims = (b) => ({ w: b[20] | (b[21] << 8) | (b[22] << 16), h: b[24] | (b[25] << 8) | (b[26] << 16) });
async function measure(file) {
  const doc = await io.read(file); const root = doc.getRoot(); const lod1 = file.includes('lod1');
  let tris = 0, verts = 0, draws = 0, morphBytes = 0, morphTargets = 0, meshes = 0; const mats = new Set(), tex = new Map(), visibleNames = [];
  const nodes = []; root.listScenes().forEach((s) => s.traverse((n) => nodes.push(n)));
  for (const n of nodes) {
    const m = n.getMesh(); if (!m) continue;
    const ex = n.getExtras() || {}; const visible = ex.cb_default === undefined ? true : ex.cb_default === 1; if (!visible) continue;
    meshes++; visibleNames.push(n.getName());
    for (const p of m.listPrimitives()) {
      draws++; const idx = p.getIndices(); tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3; const v = p.getAttribute('POSITION').getCount(); verts += v;
      const t = p.listTargets().length; morphTargets += t; morphBytes += v * t * 12 * (p.listTargets()[0] && p.listTargets()[0].getAttribute('NORMAL') ? 2 : 1);
      const mat = p.getMaterial(); if (mat) { mats.add(mat.getName()); for (const tx of [mat.getBaseColorTexture(), mat.getNormalTexture(), mat.getMetallicRoughnessTexture(), mat.getOcclusionTexture(), mat.getEmissiveTexture()]) if (tx) tex.set(tx.getName(), tx); }
    }
  }
  // all textures in the file (loaded by the engine whether or not the node is visible)
  const all = []; let fileBytes = 0, gpuWorst = 0, gpuBest = 0, gpuUsed = 0;
  for (const t of root.listTextures()) {
    const img = t.getImage(); const mime = t.getMimeType(); let w, h;
    if (mime === 'image/ktx2') ({ w, h } = ktxDims(img)); else { const s = t.getSize(); w = s?.[0]; h = s?.[1]; }
    const mip = 4/3, px = w * h, ktx = mime === 'image/ktx2';
    const worst = ktx ? px * 1.0 * mip : px * 4 * mip, best = ktx ? px * 0.5 * mip : px * 4 * mip;
    fileBytes += img.byteLength; gpuWorst += worst; gpuBest += best; if (tex.has(t.getName())) gpuUsed += worst;
    all.push({ name: t.getName(), w, h, mime, kb: Math.round(img.byteLength / 1024), sha1: crypto.createHash('sha1').update(img).digest('hex').slice(0, 12), gpu_mb_worst: +(worst / 1048576).toFixed(2) });
  }
  const anim = root.listAnimations().length; let animBytes = 0; for (const a of root.listAnimations()) for (const s of a.listSamplers()) animBytes += s.getInput().getArray().byteLength + s.getOutput().getArray().byteLength;
  return { size_mb: +(fs.statSync(file).size / 1048576).toFixed(2), lod1, visible_meshes: meshes, draw_calls_default: draws, materials_default: [...mats].sort(), triangles_default: Math.round(tris), vertices_default: verts,
    morph_targets_total: morphTargets, morph_memory_mb: +(morphBytes / 1048576).toFixed(2), joints: root.listSkins()[0]?.listJoints().length ?? 0, animations: anim, animation_mb: +(animBytes / 1048576).toFixed(2),
    textures: all.length, texture_file_kb: Math.round(fileBytes / 1024), gpu_texture_mb_worst: +(gpuWorst / 1048576).toFixed(1), gpu_texture_mb_etc1s_opaque_4bpp: +(gpuBest / 1048576).toFixed(1), gpu_texture_mb_used_by_visible: +(gpuUsed / 1048576).toFixed(1), texture_list: all };
}
const out = {};
for (const [sub, key] of [['optimized/players', 'lod0'], ['optimized/lod1', 'lod1']]) {
  const d = path.join(dir, sub); if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.startsWith('player_') && x.endsWith('.glb')).sort()) { out[`${key}/${f.replace('.glb', '')}`] = await measure(path.join(d, f)); }
}
// texture sharing across files: identical bytes = identical texture (the engine should upload each sha1 once)
const share = {};
for (const lod of ['lod0', 'lod1']) {
  const uniq = new Map(); let refs = 0, naive = 0;
  for (const [k, v] of Object.entries(out)) if (k.startsWith(lod + '/')) for (const t of v.texture_list) { refs++; naive += t.gpu_mb_worst; if (!uniq.has(t.sha1)) uniq.set(t.sha1, t); }
  share[lod] = { texture_references: refs, unique_textures: uniq.size, gpu_mb_worst_if_every_file_uploads_its_own: +naive.toFixed(0), gpu_mb_worst_if_unique_textures_are_shared: +[...uniq.values()].reduce((a, t) => a + t.gpu_mb_worst, 0).toFixed(0) };
}
out._texture_sharing = share; console.log(JSON.stringify(share));
fs.writeFileSync(path.join(dir, 'players/player_budgets.json'), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) if (v.size_mb !== undefined) console.log(k.padEnd(28), `${v.size_mb}MB  tris ${v.triangles_default}  draws ${v.draw_calls_default}  tex ${v.textures} ${v.texture_file_kb}KB  gpu<=${v.gpu_texture_mb_worst}MB  morphMem ${v.morph_memory_mb}MB`);
