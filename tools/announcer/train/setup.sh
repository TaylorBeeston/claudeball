#!/usr/bin/env bash
# One-time setup of the training environment. No sudo: everything lives under $CB_VOICE_DIR (default ~/claudeball-voice).
#   venv/            Python 3.11/3.12 virtualenv (isolated; nothing is installed system-wide)
#   vendor/piper1-gpl  Piper's training code (GPL-3.0: used as an external tool, not copied into this MIT repo)
#   checkpoints/     base checkpoints from huggingface.co/datasets/rhasspy/piper-checkpoints
# Needs on PATH: git, gcc/g++, cmake, ninja, espeak-ng, ffmpeg, uv (all present on this machine).
set -euo pipefail
VOICE_DIR="${CB_VOICE_DIR:-$HOME/claudeball-voice}"
PIPER_REPO="https://github.com/OHF-Voice/piper1-gpl.git"
PIPER_REF="${PIPER_REF:-main}"
PY="${CB_PYTHON:-$(command -v python3.12 || command -v python3.11 || true)}"
[ -n "$PY" ] || { echo "need python3.11 or 3.12 (piper's training code supports 3.9-3.13; 3.14 has no torch wheels yet). Try: uv python install 3.12"; exit 1; }
mkdir -p "$VOICE_DIR"/{vendor,checkpoints,wavs,dataset,runs}
cd "$VOICE_DIR"

[ -d venv ] || uv venv --python "$PY" venv
# shellcheck disable=SC1091
source venv/bin/activate

if [ ! -d vendor/piper1-gpl ]; then git clone --depth 50 "$PIPER_REPO" vendor/piper1-gpl; fi
(cd vendor/piper1-gpl && git fetch -q origin "$PIPER_REF" && git checkout -q "$PIPER_REF" && git rev-parse HEAD > ../piper1-gpl.commit)

uv pip install -q torch  # the default wheel bundles its own CUDA runtime; the NVIDIA driver is all that is needed
uv pip install -q -e "vendor/piper1-gpl[train]" scikit-build cmake ninja
(cd vendor/piper1-gpl && ./build_monotonic_align.sh >/dev/null && python3 setup.py build_ext --inplace >/dev/null)
uv pip install -q torchaudio faster-whisper onnxruntime soundfile pyloudnorm numpy scipy jiwer huggingface_hub onnxconverter-common

python - <<'PY'
import torch, sys
print("python", sys.version.split()[0], "| torch", torch.__version__, "| cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-")
PY
echo "training environment ready in $VOICE_DIR/venv"
