#!/usr/bin/env bash
# npm run announcer:<prep|train|export> [-- extra args]: runs the stage inside the training venv.
#   CB_VOICE_DIR   root folder (default ~/claudeball-voice): venv, checkpoints, wavs/, work/ and voicepack/ live there
#   CB_DATA_DIR    folder with wavs/ + meta.json to train on (default $CB_VOICE_DIR; set it to a test folder to use placeholder audio)
#   CB_VOICEPACK   where export writes the voice pack (default $CB_DATA_DIR/voicepack)
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
  export) exec "$VOICE_DIR/venv/bin/python" export.py --work-dir "$DATA_DIR/work" --out "${CB_VOICEPACK:-$DATA_DIR/voicepack}" "$@" ;;
  clips)  exec "$VOICE_DIR/venv/bin/python" clips.py --work-dir "$DATA_DIR/work" --out "${CB_VOICEPACK:-$DATA_DIR/voicepack}" "$@" ;;
  *) echo "usage: run.sh prep|train|export|clips [args]"; exit 2 ;;
esac
