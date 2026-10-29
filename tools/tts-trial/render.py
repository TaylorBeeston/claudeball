"""Render the trial: Kokoro (what ships) and Audio8 in several voice setups, the same lines, into ~/claudeball-tts/out/trial.

    python render.py kokoro          Kokoro for every line + the four reference clips (one take: Kokoro is deterministic)
    python render.py a8-kref         Audio8 cloning the Kokoro reference of each character, every line, 3 takes (one batch of three)
    python render.py a8-noref        Audio8 with no reference: determinism check, voice drift across lines, a pool of calibration takes
    python render.py a8-self         Audio8 cloning its own picked calibration take per character (run pick_self.py first), subset
    python render.py a8-taylor       Audio8 cloning the owner's own pilot recordings (local only), play-by-play subset
    python render.py a8-spelled      Audio8 (Kokoro refs) on lines with digits spelled out
    python render.py a8-emotion      text tricks for emotion + style by reference
    python render.py a8-batch        throughput at batch 1 / 8 / 16

Each WAV gets a line in <engine>/meta.jsonl (id, text, seed, timing). Nothing here touches the repo.
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).parent
SPEC = json.loads((HERE / "lines.json").read_text())
LINES = {l["id"]: l for l in SPEC["lines"]}
SEEDS = [0, 1, 2]
SUBSET = ["pa-batting", "ump-k", "pbp-cutter", "pbp-wall", "pbp-hr", "pbp-books", "col-towel", "col-thrown", "ban2-col", "ban5-pbp"]
# the owner's pilot takes used as the reference (never rendered as targets; none of them is in lines.json)
TAYLOR_REF = ["80585e53", "2e36bc82", "6664c5f3"]
TAYLOR_TARGETS = ["pbp-cutter", "pbp-curve", "pbp-30", "pbp-wall", "pbp-hr", "pbp-walkoff", "pbp-books", "ban1-pbp", "ban3-pbp", "ban5-pbp"]

from a8 import ROOT, SR  # noqa: E402

OUT = ROOT / "out" / "trial"


def writer(engine):
    d = OUT / engine
    d.mkdir(parents=True, exist_ok=True)
    meta = open(d / "meta.jsonl", "a", encoding="utf-8")

    def put(name, audio, sr, **info):
        sf.write(d / f"{name}.wav", audio, sr, subtype="PCM_16")
        meta.write(json.dumps({"file": f"{name}.wav", "sr": sr, **info}) + "\n")
        meta.flush()

    return put


def ref_of(kind, role):
    p = OUT / "refs" / f"{kind}-{role}.wav"
    t = json.loads((OUT / "refs" / f"{kind}-{role}.json").read_text())["text"]
    return (p, t)


def kokoro():
    from kokoro_offline import Kokoro

    k = Kokoro()
    k.say("Warm up.", "am_michael")
    put = writer("kokoro")
    for l in SPEC["lines"]:
        a, s = k.say_role(l["text"], l["role"], l.get("excited", False))
        put(l["id"], a, 24000, id=l["id"], text=l["text"], seed=None, **s)
    for lid, text in SPEC["spelled"].items():
        a, s = k.say_role(text, LINES[lid]["role"])
        put(f"{lid}--spelled", a, 24000, id=lid, text=text, variant="spelled", **s)
    refs = OUT / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    for role, r in SPEC["refs"].items():
        a, s = k.say(r["text"], r["kokoro"], r["speed"])
        sf.write(refs / f"kokoro-{role}.wav", a, 24000, subtype="PCM_16")
        (refs / f"kokoro-{role}.json").write_text(json.dumps({"text": r["text"], **s}))


def takes(m, put, name, text, ref, **info):
    """the line's three takes in one batched call (one generator: each row draws its own noise, so they are three independent takes)"""
    audios, stats = m.say_batch([text] * len(SEEDS), ref=ref, seed=info.pop("bseed", 0))
    for seed, a, s in zip(SEEDS, audios, stats):
        put(f"{name}__s{seed}", a, SR, text=text, seed=seed, **info, **s)


def model():
    import a8

    m = a8.Audio8()
    m.say("Warm up.", seed=0)
    return m


def a8_kref():
    m = model()
    put = writer("a8-kref")
    for l in SPEC["lines"]:
        takes(m, put, l["id"], l["text"], ref_of("kokoro", l["role"]), id=l["id"])


def a8_noref():
    m = model()
    put = writer("a8-noref")
    # same seed, same line, twice: is it deterministic?
    for rep in range(2):
        a, s = m.say(LINES["pbp-cutter"]["text"], seed=7)
        put(f"det__rep{rep}", a, SR, id="pbp-cutter", text=LINES["pbp-cutter"]["text"], seed=7, variant=f"det{rep}", **s)
    # same seed across different lines: same speaker? (and 3 seeds per subset line for the WER table)
    for lid in SUBSET:
        takes(m, put, lid, LINES[lid]["text"], None, id=lid)
    # the calibration pool the self-voices are picked from
    cal = SPEC["calibration"]
    for b in range(2):
        audios, stats = m.say_batch([cal] * 8, seed=100 + b)
        for i, (a, s) in enumerate(zip(audios, stats)):
            seed = 100 + 8 * b + i
            put(f"cal__s{seed}", a, SR, id="calibration", text=cal, seed=seed, variant="cal", **s)


def a8_self():
    m = model()
    put = writer("a8-self")
    for lid in SUBSET:
        l = LINES[lid]
        takes(m, put, lid, l["text"], ref_of("self", l["role"]), id=lid)


def a8_taylor():
    """the owner's own voice, from their pilot takes: stays in ~/claudeball-tts and the local library, never in git or on a host"""
    vdir = Path.home() / "claudeball-voice"
    script = {}
    for line in open(HERE.parents[1] / "tools/announcer/script/data/pilot.jsonl", encoding="utf-8"):
        j = json.loads(line)
        script[j["id"]] = j["normalized"]
    parts, texts = [], []
    for lid in TAYLOR_REF:
        x, sr = sf.read(vdir / "wavs" / f"{lid}.wav", dtype="float32", always_2d=True)
        parts += [x.mean(axis=1), np.zeros(int(0.25 * sr), np.float32)]
        texts.append(script[lid])
    refs = OUT / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    sf.write(refs / "taylor-pbp.wav", np.concatenate(parts), sr, subtype="PCM_24")
    (refs / "taylor-pbp.json").write_text(json.dumps({"text": " ".join(texts), "from": TAYLOR_REF}))
    m = model()
    put = writer("a8-taylor")
    ref = ref_of("taylor", "pbp")
    for lid in TAYLOR_TARGETS:
        takes(m, put, lid, LINES[lid]["text"], ref, id=lid)


def a8_spelled():
    m = model()
    put = writer("a8-kref")
    for lid, text in SPEC["spelled"].items():
        takes(m, put, f"{lid}--spelled", text, ref_of("kokoro", LINES[lid]["role"]), id=lid, variant="spelled")


def a8_emotion():
    m = model()
    put = writer("a8-emotion")
    ref = ref_of("kokoro", "pbp")
    for name, text in SPEC["emotion"]["variants"].items():
        takes(m, put, name, text, ref, id="pbp-hr", variant=name)
    # style by reference: 8 takes of a big call in the frozen Lyle voice; the loudest, widest one becomes the reference for other big calls
    pool_text = "And that one is gone! Back, back... gone! A home run!"
    best = None
    audios, stats = m.say_batch([pool_text] * 8, ref=ref, seed=200)
    for seed, (a, s) in enumerate(zip(audios, stats)):
        put(f"expool__s{200 + seed}", a, SR, id="expool", text=pool_text, seed=200 + seed, variant="expool", **s)
        energy = float(np.percentile(np.abs(a), 99))
        if s["finished"] and (best is None or energy > best[0]):
            best = (energy, a, seed)
    refs = OUT / "refs"
    sf.write(refs / "excited-pbp.wav", best[1], SR, subtype="PCM_16")
    (refs / "excited-pbp.json").write_text(json.dumps({"text": pool_text, "seed": 200 + best[2], "note": "picked by 99th-percentile level; check the WER"}))
    exref = ref_of("excited", "pbp")
    for lid in ["pbp-hr", "pbp-walkoff", "pbp-lunch", "pbp-dp"]:
        takes(m, put, f"exref-{lid}", LINES[lid]["text"], exref, id=lid, variant="exref")


def a8_batch():
    import torch

    m = model()
    put = writer("a8-batch")
    texts = [l["text"] for l in SPEC["lines"] if l["role"] in ("pbp", "color")][:16]
    ids = [l["id"] for l in SPEC["lines"] if l["role"] in ("pbp", "color")][:16]
    ref = ref_of("kokoro", "pbp")
    for b in (1, 4, 8, 16):
        torch.cuda.reset_peak_memory_stats()
        made, wall = 0.0, 0.0
        for i in range(0, 16, b):
            audios, stats = m.say_batch(texts[i : i + b], ref=ref, seed=0)
            made += sum(s["dur"] for s in stats)
            wall += stats[0]["gen_s"] + stats[0]["dec_s"]
            for j, (a, s) in enumerate(zip(audios, stats)):
                put(f"b{b}-{ids[i + j]}", a, SR, id=ids[i + j], text=texts[i + j], seed=0, variant=f"batch{b}", **s)
        print(json.dumps({"batch": b, "audio_s": round(made, 1), "wall_s": round(wall, 1), "throughput_x_realtime": round(made / wall, 2), "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2)}), flush=True)


if __name__ == "__main__":
    {
        "kokoro": kokoro,
        "a8-kref": a8_kref,
        "a8-noref": a8_noref,
        "a8-self": a8_self,
        "a8-taylor": a8_taylor,
        "a8-spelled": a8_spelled,
        "a8-emotion": a8_emotion,
        "a8-batch": a8_batch,
    }[sys.argv[1]]()
