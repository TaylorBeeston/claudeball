"""Render listening samples from a checkpoint (PyTorch) so you can hear progress without TensorBoard.

    python render.py --checkpoint run/.../last.ckpt --work-dir <data>/work --out run/samples/epoch0050

Each test line is rendered with the speaker that fits its style, using the same lexicon the browser will use.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from common import SAMPLE_RATE, SPEAKER_NAMES, STYLE_SPEAKER, assemble_ids, ensure_venv, log, tokenize

# Fixed lines that cover the styles and the game's typical calls. (style, text)
TEST_LINES = [
    ("crisp", "Now batting, number twenty-three, Aaron Abbott."),
    ("calm", "Ninety-four miles an hour, low and away, strike one."),
    ("building", "The count is full, two outs, and the crowd is on its feet."),
    ("excited", "Smacked down the line, that one is in the corner!"),
    ("peak", "Swing and a drive, back, back, back... and it is gone!"),
    ("deadpan", "He is hitting two forty-one on the season, with twelve home runs."),
    ("deflated", "Oh, that's a shame. He just missed it."),
    ("calm", "After seven innings, it is Portland five, Austin three."),
]


def synth(model, ids: list[int], speaker: int | None, scales=(0.667, 1.0, 0.8)) -> np.ndarray:
    import torch

    text = torch.LongTensor(ids).unsqueeze(0)
    lengths = torch.LongTensor([len(ids)])
    sid = torch.LongTensor([speaker]) if speaker is not None else None
    with torch.no_grad():
        a = model(text, lengths, list(scales), sid=sid).detach().cpu().numpy()
    return a.reshape(-1)


def main():
    ensure_venv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--work-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--config", type=Path, help="voice config.json (for the speaker map and phoneme map)")
    ap.add_argument("--device", default="cpu")
    a = ap.parse_args()
    import soundfile as sf
    import torch
    from piper.train.vits.lightning import VitsModel

    lex = json.loads((a.work_dir / "lexicon.json").read_text())["words"]
    cfg = json.loads(a.config.read_text()) if a.config and a.config.exists() else {}
    idmap = cfg.get("phoneme_id_map") or json.loads((a.work_dir / "idmap.json").read_text())
    spk = cfg.get("speaker_id_map") or {}
    model = VitsModel.load_from_checkpoint(a.checkpoint, map_location=a.device)
    model.eval()
    with torch.no_grad():
        model.model_g.dec.remove_weight_norm()
    a.out.mkdir(parents=True, exist_ok=True)
    for i, (style, text) in enumerate(TEST_LINES):
        ids = assemble_ids(tokenize(text), lex, idmap)
        if ids is None:
            log("skip (word not in lexicon):", text)
            continue
        sid = spk.get(SPEAKER_NAMES[STYLE_SPEAKER[style]]) if spk else None
        audio = synth(model, ids, sid)
        peak = max(0.01, float(np.abs(audio).max()))
        sf.write(str(a.out / f"{i:02d}-{style}.wav"), audio / peak * 0.9, SAMPLE_RATE)
    log("rendered", len(TEST_LINES), "samples to", a.out)


if __name__ == "__main__":
    main()
