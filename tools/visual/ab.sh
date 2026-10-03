#!/usr/bin/env bash
# Before / after sheet: the same static cameras from an old build (BEFORE_DIST) and the current dist/, side by side.
#   tools/visual/ab.sh BEFORE_DIST OUT_DIR "look.ts args" (e.g. "--cams pitchcam,crowd0 --tod day,night")
set -e
before=$1; out=$2; shift 2
cd "$(dirname "$0")/../.."
npx tsx tools/visual/look.ts --dist "$before" --out "$out/before" $@ >/dev/null 2>&1
npx tsx tools/visual/look.ts --no-build --out "$out/after" $@ >/dev/null 2>&1
args=()
for f in "$out"/before/*.jpg; do n=$(basename "$f"); args+=(-label "before $n" "$f" -label "after $n" "$out/after/$n"); done
montage "${args[@]}" -pointsize 20 -geometry 960x540+4+4 -tile 2x -background '#1b1b1b' -fill white "$out/ab.jpg"
echo "$out/ab.jpg"
