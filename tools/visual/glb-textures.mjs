// Extract the textures whose name matches a regex from a GLB:  node tools/visual/glb-textures.mjs <file.glb> <regex> <outdir>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
for (const t of doc.getRoot().listTextures()) if (new RegExp(process.argv[3]).test(t.getName())) { const f = `${process.argv[4]}/${t.getName()}.${t.getMimeType().split('/')[1]}`; fs.writeFileSync(f, t.getImage()); console.log(f); }
