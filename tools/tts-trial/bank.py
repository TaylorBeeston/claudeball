"""Size a pre-rendered bank: encode the Audio8 takes to Opus at a few bitrates (ffmpeg libopus, mono, like tools/announcer/train/clips.py)
and report bytes per second of speech, clips per MB at the trial's mean line length, and the size and render time of a bank of N lines.

    python bank.py [lines=5000] [takes=3]
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from render import OUT

N = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
TAKES = int(sys.argv[2]) if len(sys.argv) > 2 else 3


def main():
    met = json.loads((OUT / "metrics.json").read_text())
    rows = [r for r in met["a8-kref"] if not r.get("variant")]
    files = [OUT / "a8-kref" / r["file"] for r in rows]
    secs = sum(r["dur"] for r in rows)
    mean_dur = secs / len(rows)
    out = {"takes_measured": len(rows), "mean_line_s": round(mean_dur, 2), "bitrates": {}}
    with tempfile.TemporaryDirectory() as tmp:
        for kbps in (24, 32, 48):
            size = 0
            for f in files:
                o = Path(tmp) / f"{f.stem}-{kbps}.ogg"
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(f), "-c:a", "libopus", "-b:a", f"{kbps}k", "-ac", "1", str(o)], check=True)
                size += o.stat().st_size
            bps = size / secs
            out["bitrates"][kbps] = {
                "kB_per_s": round(bps / 1e3, 2),
                "clips_per_MB": round(1e6 / (bps * mean_dur), 1),
                "bank_MB": round(N * mean_dur * bps / 1e6, 1),
            }
    # the a8-batch stage prints one JSON line per batch size (into the render log when run as in the README)
    log = OUT.parent / "render.log"
    bench = [json.loads(l) for l in open(log) if l.startswith('{"batch"')] if log.exists() else []
    if bench:
        best = max(bench, key=lambda b: b["throughput_x_realtime"])
        hours = N * TAKES * mean_dur / best["throughput_x_realtime"] / 3600
        out["render"] = {"batch": best["batch"], "x_realtime": best["throughput_x_realtime"], "lines": N, "takes_per_line": TAKES, "hours": round(hours, 2)}
    out["whole_bank_wav_MB"] = round(N * mean_dur * 44100 * 2 / 1e6)
    print(json.dumps(out, indent=1))
    (OUT / "bank.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
