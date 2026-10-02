"""Word -> Piper phoneme-id lexicon, built with Piper's own espeak-ng bridge.

Why a lexicon at all: the game's vocabulary is closed (templates, name pools, numbers), so the browser does not need espeak-ng (GPL, WASM,
heavy): it looks each word up here. The same lexicon feeds training (data prep assembles ids with the same code the browser runs), so the model
never sees a phoneme sequence at run time that it was not trained on. Pronunciations are taken from espeak in *sentence context* (the
modal realisation across the script) so "the" is "ðə" and not the isolated "ðˈiː"; words never seen in context are phonemized alone.

    python lexicon.py [--extra words.txt ...]  ->  <voice-dir>/work/lexicon.json
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from common import SCRIPT_DIR, VOICE_DIR, load_script, log, tokenize, ensure_venv

VOWEL_CLUSTERS = [("a", "ɪ"), ("a", "ʊ"), ("e", "ɪ"), ("o", "ʊ"), ("ɔ", "ɪ")]  # same as the libritts_r / medium base configs


def merge_clusters(tokens: list[str]) -> list[str]:
    out, i = [], 0
    while i < len(tokens):
        if i + 1 < len(tokens) and (tokens[i], tokens[i + 1]) in VOWEL_CLUSTERS:
            out.append(tokens[i] + tokens[i + 1])
            i += 2
        else:
            out.append(tokens[i])
            i += 1
    return out


def build(extra_words: list[str], idmap: dict[str, list[int]]) -> dict:
    from piper.phonemize_espeak import EspeakPhonemizer

    ph = EspeakPhonemizer()

    def clause(words: list[str]) -> list[list[str]]:
        """espeak phonemes of a clause (no punctuation), as one token list per word."""
        sents = ph.phonemize("en-us", " ".join(words))
        toks = [t for s in sents for t in s]
        groups, cur = [], []
        for t in toks:
            if t == " ":
                if cur:
                    groups.append(cur)
                cur = []
            else:
                cur.append(t)
        if cur:
            groups.append(cur)
        return groups

    votes: dict[str, Counter] = defaultdict(Counter)
    all_words: set[str] = set(extra_words)
    lines = [l["normalized"] for l in load_script()]
    for text in lines:
        toks = tokenize(text)
        cur: list[str] = []
        for kind, v in toks + [("p", ".")]:
            if kind == "w":
                cur.append(v)
                all_words.add(v)
                continue
            if cur:
                groups = clause(cur)
                if len(groups) == len(cur):
                    for w, g in zip(cur, groups):
                        votes[w][tuple(merge_clusters(g))] += 1
            cur = []
    missing = 0
    words: dict[str, list[int]] = {}
    for w in sorted(all_words):
        if w in votes:
            toks = list(votes[w].most_common(1)[0][0])
        else:
            g = clause([w])
            toks = merge_clusters(g[0]) if g else []
            missing += 1
        ids: list[int] = []
        ok = True
        for t in toks:
            if t not in idmap:
                ok = False
                break
            ids += idmap[t]
        if ok and ids:
            words[w] = ids
    log(f"lexicon: {len(words)} words ({missing} phonemized alone, the rest from sentence context)")
    return {"version": 1, "voice": "en-us", "words": words}


def load_idmap(config: Path | None = None) -> dict[str, list[int]]:
    from piper.phoneme_ids import DEFAULT_PHONEME_ID_MAP

    if config and config.exists():
        return json.loads(config.read_text())["phoneme_id_map"]
    return {k: list(v) for k, v in DEFAULT_PHONEME_ID_MAP.items()}


def main():
    ensure_venv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", type=Path, default=VOICE_DIR / "work")
    ap.add_argument("--extra", type=Path, nargs="*", default=[SCRIPT_DIR / "vocab.txt"], help="word lists (one word per line)")
    a = ap.parse_args()
    extra: list[str] = []
    for f in a.extra:
        for line in f.read_text().splitlines():
            extra += [w for kind, w in tokenize(line) if kind == "w"]
    lex = build(sorted(set(extra)), load_idmap())
    a.work_dir.mkdir(parents=True, exist_ok=True)
    (a.work_dir / "lexicon.json").write_text(json.dumps(lex, ensure_ascii=False, separators=(",", ":")))
    log("wrote", a.work_dir / "lexicon.json")


if __name__ == "__main__":
    main()
