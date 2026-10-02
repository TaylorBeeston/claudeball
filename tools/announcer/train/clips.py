"""Concatenative fallback: a bank of YOUR OWN recordings, indexed by the words they say, so the game can play real recordings for the
calls it knows exactly (umpire calls, "Now batting", numbers, names) and stitch them: "Now batting," + "number twenty-three," + "Aaron" + "Abbott".

    python clips.py --work-dir <data>/work --out ~/claudeball-voice/voicepack

Writes <out>/clips/*.ogg (Opus, 32 kbps mono) and <out>/clips/index.json: { "keys": { "now batting": "c0007.ogg", ... } } where a key is the clip's
words, lower case, punctuation dropped. Private like everything else here: host it with the voice pack or leave it out (the model alone works).
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
from pathlib import Path

from common import VOICE_DIR, ensure_venv, load_script, log, tokenize


def main():
    ensure_venv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=VOICE_DIR / "voicepack")
    ap.add_argument("--max-words", type=int, default=14, help="skip long chatter lines: only short, reusable phrases are worth stitching")
    a = ap.parse_args()
    lines = {l["id"]: l for l in load_script()}
    done = {r[0][:-4] for r in csv.reader(open(a.work_dir / "metadata.csv", encoding="utf-8"), delimiter="|")}
    clips = a.out / "clips"
    clips.mkdir(parents=True, exist_ok=True)
    keys: dict[str, str] = {}
    for lid in sorted(done):
        l = lines.get(lid)
        if not l:
            continue
        words = [w for kind, w in tokenize(l["normalized"]) if kind == "w"]
        if not words or len(words) > a.max_words:
            continue
        key = " ".join(words)
        if key in keys:  # same words recorded twice (different style): keep the first, calm one
            continue
        out = clips / f"{lid}.ogg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(a.work_dir / "wavs" / f"{lid}.wav"), "-c:a", "libopus", "-b:a", "32k", "-ac", "1", str(out)], check=True)
        keys[key] = out.name
    (clips / "index.json").write_text(json.dumps({"version": 1, "gapMs": 50, "keys": keys}, ensure_ascii=False, indent=0))
    size = sum(f.stat().st_size for f in clips.glob("*.ogg"))
    log(f"{len(keys)} clips, {size / 1e6:.1f} MB -> {clips}")


if __name__ == "__main__":
    main()
