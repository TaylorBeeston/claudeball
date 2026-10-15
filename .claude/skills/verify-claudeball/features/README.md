# Claudeball verification map

This directory is the maintained source for verifying the user-facing behavior of Claudeball, the 3D baseball broadcast in the browser. Read this index before driving the game, then use the matching feature file as the recipe. Commands assume `C=.claude/skills/verify-claudeball/scripts/cbv` from the repo root (see `../SKILL.md`).

## Baseline preconditions

- `npm ci` has run in this checkout.
- A session from `$C launch` (prod build under `/claudeball/`, headless Chrome on the real GPU, fresh profile, muted). Use `--dev` only to test uncommitted work with HMR.
- `$C doctor` exits 0: our server and Chrome, the current build, a GPU renderer (not SwiftShader), `__boot.tti > 0`, no missing assets, sim kind `sim`, collector hooked.
- Every URL carries an explicit `seed` and `menu=1` or `autostart`, and `quality=low` unless the feature is about quality.
- Never drive a Chrome, server or port that this run did not start.

## Driving conventions

- Start every recipe from a fresh load (`$C goto "<query>"`) unless its preconditions say otherwise. Settings saved by an earlier recipe live in this session's `localStorage`: reload with explicit URL params, or launch a new session for a clean profile.
- Prefer ARIA roles and names (`--role radio --name Medium --in "Claudeball menu"`), `data-testid="start"`, and real keys over coordinates or `eval` writes.
- Reach game situations with `seek` (find a seed and sim time in Node), then `ff` / `next` in the page. Never edit game state to fake a situation.
- Treat every command as literal. Quoted names, keys and flags are exact.
- After a failed drive: `$C doctor`; if the page is wedged, `$C goto` again or relaunch. `$C stop` after the last drive and after every abandoned attempt.

## Proof and skip reporting

- Capture the user action and the resulting state: `shot` (picture + state json) before and after, `events --save` around the action.
- UI proof includes an ARIA snapshot (`aria <name>`) and a screenshot with the Claudeball HUD or menu visible.
- Settings proof reloads the page and reads the stored value back (ARIA `[checked]` and `localStorage`).
- Sim and broadcast proof includes the event log (`events --save`) with the sim times of the play and its consequences.
- Audio proof includes `audio <name>` (the clip plus RMS per second) and `state` (`audio.ctx` `running`).
- Record the feature file, the entry point and every harness knob used (`--turbo`, `eval`) with each artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with cbv` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

Live status as of 2026-10-14 (commit 7f85bec). "Proven" means the recipe's key steps were driven end to end by cbv and the evidence checked; "recipe" means written from source and the harness, not yet driven.

- [Loading screen and boot](./boot-loading.md) covers the loading screen, progress, readiness and the missing-assets fallback. Proven (tti, menu reveal).
- [Title menu, Game Setup and Settings](./menu-settings.md) covers Start Game, seeds and teams, game length, pace of play, quality, time of day, sound and subtitle settings, and their persistence. Proven (quality change persisted across reload).
- [Pitching, batting and the pitch clock](./pitch-flow-clock.md) covers the pitch-by-pitch flow, umpire calls, the count, the HUD pitch clock, the park clocks and violations. Proven (first pitch, umpire calls, a batter clock violation on seed 16).
- [Fielding and baserunning](./fielding-baserunning.md) covers batted balls, catches, throws, steals, tags, base touches, extra-inning runners and home runs. Partly proven (steal of second with close play).
- [HUD, scoreboard and play-by-play](./hud-scoreboard.md) covers the scorebug, pitch tracker, name cards, ticker, box score and the controls drawer. Proven (scorebug, card, box score, controls drawer).
- [Broadcast camera director and B-roll](./camera-broll.md) covers the auto director's shots, cuts and dissolves, B-roll and lower-third cards. Partly proven (B-roll shots in the event log).
- [Replays and CLOSE PLAY](./replays.md) covers instant replays, the slow-motion CLOSE PLAY replay and the home-run sequence. Proven (seed 3 close play replay).
- [Booth audio, captions, crowd and park music](./audio-captions.md) covers the announcers, PA, organ, crowd, park music, subtitles and the sound controls. Proven (unlock by click, booth lines, captions via Settings, recorded clip, mute to silence).
- [Phone and touch layout](./phone-touch.md) covers portrait phone layout, touch start, the controls drawer by tap and the phone quality policy. Proven (emulated 412x915).
- [Graphics quality, Auto tuner and performance](./quality-perf.md) covers presets, the start-up tuner, the adaptive resolution scale and frame-time capture. Partly proven (tuner picked Medium on the phone emulation; frame times).
- [Pause, restart and game over](./pause-gameover.md) covers the pause menu, restart, quit to menu, extra innings and the final screen with the box score. Proven (pause, resume, game over after extra innings, Play again).
