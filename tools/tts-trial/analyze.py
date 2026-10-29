"""Numbers for the write-up that score.py does not give per take: how steady a character's voice is from line to line (mean WavLM
similarity between different lines of the same role), and crude excitement proxies for the emotion variants (loudness, median and
90th-percentile pitch, words per second). Writes out/trial/analysis.json.
"""
import json
from collections import defaultdict

import numpy as np
import torch
import torchaudio.functional as AF

from render import LINES, OUT
from score import Scorer, load16


def pitch(path):
    f = AF.detect_pitch_frequency(torch.from_numpy(load16(path)), 16000, freq_low=60, freq_high=500)
    f = f[(f > 60) & (f < 500)]
    return (float(f.median()), float(torch.quantile(f, 0.9))) if f.numel() else (0.0, 0.0)


def main():
    s = Scorer()
    met = json.loads((OUT / "metrics.json").read_text())
    out = {"steadiness": {}, "emotion": {}}
    for e in ("kokoro", "a8-kref", "a8-self", "a8-noref", "a8-taylor"):
        rows = [r for r in met.get(e, []) if not r.get("variant") and r["id"] in LINES]
        by = defaultdict(list)
        for r in rows:
            by[LINES[r["id"]]["role"]].append(r)
        res = {}
        for role, rs in by.items():
            v = [s.sim(OUT / e / a["file"], OUT / e / b["file"]) for i, a in enumerate(rs) for b in rs[i + 1 :] if a["id"] != b["id"]]
            if v:
                res[role] = round(float(np.mean(v)), 3)
        out["steadiness"][e] = res
        print(e, res, flush=True)
    groups = defaultdict(list)
    for r in met.get("a8-emotion", []):
        groups[r["variant"]].append(r)
    groups["kokoro-excited"] = [r for r in met["kokoro"] if r["id"] == "pbp-hr"]
    groups["a8-kref-plain"] = [r for r in met["a8-kref"] if r["id"] == "pbp-hr" and not r.get("variant")]
    for v, rs in groups.items():
        eng = "kokoro" if v == "kokoro-excited" else ("a8-kref" if v == "a8-kref-plain" else "a8-emotion")
        p = [pitch(OUT / eng / r["file"]) for r in rs]
        words = [len(LINES.get(r["id"], {"text": r["text"]})["text"].split()) for r in rs]
        out["emotion"][v] = {
            "takes": len(rs),
            "lufs": round(float(np.mean([r["lufs"] for r in rs])), 1),
            "f0_median": round(float(np.mean([x[0] for x in p]))),
            "f0_p90": round(float(np.mean([x[1] for x in p]))),
            "words_per_s": round(float(np.mean([w / r["dur"] for w, r in zip(words, rs)])), 2),
            "wer": round(float(np.mean([r["wer"] for r in rs])), 2),
            "heard": [r["hyp"] for r in rs],
        }
        print(v, {k: x for k, x in out["emotion"][v].items() if k != "heard"}, flush=True)
    (OUT / "analysis.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
