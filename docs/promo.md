# Promo video (t-0019)

A hype trailer for Claudeball made only from the real game: real simulated games found by a headless scout, rendered frame by frame by the
real engine in headed Chrome on the real GPU, with the game's own audio graph rendered offline in the same pass (sample-accurate with the
picture). Outputs live outside the repo in `~/claudeball-promo/` (`CB_PROMO_DIR`); nothing but the README teaser is committed.

## Re-render everything

```sh
npm ci && npm run hdri                       # the deployed site's HDRI skies (the promo uses them)
npm run promo:scout -- --count 240 --jobs 12 # optional: the highlight search -> ~/claudeball-promo/scout.json (~5 min)
npm run promo:render -- --preview            # 960x540 @ 30 fps, quick (~35 min cold, minutes when cached)
npm run promo:render                         # 1920x1080 @ 60 fps master
npm run promo:render -- --4k                 # 3840x2160 @ 60 fps (the 1920x1080 viewport at device scale 2)
npm run promo:render -- --vertical           # the 9:16 cut (its own shots, phone-portrait viewport)
```

Stages (`--stages capture,sheets,titles,mix,picture,encode`): **capture** each shot (cached in `~/claudeball-promo/cache/<size>@<fps>/<shot>/`
with a manifest whose hash covers the shot spec, the render settings and the build, so only changed shots are re-shot; `--only id,id`,
`--force`), **sheets** (a contact sheet per shot in `~/claudeball-promo/sheets/`), **titles** (the typography layer as transparent PNGs),
**mix** (music bed + effects + each cut's game audio + the booth, ducked, mastered to -14 LUFS / -1 dBTP; stems in `edit/<tag>/stems/`),
**picture** (the timeline as symlinks into the cached frames, plus composites), **encode** (H.264 high, yuv420p, faststart, AAC 320k).

Other tools: `tools/promo/shoot.ts` (one shot from a JSON spec or a shot id, with a contact sheet: for trying camera moves),
`tools/promo/qa.ts` (contact sheets of the real broadcast with the director's shot names and an occlusion probe), `tools/promo/trace.ts`
(the sim's events and everybody's positions at given times, for designing a shot), `tools/promo/gate1.ts` / `gate2.ts` (the browser game
reproduces the headless scout; the capture is the frame that was ticked).

## How the capture works

Chrome runs **headless on the GPU** (`--headless=new`, Vulkan ANGLE on the RTX 4090: check the `ANGLE (NVIDIA ...)` line in the log); a headed
window that the desktop hides stops getting frames and its screenshots stall (`CB_PROMO_HEADED=1` brings the window back).
`?promo&autostart&noaudio` loads `src/promo/runtime.ts` (a lazy chunk, like the benchmark). It stops the engine's own loop and installs a
**virtual clock** (`performance.now`, `Date.now`, timers, `requestAnimationFrame` only move when the driver advances them), seeds
`Math.random`, fast-forwards the sim to the shot (unrendered), attaches the game's audio controller to an **OfflineAudioContext** (six
channels: the game's own broadcast mix, the park before the booth's duck, the booth), enables the HD voices (Kokoro, cached in the promo's
Chrome profile) and waits for every line to be generated before time moves on, then plays a pre-roll and the shot. Per frame:
camera (a scripted path or the broadcast director), the slow-motion ramp (`sim.speed`, with the sim stepped at 1/240 s for ultra slow
motion), timers, `engine.tick`, HUD CSS animations moved to the virtual time, the audio rendered up to the frame's time, and the canvas
read in the same task (~5 ms). Shots with the HUD need a page screenshot (~17 ms headless).

**Takes.** The game is the same at any frame rate (the director's cuts land within a frame of each other at 30 and 60 fps), but the booth's
*wording* changes from take to take, so the edit never pins a line by its text: a voice track is anchored on its event (the first booth
line after the `homerun`), and cuts into a broadcast shot are anchored on what it shows (the first `replay`, `cutaway-crowd`, `homeplate`
frame). Full-size renders save only the frames the edit uses (+-1 s) of shots without anchors; a preview saves everything.

## Storyboard (120 BPM, a bar = 2 s, 74 s)

| time | beat | picture | type | sound |
|---|---|---|---|---|
| 0-14 | cold open | night aerial orbit; crane down to the pitcher under the lights; the walk-off hitter's face; black | `CLAUDEBALL` slams in (gold glow, the ball spins to rest), "Two AIs. One ballgame. / Nothing scripted." | crowd murmur, pad + organ swell, heartbeat kick, boom + reverse crash on the title |
| 14-30 | build: what's real | a 100.6 mph four-seamer tracked in slow motion; the mitt; the broadcast's strikeout; 123.8 mph contact in ultra slow motion; the ball into the upper deck; a home run robbed at the wall | EVERY PITCH IS PHYSICS · 100.6 MPH · REAL BAT–BALL CONTACT · 123.8 MPH · FIELDERS READ THE BALL | drums enter, bass, organ chops, whooshes on cuts, riser into the drop |
| 30-50 | drop: the montage | bang-bang at first (0.02 s) with the CLOSE PLAY replay; a 5-4-3 triple play; a steal; a double play; a face close-up with the ratings card; the park's pitch clock running into the red, a violation on the HUD; an inside-the-park home run; the crowd; the plate | 0.02 S · TRIPLE PLAY · EVERY PLAYER RATED · PITCH CLOCK · A BROADCAST THAT CALLS ITSELF · A LIVING BALLPARK | impact + flash, full band, organ lead, brass stabs |
| 50-54 | the phone | the same game in a phone-portrait viewport (mobile HUD) inside a phone | RUNS IN YOUR BROWSER | breakdown |
| 54-66 | the walk-off | bottom of the 9th, tied: the pitch from centre field; contact in ultra slow motion (the band drops out); the ball over the wall; fireworks; the plate | the booth's call, as captured | boom, silence, impact on the flight, the crowd and the booth, full band |
| 66-74 | end card | logo, the URL, open source / MIT / GitHub, Built with Claude, credits | | organ chord, tail |

## Shot list

All games are `tempo=standard`, 9 innings; times are sim seconds. Generated by `npx tsx tools/promo/doc.ts --write` from the source of truth.
The scout also found a pickoff (seed 157); it is captured (`pickoff`) but was cut from the edit for the pitch-clock beat.

<!-- promo:shots -->
Shots (`tools/promo/shots.ts`; the vertical cut re-shoots each as `v-<id>` in a portrait viewport with the lens opened up):

| shot | seed | tod | sim start | anchor | dur s | camera | slow motion | in the cut | note |
|---|---|---|---|---|---|---|---|---|---|
| open-aerial | 162 | night | 5738.00 | 5738.00 | 5.5 | path (out time): orbit r 150 h 92 at 215 deg round (0, 0, 55) -> orbit r 136 h 74 at 175 deg round (0, 0, 55), looking at (0, 4, 48), 42 -> 40 deg |  | yes | night aerial, slow orbit over the park |
| open-crane | 162 | night | 5749.20 | 5750.93 | 4 | path (out time): (5, 15, -26) -> (3.4, 1.7, -7.8), looking at (0, 3, 20), 34 -> 22 deg |  | yes | crane down behind the plate to the pitcher set under the lights |
| open-face | 162 | night | 5747.50 | 5750.93 | 3 | path (out time): face:batter + (0.5, 0.05, 2.6) -> face:batter + (0.35, 0.03, 2.2), looking at face:batter, 15 -> 14 deg, aperture 1.1 |  | yes | the walk-off hitter in the box, telephoto, rack focus |
| pitch-flight | 28 | day | 4476.59 | 4476.89 | 3.2 | path (sim time): ball + (-3.2, 0.1, 0.4) -> ball + (-2.8, 0.15, 0.2), looking at ball + (0, 0, -0.7), 32 -> 30 deg, aperture 0.6 | min x0.22, sim at 1/240 s | yes | a 100.6 mph four-seamer tracked from the first-base side in slow motion |
| pitch-mitt | 28 | day | 4476.95 | 4477.30 | 2.2 | path (sim time): (-1.3, 0.85, 9) -> (-1.3, 0.85, 8.6), looking at (0.12, 0.68, -0.8), 6.5 -> 6 deg, aperture 0.9 | min x0.12, sim at 1/240 s | yes | long lens on the mitt from in front: strike three arrives |
| strikeout-hud | 28 | day | 4475.12 | 4477.30 | 4.5 | the broadcast director + HUD |  | yes | the broadcast: pitch cam, tracker, strike three |
| contact-bomb | 40 | day | 619.20 | 619.80 | 4.5 | path (sim time): (1.75, 1, 2.15) -> (1.5, 0.95, 1.9), looking at (-0.2, 0.85, 0.85), 27 -> 23 deg, aperture 0.7 | min x0.05, sim at 1/240 s | yes | ultra slow motion: bat meets ball, 123.8 mph off the bat |
| bomb-flight | 40 | day | 619.85 | 619.80 | 3.5 | path (out time): (-1.5, 2.2, -9) -> (-1, 2.6, -8), looking at ball, 32 -> 20 deg |  | yes | the bomb climbing into the upper deck |
| robbed | 35 | day | 226.00 | 228.40 | 4.6 | path (sim time): (-6, 1.7, 100) -> (-7.5, 1.6, 106), looking at id:BUF-home-b8 + (0, 1.2, 0), 15 -> 12 deg, aperture 0.5 | min x0.3 | yes | the right fielder climbs the wall and robs a home run |
| bang-first | 197 | dusk | 4856.25 | 4861.68 | 22 | the broadcast director + HUD, replays |  | yes | bang-bang at first: the broadcast, the call, the CLOSE PLAY slow-motion replay |
| bomb-broadcast | 40 | dusk | 617.78 | 624.45 | 40 | the broadcast director + HUD, replays |  | yes | the home-run sequence as the broadcast plays it (wall, crowd, trot, plate, replay) + fireworks |
| triple-play | 23 | dusk | 440.00 | 441.40 | 4.6 | path (out time): (0, 7.5, -14.5) -> (0, 7, -13), looking at ball, 34 deg |  | yes | a 5-4-3 triple play: behind the plate, following the ball round the horn |
| steal-third | 4 | day | 491.50 | 493.95 | 4 | path (out time): (27, 0.9, 27) -> (26, 0.8, 25.5), looking at (17, 0.6, 18), 34 -> 26 deg, aperture 0.5 |  | yes | stolen base: slide into third |
| double-play | 4 | day | 1762.40 | 1763.67 | 3.4 | path (out time): (-9, 1.3, 47) -> (-8.5, 1.2, 46), looking at (0, 0.9, 38.8), 17 -> 22 deg, aperture 0.5 |  | yes | the pivot at second |
| clock-park | 162 | night | 232.40 | 236.35 | 4.6 | path (out time): (1, 2.3, 23.5) -> (0.9, 2.2, 23), looking at (1.6, 1.3, -10), 15 -> 13.5 deg, aperture 0.35 |  | yes | the pitch clock on the backstop runs into the red as the pitcher sets (3.6 s left at the windup) |
| clock-violation | 197 | dusk | 4021.50 | 4025.30 | 7 | the broadcast director + HUD |  | yes | a pitch-clock violation on the batter: the umpire's signal and the HUD call-out |
| pickoff | 157 | night | 3055.50 | 3062.10 | 12 | the broadcast director + HUD, replays |  | no | pickoff at night, the broadcast |
| inside-park | 48 | day | 2444.50 | 2460.97 | 22 | the broadcast director + HUD, replays |  | yes | inside-the-park home run: the broadcast |
| face-card | 35 | day | 215.20 | 216.00 | 4 | path (out time): face:pitcher + (0.55, 0.06, 3.4) -> face:pitcher + (0.4, 0.04, 3), looking at face:pitcher + (0, -0.05, 0), 10 -> 9 deg, aperture 1.1 |  | yes | the pitcher in close-up with the HUD's name card (20-80 ratings, today's line, the arsenal) |
| phone-portrait | 162 | night | 5749.43 | 5752.46 | 8 | the broadcast director + HUD |  | yes | the broadcast on a phone: portrait viewport, mobile HUD |
| wo-pitcher | 162 | night | 5751.13 | 5752.08 | 2.2 | path (out time): (-1.2, 3.2, 48) -> (-1.2, 3.1, 47), looking at (0, 1.2, 0), 9 -> 8.5 deg, aperture 0.25 |  | yes | the 3-1 pitch: over the pitcher from centre field |
| wo-contact | 162 | night | 5752.01 | 5752.46 | 4.2 | path (sim time): (-1.9, 1.1, 2) -> (-1.6, 1.05, 1.7), looking at (0.3, 1, 0.8), 28 -> 24 deg, aperture 0.7 | min x0.05, sim at 1/240 s | yes | walk-off contact, ultra slow motion |
| wo-flight | 162 | night | 5752.56 | 5758.29 | 10 | path (out time): (-3, 9, -24) -> (-2, 8, -21), looking at ball, 40 -> 30 deg |  | yes | the ball over the wall in left-centre, high behind the plate (its booth track runs under the whole climax) |
| wo-fireworks | 162 | night | 5758.89 | 5758.29 | 5 | path (out time): (-6, 3.5, -16) -> (-4, 3, -13), looking at (2, 28, 110), 50 -> 46 deg |  | yes | fireworks over centre field, the crowd up |
| wo-broadcast | 162 | night | 5757.79 | 5758.29 | 34 | the broadcast director + HUD, replays |  | yes | the walk-off as the broadcast plays it: trot, the plate, the celebration |

Cuts (`tools/promo/edit.ts`, 120 BPM grid, a beat = 0.5 s):

| # | time s | beats | shot | from | park / booth dB |
|---|---|---|---|---|---|
| 1 | 0.0 | 8 | open-aerial | 0.4 s | -6 / - |
| 2 | 4.0 | 8 | open-crane | 0 s | -4 / - |
| 3 | 8.0 | 4 | open-face | 0.4 s | -6 / - |
| 4 | 10.0 | 8 | (card) open-face | 2.4 s | - / - |
| 5 | 14.0 | 5 | pitch-flight | 0.1 s | -8 / - |
| 6 | 16.5 | 3 | pitch-mitt | 0.3 s | -4 / - |
| 7 | 18.0 | 6 | strikeout-hud | 1.6 s | -3 / - |
| 8 | 21.0 | 7 | contact-bomb | 0.3 s | -10 / - |
| 9 | 24.5 | 3 | bomb-flight | 0 s | -2 / - |
| 10 | 26.0 | 8 | robbed | 0.6 s | -3 / - |
| 11 | 30.0 | 6 | bang-first | first `replay` + 0.5 s | -3 / - |
| 12 | 33.0 | 4 | triple-play | 0.8 s | -4 / - |
| 13 | 35.0 | 3 | steal-third | 1 s | -4 / - |
| 14 | 36.5 | 3 | double-play | 0.6 s | -4 / - |
| 15 | 38.0 | 4 | face-card | 0.6 s | -6 / - |
| 16 | 40.0 | 3 | clock-park | 2.6 s | -4 / - |
| 17 | 41.5 | 3 | clock-violation | first `umpire` + 0.1 s | -4 / - |
| 18 | 43.0 | 4 | inside-park | 14.4 s | -3 / - |
| 19 | 45.0 | 5 | bomb-broadcast | first `cutaway-crowd` + 0.1 s | -2 / - |
| 20 | 47.5 | 5 | bomb-broadcast | first `homeplate` + 0.1 s | -4 / - |
| 21 | 50.0 | 8 | phone-portrait (in the phone) | 1 s | - / - |
| 22 | 54.0 | 3 | wo-pitcher | 0.2 s | -3 / - |
| 23 | 55.5 | 7 | wo-contact | 0.1 s | -12 / - |
| 24 | 59.0 | 6 | wo-flight | 0.3 s | 0 / - |
| 25 | 62.0 | 5 | wo-fireworks | 0.4 s | 0 / - |
| 26 | 64.5 | 3 | wo-broadcast | first `homeplate` + 0.05 s | -2 / - |
| 27 | 66.0 | 16 | (card) wo-broadcast | 25 s | - / - |

Booth lines laid over several cuts:

- bomb-broadcast: the booth line after the `homerun` event lands at 25 s (3.6 s of the booth track)
- wo-flight: the booth line after the `homerun` event lands at 63.6 s (3.9 s of the booth track)
<!-- /promo:shots -->

## Music and sound

`tools/promo/music.ts` writes the bed as code (no samples, no existing songs): 120 BPM, A minor, i-VI-III-VII, kick / snare / claps / hats /
crash, bass, a drawbar organ with a Leslie (an original call-and-answer lead), brass-like stabs, a pad, a riser, and a separate effects
stem (impacts, booms, whooshes, reverse crashes) placed on the edit's cuts. The game audio of each cut comes from its own shot's capture
(the park stem: crowd, bat, mitt, PA, organ, umpire, as the fixed mic array hears them); the booth (Lyle Pemberton and Hollis "Biscuit" Dupree,
HD voices) only where the edit uses its line. The band ducks under the booth. The master is normalised to -14 LUFS with a look-ahead
true-peak limiter at -1 dBTP; stems: `music.wav` (band), `fx.wav`, `game.wav`, `voice.wav`, `master.wav`. To use another music track
(e.g. a YuE render), replace `music.wav` and re-run `--stages mix,encode`.

## TODO (resume here)

- [x] scout, capture runtime, gates, QA sweeps, jank fixes P1-P10 (see `docs/promo-jank-log.md`)
- [x] shot list, edit, typography, music, mix, assembly; previews v1-v4, report 1
- [x] constraint suite (vitest, typecheck, Pages build, sanity --prod, perf:check); 30 / 60 fps take check
- [x] 1080p60 master, README teaser (`docs/media/teaser.webm`), snippets, contact sheet, report 2
- [x] 4K60 master and the 9:16 vertical cut (`--4k`, `--vertical`), report 3
- [x] fireworks: a denser rising trail, re-shot in all three formats with `--adopt` / `--force --only`
- [ ] (user) listen to the mix; optionally swap the music bed for a YuE track (`edit/<tag>/stems/music.wav`, then `--stages mix,encode`)

Re-shooting after an engine change: every shot's cache key includes the build, so a change re-shoots everything. When the change can
only affect some shots, record the old key (`npx tsx -e "import { buildKey } from './tools/promo/capture'; console.log(buildKey())"`),
rebuild, run `promo:render -- --adopt <old key> --stages capture --only none` for each format, then `--force --only <shots>`.
Never rebuild `dist/` while a capture is running (every shot loads the page from it).
