/**
 * The build morphs at the wrist, measured in a player file: for each mesh with build_* morphs and each morph at 1, how far the vertices around
 * the wrist joint move (mean shift along the forearm toward the hand, the largest move) as the file has them and after the engine's fade
 * (src/engine/armMorphs.ts). The hands (Hand_*, gloves) have no build morphs, so anything the forearm's skin moves there is a gap or an overlap.
 *   npx tsx tools/jank/wristmorph.ts [player.glb] [--meshes Body_Skin,Undershirt,Gear_ArmSleeve_L,Gear_Wristband_L]
 */
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { fadeArmDelta } from '../../src/engine/armMorphs';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? path.join(ROOT, 'assets/optimized/players/player_base.glb');
const MESHES = opt('meshes', 'Body_Skin,Undershirt,Gear_ArmSleeve_L,Gear_ArmSleeve_R,Gear_Wristband_L,Gear_Wristband_R').split(',');

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(file);
/** a joint's bind position in the mesh's space: the inverse of its inverse bind matrix (rotation x uniform scale + translation) */
const jointAt = (e: number[]) => {
  const s2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  return [0, 1, 2].map((c) => -(e[c * 4] * e[12] + e[c * 4 + 1] * e[13] + e[c * 4 + 2] * e[14]) / s2);
};
const f1 = (v: number) => v.toFixed(1).padStart(5);
console.log(`${path.basename(file)}: vertices within 2 cm of the wrist joint (forearm side and hand side); mm`);
for (const n of doc.getRoot().listNodes()) {
  const m = n.getMesh(), sk = n.getSkin();
  if (!m || !sk || !MESHES.includes(n.getName())) continue;
  const joints = sk.listJoints().map((j) => j.getName().replace(/^mixamorig:?/, ''));
  const ibm = sk.getInverseBindMatrices()!;
  const jp = (nm: string) => {
    const e: number[] = [];
    ibm.getElement(joints.indexOf(nm), e);
    return jointAt(e);
  };
  const names: string[] = (m.getExtras() as { targetNames?: string[] })?.targetNames ?? [];
  for (const p of m.listPrimitives()) {
    const P = p.getAttribute('POSITION')!, J = p.getAttribute('JOINTS_0')!, W = p.getAttribute('WEIGHTS_0')!;
    for (const side of ['Left', 'Right']) {
      if (!joints.includes(`${side}Hand`)) continue;
      const fi = joints.indexOf(`${side}ForeArm`), hi = joints.indexOf(`${side}Hand`);
      const E = jp(`${side}ForeArm`), H = jp(`${side}Hand`);
      const ax = [H[0] - E[0], H[1] - E[1], H[2] - E[2]];
      const len = Math.hypot(ax[0], ax[1], ax[2]);
      ax.forEach((_, k) => (ax[k] /= len));
      p.listTargets().forEach((tg, ti) => {
        if (!/^build_/.test(names[ti] ?? '')) return;
        const D = tg.getAttribute('POSITION')!;
        const v: number[] = [], d: number[] = [], j: number[] = [], w: number[] = [], o = [0, 0, 0];
        let n0 = 0, axB = 0, axA = 0, maxB = 0, maxA = 0;
        for (let i = 0; i < P.getCount(); i++) {
          J.getElement(i, j);
          W.getElement(i, w);
          let fw = 0;
          for (let k = 0; k < 4; k++) if (j[k] === fi || j[k] === hi) fw += w[k];
          if (fw < 0.01) continue;
          P.getElement(i, v);
          const along = (v[0] - E[0]) * ax[0] + (v[1] - E[1]) * ax[1] + (v[2] - E[2]) * ax[2];
          if (Math.abs(along - len) > 0.02) continue;
          D.getElement(i, d);
          fadeArmDelta(d, along / len, ax, o);
          n0++;
          axB += d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
          axA += o[0] * ax[0] + o[1] * ax[1] + o[2] * ax[2];
          maxB = Math.max(maxB, Math.hypot(d[0], d[1], d[2]));
          maxA = Math.max(maxA, Math.hypot(o[0], o[1], o[2]));
        }
        if (!n0) return;
        console.log(`${n.getName().padEnd(18)} ${side.padEnd(5)} ${names[ti].padEnd(15)} n=${String(n0).padStart(4)}  along the arm: file ${f1((axB / n0) * 1000)} -> faded ${f1((axA / n0) * 1000)}   largest move: file ${f1(maxB * 1000)} -> faded ${f1(maxA * 1000)}`);
      });
    }
  }
}
