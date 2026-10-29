"""Build the listening page: loudness-matched copies (-20 LUFS, peaks under -1 dBFS) of every take next to each other, with the metrics.

    python page.py ~/.herdr-projects/claudeball/library/t-0032

The table shows the RAW loudness of each take; the players play the matched copies, so neither engine wins by being louder.
"""
import html
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

from render import LINES, OUT, SPEC

DEST = Path(sys.argv[1]).expanduser()
AUDIO = DEST / "audio"
ENGINES = [
    ("kokoro", "Kokoro (ships now)"),
    ("a8-kref", "Audio8, cloning the Kokoro voice"),
    ("a8-self", "Audio8, its own frozen voice"),
    ("a8-noref", "Audio8, no reference"),
    ("a8-taylor", "Audio8, cloning Taylor (local only)"),
]


def matched(src, dst, target=-20.0):
    x, sr = sf.read(src, dtype="float32")
    m = pyln.Meter(sr)
    pad = np.concatenate([x, np.zeros(max(0, int(0.5 * sr) - len(x)), np.float32)])
    y = x * 10 ** ((target - m.integrated_loudness(pad)) / 20)
    peak = np.abs(y).max()
    if peak > 0.89:
        y *= 0.89 / peak
    dst.parent.mkdir(parents=True, exist_ok=True)
    sf.write(dst, y, sr, subtype="PCM_16")


def cell(engine, r):
    rel = f"audio/{engine}/{r['file']}"
    matched(OUT / engine / r["file"], DEST / rel)
    bits = [f"{r['dur']:.1f} s", f"WER {r['wer']:.2f}"]
    if "sim_ref" in r:
        bits.append(f"sim {r['sim_ref']:.2f}")
    flags = "".join(f'<span class="flag">{html.escape(f)}</span>' for f in r["flags"])
    return f'<div class="take"><audio controls preload="none" src="{rel}"></audio><div class="m" title="Whisper heard: {html.escape(r["hyp"])}">{" · ".join(bits)} {flags}</div></div>'


def summary(rows):
    def mean(k):
        v = [r[k] for r in rows if k in r]
        return f"{np.mean(v):.2f}" if v else "–"

    n = len(rows)
    return [
        str(n),
        mean("wer"),
        f"{100 * sum(r['wer'] == 0 for r in rows) / n:.0f}%",
        f"{100 * sum(bool(r['flags']) for r in rows) / n:.0f}%",
        f"{100 * sum('early-stop' in r['flags'] for r in rows) / n:.0f}%",
        f"{100 * sum('repeat/extra' in r['flags'] for r in rows) / n:.0f}%",
        mean("sim_ref"),
        mean("sim_kokoro"),
        mean("lufs"),
        mean("dur"),
        mean("dur_vs_kokoro"),
    ]


def speed_rows():
    """real-time factors from clean runs only: the batch bench (idle GPU) and Kokoro's offline renders; the per-take numbers of the
    other stages are batches of three, some with another job on the GPU, so they are not speeds"""
    rows = []
    log = OUT.parent / "render.log"
    if log.exists():
        for l in open(log):
            if l.startswith('{"batch"'):
                b = json.loads(l)
                rows.append([f"Audio8, batch {b['batch']} (RTX 4090 Laptop, idle)", f"{1 / b['throughput_x_realtime']:.2f}", f"{b['throughput_x_realtime']:.2f}x", f"{b['peak_vram_gib']} GiB", "the whole line (no streaming)"])
    k = [r["rtf"] for r in json.loads((OUT / "metrics.json").read_text()).get("kokoro", [])]
    if k:
        rows.append(["Kokoro offline (kokoro-onnx, CPU, this machine)", f"{np.median(k):.2f}", f"{1 / np.median(k):.1f}x", "–", "per clause in the game"])
    rows.append(["Kokoro in the game (WebGPU, fp32; hdInfo.ts)", "0.1-0.2", "5-10x", "–", "per clause"])
    return rows


def table(head, rows):
    h = "".join(f"<th>{html.escape(x)}</th>" for x in head)
    b = "".join("<tr>" + "".join(f"<td>{x}</td>" for x in row) + "</tr>" for row in rows)
    return f"<table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table>"


def main():
    met = json.loads((OUT / "metrics.json").read_text())
    if AUDIO.exists():
        shutil.rmtree(AUDIO)
    parts = []
    head = ["setup", "takes", "mean WER", "WER = 0", "flagged", "early stop", "repeat/extra", "speaker sim to its reference", "speaker sim to Kokoro's take", "raw LUFS", "mean duration s", "duration vs Kokoro"]
    srows = []
    for e, label in ENGINES + [("a8-emotion", "Audio8, emotion tests"), ("a8-batch", "Audio8, batch bench")]:
        if e in met:
            main_rows = [r for r in met[e] if not r.get("variant")] or met[e]
            srows.append([html.escape(label)] + summary(main_rows))
    parts.append("<h2>Summary</h2>" + table(head, srows))
    parts.append("<h3>Speed</h3>" + table(["engine", "real-time factor", "throughput", "peak VRAM", "time to first audio"], speed_rows()))
    # by category: Kokoro against Audio8 cloning Kokoro
    cats = sorted({l["cat"] for l in SPEC["lines"]})
    crows = []
    for c in cats:
        ids = {l["id"] for l in SPEC["lines"] if l["cat"] == c}
        row = [html.escape(c)]
        for e in ("kokoro", "a8-kref"):
            rs = [r for r in met.get(e, []) if r["id"] in ids and not r.get("variant")]
            row.append(f"{np.mean([r['wer'] for r in rs]):.2f} ({sum(bool(r['flags']) for r in rs)}/{len(rs)} flagged)" if rs else "–")
        crows.append(row)
    parts.append("<h3>By kind of line: mean WER (flagged takes)</h3>" + table(["kind", "Kokoro", "Audio8 (Kokoro voice)"], crows))
    if "_noref_similarity" in met:
        parts.append(f"<p>No reference: speaker similarity between takes with the same seed on different lines {met['_noref_similarity']['same_seed_diff_line']:.2f}, between seeds on the same line {met['_noref_similarity']['same_line_diff_seed']:.2f}.</p>")
    # the lines
    present = [(e, l) for e, l in ENGINES if e in met]
    by = {e: {} for e, _ in present}
    for e, _ in present:
        for r in met[e]:
            if not r.get("variant"):
                by[e].setdefault(r["id"], []).append(r)
    lrows = []
    for l in SPEC["lines"]:
        row = [f"<b>{html.escape(l['role'])}</b> · {html.escape(l['cat'])}<br>{html.escape(l['text'])}"]
        for e, _ in present:
            rs = sorted(by[e].get(l["id"], []), key=lambda r: r["file"])
            row.append("".join(cell(e, r) for r in rs) or "")
        lrows.append(row)
    parts.append("<h2>The lines</h2><p>Hover a take's numbers to see what Whisper heard. sim = speaker similarity (WavLM) to the voice's reference clip.</p>" + table(["line"] + [x for _, x in present], lrows))
    # spelled-out numbers
    sp = [r for r in met.get("a8-kref", []) if r.get("variant") == "spelled"]
    if sp:
        rows = []
        for lid, text in SPEC["spelled"].items():
            raw = sorted(by["a8-kref"].get(lid, []), key=lambda r: r["file"])
            spl = sorted([r for r in sp if r["id"] == lid], key=lambda r: r["file"])
            rows.append([html.escape(LINES[lid]["text"]) + "<br><i>" + html.escape(text) + "</i>", "".join(cell("a8-kref", r) for r in raw), "".join(cell("a8-kref", r) for r in spl)])
        parts.append("<h2>Digits as the game writes them, or spelled out</h2>" + table(["line", "Audio8, digits", "Audio8, spelled out"], rows))
    if "a8-emotion" in met:
        groups = {}
        for r in met["a8-emotion"]:
            groups.setdefault(r["variant"], []).append(r)
        rows = [[f"<b>{html.escape(v)}</b><br>{html.escape(rs[0]['text'])}", "".join(cell("a8-emotion", r) for r in sorted(rs, key=lambda r: r["file"]))] for v, rs in groups.items()]
        parts.append("<h2>Emotion through the text, and by reference</h2><p><i>expool</i>: eight takes of a big call in the frozen Lyle voice; the loudest became the <i>exref</i> reference for the other big calls.</p>" + table(["variant", "takes"], rows))
    spl = OUT / "splices" / "splices.json"
    if spl.exists():
        rows = []
        for n in json.loads(spl.read_text()):
            rel = f"audio/splices/{n['file']}"
            (DEST / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(OUT / "splices" / n["file"], DEST / rel)
            rows.append([html.escape(n["kind"]), f'<audio controls preload="none" src="{rel}"></audio>', html.escape(n["audio8"]), html.escape(n["kokoro"])])
        parts.append("<h2>Hybrid: a pre-rendered Audio8 line, then a live Kokoro line</h2>" + table(["what", "listen", "Audio8 part", "Kokoro part"], rows))
    rows = []
    for p in sorted((OUT / "refs").glob("*.wav")):
        rel = f"audio/refs/{p.name}"
        matched(p, DEST / rel)
        t = json.loads(p.with_suffix(".json").read_text())["text"]
        rows.append([p.stem, f'<audio controls preload="none" src="{rel}"></audio>', html.escape(t)])
    parts.append("<h2>Reference clips</h2>" + table(["clip", "listen", "transcript"], rows))
    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audio8 TTS trial: Claudeball announcers</title>
<style>
body {{ font: 14px/1.45 system-ui, sans-serif; margin: 24px; max-width: 1600px; color: #1d1d1f; background: #fafafa; }}
@media (prefers-color-scheme: dark) {{ body {{ color: #e8e8e8; background: #141414; }} th {{ background: #222 !important; }} td, th {{ border-color: #333 !important; }} }}
table {{ border-collapse: collapse; margin: 8px 0 24px; }}
th, td {{ border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; text-align: left; }}
th {{ background: #f0f0f0; position: sticky; top: 0; }}
audio {{ height: 30px; width: 210px; display: block; }}
.take {{ margin-bottom: 6px; }}
.m {{ font-size: 11.5px; opacity: .8; cursor: help; }}
.flag {{ color: #fff; background: #c0392b; border-radius: 3px; padding: 0 4px; margin-left: 3px; font-size: 10.5px; }}
</style></head><body>
<h1>Audio8-TTS-Realistic-0.6b vs Kokoro, Claudeball announcer lines</h1>
<p>Players are loudness-matched to -20 LUFS (the tables show each take's raw loudness). Kokoro is 24 kHz, Audio8 44.1 kHz. Kokoro here is rendered offline
(same v1.0 model and voices as the game, espeak-ng instead of the browser's phonemizer, whole lines instead of the game's clause pieces).
Audio8 takes are three independent samples of the same line. The "Taylor" column clones Taylor's own pilot recordings: local only, do not share this page.
Write-up: docs/audio8-trial.md on branch hp/claudeball/t-0032-trial-audio8-tts-realistic-0-6b-for-anno.</p>
{''.join(parts)}
</body></html>"""
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / "index.html").write_text(page)
    size = sum(f.stat().st_size for f in DEST.rglob("*") if f.is_file())
    print(f"{DEST / 'index.html'}: {size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
