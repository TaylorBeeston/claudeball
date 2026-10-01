#!/usr/bin/env bash
# npm run announcer:pilot: the whole chain on the PILOT set (few epochs), to prove the plumbing and give a rough, listenable voice.
#   prep (pilot lines only) -> train (60 epochs, samples every 20) -> export (ONNX + int8/fp16 + voice.json) -> browser smoke test
# Uses your recordings in $CB_DATA_DIR (default ~/claudeball-voice). Takes about 10-25 minutes on an RTX 4090 laptop.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="bash $HERE/run.sh"
$RUN prep --pilot
$RUN train --pilot --run-name pilot
$RUN export --run-name pilot
cd "$HERE/../../.." && npx tsx tools/announcer/train/web_test.ts
