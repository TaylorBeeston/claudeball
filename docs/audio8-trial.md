# Audio8-TTS-Realistic-0.6b for the announcers: trial

Thread t-0032, 2026-10-29, main at 17016c2. Question: could [Edge0/Audio8-TTS-Realistic-0.6b](https://huggingface.co/Edge0/Audio8-TTS-Realistic-0.6b)
voice the booth instead of (or next to) the Kokoro HD voices the game ships? Scripts: [tools/tts-trial/](../tools/tts-trial/README.md). Listening
page (local, not in git): `~/.herdr-projects/claudeball/library/t-0032/index.html`.

## Recommendation

**Use it offline for promo videos now. Ship a hybrid in the game only if Taylor's listening test is a clear win.**

* It cannot run in the game. There is no ONNX, WebGPU or WASM build. It needs about 2.5 GB of weights and a CUDA GPU, and even on the RTX 4090
  laptop a line takes 0.69 s per second of speech, with no streaming.
* As a pre-rendered bank it is practical. It gets the words right (WER 0.5%, 3 small slips in 108 takes; Kokoro is near-perfect too, see
  below), and it can clone the game's own Kokoro voices from a Kokoro clip, so a character keeps his timbre. 5,000 lines are about 85 MB of Opus at 32 kbps and render in 2 to 6 hours on this GPU.
* What it would buy is unproven by my numbers. The point of Audio8 is realism and prosody, which WER and speaker similarity do not measure,
  and I could not listen. There is no real emotion control: tags, caps and punctuation do nothing measurable, and an excited reference
  clip only raises the pitch a little and inconsistently. And when it clones a Kokoro voice, the
  result is still a Kokoro-like voice with Audio8's prosody.
* Wiring a bank into the game is a moderate engine change (see [Plumbing](#how-the-game-could-play-a-bank)). Mixing inside one line is likely
  jarring; whole fixed lines next to whole live lines are probably fine if the levels are matched.

So the next step is Taylor's ears, not more code. Open the page and compare the three Audio8 columns against Kokoro, then listen to the
hybrid splices at the bottom. If the Audio8 column does not clearly sound better, the hybrid is not worth the engine work and the extra
85 MB download.

## Safety

* **Isolation.** A new venv at `~/claudeball-tts/venv` (Python 3.12, 6.7 GB; torch 2.8.0+cu128, transformers 4.57.3). Nothing went into the
  repo or `~/claudeball-voice/venv`. The model loads with `HF_HUB_OFFLINE=1`, and transformers' copy of the remote code is redirected to
  `~/claudeball-tts/hf-modules`; I checked that nothing appeared under `~/.cache/huggingface/modules`. No tokens were used.
* **Pinned revision.** `1e857568bfd4f02931aca3988ee773a44d2d26d3` (the repo was created 2026-10-14 and last changed 2026-10-27).
  * sha256 `f590053e…2d8` model.safetensors, 1.20 GB, 601M BF16 parameters
  * sha256 `c310505a…047` codec.pth, 1.35 GB
  * tokenizer about 13 MB
  * total download 2.56 GB
* **Remote code read before it ran.** `configuration_arktts.py`, `modeling_arktts.py`, `modeling_arktts_codec.py`, `processing_arktts.py`:
  * no network access, no subprocess, no `eval` or `exec`, no file writes outside the model folder
  * `save_pretrained` copies the codec, but only when it is called; nothing here calls it
  * `cached_file` would only be reached for a Hub model id, not a local folder
  * the tokenizer is a plain `PreTrainedTokenizerFast` with no custom code
* **The one pickle.** `codec.pth` is loaded with `torch.load(..., weights_only=True)`. I listed its pickle globals without running them:
  only `OrderedDict`, `torch._utils._rebuild_tensor_v2` and `torch.FloatStorage`. Clean.
* **Evaluation models.**
  * Kokoro: `onnx-community/Kokoro-82M-v1.0-ONNX`@`1939ad2a`, the same fp32 model and voices the game loads
  * Whisper: `openai/whisper-large-v3-turbo`@`41f01f3f`, safetensors
  * WavLM: `microsoft/wavlm-base-plus-sv`@`feb593a6`; its `.bin` pickle had the same three safe globals and loads `weights_only`
* **Voices.** Only four kinds of reference audio were used: Kokoro's own presets (Apache-2.0), the model's own output, an excited take in the
  cloned Lyle voice, and Taylor's own pilot recordings (local only). No real person's voice was used. The Taylor clones stay in
  `~/claudeball-tts` and the local library; do not publish the listening page.

## What was measured

* **Lines.** 36 lines from the game's own text: PA, umpire, calm pitch calls, big calls, catchphrases, deadpan colour, two banter
  exchanges, names and numbers, and the opening. Digits stay exactly as the game writes them. Each Audio8 setup has 3 independent takes per
  line.
* **Kokoro.** Rendered offline with kokoro-onnx: the same model, voices and speeds as the game (excited lines at rate 1.12 with a 1.06
  pitch shift). Two differences from the game: it phonemizes with espeak-ng instead of kokoro-js, and it renders whole lines, where the game
  splits booth lines into clauses.
* **WER.** Whisper large-v3-turbo on every take, scored against the script after both go through Whisper's English normaliser. On top of
  that I join digit groups and fold a few known ASR spellings (`doubleheader`, `2-4-1`, `3-0`) so they don't count as TTS errors.
* **Flags per take:**
  * `early-stop`: the last words are missing
  * `dropped word`: a word is missing inside the line
  * `repeat/extra`: inserted words
  * `misread`: a wrong word
  * `no-stop`: the take hit the frame cap
* **Speaker similarity.** WavLM x-vector cosine.
* **Loudness.** LUFS (pyloudnorm).

### Speed and memory (RTX 4090 Laptop, 16 GB)

| | value |
|---|---|
| load (model + codec, warm disk) | 2.1 s |
| VRAM | 1.8 GiB resident; peak 2.0 GiB at batch 1, 2.8 GiB at batch 16 |
| real-time factor, one line at a time | **0.69** (0.66-0.72 over 16 lines) |
| time to first audio | the whole line: no streaming on this code path (a 1.3 s call takes 0.87 s, a 4.1 s line 2.9 s, 13 s of speech 8.6 s) |
| throughput, batch 1 / 4 / 8 / 16 | 1.47x / **3.02x** / 2.74x / 2.49x real time |
| WER by batch size | 0 at every batch size: batching does not hurt accuracy |
| Kokoro for comparison | RTF 0.31 on the CPU here; the game measures 0.1-0.2 on WebGPU (`hdInfo.ts`) |

Two surprises in this table:

* **Batching scales poorly.** Throughput peaks at batch 4. A batch runs until its longest line ends, each generation step is a Python
  loop over one slow-model step plus 9 fast-model steps, and attention is forced to the math kernel. Sorting a bank by length before
  batching would help, and the SGLang Omni adapter (paged attention, dynamic batching) is the route to real throughput; I did not try it.
* **The GPU is shared.** While Taylor's Wan2GP job was busy, single-line RTF rose to about 2.3. All timings above are from an idle GPU.

### Accuracy and stability

| setup | takes | mean WER | takes with WER 0 | flagged | voice steadiness (Lyle / Biscuit) |
|---|---:|---:|---:|---:|---|
| Kokoro (ships now) | 36 | 0.040 | 92% | 3 | 0.90¹ / 0.95 |
| **Audio8 cloning the Kokoro voice** | 108 | **0.005** | 97% | 3 | 0.95 / 0.95 |
| Audio8, its own picked voice | 30 | 0.029 | 97% | 1 | 0.95 / 0.95 |
| Audio8, no reference | 30 | 0.002 | 97% | 1 | **0.77** / 0.91 |
| Audio8 cloning Taylor (pilot takes) | 30 | 0.013 | 97% | 1 | 0.94 |

Voice steadiness is the mean WavLM similarity between different lines of the same character. ¹ Kokoro's Lyle scores lower because the
game's excited lines get a 1.06 pitch shift; a fixed preset is as steady as a voice gets.

**On words, both engines are near-perfect.** Read the WER gap (0.5% against 4%) as "no meaningful difference", not as Audio8 being more
accurate:

* Kokoro is one take per line, Audio8 three.
* Kokoro here is the offline stand-in, whose espeak-ng phonemizer may cause slips the browser would not.
* Two of Kokoro's three misses are a filler and a compound word.

Audio8 did say "Mm-hmm" correctly in all three takes; Whisper's normaliser would have hidden it if a take had dropped the filler, and none
did.

**Every failure:**

* **Kokoro, 3 out of 36:**
  * "Curve a ball, 78"
  * "M-M-hum, biscuits and gravy"
  * one wrong word in the long opening line
* **Audio8 cloning the Kokoro voice, 3 out of 108:**
  * "Ball four!" came out as "four"
  * "Eugene Giant" for "Eugene Giants"
  * dropped "scouting" from a 27-word line
* **Audio8 in the other setups:**
  * one early stop: Biscuit's "Hot. Somebody bring the catchers a towel." stopped after "Hot." (own voice)
  * one dropped "back," (no reference)
  * one "curve ball, 78 down and in" (Taylor clone)

On the game's own text no take repeated itself or ran to the 512-frame cap (23.8 s); the emotion tests below are another matter. The same
seed with the same input gave bit-identical audio. The model card's
warnings about mispronouncing, repeating and stopping early do show up, but rarely: about 1 take in 40.

**Digits.** Audio8 reads the game's raw text correctly: "88", "5-3" as "five-three", "5-4-3", "55 and 53". Spelling the numbers out made no
measurable difference (WER 0.002 against 0, over 18 takes each). Kokoro also read them right, so the game's normaliser is not what limits it.

**Voices.**

* **No reference gives no fixed voice.** Every take is a plausible male announcer with a median pitch of 137-167 Hz across 16 seeds. But
  the same seed on different lines is a different-sounding speaker: similarity 0.80 between lines, against 0.88 between seeds on the same
  line. A reference clip is required.
* **With a reference the voice holds.** 0.94-0.95 to the reference, and 0.95 between different lines of the same character.
* **Cloning Kokoro keeps the timbre close.** Similarity to Kokoro's own take of the same line is 0.93, against 0.61 with no reference and
  0.71 for Audio8's own voices.
* **Audio8 copies the reference's loudness and room.** Cloning Taylor's quiet recordings gave −31 LUFS; the self-voice references gave −16.
  A bank needs loudness normalisation, which is trivial.

**Caveat on similarity.** WavLM-base-plus-sv is a blunt ruler for these voices. It scores Kokoro's PA voice against its umpire voice at
0.93, and Taylor's real recordings against the Kokoro PA voice at 0.96. Read the similarity numbers as "did the voice drift", not "is it the same
person". Only listening can tell whether the four characters sound distinct.

### Emotion

There are no style tokens in the tokenizer, and the card documents no style control. I tested on the home-run call, 3 takes per variant,
in the cloned Lyle voice:

| variant | LUFS | median / p90 pitch | words/s | what happened |
|---|---:|---:|---:|---|
| flat, no punctuation | −22.6 | 111 / 130 Hz | 1.99 | |
| as the game writes it ("... gone! Home run!") | −21.8 | 109 / 144 Hz | 1.79 | |
| CAPS ("GONE! HOME RUN!") | −22.0 | 110 / 143 Hz | 1.72 | no change |
| `[excited]` / `[shouting]` tags | −22.5 / −22.1 | 103-107 / 136-149 Hz | 1.8 | ignored: not spoken, no effect |
| stretched ("gooone!!!") | −22.1 | 108 / 142 Hz | 1.59 | misread ("Gu 1") 3 out of 3 |
| "(very excited, shouting)" | −22.0 | 106 / 151 Hz | 1.39 | "home run" said twice, 3 out of 3 |
| excited reference (the loudest of 8 big-call takes in the Lyle voice), same line | −20.3 | 124 / 178 Hz | 1.73 | higher pitch on this line; louder only because the reference was 2.4 LU louder |
| Kokoro's excited call | −23.4 | 113 / 141 Hz | 2.87 | |

So text does not steer delivery. An excited reference lifted the home-run call's pitch (90th percentile 144 to 178 Hz) without speeding
it up. On the other three big calls the effect was mixed: the 90th percentile went +4, +6 and −21 Hz, and the lines got 2-6% *longer*.
Most of its loudness gain is the model copying the reference's level, so I don't count that.

Style in this family of models comes from the prompt audio, so a reference that is really excited (a human take, or the best of many
Audio8 takes chosen by ear) is the lever to try next. A bank would keep 2-3 references per character (calm, building, peak), the way the
custom voice pack has styles. I did not get a convincing excited voice out of it.

Audio8 is also slower than Kokoro: 1.18x Kokoro's duration on average, up to 1.75x. On the big calls it makes each "..." a full stop. Over
a whole game that matters, because the booth plans its lines by their length.

## Where it could fit

**(a) Pre-rendered bank of fixed lines.**

* **How much is fixed text.** Three simulated 9-inning games through `scripts/booth-transcript.ts`, 2,706 booth lines:
  * about **45% of the lines** (39% of the words) have no digit and no name; a name is a capitalised word that never appears lowercase in
    the transcripts, so a few sentence-initial words ("Due", "Yeah") count as names and the share is slightly conservative
  * 562 distinct fixed lines in 3 games
  * 75% of game 3's fixed lines had already been said in games 1-2
  * so the fixed part is small and repetitive: a bank built by enumerating the templates' fixed expansions (`{a|b}` choices included)
    would cover nearly half of what the booth says
  * the other half (names, scores, counts, speeds) stays on Kokoro either way
  * 5,000 lines is a generous upper bound; the table below scales linearly
* **Size.** Measured on the trial's 108 takes (mean line 4.2 s):

  | Opus mono | kB per second of speech | clips per MB | 5,000 lines |
  |---|---:|---:|---:|
  | 24 kbps | 3.1 | 78 | 65 MB |
  | **32 kbps** (the custom pack's clip bitrate) | 4.0 | **59** | **85 MB** |
  | 48 kbps | 6.0 | 39 | 127 MB |

  32 kbps is the bitrate `tools/announcer/train/clips.py` already uses. A bank that size does not belong in the repo (160 MB tree limit,
  25 MB per file), so it lives off-repo, for example as a Hugging Face dataset or GitHub release assets, sharded by character and loaded on
  demand into the Cache API as the HD model is. For comparison, the HD voices already download 326 MB.
* **Render time.**
  * 5,000 lines × 3 takes at batch 4 (3.0x real time): about **5.8 h**
  * plus scoring every take with Whisper and keeping the best by WER, then speaker similarity
  * one take per line, re-rendering only the ~3% that fail: about 2 h
  * one evening on this GPU, while it is not running Wan2GP

**(b) Lines with names and numbers.**

* **Live, in the game: no.** Too slow and too big for a browser.
* **Stitching:** the bank's other mode, used for the PA's "Now batting," + "number 23," + "Tyler Vance."
  * it works mechanically; `pa-stitched.wav` is on the page
  * the PA's batter and pitcher announcements are two fixed frames (`cues.ts`), so the pieces are the frames, the numbers 0-99 and the
    name pool (`src/sim` rosters): a few thousand short clips
  * the pitch contour breaks at every join; listen before trusting it
* **Mixed inside one line** (Audio8 "Now batting," + Kokoro "number 23, Tyler Vance.", `pa-mixed.wav`):
  * likely the most jarring option: 44.1 kHz against 24 kHz bandwidth, and a prosody reset mid-sentence, in the same voice
  * I would not ship that
* **Between whole lines** (`lyle-hr.wav`, `lyle-banter.wav`, `biscuit.wav`, `pa-promo.wav`):
  * one fixed Audio8 line, then one live Kokoro line, same character, cloned from Kokoro, both at −20 LUFS
  * this is the plausible hybrid
  * `lyle-hr-raw.wav` is the same pair without level matching
* **Mitigations if it ships:**
  * clone the Kokoro preset (not Audio8's own voice), so the timbre stays the character's
  * normalise both engines to the same LUFS before the booth chain, whose EQ and compression then glue them
  * low-pass Audio8 at about 11 kHz to match Kokoro's 24 kHz bandwidth, or accept the difference
  * prefer whole lines from one engine; never switch mid-line
  * big calls need their own excited references (Kokoro's excited delivery is a playback pitch trick; Audio8 has no text control, and my
    excited reference only helped a little)

**(c) Promo videos: the best fit today.**

* What the capture gives: `tools/promo/capture.ts` already records the booth as its own stem, separate from the park, plus the time and
  text of every spoken line. An offline pass can re-render each logged line with Audio8 and lay it in at the logged time. Names and numbers
  included, best of N takes picked by ear for the big moments.
* Caveat 1: Audio8's longer lines would collide where the booth had planned for Kokoro's lengths, so the pass must re-time or trim.
* Caveat 2: the park stem is captured *before* the booth's duck and the edit sets park and booth levels per cut (`tools/promo/edit.ts`),
  so a replaced booth stem needs no game-side ducking; any ducking inside a cut would have to be redone in the edit.
* This needs no game change and no download for players. It is where 44.1 kHz and the extra realism pay off most.

**(d) Other ideas.**

* Audio8 with a reference of Taylor's pilot recordings already produces an intelligible clone from 12 s of audio (WER 1.3%); whether it
  sounds like Taylor needs Taylor's ears. As an
  *offline* tool it could pre-render a bank in Taylor's voice for lines Taylor never recorded. That is a cheaper route to "my voice calls
  the game" than recording 2,000 lines, and it stays local and private like the voice pack. The voice pack's clip bank (`ClipIndex`)
  could even carry it.
* It could also generate training data for the Piper fine-tune, though synthetic data trains synthetic artefacts in.

## How the game could play a bank

The custom voice pack's clip bank is the right shape: an `index.json` from words to `.ogg`, read by `ClipFirstSynth` (`src/audio/voice/clipSynth.ts`),
which wraps any `Synth` and falls through to the model. For an Audio8 bank next to the HD voices it needs these changes (engine work, not
done here):

1. **Wire it into the HD path.** Today `ClipFirstSynth` is only constructed for the custom pack (`voice/controller.ts`). `HdManager.enable()`
   builds a bare `WorkerSynth`. It would wrap that the same way.
2. **Look up before clause splitting.** `NeuralSpeechEngine.speak()` and `prefetch()` split booth lines into clauses (`pieces()`) before
   `generate()`. A whole-line bank would never see a whole booth line, so either the lookup moves above the split or the bank is rendered
   per clause, which loses the line's prosody.
3. **Add a voice dimension.** `ClipIndex.keys` maps words to a file with no voice, role or style in the key. Lyle and Biscuit saying the same
   words, or a calm and an excited take, need keys like `voice|style|words`. `generate()` already receives `voice` (the Kokoro preset) and
   `speed`.
4. **Exact match for booth lines.** `planClips` greedily covers a line with up to 14-word phrases. For booth lines the bank should match
   whole lines only, falling back to Kokoro for the whole line. Phrase stitching stays for PA and umpire forms.
5. **Hosting and caching.** Shard per character (about 20 MB each at 32 kbps), fetch the index up front, and fetch clips on demand or warm
   them like `WARM_UMP`. The clips are 44.1 kHz Opus; the mixer resamples.

## Files

* **Code (in git):** `tools/tts-trial/`, scripts and README only.
* **Not in git:** `~/claudeball-tts/` holds the venv, model, Kokoro, Whisper and WavLM folders, and the renders in `out/trial`
  (`metrics.json`, `analysis.json`, `bank.json`). Together that is about 11.5 GB; delete the folder to undo everything.
* **Listening page:** `~/.herdr-projects/claudeball/library/t-0032/`, 111 MB of loudness-matched WAVs plus `index.html`.
