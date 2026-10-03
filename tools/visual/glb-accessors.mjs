// Show how a GLB's meshes are encoded (component types, normalized, skin joint counts, texture transforms):  node tools/visual/glb-accessors.mjs <file.glb> [regex]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const re = new RegExp(process.argv[3] ?? '.');
console.log('extensions', doc.getRoot().listExtensionsUsed().map((e) => e.extensionName).join(' '));
console.log('skins', doc.getRoot().listSkins().map((s) => s.listJoints().length).join(','));
for (const n of doc.getRoot().listNodes()) {
  const m = n.getMesh(); if (!m || !re.test(n.getName())) continue;
  for (const p of m.listPrimitives()) {
    const a = (k) => { const x = p.getAttribute(k); return x ? `${x.getComponentType()}${x.getNormalized() ? 'n' : ''}` : '-'; };
    const tt = p.getMaterial()?.getBaseColorTextureInfo();
    const tr = tt?.getExtension('KHR_texture_transform');
    console.log(n.getName(), 'pos', a('POSITION'), 'nrm', a('NORMAL'), 'uv', a('TEXCOORD_0'), 'j', a('JOINTS_0'), 'skin', n.getSkin()?.listJoints().length, 'tt', tr ? JSON.stringify({ o: tr.getOffset(), s: tr.getScale() }) : '-', 'targets', p.listTargets().length);
  }
}
