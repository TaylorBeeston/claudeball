# Audio (`src/audio/`)

Broadcast/stadium sound for the game: bat, ball and glove effects, a crowd that follows the situation, an organ, a PA announcer,
umpire calls and two-voice commentary. Everything is **synthesised in the browser** (Web Audio + DSP in plain typed arrays), so it always works;
the only recordings are three short CC0 applause clips (`public/audio/`, listed in `manifest.json`, credits in `public/audio/CREDITS.md`) that replace the synthesised applause when they load. It only *listens* to the game; it never
touches sim or engine state.

```
main.ts:  attachAudio(engine, root, { off: params.has('noaudio') })     // the whole integration
```

`attachAudio(engine, root, { ui: false })` skips this layer's own button / panel / prompt: the app (`src/ui`) drives `AudioController` (`settings`, `settingsChanged()`, `unlock()`, `isLocked`, and for HD voices `hdStatus()` / `subscribeHd()` / `hdToggle()` / `removeHd()`) from its menus and attaches it inside the *Start Game* click. One settings store (`Settings` in `mixer.ts`, saved under `claudeball.audio.v1`) serves both UIs:
`master`, `sfx`, `crowd`, `organVolume` (the organ's own slider), `announcer` (voices), `muted`, `pa` (PA announcer + umpire), `commentary`, `organ` (organ on/off), `chatter` (`low` / `normal` / `high`), `hd` (HD voices on).

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
| `music.ts` | organ pieces as data (pure, tested): melody + chord changes compiled to timed notes. Includes the 7th-inning stretch (the chorus of *Take Me Out to the Ball Game*, 1908, public domain, transcribed note for note: 31 bars of 3/4 played oom-pah-pah), the charge call, a rally build, home-run fanfare, three ditties, the "shave and a haircut" sting, walk-up, dirge, three soft beds |
| `organ.ts` | the organ: drawbar-style tone (harmonics 1-6 and 8, 16' sub, decaying 2nd-harmonic percussion on lead notes, key click) through a rotary-speaker stage (AM + Doppler delay + stereo sway, ~0.9 Hz chorale or ~6.7 Hz tremolo for fanfares, soft saturation), one piece at a time with priorities (a fanfare cuts the stretch, nothing cuts a fanfare, anything cuts a bed), look-ahead scheduling, real cancellation |
| `commentary.ts` | the booth: play-by-play + colour analyst chatter grounded in the sim state (see below) |
| `neural.ts`, `neuralWorker.ts`, `hdInfo.ts` | optional HD voices (see below); `neural.ts` and the worker are lazy chunks |
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

## Organ

Where you hear it: a walk-up riff for every home batter (under the PA), a rally build (`rally`) or `charge` on a home-team hit (rally when runners are on or for extra bases), `charge` on a home run scored / walk, the fanfare on a home-team homer and a win, the "shave and a haircut" sting on a home-pitcher strikeout, a rotating ditty at every half-inning change, the stretch at the 7th-inning break (the booth is held silent for it), and a soft chord-and-arpeggio **bed** in every break between half innings and between batters in every third half inning. Beds stop at the pitcher's windup (never during a pitch). Organ cues have importance >= 2 and survive 2x (off above 2x); it is silent while paused, muted, skipping or switched off, ducks about 8 dB while anyone is speaking, and has its own volume slider (`organVolume`).
Why it used to be inaudible (the investigation): at 4x the riffs were `imp: 1` and dropped by the speed gate (21 ditties and 44 stings mapped, none played), and at 1x the organ bus sat at crowd² × 0.55 with 0.16 note gain, far under the effects. Measured now with the analyser (headless, 1x, crowd bed + game): baseline RMS 0.047; charge/rally/fanfare/stretch 0.19-0.23; ditty 0.15; bed ~0.05 (soft by design, peaks 0.09); effects peak 0.75; overall peak < 0.8.

## Booth chatter (`commentary.ts`)

`Chatter` keeps memory from the events (this plate appearance's pitches with type, speed and plate location; each pitcher's pitch mix; every batter's results; runs, hits, walks and strikeouts per half inning; last exit velocity; last close play) and the controller feeds it a snapshot built from the sim state (counts, runners and their names/speed grades, batter/pitcher lines and ratings, score, crowd excitement). It never invents facts: a template returns nothing unless every fact it mentions exists. No pronouns for players. About 90 templates, none repeated within a 28-line window, fact cooldowns per plate appearance.
- **Event-driven**: a new batter (matchup, handedness, line tonight, ratings), every pitch result ("Fastball, 94, low and away. Called strike one." the location is from the batter's side: +X is inside for a right-hander and away for a left-hander; tested for both), colour from the pitch history ("third fastball in a row", "first changeup of the night", "as hard as he has thrown tonight" without the pronoun), after a plate appearance (hits for hits, hat trick = 3 strikeouts, golden sombrero = 4, RBI), runs (ties it, takes the lead), close plays (the real margin in hundredths of a second), steals (speed grade), half-inning summaries, pitching changes and replay lines ("Let's take another look at that").
- **Idle chatter**: when the booth has been silent long enough and the game is between pitches (never during a windup), one filler line or a two-voice exchange (a play-by-play line and a colour reply sharing a `group`: if the first is dropped, interrupted or goes stale, the reply is dropped too).
- **Level** (`chatter` setting): `low` = no chatter at all, only the event calls (umpire, PA, plays, big moments); `normal` = silence of ~6.5 s before filler, ~40% of pitches narrated, banter 45%; `high` = ~3 s, ~70% of pitches, banter 70%, break exchanges always. At 2x and above (and while fast-forwarding) the booth is silent.
- Lines carry priorities and a time to live; the one speech queue speaks one at a time, drops stale lines, lets a big call cut chatter off, waits out the seventh-inning stretch, and with HD voices sheds chatter if generation is behind.

## HD voices (optional neural speech)

Browser speech cannot be routed through Web Audio (no echo, no PA processing) and its voices vary. The **HD voices** option runs Kokoro-82M (Apache-2.0, preset voices, **nobody is cloned**) in the browser: `am_onyx` (PA), `am_adam` (umpire), `am_michael` (play-by-play), `bm_george` (colour). Strictly opt-in: nothing is fetched until the player presses *Download HD voices* in Settings; `neural.ts` and `neuralWorker.ts` are separate lazy chunks (a few KB), the library `kokoro-js@1.2.1` is imported at run time from jsDelivr inside a module worker, and the model comes from the Hugging Face Hub (`onnx-community/Kokoro-82M-v1.0-ONNX`), cached by the browser (Cache API), so later visits start from the cache and the model is never part of the repo or the Pages bundle. (Reason for the CDN: kokoro-js's `phonemizer` embeds eSpeak NG, which is GPL; bundling it would put GPL code in an MIT repo.)
It sits behind the same `SpeechEngine` interface (`SwitchEngine` in `speech.ts` falls back to the browser voice whenever HD is not ready, a line fails, or the umpire call would arrive late on a slow CPU); the queue prefetches the next line while the current one plays; generation runs in the worker one job at a time; if the estimated backlog exceeds 7 s, chatter is dropped. Played through Web Audio: the PA voice is band-limited (320 Hz-3.4 kHz), driven, given a 190 ms slap-back and the stadium reverb; booth voices stay dry and close-miked. Measured numbers are in the report and below.
Measured in headless Chrome (desktop RTX GPU, 32 cores, not cross-origin-isolated so one WASM thread): WebGPU fp32 (326 MB): load 19 s, real-time factor 0.09-0.2 after warm-up (a 6 s line in 0.55 s); WASM q8 (92 MB): load 17 s, **real-time factor ~3** (a 3.5 s line takes 12 s), i.e. too slow for live chatter on the CPU path, which is why the UI warns and the queue sheds filler. Cross-origin isolation (threads) would help but GitHub Pages cannot set the headers. In the running app on the CPU path (forced with `?hdmode=cpu`, game rendering at the same time) the factor was 5-7: of 26 lines only 4 played with HD, 11 fell back to the browser voice (umpire calls go to the browser immediately when the factor is above 1), 34 chatter lines were shed and the backlog reached 18 s. So **the HD option is offered only when WebGPU exists** (`hdSupported()`); on the GPU path in the app (120 s at 1x, 37 lines generated, 39 played, 0 fallbacks, factor 0.16-0.18) it keeps up easily.

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
