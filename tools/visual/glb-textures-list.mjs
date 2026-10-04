// List the textures of a GLB with size, format and an RGBA8 + mips GPU estimate:  node tools/visual/glb-textures-list.mjs <file.glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
let file = 0, gpu = 0;
for (const t of doc.getRoot().listTextures()) {
  const s = t.getSize() ?? [0, 0]; const b = t.getImage()?.byteLength ?? 0; const g = s[0] * s[1] * 4 * 1.33; file += b; gpu += g;
  console.log(t.getName().padEnd(28), t.getMimeType().padEnd(12), `${s[0]}x${s[1]}`.padEnd(11), `${(b / 1024).toFixed(0)} KB`.padStart(9), `gpu ${(g / 1048576).toFixed(1)} MB`);
}
console.log(`total file ${(file / 1048576).toFixed(1)} MB, RGBA8 gpu ${(gpu / 1048576).toFixed(0)} MB`);
