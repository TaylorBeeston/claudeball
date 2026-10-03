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
   * small / distant players keep the full-detail meshes. OFF BY DEFAULT since 2026-10-03: the simplified geometry made players balloon into 'marshmallows'
   * (see tools/perf/FINDINGS.md); `?lodgeo=1` turns the experiment back on while the cause is being fixed.
   */
  nolodgeo: !q.has('lodgeo') || q.has('nolodgeo'),
  nomatrix: q.has('nomatrix'),
  /** off-screen / tiny puppets are animated in full like everybody else */
  noskip: q.has('noskip'),
};
