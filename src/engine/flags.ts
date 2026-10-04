/** Debug / A-B switches (URL flags) for the performance work: each turns one optimisation off so its cost and its look can be compared in the same build. */
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const FLAGS = {
  /** puppets are not frustum-culled (the old behaviour) */
  nocull: q.has('nocull'),
  /** puppets keep every part at any distance */
  nolod: q.has('nolod'),
  /** shadows and the GTAO prepass draw the puppets' own parts instead of the merged proxy */
  noproxy: q.has('noproxy'),
  /**
   * small / distant players keep the full-detail meshes (the simplified index buffers of lodSimplify.ts are not used). The old separately exported LOD
   * geometry made players balloon (its own quantization space); the in-engine simplification shares the full meshes' vertices and is on by default.
   */
  nolodgeo: q.has('nolodgeo'),
  nomatrix: q.has('nomatrix'),
  /** off-screen / tiny puppets are animated in full like everybody else */
  noskip: q.has('noskip'),
  /** the old crowd (the asset's box figures + placeholder capsules) instead of the billboard spectators (A/B) */
  oldcrowd: q.has('oldcrowd'),
};
