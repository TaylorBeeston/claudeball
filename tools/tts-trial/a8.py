"""Audio8-TTS loader and one-line synthesis, shared by the trial scripts (run with ~/claudeball-tts/venv/bin/python).

Everything stays offline and inside ~/claudeball-tts: the model is read from the pinned local snapshot, the Hub is never asked
(HF_HUB_OFFLINE), and transformers' copy of the remote code goes to ~/claudeball-tts/hf-modules instead of ~/.cache.
"""
import os
import time
from pathlib import Path

ROOT = Path(os.environ.get("CB_TTS_DIR", Path.home() / "claudeball-tts"))
MODEL = ROOT / "model"
REVISION = "1e857568bfd4f02931aca3988ee773a44d2d26d3"
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_MODULES_CACHE", str(ROOT / "hf-modules"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import AutoModel, AutoProcessor  # noqa: E402

SR = 44100
FPS = SR / 2048


class Audio8:
    def __init__(self, device="cuda"):
        self.device = device
        self.processor = AutoProcessor.from_pretrained(str(MODEL), trust_remote_code=True, local_files_only=True)
        self.model = AutoModel.from_pretrained(str(MODEL), trust_remote_code=True, local_files_only=True, dtype=torch.bfloat16).eval().to(device)
        self.model.load_codec(device=device)
        self._ref_cache = {}

    def ref_codes(self, wav_path):
        """encode a reference clip once (otherwise every cloned line runs the codec encoder again)"""
        key = str(wav_path)
        if key not in self._ref_cache:
            feats = self.processor(text=["x"], reference_audio=[key], reference_text=["x"], return_tensors="pt")
            codes, lengths = self.model.encode_audio(feats["reference_audio_values"].to(self.device), feats["reference_audio_lengths"].to(self.device))
            self._ref_cache[key] = codes[0, :, : int(lengths[0])].cpu()
        return self._ref_cache[key]

    def say(self, text, ref=None, seed=None, **kw):
        """one line -> (float32 mono at 44.1 kHz, stats); ref = (wav path, exact transcript) or None"""
        audio, stats = self.say_batch([text], ref, seed, **kw)
        return audio[0], stats[0]

    def say_batch(self, texts, ref=None, seed=None, temperature=0.8, top_p=0.95, top_k=50, max_new_tokens=512):
        """several lines in one generate call (left-padded; one shared reference) -> ([audio], [stats]); timing is for the whole batch"""
        n = len(texts)
        if ref is None:
            feats = self.processor(text=list(texts), return_tensors="pt")
        else:
            codes = self.ref_codes(ref[0]).numpy()
            feats = self.processor(text=list(texts), reference_text=[ref[1]] * n, reference_codes=[codes] * n, return_tensors="pt")
        feats = {k: v.to(self.device) for k, v in feats.items()}
        gen = None
        if seed is not None:
            gen = torch.Generator(device=self.device).manual_seed(seed)
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        out = self.model.generate(**feats, max_new_tokens=max_new_tokens, temperature=temperature, top_p=top_p, top_k=top_k, do_sample=True, return_dict_in_generate=True, generator=gen)
        torch.cuda.synchronize()
        t1 = time.perf_counter()
        wav, lengths = self.model.decode_audio(out.codes)
        torch.cuda.synchronize()
        t2 = time.perf_counter()
        audios, stats = [], []
        total = 0.0
        for i in range(n):
            audio = wav[i, : int(lengths[i])].float().cpu().numpy().astype(np.float32)
            audios.append(audio)
            total += len(audio) / SR
        for i, audio in enumerate(audios):
            dur = len(audio) / SR
            frames = int(out.code_lengths[i])
            stats.append({
                "dur": dur,
                "frames": frames,
                "finished": bool(out.finished[i]),
                "hit_cap": frames >= max_new_tokens - 1,
                "gen_s": t1 - t0,
                "dec_s": t2 - t1,
                "batch": n,
                # one line alone: its own RTF; in a batch: the batch's wall time over all the audio it made (throughput)
                "rtf": (t2 - t0) / max(total, 1e-3),
            })
        return audios, stats
