"""Pick four of Audio8's own reference-free calibration takes as the cast's frozen voices (the model's own output: nothing cloned).

Keeps takes Whisper reads back perfectly (the transcript must be exact for cloning) whose median pitch is in a male speaking range (the
cast are men), then takes the four most different voices (greedy farthest point on WavLM speaker embeddings) and gives the lowest to the
PA announcer, then Biscuit, Lyle, and the umpire. Writes refs/self-<role>.wav + .json and prints the choice.
"""
import json
import shutil

import numpy as np
import torch
import torchaudio.functional as AF

from render import OUT, SPEC
from score import Scorer, load16


def median_f0(path):
    x = torch.from_numpy(load16(path))
    f = AF.detect_pitch_frequency(x, 16000, freq_low=60, freq_high=400)
    f = f[(f > 60) & (f < 400)]
    return float(f.median()) if f.numel() else 0.0


def main():
    s = Scorer()
    d = OUT / "a8-noref"
    recs = [json.loads(l) for l in open(d / "meta.jsonl")]
    cal = [r for r in recs if r.get("variant") == "cal"]
    hyps = s.transcribe([d / r["file"] for r in cal])
    pool = []
    for r, h in zip(cal, hyps):
        ok = s.norm(h) == s.norm(SPEC["calibration"]) and r["finished"]
        f0 = median_f0(d / r["file"])
        print(f"{r['file']}: f0 {f0:5.0f} Hz, exact {ok}, '{h}'")
        if ok and 60 < f0 < 170:
            pool.append((r, f0, s.emb(d / r["file"])))
    if len(pool) < 4:
        raise SystemExit(f"only {len(pool)} usable male takes: render more calibration seeds")
    chosen = [min(pool, key=lambda p: p[1])]
    while len(chosen) < 4:
        rest = [p for p in pool if all(p[0] is not c[0] for c in chosen)]
        chosen.append(min(rest, key=lambda p: max(float((p[2] * c[2]).sum()) for c in chosen)))
    chosen.sort(key=lambda p: p[1])
    for role, (r, f0, _) in zip(["pa", "color", "pbp", "ump"], chosen):
        shutil.copy(d / r["file"], OUT / "refs" / f"self-{role}.wav")
        (OUT / "refs" / f"self-{role}.json").write_text(json.dumps({"text": SPEC["calibration"], "from": r["file"], "f0": f0}))
        print(role, r["file"], round(f0))
    sims = [[round(float((a[2] * b[2]).sum()), 3) for b in chosen] for a in chosen]
    print("pairwise speaker similarity of the four:", sims)


if __name__ == "__main__":
    main()
