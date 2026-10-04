// Compare the contract of two player GLBs (node names, morph target names per mesh, clip names / durations, skin joints):  node tools/visual/glb-contract.mjs old.glb new.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const sum = async (f) => {
  const d = await io.read(f); const r = d.getRoot();
  const nodes = new Map(r.listNodes().map((n) => [n.getName(), n]));
  const morphs = {}; for (const [k, n] of nodes) { const m = n.getMesh(); if (m) morphs[k] = JSON.stringify(m.getExtras()?.targetNames ?? []) + '/' + m.listPrimitives().map((p) => p.listTargets().length).join(','); }
  const clips = Object.fromEntries(r.listAnimations().map((a) => [a.getName(), +Math.max(...a.listSamplers().map((s) => s.getInput().getMax([])[0])).toFixed(3)]));
  const extras = Object.fromEntries([...nodes].map(([k, n]) => [k, JSON.stringify(n.getExtras())]));
  return { nodes: new Set(nodes.keys()), morphs, clips, extras, joints: r.listSkins().map((s) => s.listJoints().map((j) => j.getName()).join(',')) };
};
const [a, b] = [await sum(process.argv[2]), await sum(process.argv[3])];
const diff = (x, y) => [...x].filter((k) => !y.has(k));
console.log('nodes removed', diff(a.nodes, b.nodes), 'added', diff(b.nodes, a.nodes));
const mk = Object.keys(a.morphs).filter((k) => a.morphs[k] !== b.morphs[k]); console.log('morph differences', mk.map((k) => `${k}: ${a.morphs[k]} -> ${b.morphs[k]}`));
const ck = Object.keys(a.clips).filter((k) => a.clips[k] !== b.clips[k]); console.log('clips', Object.keys(a.clips).length, '->', Object.keys(b.clips).length, 'changed', ck.slice(0, 10));
const ek = Object.keys(a.extras).filter((k) => b.extras[k] !== undefined && a.extras[k] !== b.extras[k]); console.log('extras changed', ek);
console.log('joints same', JSON.stringify(a.joints) === JSON.stringify(b.joints));
