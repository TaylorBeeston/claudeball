# Your own voice as the Claudeball announcer

This guide takes you from "I have a microphone" to "my voice calls the game". You record yourself in the generic TV-baseball cadence (stretched vowels, rising excitement, *"and it's... GONE!"*), a small neural voice is trained from your recordings, and the game speaks with it. Your own voice is the training data, so there is no licensing problem; see [Legal and privacy](#legal-and-privacy).

```
npm run announcer:script    the recording script (already generated and committed; re-run only if the game's commentary changes)
npm run announcer:record    the recorder (a local web page, nothing leaves your computer)
npm run announcer:setup     one-time: Python environment for training (no sudo)
npm run announcer:pilot     the whole chain on the pilot set, 10-25 minutes
npm run announcer:prep      check your recordings, build the training set
npm run announcer:train     fine-tune the voice
npm run announcer:export    ONNX model + quantized versions + voice pack
npm run announcer:test      headless browser test of the voice pack
```

## At a glance

| step | what you do | your time |
|---|---|---|
| 1 | set up the mic and the room | 10 min |
| 2 | record the **pilot** (137 lines, ~11 min of audio) | 25-35 min |
| 3 | run the pilot chain, listen to the rough result | 20 min (mostly waiting) |
| 4 | record **core** (607 lines, ~58 min of audio), 5 sessions | 2-3 hours total |
| 5 | train the real voice | 2-4 hours of GPU, unattended |
| 6 | host the voice pack, switch it on in the game | 15 min |
| optional | record **extended** (names, numbers, 1400 short lines, ~74 min) | 2-3 hours total |

A *session* is 12 minutes of finished audio, about 25-30 minutes at the microphone once retakes and breaks are counted. Stop when your voice gets tired: the recorder resumes where you left off.

## 1. Microphone and room

* Any decent USB or XLR microphone works; a headset or laptop mic is the floor, not the goal. Keep it the same one for every session.
* **Pop filter** (or a sock over the mic), mic 10-15 cm from your mouth and a little to the side of it.
* A quiet room with soft things in it (curtains, a rug, a closet of clothes is the classic). Turn off fans, fridges and notifications.
* **Do not change the gain between sessions.** Set it once so loud calls peak around -6 dB on the meter and quiet ones sit around -20 dB. The recorder stores your sample rate and bit depth after the first take and warns you if you change them.
* The recorder turns off echo cancellation, noise suppression and auto gain. If your operating system adds its own "voice enhancement" or "noise cancelling" to the mic, turn that off too.
* Chrome or Chromium (or another browser with AudioWorklet) on the same machine as the folder you save to.

## 2. Record the pilot

```
npm ci                      # once
npm run announcer:record
```

Open <http://127.0.0.1:5199> (the recorder only listens on 127.0.0.1, never on your network), then:

1. **Open microphone** and allow access. Choose your mic, 48 kHz and 24-bit.
2. **Capture room tone** with the room quiet (5 seconds). This measures your noise floor; the quality checks and the hands-free mode use it.
3. Pick session **P1** and start. Each line is shown big, with its **style** and a one-line **direction** (*"stretch the vowel on gone, rise on the last word"*). Do what the direction says; do not read it out.
4. Press <kbd>Space</kbd> to start, say the line, press <kbd>Space</kbd> to stop. The take is trimmed (about 200 ms of room kept at each end), checked, saved, and played back. <kbd>←</kbd> retakes, <kbd>→</kbd> moves on, <kbd>P</kbd> plays your saved take, <kbd>S</kbd> skips, <kbd>F</kbd> flags a line for review.
5. Prefer hands-free? Choose **Auto-detect**: after the countdown it listens, starts when you speak and stops after a pause. **Hold Space** (push to talk) also works.

What the automatic checks mean:

| badge | meaning | what to do |
|---|---|---|
| Clipping | peaked at full scale | turn the gain down or lean back, retake |
| Too quiet / a bit quiet | peak below -30 / -18 dB | gain up or move closer |
| Too noisy / some noise | the room is within 25 / 35 dB of your voice | quieter spot, fan off |
| Short / Long | very different from the expected length | did you say the whole line? stumble? |
| Start/End cut off | the take began or ended mid-word | wait for the countdown; let the last word die away before stopping |

A "retake suggested" take is still saved if there was no earlier take; if you already had a good one, it is kept and the new one is not saved.

**Already have audio?** *Import existing WAV(s)* (or drop files on the page). A file named after its line id (for example `80585e53.wav`) goes to that line; otherwise it goes to the line you are on. The import is converted to mono at your sample rate and trimmed like a normal take.

**Where things are saved:** `~/claudeball-voice/` (override with `CB_VOICE_DIR`): `wavs/<id>.wav`, `meta.json` (status and checks per line), `roomtone.wav`. It is private: `*.wav`, `*.onnx` and the rest are in `.gitignore`, and nothing in this repo ever uploads them. Prefer choosing a folder in the browser? *Save to > A folder I pick* uses the File System Access API (Chromium only).

The script and the lines' ids: ids are a hash of the line's text, so regenerating the script (`npm run announcer:script`, for example after the commentary gets new lines) never renumbers lines you have already recorded; recordings of lines that no longer exist are simply ignored. Lines recorded before a text edit count as new lines.

## 3. Run the pilot chain and listen

First time only, set up the training environment (about 10 minutes and 6 GB; everything lives under `~/claudeball-voice/venv`, no sudo, nothing system-wide):

```
npm run announcer:setup
```

Then:

```
npm run announcer:pilot
```

It runs `prep --pilot` (check the recordings, transcribe them with Whisper and compare to the script, build the training set), `train --pilot` (60 epochs from a public checkpoint, listening samples every 20 epochs), `export` and the browser smoke test. When it ends:

* **Listen**: `~/claudeball-voice/work/runs/pilot/samples/epoch0060/*.wav` (eight lines, one per style) and `~/claudeball-voice/voicepack/listen/*/`.
* **Look**: `~/claudeball-voice/work/whisper_report.tsv` lists every take Whisper heard differently from the script; those lines are left out of training. Re-record the ones that are really misreads.
* The pilot voice is **rough** (11 minutes of speech), and that is fine: it proves the chain works on your hardware and gives you a feel for how the styles come out. If a style sounds wrong (for example the peak calls are flat), re-record with more energy; the model copies what it hears.

You can try the pilot voice in the game right away: see [Host it and switch it on](#6-host-it-and-switch-it-on).

## 4. Record the full set

Order of priority:

1. **PILOT** (sessions `P1`, `P2`), done.
2. **CORE** (`C1`-`C5`, 607 lines): every commentary template the game has, expanded into realistic instances: umpire calls and the PA, play results, pitches with speeds and locations, counts, situations, stats, replays and inning recaps, booth chatter, 70 plain sentences, and the big calls. About 400 lines are play-by-play, 100 are the hype voice (excited and peak) and 110 are dry colour commentary.
3. **EXTENDED** (`E1`-`E6`, ~1400 lines, optional): every first name, last name, city and team name in the roster generator (in a PA carrier line, in a play-by-play line and on its own), jersey numbers, numbers 0-130, speeds 40-110, distances, averages and ERAs, ordinals. Without them the model still pronounces unseen names (it has a pronunciation for every word in the lexicon), just with less of your voice in them; with them, the clip bank can play your real recordings for the PA lines.

Tips that make the biggest difference: same mic position every session; record the **styles as written** (the `peak` calls really should be big); do the quiet deadpan lines deadpan; drink water; stop when your voice tires. Each session starts with calm lines and ends with the big ones, so warm up first.

## 5. Train the real voice

```
npm run announcer:prep         # all recorded lines
npm run announcer:train        # 300 epochs, samples every 25 epochs
```

Training starts from a public Piper checkpoint (`libritts_r`, CC BY 4.0, 904 voices) and fine-tunes it on your lines. **Three characters, one voice:** the lines are grouped into `playbyplay` (calm, building, crisp calls, deflated), `hype` (excited, peak) and `color` (deadpan), and the model learns them as three speakers that share everything except a small speaker embedding. The game picks the character per line from the crowd's excitement and the text, so a quiet pitch call and a home-run call come out of the same voice at different energies. If you would rather have one plain voice, run `prep -- --speakers 1` (base: `ljspeech`, public domain).

* Progress and samples: `~/claudeball-voice/work/runs/full/samples/epochNNNN/`. Listen as it goes; later epochs are not always better, and you can export any checkpoint under `work/runs/full/lightning_logs/*/checkpoints/` with `export -- --checkpoint <file>`. `tensorboard --logdir ~/claudeball-voice/work/runs/full` shows losses and audio (`source ~/claudeball-voice/venv/bin/activate` first).
* The GPU can be shared with your desktop (a browser, a game, Blender). The default batch size of 16 fits next to a desktop session; if you get an out-of-memory error, close the heavy apps or use `train -- --batch-size 8`.
* Interrupted? `npm run announcer:train -- --resume --run-name full` continues from the last checkpoint.

Then export:

```
npm run announcer:export
npm run announcer:test
```

`export` writes `~/claudeball-voice/voicepack/`: the fp32 model, an int8-quantized model, an fp16 model, `voice.json` (speakers, settings and the word lexicon) and `export_report.json` (sizes, CPU speed, and how far each quantized model drifts from fp32). It picks int8 as the default model when it stays close to fp32 and falls back to fp32 otherwise. `test` loads the pack in a headless Chromium through the game's own loader and worker and speaks one line per style.

## 6. Host it and switch it on

The voice model is **not** part of the game and never in this repo (size and privacy). The game loads it from a URL you control, or from files on your own disk.

### No hosting: load from files

In the game open the sound panel (⚙), find **My voice (custom announcer)** and press **Choose files...**; select `voice.json` and `model.int8.onnx` (or whichever model `voice.json` names as `default`) from `~/claudeball-voice/voicepack/`. The model is kept in your browser, so next time the game starts it comes back by itself. Works on this machine only.

### Hugging Face (recommended)

A public model repo is free, serves files with the CORS headers the browser needs, and caches well.

```
~/claudeball-voice/venv/bin/hf auth login
~/claudeball-voice/venv/bin/hf repo create claudeball-voice --repo-type model
cd ~/claudeball-voice/voicepack
~/claudeball-voice/venv/bin/hf upload YOUR-NAME/claudeball-voice voice.json voice.json
~/claudeball-voice/venv/bin/hf upload YOUR-NAME/claudeball-voice model.int8.onnx model.int8.onnx
# optional, only if you built clips: ~/claudeball-voice/venv/bin/hf upload YOUR-NAME/claudeball-voice clips clips
```

Your pack URL is `https://huggingface.co/YOUR-NAME/claudeball-voice/resolve/main/`. Paste it into **My voice > Load my voice pack**. (The website's "Add file > Upload files" works too.) Public means anyone can download your model; it contains the voice model and the word list, never your recordings.

### GitHub

* **A normal repo file works**: put `voice.json` and the model in any public repo (files up to 100 MB) and use `https://raw.githubusercontent.com/YOU/REPO/main/` as the pack URL (raw.githubusercontent.com sends `Access-Control-Allow-Origin: *`). GitHub Pages of a separate repo works the same way.
* **A GitHub release asset does not work**: release downloads redirect to a host that does not send CORS headers, so the browser blocks them.

### Switching on

1. Press the 🔊 button or any key once (browsers only allow audio after a click).
2. Open ⚙, **My voice (custom announcer)**, paste the URL, **Load my voice pack** (or **Choose files...**). It downloads the model once (about 20 MB for int8) and keeps it in the browser's cache; the URL and "on" are remembered in `localStorage`.
3. From then on the PA, umpire, play-by-play and colour lines use your voice. Anything it cannot say (a word that is not in the lexicon, a slow machine, any error) falls back to the browser's voice for that line, so the game never goes quiet. The Kokoro "HD voices" switch is separate: turning one on turns the other off.
4. **Switch off** returns to the browser voices; **Remove saved voice** also deletes the model from the browser.

How it works: the page loads your model with onnxruntime-web (imported at run time from jsDelivr after you opt in, in a Web Worker, so the main game bundle is untouched); the text goes through the same normaliser the training data used, then through the word lexicon in `voice.json` to phoneme ids (no espeak-ng in the browser); the character (`playbyplay`, `hype`, `color`) is chosen per line from the speaker role, the crowd excitement and the words ("and it's gone!"); the audio goes through the same speech queue, prefetch and PA effects (band-limited horn, slap-back, stadium reverb for the PA announcer) as the other neural voices.

### Clips of your real recordings (optional)

For calls the game says exactly, your real recordings sound better than any model. `python clips.py` (see `tools/announcer/train/clips.py`) packs short recorded lines into Opus clips indexed by their words; `voice.json` can point at it (`"clips": {"index": "clips/index.json"}`). The game plays a line from clips only if every word is covered ("now batting" + "number twenty-three" + "Aaron" + "Abbott"), otherwise it asks the model. Upload the `clips/` folder next to `voice.json`.

## Which approach, and why

| approach | what you get | cost | verdict |
|---|---|---|---|
| **Fine-tune Piper (VITS)** | your voice, runs faster than real time on one CPU thread in the browser; model 15-60 MB; works from about 20 minutes of speech and is good at 1 hour; three speakers for styles | training on your GPU, a few hours | **chosen** |
| Fine-tune Kokoro-82M | higher naturalness | no supported fine-tuning recipe; the model is 90-330 MB and runs slower than real time on the CPU in the browser (the game's own measurement) | worth revisiting if training tools appear |
| StyleTTS2 | the most expressive of the four | heavy training, a diffusion sampler at run time, no browser/ONNX path | desktop-only; not for a browser game |
| Concatenative (clip bank) | exactly your recordings | only the lines and words you recorded, no new sentences, gaps between words | **also built**, as a first choice for exactly-known calls |

Piper's training code is GPL-3.0. It is used as an external tool in `~/claudeball-voice/vendor`, not copied into this MIT repository. The model you train is yours.

Base-checkpoint licenses (the training data of the checkpoint you fine-tune matters): `libritts_r` is CC BY 4.0 (attribution is written into `voice.json`), `ljspeech` is public domain. The popular `lessac`, `ryan` and `hfc_*` checkpoints come from non-commercial or restricted datasets, so this pipeline does not use them.

## Troubleshooting

| problem | fix |
|---|---|
| The recorder says there is no script | `npm run announcer:script` |
| "Could not open the microphone" | allow microphone access for 127.0.0.1:5199 in the browser's site settings; close other apps that hold the mic |
| The status line says echo cancellation / noise suppression is ON | the browser or OS forced it; try Chrome, or turn off "enhancements" for the mic in your system sound settings |
| Meter never moves | wrong input in the Microphone list |
| Whisper: `libcublas.so.12 is not found` | the CUDA libraries for faster-whisper are missing; prep automatically falls back to the CPU (slower, same result). Force it with `prep -- --whisper-device cpu`, or skip the check with `--whisper none` |
| `train` runs out of GPU memory | close GPU-heavy apps, or `-- --batch-size 8` |
| The voice sounds like nobody in particular / mumbles | too few epochs or too little data: record more of CORE, train 300+ epochs, compare the epoch samples |
| Some words are said wrong | a word is pronounced from the espeak-ng dictionary; names can be odd. Edit its entry in `voicepack/voice.json` (`lexicon`, phoneme ids) or re-run `npm run announcer:vocab` and `export` after adding a pronunciation |
| "no pronunciation in the voice pack for ..." in the game | a word the commentary now says is not in your lexicon; run `npm run announcer:vocab` then `export` again (no retraining needed) |
| The game plays the browser voice for some lines | by design: unknown word, model too slow for that line, or an error. `window.__audioDebug.state.speech.voiceStats` shows counters |
| The pack will not load from my URL | the host must send CORS headers (Hugging Face does; GitHub release assets do not); open the URL's `voice.json` in a tab to check it is public |
| Re-trained, but the game still plays the old voice | the browser caches the model per export (`built` time in `voice.json`); press **Remove saved voice** and load again |

## Legal and privacy

* It is **your own voice**, recorded by you, so you own the recordings and the model. Do not train on a real broadcaster's audio, and do not try to imitate a specific announcer: the point is the *generic* cadence everybody knows, not anyone's voice.
* If you later add anyone else's recordings (a friend does the colour commentary, say), get their **written consent** first, and keep their takes in a separate speaker; a voice model of a person is personal data.
* Recordings, datasets, checkpoints and models are never committed (`.gitignore`: `*.wav`, `*.onnx`, `*.ckpt`, `.venv/`, `voicepack/`) and the recorder never sends audio anywhere. The only network traffic in this pipeline is downloading public checkpoints and Whisper from Hugging Face and the Python packages. The game loads a voice pack only after you switch it on, and only from the URL or files you give it.
* A model published to a public URL can be downloaded and used by anyone, like any published recording of your voice. Use the files route if you would rather keep it on your machine.
* Attribution: the voice pack records which public checkpoint it was fine-tuned from (`libritts_r`: CC BY 4.0, LibriTTS-R). Keep that line if you share the pack.

## What was installed and where

Under `~/claudeball-voice/` only: a Python 3.12 virtualenv (`venv/`, PyTorch with CUDA, faster-whisper, onnxruntime), a clone of Piper's training code (`vendor/piper1-gpl/`), base checkpoints (`checkpoints/`, about 1 GB), your recordings and work files. The Playwright test tooling and `onnxruntime-web` are dev dependencies of this repo and are not part of the game bundle. Nothing needs sudo.
