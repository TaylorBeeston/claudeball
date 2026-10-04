#!/usr/bin/env bash
# KTX2 (Basis ETC1S) textures for the field, stadium, ball and bats, like the players (src/perf_all.sh): WebP decodes to RGBA8 on the GPU (field ~189 MB,
# stadium ~68 MB with mips); ETC1S transcodes to ETC2 / BC / ASTC (4-8x less memory; the engine's KTX2Loader falls back to RGBA when nothing fits).
# Run after field.py / stadium.py (replaces the optimize.sh WebP step for these two files). Needs KTX-Software `toktx` (~/tools/KTX-Software-*) and gltf-transform.
set -e
cd "$(dirname "$0")/.."
export PATH=$HOME/tools/KTX-Software-4.4.2-Linux-x86_64/bin:$PATH LD_LIBRARY_PATH=$HOME/tools/KTX-Software-4.4.2-Linux-x86_64/lib:$LD_LIBRARY_PATH
G="npx --yes @gltf-transform/cli"; T=$(mktemp -d "${TMPDIR:-/tmp}/cbktx.XXXXXX")
for f in field stadium ball bat bat_donut; do
  $G etc1s "$f.glb" "$T/$f.1.glb" --slots "baseColorTexture" --quality 160
  $G etc1s "$T/$f.1.glb" "$T/$f.2.glb" --slots "normalTexture" --quality 192 --compression 2
  $G etc1s "$T/$f.2.glb" "$T/$f.3.glb" --slots "*Texture" --quality 128       # what is left: the ORM maps (occlusion + metallicRoughness share one image)
  $G optimize "$T/$f.3.glb" "optimized/$f.glb" --compress meshopt --texture-compress false --simplify false --palette false --join false --flatten false
  ls -la "optimized/$f.glb"
done
rm -rf "$T"
