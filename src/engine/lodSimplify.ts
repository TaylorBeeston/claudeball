/**
 * Simplified geometry for small / distant players, made at load from the full-detail meshes themselves: only the index buffer is simplified
 * (meshoptimizer, borders locked so sleeve ends, necklines and seams stay closed); the vertex buffers, skin weights and morph targets are SHARED
 * with the full mesh. So the simplified mesh lives in exactly the full mesh's space: the old separately exported LOD file was quantized into its
 * own space (its dequantization folded into its own inverse bind matrices), which made the swapped players balloon.
 */
import { BufferAttribute, BufferGeometry, type Object3D, type Mesh } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

export interface LodOptions {
  /** fraction of the triangles to keep */
  ratio: number;
  /** meshes below this many triangles are not worth a second index buffer */
  minTriangles: number;
  /** relative error bound (of the mesh's extent) */
  error: number;
}

export const LOD_DEFAULTS: LodOptions = { ratio: 0.33, minTriangles: 600, error: 0.012 };

/** the simplified geometry of every large enough mesh of `scene`, by mesh name (first mesh of a name wins) */
export async function simplifyMeshes(scene: Object3D, o: LodOptions = LOD_DEFAULTS): Promise<Map<string, BufferGeometry>> {
  const out = new Map<string, BufferGeometry>();
  if (!MeshoptSimplifier.supported) return out;
  await MeshoptSimplifier.ready;
  const meshes: Mesh[] = [];
  scene.traverse((x) => {
    const m = x as Mesh;
    if (m.isMesh && m.name && !out.has(m.name)) meshes.push(m);
  });
  for (const m of meshes) {
    if (out.has(m.name)) continue;
    const g = m.geometry;
    const lod = simplifyGeometry(g, o);
    if (lod) out.set(m.name, lod);
  }
  return out;
}

/** a geometry sharing `g`'s attributes with a simplified index (null when `g` is small or did not simplify) */
export function simplifyGeometry(g: BufferGeometry, o: LodOptions = LOD_DEFAULTS): BufferGeometry | null {
  const pos = g.getAttribute('position');
  if (!pos) return null;
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  if (n / 3 < o.minTriangles) return null;
  // positions as floats (the files are quantized: normalized int16, read back through getX / getY / getZ)
  const P = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    P[i * 3] = pos.getX(i);
    P[i * 3 + 1] = pos.getY(i);
    P[i * 3 + 2] = pos.getZ(i);
  }
  const I = new Uint32Array(n);
  if (idx) for (let i = 0; i < n; i++) I[i] = idx.getX(i);
  else for (let i = 0; i < n; i++) I[i] = i;
  const target = Math.max(3, Math.floor((n * o.ratio) / 3) * 3);
  const [S] = MeshoptSimplifier.simplify(I, P, 3, target, o.error, ['LockBorder']);
  if (S.length >= n * 0.9) return null;
  const lod = new BufferGeometry();
  for (const [k, a] of Object.entries(g.attributes)) lod.setAttribute(k, a);
  Object.assign(lod.morphAttributes, g.morphAttributes);
  lod.morphTargetsRelative = g.morphTargetsRelative;
  lod.setIndex(new BufferAttribute(pos.count > 65535 ? S : new Uint16Array(S), 1));
  if (g.boundingSphere) lod.boundingSphere = g.boundingSphere.clone();
  if (g.boundingBox) lod.boundingBox = g.boundingBox.clone();
  lod.name = `${g.name || 'geo'}_lod`;
  return lod;
}
