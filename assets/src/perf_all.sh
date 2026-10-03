#!/usr/bin/env bash
# Runtime optimisation of the player files (run from anywhere; needs node, npx @gltf-transform/cli, sharp + @gltf-transform/* in $GT_MODULES, KTX-Software `toktx`):
#   players/*.glb       -> optimized/players/*.glb   LOD0: textures <= 2K skin / 1K rest as KTX2 (ETC1S), meshopt geometry, single-sided closed materials, face merged into skin
#   players/lod1/*.glb  -> optimized/lod1/*.glb      LOD1: <= 512 px KTX2, no body normal / ORM, merged meshes (3-4 draw calls), no animations
# Setup used here (no root needed): KTX-Software 4.4.2 Linux tarball in ~/tools, `npm i @gltf-transform/core extensions functions meshoptimizer sharp` in ~/tools/gt.
set -e
cd "$(dirname "$0")/.."
export GT_MODULES=${GT_MODULES:-$HOME/tools/gt}
export PATH=$HOME/tools/KTX-Software-4.4.2-Linux-x86_64/bin:$PATH LD_LIBRARY_PATH=$HOME/tools/KTX-Software-4.4.2-Linux-x86_64/lib:$LD_LIBRARY_PATH
G="npx --yes @gltf-transform/cli"; T=$(mktemp -d)
one() {  # one <in> <out> <lod>
  in="$1"; out="$2"; lod="$3"; b=$(basename "$in" .glb); t="$T/$lod-$b"
  node src/perf_prep.mjs "$in" "$t.0.glb" "$lod" >/dev/null 2>&1
  $G etc1s "$t.0.glb" "$t.1.glb" --slots "baseColorTexture" --quality 128 >/dev/null 2>&1
  $G etc1s "$t.1.glb" "$t.2.glb" --slots "metallicRoughnessTexture" --quality 128 >/dev/null 2>&1
  $G etc1s "$t.2.glb" "$t.3.glb" --slots "normalTexture" --quality 192 --compression 2 >/dev/null 2>&1
  $G optimize "$t.3.glb" "$t.4.glb" --compress false --texture-compress false --simplify false --palette false --join false --flatten false --prune false >/dev/null 2>&1 || echo "FAIL $out"
  node src/perf_pack.mjs "$t.4.glb" "$out" >/dev/null 2>&1 || echo "FAIL pack $out"
  rm -f "$t".*.glb
}
export -f one; export G T GT_MODULES PATH LD_LIBRARY_PATH
mkdir -p optimized/players optimized/lod1
ls players/*.glb | xargs -P 4 -I{} bash -c 'one {} optimized/players/$(basename {}) 0'
[ -d players/lod1 ] && ls players/lod1/*.glb | xargs -P 4 -I{} bash -c 'one {} optimized/lod1/$(basename {}) 1'
mkdir -p optimized/players/textures; cp players/textures/*.webp optimized/players/textures/
node src/perf_budget.mjs . | tee /tmp/perf_budget.log
python3 src/gen_manifest.py . > /dev/null
echo PERF_DONE
