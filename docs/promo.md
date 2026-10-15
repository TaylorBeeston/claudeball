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

The shots are in `tools/promo/shots.ts` (seed, time of day, sim time, camera path / director, slow-motion ramp) and the cut list in
`tools/promo/edit.ts`. All games are `tempo=standard`, 9 innings; times are sim seconds.

| shot | seed | tod | moment | camera |
|---|---|---|---|---|
| open-aerial | 162 | night | before the walk-off at-bat (5738) | orbit r 150 -> 136 m, h 92 -> 74 m, 215 -> 175 deg around (0, 0, 55) |
| open-crane | 162 | night | the pitcher sets (5749) | crane from (5, 15, -26) to (3.4, 1.7, -7.8), 34 -> 22 deg, focus on the pitcher |
| open-face | 162 | night | Zach Fisher in the box | 2.6 m in front of his face (his own frame), 15 deg, shallow focus |
| pitch-flight | 28 | day | 100.6 mph four-seamer (release 4476.887) | follows the ball 3 m to the side, x0.22 slow motion |
| pitch-mitt | 28 | day | strike three in the mitt (4477.300) | low beside the plate, x0.12 |
| strikeout-hud | 28 | day | the strikeout as broadcast | director + HUD |
| contact-bomb | 40 | day | 123.8 mph off the bat (619.796) | in front of the left-handed hitter, x0.06, sim at 1/240 s |
| bomb-flight | 40 | day | the ball into the upper deck | behind the plate, following the ball, 32 -> 20 deg |
| robbed | 35 | day | the right fielder robs a home run (leap 228.404) | inside the wall, following the fielder, x0.3 at the leap |
| bang-first | 197 | dusk | out at first by 0.02 s on a throw from right (4861.683) | director + HUD (the CLOSE PLAY replay) |
| clock-park | 162 | night | the pitcher sets with 3.6 s left on the clock (236.35) | long lens over the pitcher's shoulder: batter, catcher and the backstop clocks |
| clock-violation | 197 | dusk | a pitch-clock violation on the batter (4025.3) | director + HUD (the call-out and the umpire's signal) |
| bomb-broadcast | 40 | dusk | the home-run sequence + fireworks | director + HUD |
| triple-play | 23 | dusk | 5-4-3 triple play (441.4) | high behind the plate |
| steal-third | 4 | day | steal of third (493.95) | low at third base |
| double-play | 4 | day | the pivot at second (1763.67) | low behind second |
| pickoff | 157 | night | pickoff (3062.1) | director + HUD (not in the cut) |
| inside-park | 48 | day | inside-the-park home run (2460.97) | director + HUD |
| face-card | 35 | day | B-roll face close-up with the card | director (B-roll) + HUD |
| phone-portrait | 162 | night | the walk-off pitch | director + mobile HUD, 9:16 viewport |
| wo-pitcher | 162 | night | the 3-1 pitch (windup 5750.925) | centre-field long lens |
| wo-contact | 162 | night | 111 mph, 37 deg (5752.462) | in front of the hitter, x0.06, sim at 1/240 s |
| wo-flight | 162 | night | over the wall in right-centre (5758.292) | behind the plate following the ball, 34 -> 16 deg |
| wo-fireworks | 162 | night | the fireworks volley | low behind the plate, up at centre field |
| wo-broadcast | 162 | night | trot, plate, celebration | director + HUD |

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
