"""Data prep: recordings -> Piper training set.

    python prep.py --data-dir ~/claudeball-voice [--pilot] [--speakers 3|1] [--whisper small.en|none] [--keep-flagged] [--keep-failed]

 1. picks the lines you recorded (meta.json + wavs/), skipping lines you flagged or that failed QC (override with the flags)
 2. validates each WAV, resamples to 22.05 kHz mono, normalises loudness (active-speech RMS -23 dBFS, peak <= -1 dBFS)
 3. transcribes with faster-whisper and compares to the script text; misreads are listed in work/whisper_report.tsv and left out
 4. writes work/metadata.csv in Piper's phoneme-ids format (wav|speaker|text|ids), plus work/wavs/*.wav, work/lexicon.json, work/summary.json

Speakers: with --speakers 3, calm/building/crisp/deflated -> `playbyplay` (0), excited/peak -> `hype` (1), deadpan -> `color` (2). One
multi-speaker model lets the game switch character by situation, all three sharing your voice (the vocoder and text encoder learn from every
line; only the small speaker embedding differs). With about an hour of audio each character still gets 10-25 minutes, which is why the three
are broad groups rather than seven styles. --speakers 1 trains one plain voice.
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from math import gcd
from pathlib import Path

import numpy as np

from common import SAMPLE_RATE, SPEAKER_NAMES, STYLE_SPEAKER, VOICE_DIR, assemble_ids, comparable, ensure_venv, load_script, log, tokenize, wer
import lexicon as lexmod


def read_wav(p: Path):
    import soundfile as sf

    x, sr = sf.read(str(p), dtype="float32", always_2d=True)
    return x.mean(axis=1), sr


def resample(x: np.ndarray, sr: int, to: int) -> np.ndarray:
    from scipy.signal import resample_poly

    if sr == to:
        return x
    g = gcd(sr, to)
    return resample_poly(x, to // g, sr // g).astype(np.float32)


def speech_rms_db(x: np.ndarray, sr: int) -> float:
    """RMS (dBFS) of the active frames: frames within 35 dB of the loudest 25 ms frame."""
    hop = int(sr * 0.025)
    n = len(x) // hop
    if n == 0:
        return -120.0
    fr = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
    act = fr > fr.max() * 10 ** (-35 / 20)
    return float(20 * np.log10(np.sqrt((fr[act] ** 2).mean()) + 1e-9))


def normalise(x: np.ndarray, sr: int, target_db=-23.0, peak_db=-1.0) -> np.ndarray:
    g = 10 ** ((target_db - speech_rms_db(x, sr)) / 20)
    peak = float(np.abs(x).max() + 1e-9)
    g = min(g, 10 ** (peak_db / 20) / peak)
    return (x * g).astype(np.float32)


def load_whisper(name: str, device: str = "auto"):
    """faster-whisper on the GPU when the CUDA libraries line up, else int8 on the CPU. The load succeeds even when cuBLAS/cuDNN are missing,
    so a one-second warm-up transcription decides."""
    from faster_whisper import WhisperModel

    attempts = [("cuda", "float16"), ("cpu", "int8")] if device == "auto" else [(device, "float16" if device == "cuda" else "int8")]
    for dev, ct in attempts:
        try:
            m = WhisperModel(name, device=dev, compute_type=ct)
            list(m.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
            log(f"whisper {name} on {dev}/{ct}")
            return m
        except Exception as e:  # missing libcublas / cuDNN version mismatch are common
            log(f"whisper on {dev} failed ({str(e).splitlines()[0][:90]}); trying next")
    raise SystemExit("could not load faster-whisper")


def main():
    ensure_venv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=VOICE_DIR, help="folder with wavs/ and meta.json (the recorder's output)")
    ap.add_argument("--work-dir", type=Path, help="output (default <data-dir>/work)")
    ap.add_argument("--pilot", action="store_true", help="only the PILOT lines (priority 1)")
    ap.add_argument("--speakers", type=int, choices=(1, 3), default=3)
    ap.add_argument("--whisper", default="small.en", help="faster-whisper model, or 'none' to skip the check")
    ap.add_argument("--whisper-device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--wer", type=float, default=0.34, help="flag lines whose word error rate against the script is above this")
    ap.add_argument("--keep-flagged", action="store_true")
    ap.add_argument("--keep-failed", action="store_true", help="include takes whose QC said 'retake suggested'")
    ap.add_argument("--min-seconds", type=float, default=0.4)
    ap.add_argument("--max-seconds", type=float, default=25.0)
    a = ap.parse_args()
    work = a.work_dir or a.data_dir / "work"
    (work / "wavs").mkdir(parents=True, exist_ok=True)

    meta_p = a.data_dir / "meta.json"
    meta = json.loads(meta_p.read_text())["takes"] if meta_p.exists() else {}
    lines = [l for l in load_script() if (not a.pilot or l["priority"] == 1)]
    todo, skipped = [], {"no_wav": 0, "flagged": 0, "qc_fail": 0, "bad_audio": 0}
    for l in lines:
        wav = a.data_dir / "wavs" / f"{l['id']}.wav"
        t = meta.get(l["id"], {})
        if not wav.exists():
            skipped["no_wav"] += 1
        elif t.get("status") == "flag" and not a.keep_flagged:
            skipped["flagged"] += 1
        elif (t.get("qc") or {}).get("status") == "fail" and not a.keep_failed:
            skipped["qc_fail"] += 1
        else:
            todo.append((l, wav))
    log(f"{len(todo)} recorded lines to prepare ({skipped})")
    if not todo:
        sys.exit("nothing to prepare: record some lines first (npm run announcer:record)")

    whisper = None if a.whisper == "none" else load_whisper(a.whisper, a.whisper_device)
    report, rows, secs = [], [], {0: 0.0, 1: 0.0, 2: 0.0}
    used: list[dict] = []
    for i, (l, wav) in enumerate(todo, 1):
        try:
            x, sr = read_wav(wav)
            if not np.isfinite(x).all() or sr < SAMPLE_RATE:
                raise ValueError(f"unusable audio (sr={sr})")
            x = normalise(resample(x, sr, SAMPLE_RATE), SAMPLE_RATE)
            dur = len(x) / SAMPLE_RATE
            if not (a.min_seconds <= dur <= a.max_seconds):
                raise ValueError(f"duration {dur:.1f}s outside {a.min_seconds}-{a.max_seconds}s")
        except Exception as e:
            skipped["bad_audio"] += 1
            report.append((l["id"], "bad_audio", "", 1.0, str(e)))
            continue
        status, hyp, err = "ok", "", 0.0
        if whisper is not None:
            segs, _ = whisper.transcribe(x, language="en", beam_size=1, condition_on_previous_text=False)
            hyp = " ".join(s.text.strip() for s in segs)
            err = wer(comparable(l["normalized"]), comparable(hyp))
            lenient = l["kind"] in ("name", "team") or len(comparable(l["normalized"])) <= 3  # whisper spells names its own way and garbles 1-3 word calls
            if err > a.wer and not lenient:
                status = "misread"
            elif err > a.wer:
                status = "ok"  # kept, but visible in the report
                hyp += "  [unverified: short or name line]"
        report.append((l["id"], status, hyp, err, l["normalized"]))
        if status != "ok":
            continue
        import soundfile as sf

        sf.write(str(work / "wavs" / f"{l['id']}.wav"), x, SAMPLE_RATE, subtype="PCM_16")
        used.append(l)
        if i % 25 == 0:
            log(f"  {i}/{len(todo)}")
    with open(work / "whisper_report.tsv", "w", encoding="utf-8") as f:
        f.write("id\tstatus\twer\twhisper_heard\tscript\n")
        for r in report:
            f.write(f"{r[0]}\t{r[1]}\t{r[3]:.2f}\t{r[2]}\t{r[4]}\n")
    bad = [r for r in report if r[1] != "ok"]
    log(f"{len(used)} lines kept, {len(bad)} left out (see {work / 'whisper_report.tsv'})")
    for r in bad[:10]:
        log(f"   {r[0]} {r[1]}: heard '{r[2]}' / script '{r[4]}'")

    # lexicon + ids. The base checkpoint's phoneme map (libritts_r and the other medium voices use Piper's default map)
    idmap = lexmod.load_idmap()
    (work / "idmap.json").write_text(json.dumps(idmap, ensure_ascii=False))
    lex = lexmod.build([], idmap)
    (work / "lexicon.json").write_text(json.dumps(lex, ensure_ascii=False, separators=(",", ":")))
    # first rows must contain speakers in id order 0,1,2: Piper numbers speakers by first appearance
    order = sorted(used, key=lambda l: (STYLE_SPEAKER[l["style"]], l["id"]))
    firsts = []
    if a.speakers == 3:
        for sp in range(3):
            f = next((l for l in order if STYLE_SPEAKER[l["style"]] == sp), None)
            if f:
                firsts.append(f)
        rest = [l for l in order if l not in firsts]
        order = firsts + rest
        present = {STYLE_SPEAKER[l["style"]] for l in used}
        if present != {0, 1, 2}:
            log(f"WARNING: only speakers {sorted(present)} have recordings; ids follow first appearance, so the speaker map will shift. Record all styles or use --speakers 1.")
    nout = 0
    with open(work / "metadata.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="|", lineterminator="\n")
        for l in order:
            ids = assemble_ids(tokenize(l["normalized"]), lex["words"], idmap)
            if ids is None:
                log(f"   skip {l['id']}: word missing from lexicon")
                continue
            sp = STYLE_SPEAKER[l["style"]]
            secs[sp] += l["estSeconds"]
            row = [f"{l['id']}.wav"] + ([SPEAKER_NAMES[sp]] if a.speakers == 3 else []) + [l["normalized"], " ".join(map(str, ids))]
            w.writerow(row)
            nout += 1
    import soundfile as sf

    total = sum(sf.info(str(work / "wavs" / f"{l['id']}.wav")).duration for l in used)
    summary = {"lines": nout, "minutes": round(total / 60, 1), "speakers": a.speakers, "skipped": skipped, "misread": len(bad), "pilot": a.pilot}
    (work / "summary.json").write_text(json.dumps(summary, indent=1))
    log(f"metadata.csv: {nout} lines, {total / 60:.1f} min of audio -> {work}")
    if total < 20 * 60 and not a.pilot:
        log("note: under 20 minutes of audio; expect a rough voice. Record more of the CORE set for a good one.")


if __name__ == "__main__":
    main()
