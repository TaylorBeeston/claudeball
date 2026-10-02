# tools/announcer

Record your own voice, train it, and use it as the in-game announcer. Start with **[docs/announcer-voice.md](../../docs/announcer-voice.md)**.

| folder | what |
|---|---|
| `script/` | the recording script: `generate.ts` expands the game's own commentary templates (`templates.ts`, `templates-booth.ts`), player-name pools (parsed from `src/sim/roster.ts`), numbers, chatter and sentences into `data/*.jsonl` + `SCRIPT.md`. `npm run announcer:script` / `announcer:vocab` |
| `recorder/` | the local recorder web app (`npm run announcer:record`, 127.0.0.1:5199) and its tiny Node API; `e2e/` drives it with a fake microphone (`npm run announcer:record:e2e`) |
| `train/` | Python pipeline for your GPU: `setup.sh`, `prep.py` (validate, resample, loudness, Whisper check, lexicon, `metadata.csv`), `train.py` (Piper fine-tune in rounds with listening samples), `export.py` (ONNX, quantization, voice pack), `clips.py`, `placeholder.py` (synthetic stand-in recordings for plumbing tests), `web_test.ts` / `game_test.ts` (browser tests of a voice pack) |

Private by design: recordings, datasets, checkpoints and the voice pack live in `~/claudeball-voice` (`CB_VOICE_DIR`) and are git-ignored.
