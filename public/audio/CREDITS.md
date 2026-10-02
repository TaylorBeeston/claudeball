# Audio credits

Almost everything you hear is generated in the browser at runtime by `src/audio/synth.ts` (noise, damped resonances and
formant-filtered voices rendered into buffers) and `src/audio/organ.ts` (additive organ voices); that needs no licence and is the
fallback for every sound. The only recordings in the repo are three short applause clips (crowd one-shots) that replace the
synthesised applause when they load. They are listed in `manifest.json` (the app fetches only files listed there, so a missing file
can never cause a failed request) and are **CC0 / public domain only** (verified on each file's Wikimedia Commons page, licence
"Creative Commons Zero, Public Domain Dedication"). Total size ~120 KB (mono Vorbis, trimmed, faded, limited).

| file | derived from | author | licence | source |
|---|---|---|---|---|
| `applause_a.ogg` (5.0 s, from 8 s in), `applause_c.ogg` (2.6 s, from 24 s in) | "Sound Effects - Applause after a concert.ogg" | Amada44 (own work) | CC0 1.0 | https://commons.wikimedia.org/wiki/File:Sound_Effects_-_Applause_after_a_concert.ogg |
| `applause_b.ogg` (5.5 s) | "277021 sandermotions applause-2.wav" (audience applauding, De Doelen, Rotterdam) | Sandermotions (Freesound #277021, re-hosted on Commons) | CC0 1.0 | https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav |

Processing: trimmed, mono, 32 kHz, fade in/out, peak limited, encoded with `ffmpeg -c:a libvorbis -q:a 2`.

| what | source | licence |
|---|---|---|
| bat, ball, glove, dirt, fence, crowd murmur / roar / cheers / groans, organ | procedurally synthesised by this repo's code | MIT (this repo) |
| organ melodies | the 7th-inning stretch is the chorus of "Take Me Out to the Ball Game" (Albert Von Tilzer / Jack Norworth, 1908, public domain), transcribed from a lead sheet; the "charge" figure is a traditional public-domain bugle call and "shave and a haircut" a stock ballpark riff; fanfare, ditties, walk-up and beds are original to this project | PD / MIT |
| announcer, umpire and commentary voices | the visitor's own browser `SpeechSynthesis` voices (nothing bundled or recorded), or the optional HD voices below | n/a |

Other candidates that were checked and are **not** used:
- Wikimedia Commons (searches: cheering crowd, crowd noise, stadium crowd roar, sports crowd, applause, baseball crowd): "Applause i/ii.ogg" and "Clapping hurray.ogg" (public domain but short/thin), "High school cafeteria.ogg" and the shopping-mall ambiences (public domain, indoor room tone, not a stadium). No stadium roar, organ or baseball effect turned up.
- OpenGameArt, CC0 filter (searches: crowd, cheer, audience, applause, stadium, sports, baseball, organ, in sound-effect and music categories): "Crowd Shouting/Speaking Ambience" (CC0, but a few siblings' voices layered to sound like a protest, not a stadium), "Applause in a large hall or church" (CC0 but very reverberant, redundant with the applause already used), "Fireworks With Applause Happy People" (page lists both CC0 and CC-BY: licence unclear, skipped). The organ hits are game music tracks, not a baseball organ. No stadium roar, baseball organ or bat/glove effects.
- Kenney.nl audio packs (Impact, Interface, Digital, RPG, Music Jingles ... all CC0): nothing crowd-, stadium- or baseball-specific; not downloaded.
If more recordings are added, list each here (author, URL, licence; CC0 / public domain only) and add them to `manifest.json`.

## Optional HD voices (not part of the repo or the site bundle)

Only if the player opts in (Settings > HD voices > Download), the browser fetches at run time:
- **kokoro-js 1.2.1** (Apache-2.0) from `https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm`, with its dependencies `@huggingface/transformers` (Apache-2.0), `onnxruntime-web` (MIT) and `phonemizer` 1.2.1 (declared Apache-2.0, but it embeds **eSpeak NG, GPL-3.0-or-later**, compiled to WASM: this is why the library is loaded from the CDN at run time and is not bundled or committed here).
- **Kokoro-82M v1.0 ONNX** weights, `onnx-community/Kokoro-82M-v1.0-ONNX` on the Hugging Face Hub (model licence Apache-2.0; ~92 MB `model_quantized.onnx` or ~326 MB `model.onnx` for WebGPU), cached in the browser. The voices used are Kokoro's presets (`am_onyx`, `am_adam`, `am_michael`, `bm_george`); no voice of any real person is cloned or imitated.
Observed network hosts during use: `cdn.jsdelivr.net`, `huggingface.co`, `us.aws.cdn.hf.co` (and nothing before the opt-in).

## Experimental tiny language model (`?lm=1`, off by default, not recommended)

Fetched at run time only with that flag, never bundled: `@huggingface/transformers` 3.8.1 (Apache-2.0) from jsDelivr, and `onnx-community/LFM2-700M-ONNX` (LFM Open License v1.0, https://huggingface.co/LiquidAI/LFM2-350M/blob/main/LICENSE : Apache-style grant, redistribution with a copy of the licence, commercial use only below USD 10M annual revenue; this repo ships no weights). Evaluated but not used: `onnx-community/Qwen2.5-0.5B-Instruct` (Apache-2.0), `onnx-community/SmolLM2-360M-Instruct-ONNX` (Apache-2.0), LFM2-350M / 1.2B (LFM Open License). See `src/audio/README.md` for the results.
