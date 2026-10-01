#!/usr/bin/env bash
# npm run announcer:<prep|train|export> [-- extra args]: runs the stage inside the training venv.
#   CB_VOICE_DIR   root folder (default ~/claudeball-voice): venv, checkpoints, wavs/, work/ and voicepack/ live there
#   CB_DATA_DIR    folder with wavs/ + meta.json to train on (default $CB_VOICE_DIR; set it to a test folder to use placeholder audio)
set -euo pipefail
VOICE_DIR="${CB_VOICE_DIR:-$HOME/claudeball-voice}"
DATA_DIR="${CB_DATA_DIR:-$VOICE_DIR}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -x "$VOICE_DIR/venv/bin/python" ] || { echo "training environment missing: run  npm run announcer:setup  first"; exit 1; }
stage="$1"; shift || true
cd "$HERE"
case "$stage" in
  prep)   exec "$VOICE_DIR/venv/bin/python" prep.py --data-dir "$DATA_DIR" "$@" ;;
  train)  exec "$VOICE_DIR/venv/bin/python" train.py --work-dir "$DATA_DIR/work" "$@" ;;
  export) exec "$VOICE_DIR/venv/bin/python" export.py --work-dir "$DATA_DIR/work" "$@" ;;
  *) echo "usage: run.sh prep|train|export [args]"; exit 2 ;;
esac
