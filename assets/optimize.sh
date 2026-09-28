#!/usr/bin/env bash
# Produces assets/optimized/*.glb: meshopt-compressed geometry + WebP textures via gltf-transform (no KTX2: `toktx` not installed).
# Needs: npx @gltf-transform/cli  (or a local install). Loader must call setMeshoptDecoder(MeshoptDecoder).
set -e
cd "$(dirname "$0")"; mkdir -p optimized optimized/players
GT="${GLTF_TRANSFORM:-npx --yes @gltf-transform/cli}"
for f in ball bat field stadium players/*; do
  f="${f%.glb}"; [ -f "$f.glb" ] || continue
  $GT optimize "$f.glb" "optimized/$f.glb" --compress meshopt --texture-compress webp --simplify false --palette false --join false --flatten false
done
# ---- LODs
mkdir -p optimized/lod1
python3 src/make_lods.py stadium.glb /tmp/stadium_lod1_raw.glb
$GT prune /tmp/stadium_lod1_raw.glb /tmp/stadium_lod1_pruned.glb
$GT optimize /tmp/stadium_lod1_pruned.glb optimized/lod1/stadium.glb --compress meshopt --texture-compress webp --simplify true --simplify-ratio 0.5 --simplify-error 0.02 --palette false --join false --flatten false
for f in players/*.glb; do
  $GT optimize "$f" "optimized/lod1/$(basename "$f")" --compress meshopt --texture-compress webp --texture-size 512 --simplify true --simplify-ratio 0.3 --simplify-error 0.02 --palette false --join false --flatten false
done
