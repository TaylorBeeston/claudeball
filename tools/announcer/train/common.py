"""Shared helpers for the announcer training pipeline. Runs inside the training venv (see setup.sh)."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT_DIR = REPO / "tools/announcer/script/data"
VOICE_DIR = Path(os.environ.get("CB_VOICE_DIR", Path.home() / "claudeball-voice")).expanduser()
PIPER_DIR = VOICE_DIR / "vendor/piper1-gpl"
CKPT_DIR = VOICE_DIR / "checkpoints"

STYLE_SPEAKER = {"calm": 0, "building": 0, "crisp": 0, "deflated": 0, "excited": 1, "peak": 1, "deadpan": 2}
SPEAKER_NAMES = ["playbyplay", "hype", "color"]
SAMPLE_RATE = 22050
BOS, EOS, PAD, SPACE = "^", "$", "_", " "

# base checkpoints on huggingface.co/datasets/rhasspy/piper-checkpoints: license of the *training data* matters for a derivative
BASES = {
    # 904 speakers, LibriTTS-R, CC BY 4.0 (attribution required): multi-speaker, so style speakers 0/1/2 map onto existing embedding rows
    "libritts_r": {"path": "en/en_US/libritts_r/medium/best.ckpt", "license": "CC BY 4.0 (LibriTTS-R)", "speakers": 904},
    # 1 speaker, LJSpeech, public domain: single-voice fallback
    "ljspeech": {"path": "en/en_US/ljspeech/medium/lj-med_1000.ckpt", "license": "public domain (LJ Speech)", "speakers": 1},
}


def log(*a):
    print(*a, flush=True)


def load_script() -> list[dict]:
    return [json.loads(l) for l in (SCRIPT_DIR / "all.jsonl").read_text().splitlines() if l.strip()]


def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


# ---------------------------------------------------------------- words (mirror of src/audio/voice/phonemize.ts tokenize)
_TOKEN = re.compile(r"[a-z]+(?:'[a-z]+)*|[,.;:!?]")


def tokenize(text: str) -> list[tuple[str, str]]:
    """Normalised line -> [('w', word) | ('p', punctuation)]. Must stay identical to `tokenize` in src/audio/voice/phonemize.ts."""
    t = text.lower().replace("’", "'").replace("‘", "'").replace("...", ",").replace("…", ",").replace("-", " ")
    return [("w", m) if m[0].isalpha() else ("p", m) for m in _TOKEN.findall(t)]


def assemble_ids(tokens: list[tuple[str, str]], words: dict[str, list[int]], idmap: dict[str, list[int]]) -> list[int] | None:
    """Tokens -> Piper phoneme ids using the lexicon. None when a word is missing (the caller falls back or skips the line).
    Layout: BOS PAD (phoneme PAD)* EOS, with a space token between words and after , ; : so it looks like espeak's output.
    Must stay identical to `assembleIds` in src/audio/voice/phonemize.ts."""
    ids: list[int] = list(idmap[BOS]) + list(idmap[PAD])
    first = True
    for kind, val in tokens:
        if kind == "w":
            if val not in words:
                return None
            if not first:
                ids += list(idmap[SPACE]) + list(idmap[PAD])
            ids += _with_pad(words[val], idmap)
        else:
            if val not in idmap:
                continue
            ids += list(idmap[val]) + list(idmap[PAD])
        first = False
    ids += list(idmap[EOS])
    return ids


def _with_pad(word_ids: list[int], idmap: dict[str, list[int]]) -> list[int]:
    out: list[int] = []
    for i in word_ids:
        out.append(i)
        out += list(idmap[PAD])
    return out


def num_to_words(n: int) -> str:
    ones = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
    tens = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
    if n < 20:
        return ones[n]
    if n < 100:
        return tens[n // 10] + ("" if n % 10 == 0 else " " + ones[n % 10])
    if n < 1000:
        return ones[n // 100] + " hundred" + ("" if n % 100 == 0 else " and " + num_to_words(n % 100))
    return num_to_words(n // 1000) + " thousand" + ("" if n % 1000 == 0 else " " + num_to_words(n % 1000))


def comparable(text: str) -> list[str]:
    """Words for the Whisper comparison: lower case, digits spelled, hyphens split, punctuation dropped."""
    t = text.lower().replace("-", " ")
    t = re.sub(r"\d+", lambda m: " " + num_to_words(int(m.group())) + " ", t)
    t = t.replace("%", " percent ").replace("&", " and ")
    return re.findall(r"[a-z']+", t.replace("’", "'"))


def wer(ref: list[str], hyp: list[str]) -> float:
    d = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(hyp) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (ref[i - 1] != hyp[j - 1]))
            prev = cur
    return d[len(hyp)] / max(1, len(ref))


def ensure_venv():
    if sys.prefix == sys.base_prefix:
        sys.exit("Run this inside the training venv:  source ~/claudeball-voice/venv/bin/activate   (or use npm run announcer:<stage>)")


def load_whisper(name: str, device: str = "auto"):
    """faster-whisper on the GPU when the CUDA libraries line up, else int8 on the CPU. The load succeeds even when cuBLAS/cuDNN are missing,
    so a one-second warm-up transcription decides."""
    import numpy as np
    from faster_whisper import WhisperModel

    attempts = [("cuda", "float16"), ("cpu", "int8")] if device == "auto" else [(device, "float16" if device == "cuda" else "int8")]
    for dev, ct in attempts:
        try:
            m = WhisperModel(name, device=dev, compute_type=ct)
            list(m.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
            log(f"whisper {name} on {dev}/{ct}")
            return m
        except Exception as e:  # missing libcublas / cuDNN version mismatch are common
            log(f"whisper on {dev} failed ({str(e).splitlines()[0][:90]}); trying next")
    raise SystemExit("could not load faster-whisper")


