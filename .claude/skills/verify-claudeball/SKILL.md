---
name: verify-claudeball
description: Drive the real Claudeball game (3D baseball in the browser, three.js + a real physics/AI sim) in an isolated headless Chrome on the real GPU and prove behavior with evidence (screenshots, ARIA snapshots, HUD/state dumps, the sim + broadcast event log, console errors, frame times, recorded audio). Use before claiming any UI, HUD, engine, broadcast-camera, audio or sim change works, to reproduce a bug a user saw, or to jump to a game situation (bases loaded, 2 outs, a close play, a home run, game over).
---

# verify-claudeball

The game is a web page: a loading screen, a title menu (Start Game / Game Setup / Settings), then a broadcast of two AI teams playing (HUD, camera director, replays, booth audio), a pause menu and a game-over screen. Nothing is scripted: every play comes from the sim's physics and AI. Proof therefore means: launch the real build, reach the situation through the real game (a seed plus the player's own fast-forward), and capture what a viewer would see and hear plus the state behind it.

Everything goes through one helper, `cbv` (`scripts/cbv`, a TypeScript CLI run with the repo's tsx). Run all commands from the repo root:

```
C=.claude/skills/verify-claudeball/scripts/cbv
$C help
```

The feature map in [`features/README.md`](features/README.md) is the recipe book: read it, then the feature file you need.

## Launch

Prerequisites (once per checkout): `npm ci` (a new worktree has no `node_modules`; `cbv` refuses to run without it), `/usr/bin/google-chrome-stable` (override with `CHROME=`), ImageMagick `montage` for contact sheets. The shipped assets are tracked in git, so no asset step is needed. Do **not** run `npm run assets:derive` or `npm run assets:fetch` to verify anything: those are asset-pipeline tools.

```
$C launch                                   # prod build (CB_BASE=/claudeball/, what GitHub Pages serves) in headless Chrome
$C launch --dev                             # the vite dev server instead (live sources, HMR, base /)
$C launch --no-build                        # reuse dist-verify/ from the last launch (doctor warns if it is stale)
$C launch --emu 412x915@2.625               # a phone: viewport, DPR, touch, (pointer: coarse)
$C launch --headed                          # a visible window (ANGLE gl); only when a human must watch
$C launch --size 1920x1080 --query "menu=1&seed=24&quality=low"
```

What launch does: builds into `dist-verify/` (prod; about 1 s), starts `vite preview` / `vite` on a free port bound to 127.0.0.1, starts Chrome with a fresh profile in `$TMPDIR/cbv/<session>/profile` and its own free CDP port (`--headless=new` with Vulkan ANGLE, so WebGL runs on the real GPU; `--mute-audio`, so nothing reaches the speakers), starts a small keeper process that holds the emulation, the in-page collector and the console log, then opens the game at the query and waits.

**Ready signal:** `window.__boot.tti > 0` (the menu or game is interactive). Launch prints the session id, URL, evidence folder and `__boot` (tti, mode `menu`/`playing`, missing assets, per-step ms), then `[cbv] ready`. Typical tti is 6-10 s.

The default query is `menu=1&seed=24&quality=low`. Always pass an explicit `seed` and either `menu=1` or `autostart` (see Drive). Every later command acts on the newest session of this checkout; pass `--session <id>` (or `CBV_SESSION`) to choose another. `$C list` shows them.

Teardown: `$C stop` (see Cleanup).

## Doctor

```
$C doctor
```

Read-only; exit 0 = worth driving, 1 = do not drive (FAIL lines say why). It appends its report to the evidence folder's `doctor.txt`. Checks:

- `server`: our pid alive, and the port's listener is that pid (`ss -ltnp`), with its cwd.
- `chrome`: our pid alive (its command line carries our profile dir), the CDP port owned by it.
- `keeper`: alive; without it a reload loses the event collector and the fake speech voices.
- `build`: prod: the served `index.html` equals `dist-verify/index.html`, and the build stamp (`dist-verify/cbv-stamp.json`: git HEAD + dirty flag at build time) matches the checkout. WARN = you are testing older code: relaunch without `--no-build`. Dev: the server's cwd is this checkout.
- `webgl`: WebGL2 and the renderer string. It must name the GPU (`... NVIDIA GeForce RTX 4090 Laptop GPU ...` on this machine). SwiftShader / llvmpipe is WARN: screenshots still work, frame times mean nothing.
- `boot`: tti > 0 and no missing assets. `sim`: kind `sim` (not the mock).
- `collector`: the in-page event/console collector is installed and hooked to the engine.
- `audio`: the Web Audio context state. `no controller yet` is normal in the menu (audio is attached by the Start Game click, or at once with `autostart`); `running` once a game plays; `off` with `noaudio`.
- `console`: errors captured in the page since the last load (WARN, see `$C log`).

Run doctor first, after anything surprising, and after any failed drive. If doctor fails because the skill is wrong (a renamed handle), fix the skill; if the game is broken, report it.

## Drive

### URL query (the game's own parameters; `cbv goto "<query>"` reloads with them)

| param | effect |
|---|---|
| `seed=N` | the match. Same seed + same tempo + same innings = the same game, pitch for pitch. Without it a person gets a random seed |
| `menu=1` / `autostart` | show the title menu / skip it. Automation (`navigator.webdriver`) would autostart, but cbv's Chrome is not marked as automated, so it behaves like a person's browser: **always pass one of them** |
| `tempo=broadcast\|standard\|quick` | pace of play (default broadcast: walk-ups, B-roll, mound visits). Changes the whole game, so a seed's timeline is per tempo |
| `innings=1..9` | game length (1 = demo; a tie goes to extra innings with the automatic runner) |
| `quality=low\|medium\|high\|ultra` | graphics preset; skips the Auto tuner. Use `low` unless the quality itself is under test |
| `tod=day\|dusk\|night`, `away=REN&home=OMA` (club abbreviations or 0-29) | time of day, teams |
| `subtitles=all\|booth\|off`, `subtitlesize=S\|M\|L\|XL`, `chatter=low\|normal\|high` | captions, commentary density |
| `speed=1\|2\|4`, `camera=auto\|free`, `replays=0`, `hud=0`, `box=1` | start-of-game settings |
| `noaudio`, `mock`, `noassets`, `nopost`, `noao`, `nobloom`, `nodof` | debugging switches |
| `perf=1` | profiler overlay + `window.__perf` (cbv perf uses it) |
| `audiorate=32000`, `lowpower=1`, `audiodebug=1` | audio context rate, the phone audio path, the live audio meter panel |
| `notune` | skip the Auto quality tuner |

Settings changed in the menu are saved to `localStorage` (`claudeball.settings.v1`) and override the defaults on the next load; URL params override saved ones.

### Real input (the user path)

```
$C click --testid start                                   # Start Game (data-testid="start"); also: --role button --name "Start Game"
$C click --text "Game Setup" | --text Settings            # title menu buttons
$C click --role radio --name Medium --in "Claudeball menu"     # menus are role=dialog "Claudeball menu" / "Game menu"; settings are radiogroups
$C click --role switch --name "Stadium organ"             # on/off settings are role=switch with aria-checked
$C click --role button --name Resume                      # pause menu: Resume, Settings, Restart game, Quit to menu; game over: Play again, Menu
$C press Escape | p                                        # pause / back
$C press 1 2 3                                            # game speed 1x / 2x / 4x
$C press .                                                # next batter (fast-forwards the sim, no rendering cost)
$C press n                                                # next half inning
$C press b c q t Space                                    # box score, camera auto/free, cycle quality, cycle time of day, pause the sim
$C tap 206 300                                            # a touch (phone sessions); click also sends touches on --emu sessions
```

Hot keys only work while a game is playing (not in a menu, the pause screen or game over). ARIA names for every control: `$C aria` (the HUD controls drawer: `Controls`, `Pause`, `Speed 1x/2x/4x`, `Next batter`, `Next half`, `Box score`, `Camera: Auto`, `Replays`, `Sound`, `Menu`; the always-visible `Skip to the next batter`).

### Reaching a situation (no state setters exist, by design: the sim is real)

1. **Find it** without a browser: `$C seek "<condition>" --seeds 1-8 --tempo broadcast --innings 9 [--max 2]` plays the sim alone in Node (about 15 s per 9-inning game) and prints seed, sim time, inning, outs, count, runners, score, batter and the event for each hit. Conditions are JS over `s` (engine-shaped state: `s.outs`, `s.runners` [1B,2B,3B], `s.count`, `s.inning`, `s.half`, `s.score`, `s.pitchClock`, `s.phase`, `s.over`) and `ev` (one event: `ev.type` = `pitch`, `contact`, `umpire_call` (`ev.kind`: ball, strike_called, strike_swinging, foul, safe, out, ...), `out`/`safe` (`ev.closePlay`, `ev.margin`), `homerun`, `robbed_hr`, `steal`... see `cbv events`). Director events (`broadcast.*`) exist only in the page.
2. **Jump there** in the page: `$C goto "autostart&seed=S&tempo=T&innings=I&quality=low"`, then `$C ff "s.time >= <simTime - 10>" --turbo` (about 24 game seconds per wall second), then `$C ff "<condition>" --speed 1 --keep-replays` to arrive at normal speed with the broadcast running. The page reproduces the Node timeline exactly (proven: seed 3's close play at 1225.54 s in both, at commit 7f85bec).
3. Or **play forward** with the player's own skips: `$C next batter --until "s.outs===2 && s.runners[0]"`, `$C next half --until "s.inning===3"` (presses `.` / `n` until the condition holds; quick, no rendering).

`ff` options: `--speed 1|2|4` (the same knob as the 1/2/3 keys; default 4), `--turbo` (harness knob: a fixed 0.1 s step per frame; label it in evidence), `--pause` (pause the sim when it hits, for a still), `--timeout <s>` (default 300; exit 3 on timeout; exit 4, with the error, when the condition never evaluated without throwing: a typo such as `s.runner`, so a silent "not found" cannot happen; `seek` does the same), `--keep-replays` (otherwise replays are switched off during the jump, because a replay holds the live game, and restored afterwards). It prints the hit event and the situation.

Measured situations (commit a79beed, tempo broadcast, 9 innings; re-measure with `seek` after sim changes: the rules-and-contact work of t-0021 moved every seed's timeline):

| situation | seed | sim time | notes |
|---|---|---|---|
| first pitch / `play_ball` | 24 | 69.9 s | pregame: booth welcome at ~31 s, B-roll |
| home run, 2 outs | 1 | 5028.8 s | top 8, runners on 1st and 3rd (seed 1's first homer) |
| grand slam | 8 | 993.2 s | top 2, bases loaded, 1 out |
| close play (safe at 2B) | 3 | 6310.7 s | top 8, 1 out, runner on 2nd |
| pitch-clock violation (pitcher, automatic ball) | 5 | 5198.6 s | top 7; rare |
| obstruction (the umpire gives the runner second) | 8 | 3777.9 s | top 6, 2 outs; about 0.2 a game |
| game over | 24 | 6705.6 s | away wins 6-4; faster: `innings=1` + `cbv next half --until s.over` |

A missed-base appeal is rarer than these (about 0.2 missed bags a game, only those a fielder saw are appealed): none in seeds 1-24.
The seed 3 steal of second that this table used to list (the `CLOSE PLAY` with fielders inside each other) is now at 1246.5 s in seed 3, a hook slide that beats the tag.

### Reading the game

```
$C state [--save name]       # appMode (boot|menu|playing|paused|over|curtain), sim (time, paused, speed, hold), game (inning, outs, count, runners,
                             # score, batter, pitcher, phase, lull, pitchClock), director (shot, broll, replaying, caption), render (quality, fps,
                             # adaptive scale, viewport), hud (scorebug, clock, call, ticker, replay, card, final, box, captions: visible text only),
                             # audio (context, sounds ready, organ, music, last booth lines)
$C events [--type safe,broadcast.replayStart] [--since 1200] [--tail 40] [--save name]   # sim + director events with sim time (`t`)
$C eval "<js>"               # engine and s (= engine.sim.state) in scope; e.g. $C eval "engine.director.shot"
```

`window` handles in the page: `engine` (the Engine: `sim`, `director`, `hud`, `players`, `liveState`, `qualityName`, `adaptive`, `env`), `__boot` (`tti`, `mode`, `missing`, `steps`, `stages`), `__audioDebug` (`state`: context, ready, booth transcript, music; `speechLog`; exists once audio is attached), `__captionsFeed(event)` (feeds a caption by hand: a demo hook, not proof), `__perf` (`?perf=1`), `__bench` (`?bench=1`, tools/perf), and the harness's own `__cbv` (`events`, `log`).

## Evidence

Every session writes to `verify-evidence/<session>/` at the repo root (git-ignored; never commit it):

```
$C shot <name>               # <name>.jpg + <name>.state.json (the state at that instant)
$C aria <name>               # <name>.aria.txt: the accessibility tree (menus, buttons, HUD regions, box score table)
$C state --save <name>       # <name>.state.json
$C events --save <name>      # <name>.events.jsonl
$C perf --secs 5 --save <n>  # frame count, fps, p50/p95/max frame ms, quality, adaptive scale (+ __perf stats with perf=1)
$C audio <name> --secs 6     # <name>.webm (what the game sends to the speakers) + <name>.audio.json (peak and RMS dBFS per second)
$C sheet [--name n] [--match re]   # _<n>.jpg: a labelled contact sheet of the session's screenshots
$C log                       # console errors in the page since the last load
```

Always there: `console.jsonl` (the keeper's log of every console error/warning, page error, HTTP status >= 400 and navigation for the whole session), `doctor.txt`, and after `stop` the `server.log`, `chrome.log`, `keeper.log` (and `build.log` for prod launches).

Proof standards:

- Drive the real user path: menu clicks, keys, taps, URL parameters a user could open. `ff`/`next`/`seek` only choose *where* in a real game to look. `--turbo`, `director.bench`, `fixedDt`, `replaysEnabled` and `eval` writes are harness knobs: say so next to any evidence they produced.
- Capture the action and the result: a shot (or state) before, the command, a shot + state + events after. A setting is proven by reloading and reading it back (`aria`), not by the click alone.
- Verify side effects alongside the picture: `localStorage` (`$C eval "localStorage['claudeball.settings.v1']"`), the event log, the audio level (`audio` RMS well above -60 dBFS means sound flowed), console errors (`log` empty).
- A screenshot of the HUD needs the state json next to it (`shot` writes both): the picture shows it rendered, the json shows what the game believed.
- Name artifacts after the feature (`<feature>-<step>`) and put the commands you ran in your report.
- `--mute-audio` only stops the speakers: the Web Audio graph runs and `cbv audio` records it. Headless Chrome has no speech voices; the keeper installs fake ones (they "speak" for a time proportional to the text), so the booth schedule and the captions run, but `.webm` clips contain no announcer voice.

## Cleanup

```
$C stop                      # this session (or --session <id>)
$C stop --all                # every session of this checkout
```

`stop` signals only the process groups it started (keeper, Chrome, server), after checking each pid's command line still carries this session's marker (profile dir, port, session id), escalates to SIGKILL after 3 s, confirms both ports are closed, copies the logs into the evidence folder, and removes `$TMPDIR/cbv/<session>/` (profile + scratch). It never removes `verify-evidence/`. Run it after every failed attempt too.

Never kill by process name (`pkill chrome`, `killall node`): this machine runs other agents' Chrome sessions (one renders a promo video in a headed Chrome and serves its own `vite preview`), the user's Brave, and other dev servers. Never reuse another session's port or profile. Keep runs short; leave GPU benchmarks to `tools/perf` and only when asked.

`verify-evidence/` lives in the checkout: copy what must outlive a worktree (the contact sheet, state dumps) to wherever your task keeps deliverables before the worktree is removed.

## Helpers

- `scripts/cbv` (executable): the CLI above. `$C help` lists every command and option. It is `scripts/cbv.ts` run with the repo's tsx (typecheck: `npx tsc --noEmit -p .claude/skills/verify-claudeball/scripts`).
- Reused repo tools (each starts its own build/server/Chrome; they are heavier, use them when the task is theirs): `npm run perf:check` (draw-call/triangle and audio-graph budgets), `npx tsx tools/perf/tunecheck.ts` (what Auto quality picks), `npx tsx tools/perf/sanity.ts` (puppet bounding boxes), `npx tsx tools/visual/look.ts --mode static|play|ui --sheet` (art-direction screenshots), `npx tsx tools/visual/jank.ts` (pose dumps at game times), `npx tsx tools/visual/booth.ts` (booth/PA transcript), `npx tsx tools/audio/render.ts` (offline WAV render of the whole mix, written to `~/claudeball-audio-renders/`), `npx tsx scripts/pitchclock.ts` (clock rates over many games). These use headed Chrome and `dist/`; do not run them in parallel with someone else's GPU work without need.
