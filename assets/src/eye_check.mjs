// Eyeball visibility check on any (also meshopt / quantized) player GLB:  node eye_check.mjs <file.glb> [...]   (GT_MODULES as in perf_prep.mjs)
// Shoots rays along -Z (the model faces +Z) through a 12 x 12 mm grid around the left eye centre and reports whether the eyeball / cornea or the head skin is hit first.
import { createRequire } from 'node:module'; import path from 'node:path';
const require = createRequire(path.join(process.env.GT_MODULES || process.env.HOME + '/tools/gt', 'x.js'));
const { NodeIO } = require('@gltf-transform/core'); const { ALL_EXTENSIONS } = require('@gltf-transform/extensions'); const { dequantize } = require('@gltf-transform/functions'); const { MeshoptDecoder } = require('meshoptimizer');
await MeshoptDecoder.ready; const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
function tris(node) { const P = [], T = []; let base = 0; for (const p of node.getMesh().listPrimitives()) { const a = p.getAttribute('POSITION'); const n = a.getCount(); for (let i = 0; i < n; i++) P.push(a.getElement(i, [0, 0, 0]).slice()); const idx = p.getIndices(); for (let i = 0; i < idx.getCount(); i += 3) T.push([idx.getScalar(i) + base, idx.getScalar(i + 1) + base, idx.getScalar(i + 2) + base]); base += n; } return { P, T }; }
function top(m, x, y) { let best = -9; const { P, T } = m; for (const [a, b, c] of T) { const A = P[a], B = P[b], C = P[c]; const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(d) < 1e-12) continue; const l1 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, l3 = 1 - l1 - l2; if (l1 < 0 || l2 < 0 || l3 < 0) continue; const z = l1 * A[2] + l2 * B[2] + l3 * C[2]; if (z > best) best = z; } return best; }
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f); await doc.transform(dequantize()); const by = {}; doc.getRoot().listScenes()[0].traverse((n) => { if (n.getMesh()) by[n.getName()] = n; });
  if (!by.Eyes || !by.Head) { console.log(f, 'no Eyes / Head node'); continue; }
  const H = tris(by.Head), E = tris(by.Eyes), C = by.Eyes_Cornea ? tris(by.Eyes_Cornea) : null; let vis = 0, n = 0, dz = [];
  // centre of the left eyeball from its own vertices (positions of quantized files are in a shifted / scaled local space)
  let xs = E.P.map((p) => p[0]); const xmid = (Math.min(...xs) + Math.max(...xs)) / 2; let mn = [9, 9, 9], mx = [-9, -9, -9]; for (const p of E.P) if (p[0] > xmid) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); } const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { const x = cx + (i - 2) * 0.003, y = cy + (j - 2) * 0.003; const zh = top(H, x, y), ze = Math.max(top(E, x, y), C ? top(C, x, y) : -9); n++; if (ze > zh) { vis++; dz.push(ze - zh); } }
  console.log(path.basename(f), `eyeball in front of the head surface at ${vis}/${n} grid points (the rest is lid skin: the eye opening is ~16 x 8 mm)`);
}
