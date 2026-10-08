# Audio (`src/audio/`)

Broadcast/stadium sound for the game: bat, ball and glove effects, a crowd that follows the situation, an organ, a PA announcer,
umpire calls and two-voice commentary. Everything is **synthesised in the browser** (Web Audio + DSP in plain typed arrays), so it always works;
the only recordings are three short CC0 applause clips (`public/audio/`, listed in `manifest.json`, credits in `public/audio/CREDITS.md`) that replace the synthesised applause when they load. It only *listens* to the game; it never
touches sim or engine state.

```
main.ts:  attachAudio(engine, root, { off: params.has('noaudio') })     // the whole integration
```

`attachAudio(engine, root, { ui: false })` skips this layer's own button / panel / prompt: the app (`src/ui`) drives `AudioController` (`settings`, `settingsChanged()`, `unlock()`, `isLocked`, and for HD voices `hdStatus()` / `subscribeHd()` / `hdToggle()` / `removeHd()`) from its menus and attaches it inside the *Start Game* click. One settings store (`Settings` in `mixer.ts`, saved under `claudeball.audio.v1`) serves both UIs:
`master`, `sfx`, `crowd`, `organVolume` (the organ's own slider), `announcer` (voices), `muted`, `pa` (PA announcer + umpire), `commentary`, `organ` (organ on/off), `chatter` (`low` / `normal` / `high`), `hd` (HD voices on), `venue` (`dry` / `normal` / `big`: the park's acoustics), `micPerspective` (`broadcast` / `close`), `duck` (`light` / `normal` / `strong`: how far the park sits back under the booth).

Controls: **M** mutes/unmutes (while audio is still locked, M / 🔊 / the prompt unlock it *and* unmute), the 🔊 button (top right, under the engine's control row) mutes, the ⚙ button opens volumes
(master / effects / crowd & organ / voices) and the **PA announcer & umpire** and **Commentary** toggles (default on). Settings persist
in `localStorage` (`claudeball.audio.v1`, every access in try/catch). Browsers only allow audio after a click or key press, so a
"Click to enable sound" pill shows until the context runs. `?noaudio` skips the layer completely.

## Flow

```
sim raw event bus ─┐                       ┌─ sfx   → positioned in the park → mic array ┐
(or engine events) ─┴→ CueMapper (cues.ts) ─┼─ crowd model (crowd.ts) → zones / one-shots → mic array   ├→ park bus → duck → master chain → out
   + frame-derived:   Cue[]                 ├─ organ → Organ → PA system → mic array               ┘          ▲ (sidechain key)
   bounces, slides,                         └─ speak → SpeechGate → PA voice (PA system) / umpire (field mics) / booth chain ─┘
   cleats (index.ts)
```
The mix is a broadcast's: the park has its own soundscape (everything sounds IN the ballpark, with its reverb and slap-back), picked up by
fixed microphones and mixed like a TV truck would; the camera never changes it. See **The park soundscape** below.

| file | what |
|---|---|
| `index.ts` | `attachAudio`, the controller: event intake, per-tick loop (30 Hz), modes (pause, replay, speed, skipping), frame-derived cues, `window.__audioDebug` |
| `cues.ts` | **pure** `CueMapper.map(event, ctx) → Cue[]` (sound choice by physics: exit velo/launch angle, pitch mph, throw distance ...), commentary text, speed gating. Unit-tested |
| `types.ts` | `Cue`, sound ids, `MapCtx` |
| `synth.ts`, `dsp.ts` | the sound recipes (bat crack in 3 strengths, thud, tick, bunt, whooshes, mitt/glove pops, bounce, dirt, wall, fence rattle, seat thump, throw, tag, slide, footstep, base, HBP, fireworks, PA mic click, crowd one-shots, crowd loops) rendered to Float32Arrays; deterministic per variant |
| `mixer.ts` | one `AudioContext`, the settings, buffer cache (rendered a few ms per timer tick after unlock, ~80 buffers; park sounds mono at the context rate), voice pool (cap 32 logical voices, each heard by up to 3 mics; importance-based stealing, per-sound min gap, nodes disconnected `onended`), replay/pause modes, crowd shots by zone |
| `venue/graph.ts` | the park and the broadcast chains as a Web Audio graph: mic strips, PA system, reverb and slap-backs, sidechain duck, booth chain, master chain |
| `venue/mics.ts` | **pure**: the mic plot, polar patterns, pickup maths (distance, delay, air, proximity), the pan law, crowd zones, PA speakers |
| `venue/ir.ts` | **pure**: the synthesised stadium impulse response (presets Dry / Normal / Big) |
| `venue/duck.ts` | **pure**: the sidechain follower (`duckStep`) and the AudioWorklet that runs it |
| `venue/analysis.ts` | **pure**: LUFS, true peak, RT60, spectra, envelopes (tests and the render tool) |
| `debugPanel.ts` | `?audiodebug=1`: live meters per mic, duck, zones, venue |
| `excitement.ts` | crowd level = smoothed (leverage baseline + event pulses); rises fast, calms slowly |
| `ambience.ts` | the crowd bed by zone: murmur, roar (and applause) loops per section of the stands, levels from the crowd model |
| `music.ts` | organ pieces as data (pure, tested): melody + chord changes compiled to timed notes. Includes the 7th-inning stretch (the chorus of *Take Me Out to the Ball Game*, 1908, public domain, transcribed note for note: 31 bars of 3/4 played oom-pah-pah), the charge call, a rally build, home-run fanfare, three ditties, the "shave and a haircut" sting, walk-up, dirge, three soft beds |
| `organ.ts` | the organ: drawbar-style tone (harmonics 1-6 and 8, 16' sub, decaying 2nd-harmonic percussion on lead notes, key click) through a rotary-speaker stage (AM + Doppler delay + stereo sway, ~0.9 Hz chorale or ~6.7 Hz tremolo for fanfares, soft saturation), one piece at a time with priorities (a fanfare cuts the stretch, nothing cuts a fanfare, anything cuts a bed), look-ahead scheduling, real cancellation |
| `commentary.ts` | the booth: play-by-play + colour analyst chatter grounded in the sim state (see below) |
| `synthJobs.ts`, `synthWorker.ts` | start-up synthesis as pure jobs, run in a worker (main-thread fallback) |
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
- **Replay** (director shot `replay`): new effects play at 0.6x speed through a produced, low-passed path (not the mics) and quieter, a whoosh marks the cut, the crowd carries on. **Pause**: effects and organ go silent, the murmur stays, speech pauses. **2x/4x**: minor cues (footsteps, base touches, return throws) are dropped at 2x, only key cues at 4x, speech is off above 1x. **Fast-forward (`n`)**: all cues dropped, speech cleared.

## Organ

Where you hear it: a walk-up riff for every home batter (under the PA), a rally build (`rally`) or `charge` on a home-team hit (rally when runners are on or for extra bases), `charge` on a home run scored / walk, the fanfare on a home-team homer and a win, the "shave and a haircut" sting on a home-pitcher strikeout, a rotating ditty at every half-inning change, the stretch at the 7th-inning break (the booth is held silent for it), and a soft chord-and-arpeggio **bed** in every break between half innings and between batters in every third half inning. Beds stop at the pitcher's windup (never during a pitch). Organ cues have importance >= 2 and survive 2x (off above 2x); it is silent while paused, muted, skipping or switched off, plays **through the PA system** (it sounds in the park: horns, slap-back, the bowl's reverb), lays out (-6 dB) under the PA announcer, sits under the booth through the sidechain duck, and has its own volume slider (`organVolume`).
Why it used to be inaudible (the investigation): at 4x the riffs were `imp: 1` and dropped by the speed gate (21 ditties and 44 stings mapped, none played), and at 1x the organ bus sat at crowd² × 0.55 with 0.16 note gain, far under the effects. Measured now with the analyser (headless, 1x, crowd bed + game): baseline RMS 0.047; charge/rally/fanfare/stretch 0.19-0.23; ditty 0.15; bed ~0.05 (soft by design, peaks 0.09); effects peak 0.75; overall peak < 0.8.

## The broadcast booth (`broadcast/`)

Two voices, a play-by-play announcer ("pxp") and a colour analyst, behave like a live TV booth.

**The cast** (`cast.ts`, fictional people, no real broadcaster's name, voice or catchphrase): **Lyle Pemberton** (play-by-play: twenty-six seasons, a pencil scorebook, ballpark history, dry wit), **Hollis "Biscuit" Dupree** (analyst: eleven seasons as a backup catcher, a .219 hitter with nine home runs he remembers one by one; sees the game from behind the plate, self-deprecating, not afraid to disagree) and **Clem Ashworth** (the PA). Each has a caption label (`LYLE` / `BISCUIT` / `PA`: sent as `label` and `name` in `speechStart`, and `audio.speakerLabel(role)` / `audio.speakerName(role)` / `audio.cast`), pronouns, traits, what the partner calls him (stories use `$other`: "Every run counts double in a tie game, Lyle"), and stable voices: the Kokoro preset (`HD_VOICES` is built from it: am_michael / bm_george / am_onyx), a browser-voice preference (`pickVoices`: both booth voices male-ish when the browser has three), the delivery (rate, pitch) every engine uses for his ordinary lines, and the custom voice pack's speakers (playbyplay + hype -> Lyle, color -> Biscuit). `CATCHPHRASES` and `RUNNING_JOKES` are rationed per game.

**The opening** (`pregame.ts`, `facts.ts`): the sim's first break is the pregame (`breakStart { pregame: true, sec }`: 60-90 s at Broadcast, ~36-54 s at Standard, ~15-22 s at Quick) and ends with the plate umpire's `umpireCall play_ball`. The PA welcomes the crowd to the park by name ("Good evening, ladies and gentlemen, welcome to Kestrel Park!"); then the booth runs a scripted **segment** fitted to the time left: the welcome (always: park, clubs, day of the week, the two names), then by importance the home starter (age, hand, velocity, his best pitch by scouting grade and how often he throws it, command), the records coming in and recent form, the analyst's hello, the weather and first-pitch time, the visiting starter, the lineups (the leadoff man's speed, the cleanup man's power, the best bat), the teams taking the field (in their colours), the umpire crew, the managers, the park and its quirk, the mascot, the PA man. At "Play ball!" a MUST handoff names the leadoff man and the pitcher and says "it's the top of the first" (the old "Here we go" / "The top of the 1st" / first batter intro are not said when there is an opening). Facts come from the sim's teams and `game.info` (`src/sim/gameinfo.ts`: park, officials, managers, records from team strength, date; generated on its own random streams); the weather is flavour derived from the seed and the renderer's sky (`host.env.todName`, `hdriActive`), consistent for the game; no wind claims unless the sim has a wind. A booth that starts late (audio attached during the pregame) opens from the snapshot's `lull` instead. Transcripts: `docs/booth-openings.md`.

**Breaks between half innings** (`segments.ts`, on `breakStart` after the pregame): the recap of the half that just ended ("Middle of the fourth, Chargers 3, Foxes 0. The Foxes scored two in the top, Campbell's two-run homer the big blow" / "Three up, three down for Gibson"), the pitcher's line so far (from the box score) with the analyst's read, now and then the clock and the temperature ("It's nine-twelve here at Kestrel Park, 79 degrees": first pitch plus ~19 minutes an inning, the night cooling a little), a park promo that fits the time of day, a running joke, and the hitters due up last. In every other long break (30 s and more) Lyle says "We'll be right back", the booth is silent like a commercial, and "And we're back. Due up ..." is timed to end with the break. Quick-tempo breaks (under 15 s) get one line: the score and who is due up. The seventh-inning stretch silences the booth: that break waits for the organ and comes back with a word about the stretch. When the sim has breaks, the break's recap replaces the generic "that'll do it for the top of the fourth" and "the bottom of the fourth" calls, and no topic starts while a break is waiting.

**The closing** (after `gameEnd`'s final call): the final at the park, the decisive moment from the game log (the hit that put the winners ahead for good, "breaking the tie" / "putting them ahead"), the winners' starter's line, the best bat's line, the records after tonight, a word from Biscuit that fits the score (a laugher, a nail-biter), and the sign-off: "For Hollis "Biscuit" Dupree, I'm Lyle Pemberton. Thanks for spending the night with us, and good night from Kestrel Park." 45 s, over the game-over screen; nothing else is said after it.

**A richer conversation.**
- *Moments* (`GameLog.moments`): home runs, run-scoring hits, robbed home runs, double plays and inning-ending strikeouts with runners in scoring position, with the runs and whether the batting side was behind, tied or ahead.
- *Callbacks*: "Last time up, Abbott drove in two runs with a double in the first", "That is the man who took a home run away from Rivera back in the fourth", "Campbell has struck out twice so far".
- *Catchphrases*, rationed per game: Lyle's "Pack a lunch!" goes on the end of his own home-run call; Biscuit's "Grown-man swing" and "Biscuits and gravy" come in over its last words.
- *Running jokes* (`RUNNING_JOKES`) come back in stages, with gaps of 10-25 minutes between them: Biscuit's nine career home runs whenever a catcher bats, the press-box sliders in long lulls, why they call him Biscuit, how few runners he threw out after a steal.
- *A light disagreement* after a pitching change, grounded in the pitch count and runs: Biscuit would have left a pitcher in at 85 pitches, Lyle takes the fresh arm, and they leave it at "that's why he manages and I talk". When it was clearly time, they agree.
- *A catcher's tangent* on a catcher's mound visit.
- *Long lulls* (mound visits, pitching changes, reviews with 15 s or more left): exchanges up to six turns, the starter's scouting report and the clubs' form coming in.
- *Names*: now and then (at most one topic in four, about a third of the time) a question goes to the partner by name ("..., Biscuit?") or the answer opens with it ("Well, Lyle, ..."); a player's name keeps its capital.
- *No repeats*: the last 150 lines are remembered (and every break line for the whole game); a call with the same words is re-worded from the lexicon, a story is rebuilt with other words or skipped, and the segments pick variants not said recently.

**Segments** (`Director.runSegment(segment, t, deadline)`): ordered turns grouped in blocks; optional blocks that would end after the deadline are skipped (with their replies), a MUST call pre-empts a turn and the segment resumes after it, turns wait while the field channel speaks when voices cannot overlap (`holdForField`), they play at every chatter level (the builder makes them short at Low), and the park-music rule (calls only while break music plays) does not silence a running segment. Everything here is pure TypeScript with injected clock / rng / duration function, so it is unit-tested deterministically (`broadcast/__tests__`, ~90 tests).

| file | what |
|---|---|
| `director.ts` | the turn-taking scheduler (see below) |
| `lexicon.ts` | what the play-by-play says for every sim event: 98 keys, 726 grammar templates (204 with he / him / his), 4-107 variants per event (`call` 96, `out` 107, `contact` 49, `plateAppearanceEnd` 45, `homeRun` 32, `walk` 20 ...), with direction / depth / hit-type words, runner and outs context, close plays, steal numbers, double / triple plays, grand slam / walk-off, robbed home runs; `EVENT_KEYS` + `SILENT_EVENTS` are checked against the sim's `GameEvent` list by a test |
| `grammar.ts` | `{a|b}` choices, `[optional]`, `$slot`; a missing slot yields nothing (never an invented fact) |
| `gamelog.ts` | the rolling game log: every pitch (type, mph, plate location, result, count), plate appearances, per-pitcher mix and streaks, per-count tendencies, batter vs pitcher, runs per half, steals, comebacks |
| `stories.ts` | conversation topics: 35 story types (first-pitch breaking ball, sequencing, pitch streaks, "on this count he has thrown the slider 4 of 5 times", times through the order, hot / cold bats, hat trick, pitcher cruising / rattled, velocity trend, pitch count, no-hitter, speed and steal threats, matchups, comebacks, zeroes, crowd ...) each with 2-4 turns (observation, question, answer, quip); `TopicPicker` scores salience, relevance, novelty and tension, never tells a fact twice, caps neutral fillers at 3 in a row |
| `booth.ts` | ties the log, lexicon, stories, director and colour reactions together; the opening, breaks and closing, catchphrases, running jokes, callbacks |
| `cast.ts` | the cast (names, labels, voices, catchphrases, running jokes, promos) |
| `pregame.ts`, `facts.ts` | the opening segment, weather and clock flavour, the facts read from the sim |
| `segments.ts` | the break and closing segments, callbacks |
| `gate.ts`, `channels.ts` | the speech gate (below) and the booth sink (excited delivery: faster, higher; cuts at a clause) |
| `lm.ts`, `lmClient.ts`, `lmWorker.ts` | the experimental tiny-LM plumbing (below) |

**Director.** Importance: *MUST* (outs, hits, runs, home runs, errors, K, walks ... never dropped; may cut a filler / colour / SHOULD line at its next clause, or at once if no clause ends within 1.5 s, unless that line has under 1.2 s left; never cuts another MUST; the other voice yields too), *SHOULD* (ball / strike calls, batted-ball calls, tags, steals: said only if the booth is free within 0.7 s, else NOT said over a line; its count is folded into the next batted-ball call as its own clause, "that makes it two and one", resolved when it is spoken, or dropped when stale), *COULD* (conversation topics and colour). One person talks at a time; 0.2-0.6 s beats between turns; short interjections ("Ooh", "Wow", "Nice piece of hitting") may start over the last 0.4 s of the other voice; a topic is dropped (with its remaining turns) when something more important arrives; after a topic the booth breathes (Normal 5-11 s, High 2.5-6 s, Low: calls only, no topics). Silent at 2x and above, while skipping, paused, muted, and during the stretch. The transcript script `npx tsx scripts/booth-transcript.ts [seed] [low|normal|high] [innings] [tempo] [day|dusk|night] [--opening]` plays a simulated game through the booth with a fake clock (a 3-inning game at Normal: ~145 utterances, ~1.5 words/s, about half the time speaking; High is denser, Low is calls only).

**PA and booth are separate channels.** The stadium PA announcer and the umpire (the *field* channel, a `SpeechQueue` for roles `pa` / `ump`) and the booth run independently through `SpeechGate`: with the HD voices (Web Audio: any number of lines at once, each routed by the mixer: the PA voice through the PA system into the park, the umpire as a source at the plate heard by the field mics, the booth through the broadcast voice chain) they overlap; the park (PA included) ducks under the booth through the sidechain and the booth sits about 2 dB under the PA, nothing is muted. **Browser speech synthesis has one global queue and cannot overlap**; with browser voices (and the single-line custom voice) the gate falls back to one line at a time, the field channel first, and a booth line that waited too long is dropped. The PA is about 4-5 dB quieter than before by default; `paVolume` has its own slider ("PA announcer", also in the app menu), umpire calls share it.

## Conversation and vocabulary

**Pronouns.** Every player is "he / him / his" (the owner's decision: "baseball is usually males playing"): "he'll hold at first", "he took that away", "his fourth strikeout". Nobody else is gendered: umpires are "the umpire", the crowd and the audience are neutral. A pronoun is only written where it can mean one person (the batter, the runner, the pitcher in a line that names only him; 204 templates in `lexicon.ts` plus pronoun variants in the stories), and tests check that no template says she / her, and none that mentions the umpire says he. The tiny-LM validator now accepts he / him / his and rejects she / her. Per-player gender is not modelled (the sim has none).
Excited calls (home runs, robbed home runs, walk-offs, double plays, diving catches) use `rate` 1.12 and `pitch` 1.1 for browser voices; for the HD voices the line is generated at speed 1.12/1.06 and played back 6% faster, so the pitch rises while the tempo stays. (Kokoro only takes voice and speed.)

## The crowd (`crowd.ts`, `ambience.ts`)

The crowd reacts to what happens. `crowd.ts` is a pure model (no Web Audio, no clock, no `Math.random`: the rng and the time step are injected; `__tests__/crowd.test.ts` has 15 tests). It keeps a stack of **envelopes** (attack / hold / decay per event, summed with a soft maximum on top of the situation's leverage: late innings, a close score, runners in scoring position), schedules **one-shots**, and makes a trickle of **incidental life**; `ambience.ts` only holds the bed: three looping buffers (murmur, roar wash, applause) with gain and low-pass automation, so the bed costs three sources and four parameters.

| event | reaction |
|---|---|
| `contact` | an immediate pop sized by exit velocity: a soft "ooh" for weak contact, a sharper rise (gasp + ooh) for hard hits; a fly ball with carry makes an **anticipation swell** that rises over its hang time (1-6 s) while the murmur holds its breath |
| foul call | the pop is cut at once, a small "aww": gone in a second or two |
| out / catch | caught fly: relief "ohh" (+ applause when the home defence made the out, an "aww" when it was the home batter); strikeout: cheer for the home pitcher, "aww" for the home batter; double / triple play; close play |
| hits | a cheer scaled by impact (single, double, triple) and by side: the home team's is loud; a visitor's is muted, with groans, a few boos and a small pocket of cheering |
| `homeRun` | home: a crescendo that keeps building for 4-8 s: first wave as it clears the wall, a long roar that peaks at ~4 s, clapping loop, whistles, a second wave and a wave of cheer that sweeps across the stands; visitor: groan, a few boos, a pocket of cheering |
| robbed home run | gasp, then a groan (home batter) or a roar and applause (home fielder) |
| count | two strikes with the home pitcher: the **clap-clap, clap-clap-clap** rhythm; swinging strike: an "oh"; the murmur leans in on two strikes and full counts and hushes right before the pitch in tense moments |
| others | walks (aww + boos for the home pitcher), steals (tension swell, then a pop), runs (roar, rally, walk-off: huge), pitching change, mound visit (conversation and quiet clapping), a ball tossed to a fan, game start / end, between-innings chants |
| life | lone claps, a shout, a whistle, a kid, a distant vendor-style call, a seat banging, pockets of conversation, a chant start, the wave: random, quieter when the game is hot, half as often on a phone |

The camera does not matter (a broadcast never mixes camera audio). The bed is seven **zones** (behind home, the home side on third, the third-base line, the visitors' first-base side, both bleachers, the upper deck): each has its own loops and its own level from the model, which keeps energy per side of the fans (home fans weigh the home team's envelopes, the visitors' sections theirs: a visitor's home run lifts the first-base side and the right-field bleachers while the home sections groan). One-shots carry a zone (or a pan that picks one), big roars fill the whole bowl (the house pair, the crowd mics and the reverb), the wave goes section by section; every zone is heard through the mics over it, early and close, and the other mics later and darker. Synthesised in `synth.ts` (nothing sampled, the CC0 applause clips still replace `applause` when present): 12 new sounds (`clap_single`, `clap_burst`, `whistle`, `shout`, `shout2`, `kid`, `vendor`, `chatter`, `chant`, `aww`, `oh_relief`, `boo_few`) and the applause loop. The old crowd cues of `cues.ts` are switched off in the running game (`crowdCues: false`); the model makes every crowd sound from the same events.

**Light on phones** (`perf.ts`, `?lowpower=1|0` forces it): the model advances at 10 Hz (5 Hz on a phone), the bed is three loops, one-shots are capped at 6 voices (3 on a phone), incidental sounds are half as frequent, footsteps are off and the controller tick runs at 15 Hz instead of 30. `__audioDebug.controller.debug.tickMs` is the moving average of one tick (about 0.4 ms measured on a desktop).

## Broadcast stings (`broadcastfx.ts`)

Subtle synthesised stings for the camera work, on their own bus with its own slider (**Broadcast effects**) and the master mute: a soft whoosh for a dissolve or a wipe, a tiny low tick on a hard cut to B-roll or out of a replay (an ordinary cut is silent), a whoosh with a short rising sting into a replay, a small blip when a graphic appears, a low thump on a stadium aerial. At most one every 3 s (a replay sting may follow after 1 s), never at 2x+, paused or skipping.

Input, two ways and never both: the engine's structured events `cameraCut { kind: 'cut' | 'dissolve' | 'wipe' | 'replay' | 'broll', from, to, durationMs }`, `replayStart`, `replayEnd`, `graphicShown { kind }` (through the engine's event stream, the sim's event bus or `audio.cameraEvent(ev)`), and until the first of them arrives the director's **shot name** changes (`host.director.shot`: into `replay`, out of it, `broll`, `wide`). `src/engine/README.md` does not list these events yet; once it does, check the field names against `FX_EVENT_TYPES` and `BroadcastFx.event`.

## Park music (`park/`)

Optional stadium music for the big moments, from files in `public/audio/music/` (see `docs/park-music-brief.md` for the 27 tracks to make, prompts for YuE, mastering, and licensing). **With no files the organ stingers play** (nothing changes); each trigger that has a file uses it and keeps the organ otherwise.

| file | what |
|---|---|
| `manifest.ts` | the triggers (`runScored`, `homeRun`, `rally`, `walkUp`, `inningBreak`, `pitchingChange`, `gameStart`, `finalWin`, `finalLoss`) with priority, wanted length, cooldown; `parseManifest` (validates what came over the network), `pickTrack` (weighted, avoids the last two), `buildManifest` (the index script's logic: keeps hand-tuned `gain` / `weight` / `loop`, warns about sizes, lengths, names, sample rate, missing variants) |
| `director.ts` | pure rules: the home team's good news only; priority finals > home run > rally > run > game start > pitching change > walk-up > break, nothing overlaps (a higher track fades the current one first), cooldowns, walk-ups and the break stop at the windup / when the next batter is called, the break is as long as `breakStart.sec`, the stretch is the organ's, a walk-off run has no stinger |
| `player.ts` | `ParkMusic`: manifest (fetched once, at app boot), decisions -> files, **streamed** through a media element (no whole-track decode: light on phones), fades, only the next likely files fetched ahead (2 on a phone, none on data saver), a failing file is never retried and the organ stinger plays instead; `WebAudioMusic` is the real backend |

Mixing: music plays **through the PA system** into the park (horns, slap-back, the bowl's reverb, picked up by the mics), with its own level slider (**Park music**, switch on/off, default on at a modest level); it sits under the booth through the sidechain duck, about 4 dB under the PA announcer and under big crowd moments; it is silent while paused, skipping, at 2x+ or muted, and the organ stays quiet while a track plays. While the break music plays the booth keeps to the calls (chatter `low`). `scripts/music-index.ts` (`npm run audio:music:index`) writes `manifest.json` (durations from `ffprobe`, or the Ogg header). Check with `?musictest=homeRun` (or `a,b`, or `all`); `__audioDebug.state.music` shows what plays and the last decisions.

## The park soundscape (`venue/`)

The ballpark has its own soundscape: the organ, the PA announcer, the park music, the crowd and every bat crack and glove pop sound
**in the park** (they ring around the bowl, slap back off the upper deck and the scoreboard), and the broadcast hears them the way a TV
crew does: through **fixed microphones** around the park, mixed in the truck. The active camera never changes the mix. The announcers are
separate: close-miked headsets, a broadcast voice chain, and the park ducks out of their way.

```
 PARK (in the ballpark)                                                         MIC ARRAY (fixed)               TRUCK
 bat / mitt / glove / bounces / wall / slides / cleats ─ K=3 copies, flight-time ─┐
 umpire's voice (at the plate) ──────────────────────── delay + gain pairs ──────┤   per mic: input (mono)
 crowd: 7 zone beds (loops) ─ zone level / low-pass ─── delay + gain pairs ──────┤   -> EQ (the mic's colour)
 crowd one-shots (a seat in a zone; roars: the whole bowl) ─ K=2 copies ─────────┤   -> static pan -> PARK BUS ─┐
 PA SYSTEM: PA voice + organ + park music                                        │   -> reverb send ┐          │
   -> 150 Hz-7 kHz horns, presence, drive -> 4 clusters (0-41 ms) ─ pairs ───────┘                   │          │
   -> slap-backs 210 / 290 ms (upper deck, scoreboard) ───────────────────────────────────────────────┼─────────┤
   -> heavy reverb send ──────────────────────────────────────────────> CONVOLVER (stadium IR) ─────┘          │
                                                                                                                 ▼
 PARK BUS -> DUCK (gain + dynamic 1-4 kHz cut, keyed by the booth) ─────────────────────────────────────> MASTER ─> HP 60 Hz -> glue
 BOOTH: per-voice EQ -> HP 90 -> presence +2.5 dB @ 3 kHz -> de-ess shelf -3 dB @ 7.5 kHz -> compressor 3.5:1 ─>     -> limiter -> soft
        -> makeup -> soft limiter -> announcer fader ─┬────────────────────────────────────────────────> MASTER       clip -1 dBFS -> out
                                                      └─> sidechain key (AudioWorklet; phones: analyser + timer)
 BROADCAST FX (camera stings, replay whooshes): dry, centred ──────────────────────────────────────────> MASTER (not ducked)
 REPLAY (slow-motion SFX): produced path, 0.6x, low-passed ────────────────────────────────────────────> PARK BUS
```

**Pickup physics** (`venue/mics.ts`, pure, tested). For each source position and mic: inverse-distance attenuation with a floor (`ref`),
the polar pattern toward the mic's aim (omni, cardioid family, shotgun, parabolic dish, boundary half-space), **propagation delay**
(343 m/s, relative to the mic that hears it first, so the nearest mic is in sync with the picture: the bat crack reaches the centre-field
wall mic ~0.3 s after the dish behind home), air absorption (a 4.2 kHz low-pass for pickups beyond 42 m or behind a directional mic's
axis), and a proximity bass boost for a directional mic within a metre. A one-shot is the same buffer started K times (one per mic, at its
delay, one gain each; one logical voice against the cap); continuous sources (zone beds, PA clusters, the umpire) are wired once with a
DelayNode and a gain per pickup. Per-frame JS: none (pickups are computed when a sound is triggered).

**Stereo image** (fixed): it matches the main camera, the centre-field "pitch" shot (telephoto from behind the pitcher). From there
**third base is on screen right** and first base on the left, and the telephoto view makes screen-x almost exactly sim X, so a mic's pan
is `PAN_SIGN * x / 62 m` (the plate, the mound, centre field and the crowd behind home are centred). `PAN_SIGN` in `venue/mics.ts`
flips the whole image in one place (for a high-home main camera, say).

| mic | position (x, y, z m) | aimed at | pattern | fader | pan | reverb send | phones |
|---|---|---|---|---|---|---|---|
| `plate` Parabolic, behind home plate | 0, 1.2, -17 | 0, 0.9, 1 | parabolic | +14 dB | 0.00 | 0.05 | yes |
| `first` Shotgun, first base | -27, 0.6, 15 | -19, 0.0, 19 | shotgun | +9 dB | -0.44 | 0.08 | yes |
| `third` Shotgun, third base | 27, 0.6, 15 | 19, 0.0, 19 | shotgun | +9 dB | 0.44 | 0.08 | yes |
| `infield` Boundary, second base / mound | 0, 0.1, 30 | 0, 5.0, 25 | boundary | +6 dB | 0.00 | 0.1 |  |
| `wall_lf` Boundary, left-field wall | 53, 1.5, 100 | 30, 1.0, 60 | boundary | +4 dB | 0.86 | 0.2 |  |
| `wall_cf` Boundary, centre-field wall | 0, 1.5, 122 | 0, 1.0, 60 | boundary | +4 dB | 0.00 | 0.2 | yes |
| `wall_rf` Boundary, right-field wall | -53, 1.5, 100 | -30, 1.0, 60 | boundary | +4 dB | -0.86 | 0.2 |  |
| `dugout` Shotgun, home dugout (3B side) | 21, 1.6, 1 | 19, 0.6, 3 | shotgun | 0 dB | 0.33 | 0.05 |  |
| `crowd_home` Crowd, behind home (lower bowl) | 0, 12.0, -28 | 0, 6.0, -36 | cardioid | 0 dB | 0.00 | 0.25 | yes |
| `crowd_3b` Crowd, third-base side | 40, 12.0, 12 | 48, 6.0, 14 | cardioid | 0 dB | 0.65 | 0.25 | yes |
| `crowd_1b` Crowd, first-base side | -40, 12.0, 12 | -48, 6.0, 14 | cardioid | 0 dB | -0.65 | 0.25 | yes |
| `crowd_lf` Crowd, left-field bleachers | 60, 13.0, 100 | 68, 8.0, 112 | cardioid | -1 dB | 0.95 | 0.35 |  |
| `crowd_rf` Crowd, right-field bleachers | -60, 13.0, 100 | -68, 8.0, 112 | cardioid | -1 dB | -0.95 | 0.35 |  |
| `crowd_upper` Crowd, upper deck | 0, 30.0, -40 | 0, 26.0, -52 | supercardioid | -2 dB | 0.00 | 0.4 |  |
| `house_l` House pair, left (1B side) | -4, 22.0, -36 | -30, 0.0, 50 | cardioid | +2 dB | -0.85 | 0.45 | yes |
| `house_r` House pair, right (3B side) | 4, 22.0, -36 | 30, 0.0, 50 | cardioid | +2 dB | 0.85 | 0.45 | yes |

| zone | centre (x, y, z m) | home fans | size |
|---|---|---|---|
| `backstop` Behind home plate | 0, 6.0, -30 | 75 % | 1 |
| `home_side` Home-side infield (3B) | 34, 7.0, 4 | 92 % | 1 |
| `line_3b` Third-base line | 52, 8.0, 42 | 85 % | 0.9 |
| `line_1b` First-base side (visitors) | -40, 7.0, 24 | 50 % | 1 |
| `lf_bleachers` Left-field bleachers | 64, 9.0, 108 | 80 % | 0.8 |
| `rf_bleachers` Right-field bleachers | -64, 9.0, 108 | 60 % | 0.8 |
| `upper_deck` Upper deck | 0, 26.0, -50 | 72 % | 1.1 |

| PA cluster | position | delay | level |
|---|---|---|---|
| main | 62, 14.0, 92 | 0 ms | 1 |
| home | 0, 17.0, -36 | 12 ms | 0.8 |
| line_3b | 42, 15.0, 14 | 34 ms | 0.55 |
| line_1b | -42, 15.0, 14 | 41 ms | 0.55 |

Phones (`perf.ts` low power) use the 9 mics marked above, 2 pickups per one-shot (1 for crowd), 4 zones (each folds its neighbours),
a mono 1.6 s IR spread by a 13 ms offset copy, the analyser-driven duck instead of the worklet, and no glue compressor.

**Venue** (`venue/ir.ts`): one shared convolver with a synthesised IR (deterministic): pre-delay, eight early reflections (lower bowl
22 ms ... scoreboard 248 ms), a diffuse tail in four bands with their own RT60 (highs die faster), decorrelated stereo, unit energy.
Measured (T30 / per octave): **Dry** ~1.0 s, **Normal** 2.1 s mid (250 Hz 2.35 s, 1 kHz 2.1 s, 4 kHz 1.44 s, 8 kHz 1.04 s),
**Big** ~2.5 s; wet return 0.16 / 0.30 / 0.38; the slap-backs scale 0.4x / 1x / 1.25x.

**Levels** (set by measurement: `render.ts --stems`, each family alone through the whole chain; the booth is the anchor). Game scene at the
default settings: master **-16.6 LUFS integrated, true peak -3.5 dBTP, no clipping** (phones -16.2 LUFS, -2.0 dBTP); booth -13 LUFS while
talking, organ -18, PA voice -19, crowd -18 (calm bed about 11 dB under the booth, a home-run roar ~2 dB under the booth's peaks), field
effects -19 (bat crack momentary max -15). **Gain staging**: Chrome's DynamicsCompressor adds automatic makeup gain (~+11 dB on the booth
compressor, ~+2 dB on the limiter), so the booth's own makeup is -6 dB and its level sits in its fader, and the master's output trim keeps
the limiter's peaks ~2 dB under the soft clipper's knee: the clippers are a safety net that does not act (`render.ts --null-clip`: the
render with linear clippers differs by -92 dB, phones -61 dB). The knobs: `MAKEUP` (master), `BOOTH_LEVEL`, `ORGAN_LEVEL`, `MUSIC_LEVEL`,
`PA_LEVEL` in `mixer.ts`; `TRIM` (sfx / crowd one-shots / beds / PA into the mics / umpire) in `venue/graph.ts`; mic faders in `MICS`.
Park music cannot be rendered offline (it streams): `MUSIC_LEVEL` matches the organ's and was not measured.

**Duck** (`venue/duck.ts`): `duckStep` follows the booth bus (mean square per 128-sample block, 5 ms up / 120 ms down detector), a gain
computer (threshold -50 dBFS, 14 dB range to full depth), attack 50 ms, hold 250 ms (bridges the gaps between words), release 500 ms;
depth 4 / 7 / 10 dB (setting) and a further 2.5-5 dB cut of the 1-4 kHz band of the park (a peaking filter at 2.2 kHz driven by the same
envelope: the crowd stays big, the voice clear). A crowd peak (a home-run roar) shallows the duck to as little as 45 % of its depth.
Browser speech is outside Web Audio, so then the speech gate's "booth is talking" flag is the key (`ext`). Measured in the render: -8 dB
at full duck (gain plus presence cut, RMS of the park), 90 % in ~100 ms, back within 1 dB ~1.3 s after the line.

### Tuning guide

- *The organ / PA sounds too far away*: lower `paVerb` (graph.ts, 0.55) or the venue's `wet`; raise `ORGAN_LEVEL`.
- *Too much echo on the PA*: the slap-back gains (`slap(0.21, ..., 0.2, ...)`), or Venue: Dry.
- *Bat crack too thin / too boomy*: the `plate` mic's tone (`TONE.parabolic`, a 260 Hz high-pass) and fader; `TRIM.sfx`.
- *Crowd too loud under the booth*: `TRIM.bed` (the bed), `TRIM.crowd` (one-shots), or the duck setting; `setCrowdEnergy` (mixer)
  sets how much a big moment shallows the duck.
- *The image leans*: check mirrored mics in the debug panel; `PAN_WIDTH` sets the spread, `PAN_SIGN` the orientation.
- *CPU*: every always-on node costs (measured with `render.ts --bench`, ms of CPU per audio second per node on this desktop: convolver
  12 (mono IR 6), DynamicsCompressor 2.1, a 16 kHz buffer resampled 0.9, a 2x-oversampled WaveShaper 0.9, biquad 0.34, delay 0.19,
  panner 0.14, gain 0.07). Keep strips to one EQ, park buffers at the context rate, pickups few.

### Verifying without ears

- `?audiodebug=1`: the live panel.
- `npx tsx tools/audio/render.ts [--tag NAME] [--scenes game,impulse,duck,organ,pa-noise] [--venue big] [--lowpower] [--stems] [--reps 3] [--null-clip] [--determinism] [--bench]`
  renders the real graph on an OfflineAudioContext (headless Chrome via the dev server) to `~/claudeball-audio-renders/<tag>-<scene>.wav`
  (never in the repo) with `<tag>-analysis.json`: integrated / momentary loudness, loudness range, true peak, clipping, CPU ms per audio
  second, the venue's RT60 from the rendered tail and from the IR (per octave), the duck's depth over time (the park with the booth muted
  but still keying, against no booth), the PA's frequency response (white noise in: -6 dB edges), per-family stems. The scene: an organ
  phrase, a PA line, a pitch, a hard bat crack at the plate, a fly ball to the left-field fence, a home-run roar, booth lines over it.
  Booth / PA lines use the owner's first local recording in `~/claudeball-voice/wavs` if present, else a synthetic speech-like signal.
- `npx tsx tools/audio/live.ts [--cpu 4 --lowpower] [--audiodebug]`: the running game's audio tick cost and the panel.

**Cost** (A/B interleaved under the same load, offline render on this desktop, ms of audio-thread CPU per second of audio; the old graph
from `ee33acc`): game scene old 17.4 -> **new 60** (desktop graph) / **32.5** (phone graph); near-idle old 7.5 -> 28 / 14. The new
desktop graph is ~6 % of one core, the phone graph ~2x the old cost; all of it on the audio thread. The main-thread audio tick did not
change (`tools/audio/live.ts`: median 0.10 -> 0.11 ms on desktop, 0.43 -> 0.35 ms with 4x CPU throttling + low power). Renders repeat
to within 3e-5 (about -91 dBFS; the crowd beds' first moments differ between runs: not bit-exact, cause not found).

**Start-up, the hidden page, the sample rate** (perf pass 2, `tools/perf/FINDINGS.md`):
- Every sound is synthesised at start (101 effects and crowd one-shots, the three bed loops, the stadium IR: ~0.9 s of maths on this
  desktop, single jobs up to 115 ms). `synthJobs.ts` holds the jobs as pure functions; `synthWorker.ts` runs them off the main thread and
  the mixer turns each result into an AudioBuffer as it lands (`Mixer.prepare`). Without a worker (the offline render tool, tests) the
  same jobs run on the main thread, at most 6 ms per timer tick. On the main thread they used to freeze frames for 210-360 ms as the game
  started on a phone-class CPU.
- The context is suspended while the page is hidden (another app, a background tab) and resumed when it is shown again.
- `?audiorate=32000` runs the context at 32 kHz (an experiment, not the default; measured numbers in FINDINGS).

## HD voices (optional neural speech)

`hd.ts` is a manager that outlives games: download, progress, cache check and a *Preview voices* button work from the title menu before any game or `AudioContext` exists (an `AudioBuffer` belongs to no context; the preview makes its own mixer on the click), and a new game just rebinds its mixer, so the model is not reloaded or re-downloaded. Clause-by-clause synthesis for the booth (the first clause plays sooner, a cut happens exactly at a clause), one generation job at a time in priority order (a spoken line > the next queued line > background warm-up of the umpire's calls), concurrent playback for the channels.

Browser speech cannot be routed through Web Audio (no echo, no PA processing) and its voices vary. The **HD voices** option runs Kokoro-82M (Apache-2.0, preset voices, **nobody is cloned**) in the browser: `am_onyx` (PA), `am_adam` (umpire), `am_michael` (play-by-play), `bm_george` (colour). Strictly opt-in: nothing is fetched until the player presses *Download HD voices* in Settings; `neural.ts` and `neuralWorker.ts` are separate lazy chunks (a few KB), the library `kokoro-js@1.2.1` is imported at run time from jsDelivr inside a module worker, and the model comes from the Hugging Face Hub (`onnx-community/Kokoro-82M-v1.0-ONNX`), cached by the browser (Cache API), so later visits start from the cache and the model is never part of the repo or the Pages bundle. (Reason for the CDN: kokoro-js's `phonemizer` embeds eSpeak NG, which is GPL; bundling it would put GPL code in an MIT repo.)
It sits behind the same `SpeechEngine` interface (`SwitchEngine` in `speech.ts` falls back to the browser voice whenever HD is not ready, a line fails, or the umpire call would arrive late on a slow CPU); the queue prefetches the next line while the current one plays; generation runs in the worker one job at a time; if the estimated backlog exceeds 7 s, chatter is dropped. Played through Web Audio: the PA voice goes through the PA system (150 Hz-7 kHz horns, drive, clusters, slap-backs, the bowl's reverb); booth voices go through the broadcast voice chain, dry and close-miked. Measured numbers are in the report and below.
Measured in headless Chrome (desktop RTX GPU, 32 cores, not cross-origin-isolated so one WASM thread): WebGPU fp32 (326 MB): load 19 s, real-time factor 0.09-0.2 after warm-up (a 6 s line in 0.55 s); WASM q8 (92 MB): load 17 s, **real-time factor ~3** (a 3.5 s line takes 12 s), i.e. too slow for live chatter on the CPU path, which is why the UI warns and the queue sheds filler. Cross-origin isolation (threads) would help but GitHub Pages cannot set the headers. In the running app on the CPU path (forced with `?hdmode=cpu`, game rendering at the same time) the factor was 5-7: of 26 lines only 4 played with HD, 11 fell back to the browser voice (umpire calls go to the browser immediately when the factor is above 1), 34 chatter lines were shed and the backlog reached 18 s. So **the HD option is offered only when WebGPU exists** (`hdSupported()`); on the GPU path in the app (120 s at 1x, 37 lines generated, 39 played, 0 fallbacks, factor 0.16-0.18) it keeps up easily.

## Voices (SpeechSynthesis)

Umpire calls (`Strike!`, `Ball four!`, `Foul ball!`, `Safe!`, `Out!`), the PA (`Now batting, number 23, ...`, `Now pitching ...`, welcome) and the two commentators
(play-by-play uses the sim's own `playEnd` description plus the score; colour adds stats such as exit velocity, strikeout count, batter's line) use the browser's voices.
Limits, honestly: browser speech **cannot be routed through Web Audio**, so there is no convolver/echo on the voices (the PA feel comes from a lower pitch and slower rate plus a synthesised
"mic click" and click before announcements) and their volume is only the utterance volume. The browser has one speech queue, so the queue speaks one line at a time. Voices load
asynchronously and headless/Linux browsers may have none; then speech is a silent no-op, and umpire calls fall back to a synthesised shout.
Players are "he / him / his" (see Pronouns above).

## Debug hook

`?audiodebug=1`: a live panel (master level, the duck's reduction, a meter per mic, the zones' levels, who is talking, voices, the venue's RT60). `window.__audioDebug`: `controller.mixer.debugInfo()` (voices, sources, graph stats: worklet / nodes / mics / venue), `state` (context state, buffers prepared, live voices, excitement, speech stats, organ riffs, per-sound play counts), `cues` (last 300: kind, id, played, text),
`mapped` / `played` (counters; *mapped* counts every cue before speed gating or voice limits, *played* what actually started), `perHalf` (mapped counts per `1t`, `1b`, `2t` ...),
`energy` (output RMS/peak every 100 ms from an `AnalyserNode`), `speechLog`, `level()`.

## Tests

`npm test` runs `src/audio/__tests__` and `src/audio/venue/__tests__`: event → cue mapping (incl. junk input and pronoun check), the mic maths (delays, distance law, polar patterns, pan law), the IR's RT60 per band, the duck follower and its worklet source, excitement, the speech queue (fake engine), every synth recipe renders finite/non-silent audio,
and the mixer against a fake `AudioContext` (voice cap, stealing, node disconnect on end, mute, replay slow-down, no-op without audio).

## What audio would like from the sim/engine

Nothing blocking. Nice to have: an event for a batted ball landing, the fence-contact `speed` for foul balls into the stands, and catch events for the casual `ballReturn` legs.

## My voice (custom announcer), `voice/`

An opt-in third speech engine: the owner's own trained voice (recorded and trained with `tools/announcer/`, see `docs/announcer-voice.md`). It reuses the HD-voice plumbing: `voice/packSynth.ts` is a `Synth` that the same `NeuralSpeechEngine` drives (one speech queue, prefetch, PA processing, browser-voice fallback on any failure or slow line), installed in `SwitchEngine.neural` by `voice/controller.ts`; switching it on turns Kokoro off and vice versa. `voiceManager.ts` makes it outlive games like `hd.ts` does for Kokoro: the title menu can load the pack (URL or files), preview it and switch it off before any game; a game's controller just binds its mixer and follows whichever engine is on. Because the engine is the same concurrent `NeuralSpeechEngine`, the custom voice overlaps PA and booth too.

| file | what |
|---|---|
| `normalize.ts` | game text -> spoken words ("94" -> "ninety-four", "6-4-3" -> "six-four-three", ".241" -> "two forty-one"); the recording script and the training data use the same function |
| `phonemize.ts` | words -> Piper phoneme ids through the voice pack's lexicon (no espeak-ng in the browser); twin of `tools/announcer/train/common.py` |
| `pack.ts` | the `voice.json` manifest (validated), URL / local-file loading, Cache API storage, `chooseStyle` (PA/umpire crisp, colour deadpan, play-by-play follows crowd excitement and the words) and the style -> speaker map |
| `synthCore.ts`, `worker.ts` | the synthesis (needs only an `ort`-shaped object, so it is unit-tested with a mock) and the module worker; onnxruntime-web is imported at run time from a pinned jsDelivr URL (or `runtime.ortUrl` in `voice.json`), never bundled |
| `clips.ts`, `clipSynth.ts` | optional bank of the owner's real recordings, stitched for lines it covers exactly; else the model |
| `controller.ts`, `panel.ts` | state (off/loading/ready/error), persistence (`claudeball.voicepack.v1` in localStorage), and the block in the audio panel (URL box, file picker) |

Nothing is downloaded until the owner switches it on, and the voice pack is never part of the repo or the build. Debug: `__audioDebug.state.speech.voice` (state) and `.voiceStats` (generated / played / fallbacks / failures).

## Captions API (`captions.ts`, for the UI)

```ts
const off = audio.onSpeech((e) => {
  if (e.type === 'speechStart') show(e.id, e.channel, e.speaker, e.text);          // a line starts to sound
  else if (e.truncatedAt !== undefined) trim(e.id, e.truncatedAt);                  // it was cut / cancelled: the caption ends here
  else done(e.id);                                                                  // it was said to the end
});
audio.speakingNow();  // lines sounding right now: a caption UI that subscribes late
audio.clockMs();      // the clock of startMs / endMs (AudioContext time in ms)
```

* `speechStart { id, channel: 'booth' | 'pa' | 'umpire', speaker: 'pbp' | 'color' | 'pa' | 'ump', text, startMs, expectedDurationMs, excited }`. `text` is exactly what the voice is given (no markup; a booth line that had the live count folded in already contains it, "(Now one and one.)": folds are resolved when the line is spoken, so there is no later text edit). `startMs` is when the line really started to sound (the engine's start callback: browser `onstart`, or the first clause of an HD / custom-voice line), on the audio clock. `expectedDurationMs` is an estimate from the words (a real end comes with `speechEnd`).
* `speechEnd { id, endMs, reason: 'finished' | 'cut' | 'cancelled' | 'error', truncatedAt? }`. `truncatedAt` is the number of characters of `text` that were spoken: a booth line cut by the director ends at a clause (`reason: 'cut'`); a more important line, pause, skip or mute cancels (`'cancelled'`). The HD voices report the exact count (completed clauses plus the fraction of the current one), other engines get an estimate from the elapsed time. Absent when the whole line was said.
* A line that never sounds (dropped as stale while waiting for a one-line-at-a-time browser voice, a failed voice, muted roles, speed above 1x) produces no events. Listeners that throw are ignored. PA, umpire and booth lines can overlap with the HD voices, so several lines can be started at the same time; use `id`.
* Implementation: `SpeechGate` (`broadcast/gate.ts`) wraps every line of both channels; engines say they report starts with `emitsStart` and `SpeakOptions.onstart`, and optionally give `SpeakHandle.spokenChars()`. Tests: `broadcast/__tests__/captions.test.ts`.

## Tiny language model for colour lines (experimental, off by default)

`?lm=1` (WebGPU only) loads an in-browser model in a worker (`lmWorker.ts`, transformers.js and weights fetched from jsDelivr / Hugging Face at run time, nothing bundled), prompts it with a compact facts JSON, a style guide and the last lines, validates the answer (every number and name must be in the facts, no pronouns for players, length, no repetition) and uses it for a colour line now and then; late, invalid or failed answers fall back instantly to the grammar. **Evaluation (30 sampled game situations, headless Chrome, RTX GPU, q4, transformers.js 3.8 / 4.3, prompt ~300 tokens):**

| model | licence | download | load | first token | total / line | tok/s | VRAM | validator pass | usable lines (my reading of all 30) |
|---|---|---|---|---|---|---|---|---|---|
| Qwen2.5-0.5B-Instruct | Apache-2.0 | 786 MB | 47 s | 403 ms | 1.6 s | 23 | +1.7 GB | 11/30 | 0 |
| SmolLM2-360M-Instruct | Apache-2.0 | 386 MB | 46 s | 459 ms | 1.2 s | 21 | +1.2 GB | 13/30 | 0 |
| LFM2-350M | LFM Open License v1.0 | 294 MB | 23 s | 54 ms | 0.47 s | 112 | +0.55 GB | 17/30 | 0 |
| LFM2-700M | LFM Open License v1.0 | 559 MB | 45 s | 90 ms | 0.42 s | 107 | +0.9 GB | 20/30 | ~1 |
| LFM2-1.2B | LFM Open License v1.0 | ~800 MB | 72 s | 133 ms | 0.32 s | 105 | +1.0 GB | 21/30 | ~3 |

Speed is fine for the LFM2 models (well inside a 1.5 s budget, 100+ tok/s; Qwen / SmolLM2 are 3-4x slower). **Quality is not**: the validator only checks surface grounding, and lines that pass it are still mostly nonsense or wrong ("hitting a home run" in a game without one, "60 hits", "Ramirez faced 87 inning", a pitcher who "struck out twice"), they do not sound like colour, and the 0.5B models degenerate; a rewrite-the-grammar-line variant was worse. All 30 grammar lines for the same moments are coherent. With Kokoro (326 MB) alongside, the combined download is 0.6-1.1 GB and the GPU holds both. **Recommendation: do not ship it.** The plumbing stays behind `?lm=1` for a future, better model (raw outputs: the report's library folder; reproduce with `scripts/lm/`). LFM Open License v1.0 (checked from the model repo): Apache-style grant, redistribution with the licence copy, but commercial use is only licensed for entities below USD 10M annual revenue; this MIT repo redistributes no weights (the player's browser downloads them), so it is compatible for a hobby / non-commercial project, but anyone commercial above that threshold would need their own arrangement; Qwen2.5 and SmolLM2 are Apache-2.0.

## Scripts

`tools/audio/render.ts` (headless render of the whole graph to WAVs + analysis, see below), `tools/audio/live.ts` (the audio layer's tick cost in the running game, `--cpu 4 --lowpower` for a phone, `--audiodebug` prints the panel), `tools/audio/bench.ts` (Web Audio node costs, `render.ts --bench`).
`scripts/crowd-check.cjs` (a game in headless Chrome: crowd level timeline, which reactions played, music decisions, stings, tick cost), `scripts/music-index.ts`.

`scripts/booth-transcript.ts` (a game through the booth), `scripts/audio-check.cjs` (headless Chrome: fake browser voices or the HD voices, PA/booth overlap, errors), `scripts/modal-shots.cjs` (in-game panels at five viewports), `scripts/lm/` (LM benchmark and evaluation). The browser scripts need Playwright 1.58 (`PLAYWRIGHT_DIR`).
