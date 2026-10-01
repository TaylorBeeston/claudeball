"""Export the trained model to ONNX, quantize it, measure size / speed / quality, and assemble the voice pack.

    python export.py --work-dir <data>/work [--run-name full] [--checkpoint path.ckpt] [--out ~/claudeball-voice/voicepack]

Writes <out>/ (private, never committed; host it yourself, see docs/announcer-voice.md):
  model.onnx fp32 | model.fp16w.onnx weights stored as fp16, fp32 maths (half the size, runs everywhere) | model.int8.onnx dynamic int8 | model.fp16.onnx true fp16 (WebGPU only)
  voice.json            manifest the game loads: speakers, scales, lexicon, phoneme ids, which model file is the default
  export_report.json    sizes, CPU real-time factor, and how far each quantized model drifts from fp32 (noise-free log-mel L1 + Whisper WER)
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import logging

import numpy as np

logging.getLogger().setLevel(logging.ERROR)  # onnxruntime-quantization logs a warning per skipped tensor

from common import load_whisper, BASES, SAMPLE_RATE, SPEAKER_NAMES, STYLE_SPEAKER, VOICE_DIR, assemble_ids, comparable, ensure_venv, log, tokenize, wer
from render import TEST_LINES

PUNCT = [",", ".", ";", ":", "!", "?"]


def run_ort(sess, ids, sid, scales=(0.667, 1.0, 0.8)):
    feeds = {
        "input": np.array([ids], dtype=np.int64),
        "input_lengths": np.array([len(ids)], dtype=np.int64),
        "scales": np.array(scales, dtype=np.float32),
    }
    names = {i.name for i in sess.get_inputs()}
    if "sid" in names:
        feeds["sid"] = np.array([sid or 0], dtype=np.int64)
    return sess.run(None, feeds)[0].reshape(-1)


def weights_fp16(src: Path, dst: Path) -> None:
    """Weight-only fp16: every large fp32 initializer is stored as fp16 and cast back to fp32 at load (ORT folds the Cast), so the file is about
    half the size, the arithmetic stays fp32 and it runs on every provider, including the browser's WASM one (true fp16 models do not)."""
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    m = onnx.load(str(src))
    g = m.graph
    casts = []
    for init in list(g.initializer):
        if init.data_type != TensorProto.FLOAT:
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < 256:
            continue
        name = init.name
        h = numpy_helper.from_array(arr.astype(np.float16), name + "__fp16")
        g.initializer.remove(init)
        g.initializer.append(h)
        casts.append(helper.make_node("Cast", [name + "__fp16"], [name], to=TensorProto.FLOAT, name="cast_" + name))
    g.node.insert(0, *casts) if False else None
    for i, n in enumerate(casts):
        g.node.insert(i, n)
    onnx.save(m, str(dst))


def logmel(x: np.ndarray) -> np.ndarray:
    import librosa

    m = librosa.feature.melspectrogram(y=x.astype(np.float32), sr=SAMPLE_RATE, n_fft=1024, hop_length=256, n_mels=80)
    return np.log(np.maximum(m, 1e-5))


def main():
    ensure_venv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", type=Path, required=True)
    ap.add_argument("--run-name", default="full")
    ap.add_argument("--checkpoint", type=Path)
    ap.add_argument("--out", type=Path, default=VOICE_DIR / "voicepack")
    ap.add_argument("--default", choices=["auto", "fp32", "fp16w", "int8", "fp16"], default="auto", help="which model voice.json points at (auto: the smallest of fp16w / int8 that stays close to fp32, else fp32)")
    ap.add_argument("--no-whisper", action="store_true")
    a = ap.parse_args()
    import onnxruntime as ort

    run = a.work_dir / "runs" / a.run_name
    ckpt = a.checkpoint or next(iter(sorted(run.rglob("last.ckpt"), key=lambda p: p.stat().st_mtime, reverse=True)), None)
    if not ckpt:
        sys.exit(f"no checkpoint under {run}: train first (npm run announcer:train)")
    a.out.mkdir(parents=True, exist_ok=True)
    fp32 = a.out / "model.onnx"
    log(f"exporting {ckpt.name} -> {fp32}")
    subprocess.run([sys.executable, str(Path(__file__).parent / "export_onnx_legacy.py"), "--checkpoint", str(ckpt), "--output-file", str(fp32)], check=True)
    cfg = json.loads((run / "config.json").read_text())
    shutil.copy(run / "config.json", a.out / "model.onnx.json")

    # --- quantize
    int8, fp16, fp16w = a.out / "model.int8.onnx", a.out / "model.fp16.onnx", a.out / "model.fp16w.onnx"
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)
    except Exception as e:
        log("int8 quantization failed:", str(e).splitlines()[0])
        int8.unlink(missing_ok=True)
    try:
        import onnx
        from onnxconverter_common import float16

        m = onnx.load(str(fp32))
        onnx.save(float16.convert_float_to_float16(m, keep_io_types=True), str(fp16))
    except Exception as e:
        log("fp16 conversion failed:", str(e).splitlines()[0])
        fp16.unlink(missing_ok=True)

    try:
        weights_fp16(fp32, fp16w)
    except Exception as e:
        log("weight-only fp16 failed:", str(e).splitlines()[0])
        fp16w.unlink(missing_ok=True)

    # --- measure
    lex = json.loads((a.work_dir / "lexicon.json").read_text())["words"]
    idmap = cfg["phoneme_id_map"]
    spk = cfg.get("speaker_id_map") or {}
    lines = []
    for style, text in TEST_LINES:
        ids = assemble_ids(tokenize(text), lex, idmap)
        if ids:
            lines.append((style, text, ids, spk.get(SPEAKER_NAMES[STYLE_SPEAKER[style]])))
    whisper = None if a.no_whisper else load_whisper("small.en")
    mos = None
    try:
        from piper.train.vits.mos import MosPredictor

        mos = MosPredictor("utmos")
    except Exception:
        pass
    report: dict = {"checkpoint": ckpt.name, "models": {}}
    base_mels = None
    for tag, path in (("fp32", fp32), ("fp16w", fp16w), ("int8", int8), ("fp16", fp16)):
        if not path.exists():
            continue
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        try:
            sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
            # deterministic pass for drift measurement, normal pass for speed and intelligibility
            det = [run_ort(sess, ids, sid, (0.0, 1.0, 0.0)) for _, _, ids, sid in lines]
            t0 = time.perf_counter()
            outs = [run_ort(sess, ids, sid) for _, _, ids, sid in lines]
            dt = time.perf_counter() - t0
        except Exception as e:
            report["models"][tag] = {"error": str(e).splitlines()[0], "bytes": path.stat().st_size}
            log(f"{tag}: could not run on CPU ({str(e).splitlines()[0][:90]})")
            continue
        secs = sum(len(o) for o in outs) / SAMPLE_RATE
        mels = [logmel(o) for o in det]
        entry = {"bytes": path.stat().st_size, "mb": round(path.stat().st_size / 1e6, 1), "cpu_rtf": round(dt / secs, 3)}
        if tag == "fp32":
            base_mels = mels
        elif base_mels is not None:
            entry["logmel_l1_vs_fp32"] = round(float(np.mean([np.abs(m[:, : min(m.shape[1], b.shape[1])] - b[:, : min(m.shape[1], b.shape[1])]).mean() for m, b in zip(mels, base_mels)])), 3)
        if whisper is not None:
            errs = []
            for (_, text, _, _), o in zip(lines, outs):
                segs, _ = whisper.transcribe((o / max(0.01, np.abs(o).max()) * 0.9).astype(np.float32), language="en", beam_size=1)
                errs.append(wer(comparable(text), comparable(" ".join(s.text for s in segs))))
            entry["whisper_wer"] = round(float(np.mean(errs)), 3)
        if mos is not None:
            import torch

            sc = [mos.score(torch.from_numpy(o.astype(np.float32)), SAMPLE_RATE) for o in outs]
            sc = [x for x in sc if x is not None]
            if sc:
                entry["utmos"] = round(float(np.mean(sc)), 2)
        report["models"][tag] = entry
        import soundfile as sf

        for (style, _, _, _), o in zip(lines, outs):
            (a.out / "listen" / tag).mkdir(parents=True, exist_ok=True)
            sf.write(str(a.out / "listen" / tag / f"{style}-{len(o)}.wav"), o / max(0.01, np.abs(o).max()) * 0.9, SAMPLE_RATE)
        log(f"{tag}: {entry}")

    m = report["models"]
    pick = a.default
    if pick == "auto":
        i8 = m.get("int8", {})
        pick = "fp32"
        for cand in ("fp16w", "int8"):
            c = m.get(cand, {})
            f32 = m.get("fp32", {})
            if c and "error" not in c and c.get("whisper_wer", 0) <= f32.get("whisper_wer", 0) + 0.08 and c.get("utmos", 9) >= f32.get("utmos", 0) - 0.35:
                pick = cand
                break
    if False:
        i8 = m.get("int8", {})
        f32 = m.get("fp32", {})
        # the noise-free log-mel distance is shown for reference only (a quantized model can shift timing, which inflates it);
        # what decides is intelligibility (Whisper) and the perceptual score (UTMOS) staying close to fp32
        ok = bool(i8) and "error" not in i8 and i8.get("whisper_wer", 0) <= f32.get("whisper_wer", 0) + 0.08 and i8.get("utmos", 9) >= f32.get("utmos", 0) - 0.35
        pick = "int8" if ok else "fp32"
    file = {"fp32": "model.onnx", "fp16w": "model.fp16w.onnx", "int8": "model.int8.onnx", "fp16": "model.fp16.onnx"}[pick]
    base = "libritts_r" if cfg.get("num_speakers", 1) > 1 else "ljspeech"
    pack = {
        "format": 1,
        "name": "My announcer",
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sampleRate": cfg["audio"]["sample_rate"],
        "models": {k: {"file": f, "bytes": (a.out / f).stat().st_size} for k, f in (("fp32", "model.onnx"), ("fp16w", "model.fp16w.onnx"), ("int8", "model.int8.onnx"), ("fp16", "model.fp16.onnx")) if (a.out / f).exists()},
        "default": pick,
        "speakers": {n: spk[n] for n in SPEAKER_NAMES if n in spk} if spk else None,
        "styleSpeaker": {s: SPEAKER_NAMES[sp] for s, sp in STYLE_SPEAKER.items()} if spk else None,
        "scales": {"noise": cfg.get("inference", {}).get("noise_scale", 0.667), "length": cfg.get("inference", {}).get("length_scale", 1.0), "noiseW": cfg.get("inference", {}).get("noise_w", 0.8)},
        "phonemeIdMap": {k: idmap[k] for k in ["_", "^", "$", " ", *PUNCT]},
        "lexicon": lex,
        "attribution": f"Fine-tuned from the Piper '{base}' checkpoint ({BASES[base]['license']}) on the owner's own recordings.",
    }
    (a.out / "voice.json").write_text(json.dumps(pack, ensure_ascii=False, separators=(",", ":")))
    report["default"] = pick
    (a.out / "export_report.json").write_text(json.dumps(report, indent=1))
    log(f"\nvoice pack ready: {a.out}  (default model: {pick}, {pack['models'][pick]['bytes'] / 1e6:.1f} MB)")
    log("listen to the files in", a.out / "listen")


if __name__ == "__main__":
    main()
