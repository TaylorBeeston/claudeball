"""Fine-tune Piper (VITS) on your recordings, in rounds, rendering listening samples after each round.

    python train.py --work-dir <data>/work [--run-name full] [--pilot] [--epochs 300] [--batch-size 16] [--base auto]

Weights start from a public Piper checkpoint through `--model.warmstart_ckpt` (copies every matching tensor, fresh optimiser and epoch
counter), so your hour of speech only has to teach it your voice and delivery. Base choice (checked licenses, see docs/announcer-voice.md):
 - 3 speakers (styles) -> libritts_r  (CC BY 4.0, 904-speaker multi-speaker model)
 - 1 speaker           -> ljspeech    (public domain)
Outputs in <work-dir>/runs/<run-name>/: config.json (the voice config), checkpoints/, samples/epochNNNN/*.wav, tensorboard logs (`tensorboard --logdir`).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from common import BASES, CKPT_DIR, PIPER_DIR, VOICE_DIR, ensure_venv, log

VOWEL_CLUSTERS = '[["a","ɪ"],["a","ʊ"],["e","ɪ"],["o","ʊ"],["ɔ","ɪ"]]'


def fetch_base(name: str) -> Path:
    spec = BASES[name]
    dest = CKPT_DIR / name / Path(spec["path"]).name
    if dest.exists():
        return dest
    from huggingface_hub import hf_hub_download

    log(f"downloading base checkpoint {name} ({spec['license']})")
    got = hf_hub_download(repo_id="rhasspy/piper-checkpoints", repo_type="dataset", filename=spec["path"], local_dir=str(CKPT_DIR / name))
    dest.parent.mkdir(parents=True, exist_ok=True)
    return Path(got)


def newest(run: Path, pattern: str) -> Path | None:
    c = sorted(run.rglob(pattern), key=lambda p: p.stat().st_mtime)
    return c[-1] if c else None


def main():
    ensure_venv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", type=Path, required=True)
    ap.add_argument("--run-name", default="full")
    ap.add_argument("--pilot", action="store_true", help="few epochs: proves the plumbing, gives a rough listenable result")
    ap.add_argument("--epochs", type=int, help="total epochs (default 300, pilot 60)")
    ap.add_argument("--round", type=int, help="epochs between listening samples (default 25, pilot 20)")
    ap.add_argument("--batch-size", type=int, default=16, help="16 fits next to a desktop session on a 16 GB laptop GPU; raise if you have room")
    ap.add_argument("--base", default="auto", choices=["auto", *BASES])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--resume", action="store_true", help="continue an earlier run in the same run dir")
    a = ap.parse_args()

    meta = a.work_dir / "metadata.csv"
    if not meta.exists():
        sys.exit(f"{meta} not found: run prep first (npm run announcer:prep)")
    ncols = len(next(csv.reader(open(meta, encoding="utf-8"), delimiter="|")))
    speakers = 3 if ncols == 4 else 1
    base = ("libritts_r" if speakers == 3 else "ljspeech") if a.base == "auto" else a.base
    if speakers == 3 and base == "ljspeech":
        sys.exit("a 3-speaker dataset needs the multi-speaker base (libritts_r); re-run prep with --speakers 1 to use ljspeech")
    nspk = BASES[base]["speakers"] if speakers == 3 else 1
    epochs = a.epochs or (60 if a.pilot else 300)
    rnd = a.round or (20 if a.pilot else 25)
    run = a.work_dir / "runs" / a.run_name
    run.mkdir(parents=True, exist_ok=True)
    ckpt0 = fetch_base(base)
    nutt = sum(1 for _ in open(meta, encoding="utf-8"))
    log(f"{nutt} utterances, {speakers} speaker(s), base {base}, {epochs} epochs in rounds of {rnd}, batch {a.batch_size} (~{max(1, nutt * 9 // 10 // a.batch_size)} steps/epoch)")
    decay = 0.05 ** (1 / epochs)

    mos_ok = subprocess.run([sys.executable, "-c", "import torchaudio"], capture_output=True).returncode == 0
    if not mos_ok:
        log("torchaudio is not importable: skipping the UTMOS quality score (val_mel is still tracked)")
    done = 0
    t0 = time.time()
    while done < epochs:
        target = min(epochs, done + rnd)
        cmd = [
            sys.executable, str(Path(__file__).parent / "fit_main.py"), "fit",
            "--data.voice_name", "claudeball-announcer",
            "--data.csv_path", str(meta), "--data.audio_dir", str(a.work_dir / "wavs"),
            "--data.espeak_voice", "en-us", "--data.cache_dir", str(run / "cache"), "--data.config_path", str(run / "config.json"),
            "--data.batch_size", str(a.batch_size), "--data.dataset_type", "phoneme_ids", "--data.num_workers", str(a.workers),
            "--data.vowel_clusters", VOWEL_CLUSTERS,
            "--model.sample_rate", "22050", "--model.num_speakers", str(nspk),
            "--model.lr_decay", f"{decay}", "--model.lr_decay_d", f"{decay}",
            "--trainer.max_epochs", str(target), "--trainer.default_root_dir", str(run), "--trainer.devices", "1",
            "--trainer.check_val_every_n_epoch", str(max(1, min(rnd, 5))), "--trainer.log_every_n_steps", "10",
        ]
        last = newest(run / "lightning_logs", "last.ckpt") if (done > 0 or a.resume) else None
        if last:
            cmd += ["--ckpt_path", str(last)]
        else:
            cmd += ["--model.warmstart_ckpt", str(ckpt0)]
        log(f"\n=== epochs {done + 1}-{target} of {epochs} ===")
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "CB_DROP_MOS": "0" if mos_ok else "1"}
        if not mos_ok and "--model.mos_metric" not in cmd:
            cmd += ["--model.mos_metric", "none"]
        r = subprocess.run(cmd, cwd=str(PIPER_DIR), env=env)
        if r.returncode != 0:
            sys.exit(f"training failed (exit {r.returncode}); see the log above. Checkpoints so far are in {run}")
        done = target
        last = newest(run / "lightning_logs", "last.ckpt")
        if last:
            subprocess.run([sys.executable, str(Path(__file__).parent / "render.py"), "--checkpoint", str(last), "--work-dir", str(a.work_dir),
                            "--out", str(run / "samples" / f"epoch{done:04d}"), "--config", str(run / "config.json")], check=False)
            best = newest(run / "lightning_logs", "epoch=*val_mel*.ckpt")
            log(f"epoch {done}: elapsed {(time.time() - t0) / 60:.1f} min, last checkpoint {last.name}, latest best {best.name if best else '-'}")
    (run / "DONE").write_text(f"epochs={epochs} base={base} speakers={speakers}\n")
    log(f"\ntraining finished. Listen to {run / 'samples'} then run: npm run announcer:export")


if __name__ == "__main__":
    main()
