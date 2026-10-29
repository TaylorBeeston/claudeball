"""Kokoro-82M offline, as close to the game's HD voices as Python gets: the same onnx-community v1.0 fp32 model and voice files the
browser loads (src/audio/neuralWorker.ts), run by kokoro-onnx on the CPU. Not identical: the browser phonemizes with kokoro-js, this
with espeak-ng, so a few words can come out differently.
"""
import time

import numpy as np

import a8  # noqa: F401  (sets the offline environment)
from a8 import ROOT

KDIR = ROOT / "kokoro"
SR = 24000
# the game's speed per role (cast.ts delivery.rate; the umpire's warm calls use 1) and its excited lines: rate 1.12, shift 1.06
SPEED = {"pbp": 1.04, "color": 1.0, "pa": 0.92, "ump": 1.0}
VOICE = {"pbp": "am_michael", "color": "bm_george", "pa": "am_onyx", "ump": "am_adam"}
EXCITED = {"rate": 1.12, "shift": 1.06}


def _voices_npz():
    out = KDIR / "voices.npz"
    if not out.exists():
        arrays = {p.stem: np.fromfile(p, dtype=np.float32).reshape(-1, 1, 256) for p in (KDIR / "voices").glob("*.bin")}
        np.savez(out, **arrays)
    return out


class Kokoro:
    def __init__(self):
        from kokoro_onnx import Kokoro as K

        self.k = K(str(KDIR / "onnx" / "model.onnx"), str(_voices_npz()))

    def say(self, text, voice, speed=1.0, shift=1.0):
        """`shift` is the game's playbackRate pitch lift (it asks Kokoro for speed rate/shift, then plays the buffer shift x faster)"""
        lang = "en-gb" if voice.startswith("b") else "en-us"
        t0 = time.perf_counter()
        audio, sr = self.k.create(text, voice=voice, speed=speed / shift, lang=lang)
        dt = time.perf_counter() - t0
        audio = np.asarray(audio, dtype=np.float32)
        if shift != 1.0:
            n = int(round(len(audio) / shift))
            audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
        dur = len(audio) / sr
        return audio, {"dur": dur, "gen_s": dt, "rtf": dt / max(dur, 1e-3)}

    def say_role(self, text, role, excited=False):
        if excited:
            return self.say(text, VOICE[role], EXCITED["rate"], EXCITED["shift"])
        return self.say(text, VOICE[role], SPEED[role])
