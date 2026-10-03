// Final geometry pack of a player GLB: meshopt compression with ONE scene-wide quantization volume.
//   (gltf-transform's default per-mesh volume gives every skinned mesh its own skin - 31 skeletons per player instead of 1, and local position spaces that cannot be compared:
//    e.g. Eyes and Head looked 3 cm apart in their raw, normalised coordinates.)   node perf_pack.mjs <in.glb> <out.glb>
import { createRequire } from 'node:module'; import path from 'node:path';
const require = createRequire(path.join(process.env.GT_MODULES || process.env.HOME + '/tools/gt', 'x.js'));
const { NodeIO } = require('@gltf-transform/core'); const { ALL_EXTENSIONS } = require('@gltf-transform/extensions'); const { meshopt } = require('@gltf-transform/functions'); const { MeshoptDecoder, MeshoptEncoder } = require('meshoptimizer');
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(process.argv[2]);
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: 'scene' }));
await io.write(process.argv[3], doc);
