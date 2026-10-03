/**
 * Feathered facial hair. The beard / mustache / goatee are shells cut from the head mesh with an opaque fibre texture, so their cut edge is a hard
 * line: a mustache read as a black bar. Each shell gets a per-vertex `cbEdge` attribute (metres from the shell's open boundary, measured along
 * the surface in the bind pose) and the `CB_FEATHER` shader path fades the alpha over the last few millimetres with a strand-like breakup
 * (alpha-to-coverage under MSAA, a cutoff without), so the hair thins out into the skin. Pure maths here; the material side is in `gltfCharacter.ts`.
 */
import { BufferAttribute, ShaderChunk, type BufferGeometry } from 'three';

/** facial-hair nodes that are shells with a cut edge */
export const FEATHERED = /^(Gear_Mustache|Gear_Goatee|Gear_Beard_Full)$/;

/**
 * Distance (along the mesh) from every vertex to the nearest boundary edge. Vertices at the same position (uv seams) are welded first, so a seam
 * is not mistaken for the edge. `positions` xyz triples, `index` triangle list.
 */
export function boundaryDistance(positions: ArrayLike<number>, index: ArrayLike<number>, weldEps = 1e-4): Float32Array {
  const n = positions.length / 3;
  // weld
  const key = new Map<string, number>();
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(positions[i * 3] / weldEps)},${Math.round(positions[i * 3 + 1] / weldEps)},${Math.round(positions[i * 3 + 2] / weldEps)}`;
    let r = key.get(k);
    if (r === undefined) key.set(k, (r = i));
    rep[i] = r;
  }
  // edges of the welded mesh and how many triangles use each
  const edgeCount = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t + 2 < index.length; t += 3) {
    const v = [rep[index[t]], rep[index[t + 1]], rep[index[t + 2]]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      if (a === b) continue;
      const k = ek(a, b);
      const c = edgeCount.get(k) ?? 0;
      edgeCount.set(k, c + 1);
      if (!c) {
        adj[a].push(b);
        adj[b].push(a);
      }
    }
  }
  const dist = new Float64Array(n).fill(Infinity);
  const queue: number[] = [];
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    const a = Math.floor(k / n), b = k % n;
    dist[a] = dist[b] = 0;
    queue.push(a, b);
  }
  // Dijkstra with a plain array as the frontier (the shells have a few thousand vertices)
  const len = (a: number, b: number) => Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
  const done = new Uint8Array(n);
  let frontier = [...new Set(queue)];
  while (frontier.length) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (dist[frontier[i]] < dist[frontier[bi]]) bi = i;
    const u = frontier[bi];
    frontier[bi] = frontier[frontier.length - 1];
    frontier.pop();
    if (done[u]) continue;
    done[u] = 1;
    for (const w of adj[u]) {
      const d = dist[u] + len(u, w);
      if (d < dist[w]) {
        dist[w] = d;
        frontier.push(w);
      }
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(dist[rep[i]]) ? dist[rep[i]] : 1;
  return out;
}

/**
 * Add `cbEdge` to a shell's geometry (once; shared by every clone of the template). `unit` = metres per geometry unit: the optimized files are
 * quantized, so their positions are in a normalized range and the node / bind matrix carries the scale back to metres.
 */
export function addEdgeAttribute(g: BufferGeometry, unit = 1): void {
  if (g.getAttribute('cbEdge')) return;
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  if (!pos || !idx) return;
  const p = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p[i * 3] = pos.getX(i);
    p[i * 3 + 1] = pos.getY(i);
    p[i * 3 + 2] = pos.getZ(i);
  }
  const d = boundaryDistance(p, idx.array, 1e-4 / unit);
  for (let i = 0; i < d.length; i++) d[i] *= unit;
  g.setAttribute('cbEdge', new BufferAttribute(d, 1));
}

let installed = false;
/** the `CB_FEATHER` shader path (a material opts in with `defines.CB_FEATHER = '<width in metres>'`) */
export function installFeather() {
  if (installed) return;
  installed = true;
  ShaderChunk.uv_pars_vertex = ShaderChunk.uv_pars_vertex + '\n#ifdef CB_FEATHER\nattribute float cbEdge;\nvarying float vCbEdge;\n#endif\n';
  ShaderChunk.uv_vertex = ShaderChunk.uv_vertex + '\n#ifdef CB_FEATHER\nvCbEdge = cbEdge;\n#endif\n';
  ShaderChunk.uv_pars_fragment = ShaderChunk.uv_pars_fragment + '\n#ifdef CB_FEATHER\nvarying float vCbEdge;\n#endif\n';
  ShaderChunk.alphamap_fragment =
    ShaderChunk.alphamap_fragment +
    `
#ifdef CB_FEATHER
  {
    // strands: thin streaks across the shell (noise in u, slow in v), so the edge breaks up into hairs instead of fading like a decal
    #ifdef USE_MAP
      vec2 cbS = vMapUv * vec2( 420.0, 26.0 );
    #else
      vec2 cbS = gl_FragCoord.xy * vec2( 0.9, 0.12 );
    #endif
    float cbN = fract( sin( dot( floor( cbS ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    float cbK = smoothstep( 0.0, CB_FEATHER, vCbEdge + ( cbN - 0.5 ) * CB_FEATHER * 0.9 );
    diffuseColor.a *= cbK;
  }
#endif
`;
}
