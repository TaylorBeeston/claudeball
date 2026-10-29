# Audio8 TTS trial

Scripts behind [docs/audio8-trial.md](../../docs/audio8-trial.md): Audio8-TTS-Realistic-0.6b against the game's Kokoro HD voices on the same
announcer lines. Nothing here is used by the game. No weights, no audio and no venv live in the repo: everything goes to
`~/claudeball-tts/` (override with `CB_TTS_DIR`).

## Setup (once, ~11 GB)

```
uv venv --python 3.12 ~/claudeball-tts/venv
uv pip install --python ~/claudeball-tts/venv/bin/python torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python ~/claudeball-tts/venv/bin/python transformers==4.57.3 "soundfile>=0.12" "safetensors>=0.4" numpy jiwer pyloudnorm kokoro-onnx
cd ~/claudeball-tts
hf download Edge0/Audio8-TTS-Realistic-0.6b --revision 1e857568bfd4f02931aca3988ee773a44d2d26d3 --local-dir model
hf download onnx-community/Kokoro-82M-v1.0-ONNX onnx/model.onnx voices/am_adam.bin voices/am_michael.bin voices/am_onyx.bin voices/bm_george.bin --revision 1939ad2a8e416c0acfeecc08a694d14ef25f2231 --local-dir kokoro
hf download openai/whisper-large-v3-turbo --revision 41f01f3fe87f28c78e2fbf8b568835947dd65ed9 --local-dir whisper   # ASR for the WER
hf download microsoft/wavlm-base-plus-sv config.json preprocessor_config.json pytorch_model.bin --revision feb593a6c23c1cc3d9510425c29b0a14d2b07b1e --local-dir wavlm-sv   # speaker similarity
```

Audio8 needs `trust_remote_code`: read `model/*.py` before the first run (the audit is in the doc). `a8.py` loads it offline
(`HF_HUB_OFFLINE`) and keeps transformers' copy of the remote code in `~/claudeball-tts/hf-modules`.

## Run

From this folder, with `P=~/claudeball-tts/venv/bin/python`:

```
$P smoke.py ~/claudeball-tts/out/smoke          # one line three times: load time, VRAM, RTF
$P render.py kokoro                             # Kokoro takes + the four characters' reference clips
for s in a8-kref a8-noref a8-spelled a8-emotion a8-taylor a8-batch; do $P render.py $s; done 2>&1 | tee ~/claudeball-tts/out/render.log
$P pick_self.py                                 # Audio8's own voices for the cast, from the reference-free calibration takes
$P render.py a8-self
$P score.py                                     # Whisper WER, loudness, flags, speaker similarity -> out/trial/metrics.json
$P splice.py                                    # hybrid demos (Audio8 fixed line + Kokoro live line)
$P analyze.py                                   # voice steadiness per character, emotion proxies -> out/trial/analysis.json
$P bank.py 5000 3                               # bank size per Opus bitrate and render time
$P page.py ~/.herdr-projects/claudeball/library/t-0032   # the listening page
```

| file | what |
|---|---|
| `lines.json` | the 36 test lines (the game's own text), the spelled-out variants, the emotion variants, the reference texts |
| `a8.py` | Audio8 loader, `say` / `say_batch` with timing |
| `kokoro_offline.py` | Kokoro v1.0 fp32 ONNX with the game's voices and speeds (kokoro-onnx, CPU) |
| `render.py` | every render stage |
| `pick_self.py` | picks four distinct male calibration takes as frozen voices |
| `score.py` | WER, flags, LUFS, WavLM speaker similarity |
| `analyze.py` | steadiness of each character's voice across lines; loudness / pitch / pace of the emotion variants |
| `splice.py`, `bank.py`, `page.py` | hybrid demos, bank sizing, listening page |

`a8-taylor` clones the owner's own pilot recordings from `~/claudeball-voice/wavs`: its output stays on this machine.
