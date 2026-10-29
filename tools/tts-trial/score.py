"""Score every rendered take: Whisper large-v3-turbo transcript -> WER against the script (both through Whisper's English normaliser),
loudness (LUFS), duration, failure flags, and speaker similarity (WavLM x-vector cosine) to the reference clip and to Kokoro's take of
the same line. Writes ~/claudeball-tts/out/trial/metrics.json.

    python score.py [engine ...]     (default: every engine folder)
"""
import json
import re
import sys

import jiwer
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
import torch
import torchaudio.functional as AF

import a8  # noqa: F401  (offline environment)
from a8 import ROOT
from render import OUT

DEV = "cuda"
EQUIV = [("double header", "doubleheader"), ("241", "2 for one"), ("24 one", "2 for one"), ("grown man is", "grown man"), ("grown man s", "grown man")]


def load16(path):
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = torch.from_numpy(x.mean(axis=1))
    return AF.resample(x, sr, 16000).numpy() if sr != 16000 else x.numpy()


class Scorer:
    def __init__(self):
        from transformers import AutoFeatureExtractor, WavLMForXVector, pipeline
        from transformers.models.whisper.english_normalizer import EnglishTextNormalizer

        self.asr = pipeline("automatic-speech-recognition", model=str(ROOT / "whisper"), torch_dtype=torch.float16, device=DEV)
        self.norm_ = EnglishTextNormalizer(json.loads((ROOT / "whisper" / "normalizer.json").read_text()))
        self.fe = AutoFeatureExtractor.from_pretrained(str(ROOT / "wavlm-sv"))
        self.sv = WavLMForXVector.from_pretrained(str(ROOT / "wavlm-sv")).eval().to(DEV)
        self._emb = {}

    def norm(self, s):
        # "5-3" and "five-three" normalise to "5 3" and "53": join digit groups so both count as the same words
        s = re.sub(r"(?<=\d) (?=\d)", "", self.norm_(s))
        # how Whisper spells what was said correctly ("three and oh" -> "3-0", "two for one" -> "2-4-1"): not a TTS error
        s = re.sub(r"\b(\d) and (\d)\b", r"\1\2", s)
        for a, b in EQUIV:
            s = re.sub(rf"\b{a}\b", b, s)
        return " ".join(s.split())

    def transcribe(self, paths):
        out = self.asr([load16(p) for p in paths], batch_size=16, generate_kwargs={"language": "en", "task": "transcribe"})
        return [o["text"].strip() for o in out]

    @torch.inference_mode()
    def emb(self, path):
        k = str(path)
        if k not in self._emb:
            x = load16(path)
            if len(x) < 16000:  # the x-vector head needs about a second ("Safe!" is shorter): pad with silence
                x = np.concatenate([x, np.zeros(16000 - len(x), np.float32)])
            f = self.fe(x, sampling_rate=16000, return_tensors="pt", padding=True).to(DEV)
            e = self.sv(**f).embeddings[0]
            self._emb[k] = torch.nn.functional.normalize(e, dim=-1).cpu()
        return self._emb[k]

    def sim(self, a, b):
        return float((self.emb(a) * self.emb(b)).sum())


def lufs(path):
    x, sr = sf.read(path, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    if len(x) < int(0.5 * sr):  # the meter needs 400 ms blocks; very short calls are padded with silence
        x = np.concatenate([x, np.zeros(int(0.5 * sr) - len(x), np.float32)])
    return float(pyln.Meter(sr).integrated_loudness(x))


def errors(ref, hyp):
    """WER and what kind of errors, including whether the take lost its last words (an early stop)"""
    if not hyp:
        return {"wer": 1.0, "sub": 0, "del": len(ref.split()), "ins": 0, "tail_del": True}
    o = jiwer.process_words(ref, hyp)
    last = o.alignments[0][-1] if o.alignments[0] else None
    return {"wer": o.wer, "sub": o.substitutions, "del": o.deletions, "ins": o.insertions, "tail_del": bool(last and last.type == "delete")}


def ref_for(engine, rec):
    from render import LINES

    role = LINES.get(rec["id"], {}).get("role", "pbp")
    v = rec.get("variant")
    kind = {"kokoro": "kokoro", "a8-kref": "kokoro", "a8-batch": "kokoro", "a8-self": "self", "a8-taylor": "taylor", "a8-emotion": "excited" if v == "exref" else "kokoro"}.get(engine)
    if engine == "a8-batch":
        role = "pbp"  # the batch bench uses Lyle's reference for every line
    if kind is None:
        return None
    p = OUT / "refs" / f"{kind}-{role}.wav"
    return p if p.exists() else None


def main():
    engines = sys.argv[1:] or sorted(p.name for p in OUT.iterdir() if (p / "meta.jsonl").exists())
    s = Scorer()
    path = OUT / "metrics.json"
    allm = json.loads(path.read_text()) if path.exists() else {}
    kdur = {}
    kmeta = OUT / "kokoro" / "meta.jsonl"
    if kmeta.exists():
        for line in open(kmeta):
            r = json.loads(line)
            kdur[(r["id"], r.get("variant") == "spelled")] = r["dur"]
    for engine in engines:
        d = OUT / engine
        recs = {}
        for line in open(d / "meta.jsonl"):
            r = json.loads(line)
            recs[r["file"]] = r  # a re-run overwrites: the last line per file wins
        recs = list(recs.values())
        hyps = s.transcribe([d / r["file"] for r in recs])
        rows = []
        for r, hyp in zip(recs, hyps):
            ref_n, hyp_n = s.norm(r["text"]), s.norm(hyp)
            e = errors(ref_n, hyp_n)
            row = {**r, "engine": engine, "hyp": hyp, "lufs": lufs(d / r["file"]), **e}
            kd = kdur.get((r["id"], r.get("variant") == "spelled")) or kdur.get((r["id"], False))
            if kd and engine != "kokoro":
                row["dur_vs_kokoro"] = r["dur"] / kd
            flags = []
            if r.get("hit_cap") or r.get("finished") is False:
                flags.append("no-stop")
            if e["tail_del"] or (kd and r["dur"] < 0.7 * kd and e["del"] > 0):
                flags.append("early-stop")
            elif e["del"] > 0:
                flags.append("dropped word")
            if e["ins"] >= 2 or (kd and r["dur"] > 1.6 * kd and e["ins"] > 0):
                flags.append("repeat/extra")
            if e["sub"] >= 1:
                flags.append("misread")
            row["flags"] = flags
            ref = ref_for(engine, r)
            if ref is not None:
                row["sim_ref"] = s.sim(d / r["file"], ref)
            kp = OUT / "kokoro" / (f"{r['id']}--spelled.wav" if r.get("variant") == "spelled" else f"{r['id']}.wav")
            if engine != "kokoro" and kp.exists():
                row["sim_kokoro"] = s.sim(d / r["file"], kp)
            rows.append(row)
        allm[engine] = rows
        bad = [x for x in rows if x["flags"]]
        print(f"{engine}: {len(rows)} takes, mean WER {np.mean([x['wer'] for x in rows]):.3f}, flagged {len(bad)}", flush=True)
    # self-similarity of the no-reference voice: same seed on different lines, and different seeds on the same line
    if "a8-noref" in allm:
        rows = [x for x in allm["a8-noref"] if not x.get("variant")]
        d = OUT / "a8-noref"
        same_seed, same_line = [], []
        for i, a in enumerate(rows):
            for b in rows[i + 1 :]:
                v = s.sim(d / a["file"], d / b["file"])
                if a["seed"] == b["seed"] and a["id"] != b["id"]:
                    same_seed.append(v)
                if a["id"] == b["id"] and a["seed"] != b["seed"]:
                    same_line.append(v)
        allm["_noref_similarity"] = {"same_seed_diff_line": float(np.mean(same_seed)), "same_line_diff_seed": float(np.mean(same_line))}
        print(allm["_noref_similarity"])
    # what "same speaker" and "different speaker" look like on this scale: the reference clips against each other
    refs = sorted((OUT / "refs").glob("*.wav"))
    allm["_ref_similarity"] = {f"{a.stem}|{b.stem}": s.sim(a, b) for i, a in enumerate(refs) for b in refs[i + 1 :]}
    path.write_text(json.dumps(allm, indent=1))


if __name__ == "__main__":
    main()
