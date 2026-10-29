"""Hybrid demos: what a pre-rendered Audio8 line next to a live Kokoro line sounds like, for the same character, level-matched
(both at -20 LUFS, Kokoro resampled to 44.1 kHz); one pair left at raw levels; and the PA "Now batting" line stitched from Audio8 phrases
the way the clip bank would stitch it. Run after score.py (it picks the best of the three Audio8 takes by WER, then speaker similarity).
"""
import json

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
import torch
import torchaudio.functional as AF

from a8 import SR
from render import LINES, OUT, ref_of

GAP = 0.45
# (name, character, fixed line rendered by Audio8, live line said by Kokoro, live line excited?)
PAIRS = [
    ("lyle-hr", "pbp", "pbp-lunch", "Tyler Vance launches a home run, and the Kings lead 4 to 2.", True),
    ("lyle-banter", "pbp", "ban3-pbp", "The one-one pitch to Riley Perez... ground ball to short, and he is out at first.", False),
    ("biscuit", "color", "col-grownman", "He sits around 91 with the fastball, and he will throw the curveball in any count.", False),
    ("pa-promo", "pa", "pa-promo", "Now batting, number 23, Tyler Vance.", False),
]


def best_take(metrics, engine, lid):
    rows = [r for r in metrics[engine] if r["id"] == lid and not r.get("variant")]
    return min(rows, key=lambda r: (r["wer"], len(r["flags"]), -r.get("sim_ref", 0)))


def to44(x, sr):
    return AF.resample(torch.from_numpy(x), sr, SR).numpy() if sr != SR else x


def level(x, target=-20.0):
    m = pyln.Meter(SR)
    pad = np.concatenate([x, np.zeros(max(0, int(0.5 * SR) - len(x)), np.float32)])
    g = 10 ** ((target - m.integrated_loudness(pad)) / 20)
    y = x * g
    peak = np.abs(y).max()
    return (y * (0.89 / peak) if peak > 0.89 else y).astype(np.float32)


def join(*parts, gap=GAP):
    z = np.zeros(int(gap * SR), np.float32)
    out = []
    for p in parts:
        out += [p, z]
    return np.concatenate(out[:-1])


def main():
    from kokoro_offline import Kokoro

    import a8

    metrics = json.loads((OUT / "metrics.json").read_text())
    k = Kokoro()
    d = OUT / "splices"
    d.mkdir(parents=True, exist_ok=True)
    notes = []
    for name, role, lid, live, ex in PAIRS:
        b = best_take(metrics, "a8-kref", lid)
        x, sr = sf.read(OUT / "a8-kref" / b["file"], dtype="float32")
        y, _ = k.say_role(live, role, ex)
        y = to44(y, 24000)
        sf.write(d / f"{name}.wav", join(level(x), level(y)), SR, subtype="PCM_16")
        notes.append({"file": f"{name}.wav", "kind": "hybrid, level-matched", "audio8": f"{LINES[lid]['text']} ({b['file']})", "kokoro": live})
        if name == "lyle-hr":
            sf.write(d / f"{name}-raw.wav", join(x, y), SR, subtype="PCM_16")
            notes.append({"file": f"{name}-raw.wav", "kind": "hybrid, raw levels (no matching)", "audio8": LINES[lid]["text"], "kokoro": live})
    # the PA line from phrases: what the clip bank's stitcher would make of Audio8 clips, and Audio8's whole line for comparison
    m = a8.Audio8()
    ref = ref_of("kokoro", "pa")
    phrases = ["Now batting,", "number 23,", "Tyler Vance."]
    parts = []
    for p in phrases:
        best = None
        for seed in (0, 1, 2):
            a, s = m.say(p, ref=ref, seed=seed)
            if s["finished"] and (best is None or abs(s["dur"] - 1.2) < abs(best[1]["dur"] - 1.2)):
                best = (a, s)
        parts.append(level(best[0]))
    sf.write(d / "pa-stitched.wav", join(*parts, gap=0.12), SR, subtype="PCM_16")
    notes.append({"file": "pa-stitched.wav", "kind": "PA line stitched from three Audio8 phrases (120 ms gaps, like the clip bank)", "audio8": " + ".join(phrases), "kokoro": ""})
    whole = best_take(metrics, "a8-kref", "pa-batting")
    x, _ = sf.read(OUT / "a8-kref" / whole["file"], dtype="float32")
    sf.write(d / "pa-whole.wav", level(x), SR, subtype="PCM_16")
    notes.append({"file": "pa-whole.wav", "kind": "the same PA line rendered whole by Audio8", "audio8": LINES["pa-batting"]["text"], "kokoro": ""})
    head = phrases[0]
    a, _ = m.say(head, ref=ref, seed=0)
    y, _ = k.say_role("number 23, Tyler Vance.", "pa")
    sf.write(d / "pa-mixed.wav", join(level(a), level(to44(y, 24000)), gap=0.12), SR, subtype="PCM_16")
    notes.append({"file": "pa-mixed.wav", "kind": "mixed inside one line: Audio8 'Now batting,' + Kokoro 'number 23, Tyler Vance.'", "audio8": head, "kokoro": "number 23, Tyler Vance."})
    (d / "splices.json").write_text(json.dumps(notes, indent=1))


if __name__ == "__main__":
    main()
