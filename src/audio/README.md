# Audio (`src/audio/`)

Broadcast/stadium sound for the game: bat, ball and glove effects, a crowd that follows the situation, an organ, a PA announcer,
umpire calls and two-voice commentary. Everything is **synthesised in the browser** (Web Audio + DSP in plain typed arrays), so it always works;
the only recordings are three short CC0 applause clips (`public/audio/`, listed in `manifest.json`, credits in `public/audio/CREDITS.md`) that replace the synthesised applause when they load. It only *listens* to the game; it never
touches sim or engine state.

```
main.ts:  attachAudio(engine, root, { off: params.has('noaudio') })     // the whole integration
```

Controls: **M** mutes/unmutes (while audio is still locked, M / 🔊 / the prompt unlock it *and* unmute), the 🔊 button (top right, under the engine's control row) mutes, the ⚙ button opens volumes
(master / effects / crowd & organ / voices) and the **PA announcer & umpire** and **Commentary** toggles (default on). Settings persist
in `localStorage` (`claudeball.audio.v1`, every access in try/catch). Browsers only allow audio after a click or key press, so a
"Click to enable sound" pill shows until the context runs. `?noaudio` skips the layer completely.

## Flow

```
sim raw event bus ─┐                       ┌─ sfx   → spatialize(camera) → pan/lowpass/gain → sfx bus ┐
(or engine events) ─┴→ CueMapper (cues.ts) ─┼─ crowd → crowd bus                                       ├→ master → compressor → out
   + frame-derived:   Cue[]                 ├─ excite → Excitement → Ambience loops (crowd bus)        │
   bounces, slides,                         ├─ organ → Organ (organ bus + stadium reverb)             ┘
   cleats (index.ts)                        └─ speak → SpeechQueue → browser SpeechSynthesis
```

| file | what |
|---|---|
| `index.ts` | `attachAudio`, the controller: event intake, per-tick loop (30 Hz), modes (pause, replay, speed, skipping), frame-derived cues, `window.__audioDebug` |
| `cues.ts` | **pure** `CueMapper.map(event, ctx) → Cue[]` (sound choice by physics: exit velo/launch angle, pitch mph, throw distance ...), commentary text, speed gating. Unit-tested |
| `types.ts` | `Cue`, sound ids, `MapCtx` |
| `synth.ts`, `dsp.ts` | the sound recipes (bat crack in 3 strengths, thud, tick, bunt, whooshes, mitt/glove pops, bounce, dirt, wall, fence rattle, seat thump, throw, tag, slide, footstep, base, HBP, fireworks, PA mic click, crowd one-shots, crowd loops) rendered to Float32Arrays; deterministic per variant |
| `mixer.ts` | one `AudioContext`, buses, reverb, buffer cache (rendered a few ms per timer tick after unlock, ~80 buffers), voice pool (cap 32, importance-based stealing, per-sound min gap, nodes disconnected `onended`), replay/pause modes |
| `spatial.ts` | camera-relative pan / distance gain / air-absorption lowpass (gentle roll-off: TV effects mics sit at the plate and bases, not at the camera) |
| `excitement.ts` | crowd level = smoothed (leverage baseline + event pulses); rises fast, calms slowly |
| `ambience.ts` | murmur + roar loops gained by excitement, plus sparse whoops / clap ripples |
| `organ.ts` | short organ riffs on `PeriodicWave` oscillators with tremolo/vibrato |
| `speech.ts` | priority queue over `SpeechSynthesis`: one line at a time, TTL for stale lines, big lines interrupt chatter, voice picking, pause/resume |
| `mixer.ts` samples | `loadSamples()` fetches `${BASE_URL}audio/manifest.json` and only the files it lists (`crowd:*` keys), decodes them and swaps them in for the synth buffer; any failure leaves the synthesised sound |
| `ui.ts` | button, panel, prompt, settings persistence |

## Where the events come from

`RealSimAdapter` (engine) exposes the sim's own game as the public getter `game`; `rawBusOf()` uses `game.on('*')` (falling back to the old private `g` on older engines) because the engine's
reduced `GameEvent` stream drops what audio needs. With no raw bus (the `?mock` game) `engineToRaw()` converts engine events into the sim shape. Never both.
Unknown events and missing fields are ignored (the mapper is wrapped in try/catch and tested with junk input).

**Detailed mode** (`CueMapper({ detailed: true })`, on whenever the raw bus exists, and switched on by the first `umpireCall`) avoids double triggers:
- umpire voices come from `umpireCall` (timed with the umpire's gesture, 0.2-0.6 s after the play; strikes/balls/fouls/safe/out/time, at the umpire's position for the fallback shout); `call`, `out` and `safe` no longer speak, they only drive crowd reactions;
- pops come from `catch`/`fielded` (`kind` pitch/throw/fly/line/ground/pickoff, `height`, `side`, `firm`): the catcher's mitt pop is scaled by pitch speed and is sharper (higher, louder) when `firm`, duller when caught at the edge of the glove; throws pop at the receiver when caught, not after a guessed flight time; `pitchCrossed` adds no pop. Casual `ballReturn` legs have no catch event, so their soft pop is still scheduled;
- `tag` = glove slap (the `out` that follows adds none), `tagAttempt` is silent, `tagAvoided` = a swish through air + crowd "ooh";
- `closePlay` on `out`/`safe` = crowd tension ("ooh" + excitement) until the umpire rules, then relief/groans for the side that won the call;
- the play-by-play line waits 1.3 s so the umpire's call comes first.

Sim events used: `gameStart, batterUp, pitchReleased, pitchCrossed, swing, contact, call, umpireCall, fielded, catch, error, throw, ballReturn, tag, tagAttempt, tagAvoided, out, safe, steal, walk, hitByPitch, wildPitch/passedBall, wallContact, wallLeap, robbedHomeRun, homeRun, baseTouch, runScored, plateAppearanceEnd, playEnd, pitchingChange, halfInningEnd, gameEnd`.
No sim event exists for these, so `index.ts` derives them from the snapshot each tick: ball bounces (grass vs infield dirt vs warning-track dirt), slides (`anim` becomes `slide`), cleats (only for runners near the camera, only at 1x).

## Sound design notes

- **Bat**: `classifyContact(exitMph, launchDeg, sprayDeg)`: hard = bright crack with a low thump, weak/topped = dull thud, small foul tips tick, ~bunt-speed taps.
- **Pitch**: subtle release whoosh, then a mitt pop at the catcher scaled by pitch mph (3 buckets) when the ball crosses the plate. Pitches the batter hits produce no pop (the sim emits no `pitchCrossed` for them).
- **Throws**: whip at the thrower, glove pop at the receiver after distance/speed seconds.
- **Crowd**: leverage baseline (late innings, close score, runners in scoring position, two strikes, two outs) + pulses (ball in the air swells before it lands, then reacts to the outcome). Reactions depend on who is batting: the home crowd roars for its team and is muted or booing for the visitors; strikeouts cheer for the home pitcher; robbed home runs gasp first.
- **Organ**: charge after home hits, fanfare on a home HR, stinger on outs, ditty between halves, an original waltz for the 7th-inning stretch.
- **Replay** (director shot `replay`): new effects play at 0.6x speed through a lowpass and quieter, a whoosh marks the cut, the crowd carries on. **Pause**: effects and organ go silent, the murmur stays, speech pauses. **2x/4x**: minor cues (footsteps, base touches, return throws) are dropped at 2x, only key cues at 4x, speech is off above 1x. **Fast-forward (`n`)**: all cues dropped, speech cleared.

## Voices (SpeechSynthesis)

Umpire calls (`Strike!`, `Ball four!`, `Foul ball!`, `Safe!`, `Out!`), the PA (`Now batting, number 23, ...`, `Now pitching ...`, welcome) and the two commentators
(play-by-play uses the sim's own `playEnd` description plus the score; colour adds stats such as exit velocity, strikeout count, batter's line) use the browser's voices.
Limits, honestly: browser speech **cannot be routed through Web Audio**, so there is no convolver/echo on the voices (the PA feel comes from a lower pitch and slower rate plus a synthesised
"mic click" and click before announcements) and their volume is only the utterance volume. The browser has one speech queue, so the queue speaks one line at a time. Voices load
asynchronously and headless/Linux browsers may have none; then speech is a silent no-op, and umpire calls fall back to a synthesised shout.
Commentary never uses pronouns for players.

## Debug hook

`window.__audioDebug`: `state` (context state, buffers prepared, live voices, excitement, speech stats, organ riffs, per-sound play counts), `cues` (last 300: kind, id, played, text),
`mapped` / `played` (counters; *mapped* counts every cue before speed gating or voice limits, *played* what actually started), `perHalf` (mapped counts per `1t`, `1b`, `2t` ...),
`energy` (output RMS/peak every 100 ms from an `AnalyserNode`), `speechLog`, `level()`.

## Tests

`npm test` runs `src/audio/__tests__`: event → cue mapping (incl. junk input and pronoun check), spatial maths, excitement, the speech queue (fake engine), every synth recipe renders finite/non-silent audio,
and the mixer against a fake `AudioContext` (voice cap, stealing, node disconnect on end, mute, replay slow-down, no-op without audio).

## What audio would like from the sim/engine

Nothing blocking. Nice to have: an event for a batted ball landing, the fence-contact `speed` for foul balls into the stands, and catch events for the casual `ballReturn` legs.

## My voice (custom announcer), `voice/`

An opt-in third speech engine: the owner's own trained voice (recorded and trained with `tools/announcer/`, see `docs/announcer-voice.md`). It reuses the HD-voice plumbing: `voice/packSynth.ts` is a `Synth` that the same `NeuralSpeechEngine` drives (one speech queue, prefetch, PA processing, browser-voice fallback on any failure or slow line), installed in `SwitchEngine.neural` by `voice/controller.ts`; switching it on turns Kokoro off and vice versa.

| file | what |
|---|---|
| `normalize.ts` | game text -> spoken words ("94" -> "ninety-four", "6-4-3" -> "six-four-three", ".241" -> "two forty-one"); the recording script and the training data use the same function |
| `phonemize.ts` | words -> Piper phoneme ids through the voice pack's lexicon (no espeak-ng in the browser); twin of `tools/announcer/train/common.py` |
| `pack.ts` | the `voice.json` manifest (validated), URL / local-file loading, Cache API storage, `chooseStyle` (PA/umpire crisp, colour deadpan, play-by-play follows crowd excitement and the words) and the style -> speaker map |
| `synthCore.ts`, `worker.ts` | the synthesis (needs only an `ort`-shaped object, so it is unit-tested with a mock) and the module worker; onnxruntime-web is imported at run time from a pinned jsDelivr URL (or `runtime.ortUrl` in `voice.json`), never bundled |
| `clips.ts`, `clipSynth.ts` | optional bank of the owner's real recordings, stitched for lines it covers exactly; else the model |
| `controller.ts`, `panel.ts` | state (off/loading/ready/error), persistence (`claudeball.voicepack.v1` in localStorage), and the block in the audio panel (URL box, file picker) |

Nothing is downloaded until the owner switches it on, and the voice pack is never part of the repo or the build. Debug: `__audioDebug.state.speech.voice` (state) and `.voiceStats` (generated / played / fallbacks / failures).
