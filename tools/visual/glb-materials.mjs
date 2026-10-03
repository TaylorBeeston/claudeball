// List the material / alpha mode / base texture of the nodes matching a regex in a GLB:  node tools/visual/glb-materials.mjs <file.glb> [regex]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const re = new RegExp(process.argv[3] ?? '.');
for (const n of doc.getRoot().listNodes()) {
  if (!re.test(n.getName())) continue;
  const m = n.getMesh(); if (!m) continue;
  for (const p of m.listPrimitives()) {
    const mt = p.getMaterial();
    const pos = p.getAttribute('POSITION');
    console.log(n.getName(), 'verts', pos?.getCount(), 'mat', mt?.getName(), 'alpha', mt?.getAlphaMode(), mt?.getAlphaCutoff(), 'base', mt?.getBaseColorFactor().map(x=>+x.toFixed(2)), 'tex', mt?.getBaseColorTexture()?.getName() || mt?.getBaseColorTexture()?.getURI(), mt?.getBaseColorTexture()?.getMimeType(), 'ds', mt?.getDoubleSided());
  }
}
