"""Synthetic stand-in recordings for testing the pipeline WITHOUT your voice.

    python placeholder.py --data-dir ~/claudeball-voice/_placeholder [--tier pilot|core] [--limit N]

Speaks each script line with Piper's public-domain LJSpeech voice (rate varied by style) and writes `wavs/<id>.wav` + `meta.json` in the same
layout the recorder uses. Never point this at your real recordings folder: use a separate --data-dir. Only for plumbing tests.
"""
from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

from common import CKPT_DIR, VOICE_DIR, ensure_venv, load_script, log

# style -> (length_scale, gain). Smaller length_scale = faster.
STYLE_PARAMS = {"calm": (1.0, 0.5), "building": (0.95, 0.6), "excited": (0.85, 0.8), "peak": (0.8, 0.95), "deadpan": (1.1, 0.45), "crisp": (1.0, 0.6), "deflated": (1.2, 0.4)}
URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx"


def fetch_voice() -> Path:
    d = CKPT_DIR / "placeholder-voice"
    d.mkdir(parents=True, exist_ok=True)
    onnx = d / "en_US-ljspeech-medium.onnx"
    if not onnx.exists():
        import urllib.request

        log("downloading the public-domain LJSpeech Piper voice for placeholders")
        urllib.request.urlretrieve(URL, onnx)
        urllib.request.urlretrieve(URL + ".json", str(onnx) + ".json")
    return onnx


def main():
    ensure_venv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--tier", default="pilot", choices=["pilot", "core", "extended", "all"])
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    if a.data_dir.resolve() == VOICE_DIR.resolve():
        raise SystemExit("refusing to write placeholder audio into your real recordings folder; pass another --data-dir")
    from piper import PiperVoice, SynthesisConfig

    voice = PiperVoice.load(str(fetch_voice()))
    (a.data_dir / "wavs").mkdir(parents=True, exist_ok=True)
    lines = [l for l in load_script() if a.tier == "all" or l["tier"] == a.tier][: a.limit]
    takes = {}
    for i, l in enumerate(lines, 1):
        ls, gain = STYLE_PARAMS[l["style"]]
        chunks = [c.audio_float_array for c in voice.synthesize(l["normalized"], SynthesisConfig(length_scale=ls, noise_scale=0.6))]
        x = np.concatenate([np.zeros(int(0.2 * voice.config.sample_rate), np.float32), *chunks, np.zeros(int(0.2 * voice.config.sample_rate), np.float32)])
        x = x / max(1e-6, np.abs(x).max()) * gain
        with wave.open(str(a.data_dir / "wavs" / f"{l['id']}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(voice.config.sample_rate)
            w.writeframes((x * 32767).astype(np.int16).tobytes())
        takes[l["id"]] = {"status": "done", "qc": {"status": "ok", "checks": []}, "placeholder": True}
        if i % 25 == 0:
            log(f"  {i}/{len(lines)}")
    (a.data_dir / "meta.json").write_text(json.dumps({"takes": takes, "config": {"rate": voice.config.sample_rate, "bits": 16}}))
    log(f"wrote {len(lines)} placeholder takes to {a.data_dir}")


if __name__ == "__main__":
    main()
