# Loading screen and boot

Opening the game shows a loading screen with a progress bar while the 3D park, players, sky and shaders are prepared behind it; then the title menu (or, from an autostart link, the game) appears. If some 3D assets fail to load, the game still starts with simple stand-ins and says so.

## Sub-features

- `boot-progress` shows the loading screen with staged progress until the first screen is ready.
- `boot-ready` reveals the title menu (or the game with `autostart`) once everything is compiled and drawn once.
- `boot-missing` keeps going with stand-ins and a note when assets are missing.
- `boot-curtain` reuses the same screen as a curtain ("Preparing the match…", "Setting up the game…", "Back to the menu…") for restarts and setting changes.
- `boot-webgl-fail` shows "Could not start the 3D view. Your browser needs WebGL 2." when WebGL 2 is unavailable.

## How to get to it (user POV)

- Open the site (`/claudeball/` on GitHub Pages, `/` on the dev server).
- Open a shared link (`?seed=…`), which may skip the menu with `autostart`.
- Restart, Play again or Quit to menu (the curtain).

## Driving it with cbv

Preconditions:

- A session from `$C launch` and `$C doctor` exit 0.

- **Loading screen.** Reload and look at the screen before it is ready. Run `$C goto "menu=1&seed=24&quality=low" &` then, within a second or two, `$C shot boot-1-loading`. The picture shows the loading screen; `boot-1-loading.state.json` has `loadingScreen` text and `boot.tti` 0. (Racy: the screen is up for 6-10 s.)
- **Ready.** Wait for the reload to finish. `$C goto` prints `boot` with `tti` (ms to interactive), `mode` `menu`, `missing` `[]` and per-step ms (`assets`, `players`, `textures`, `shaders`, `warm`). Run `$C shot boot-2-title`. The title menu shows "CLAUDEBALL" over the park.
- **Progress log.** Run `$C eval "__boot.stages.map(s => s.stage + ' ' + s.frac.toFixed(2))"`. The stages rise from `Starting…` to `Ready`.
- **Autostart.** Run `$C goto "autostart&seed=24&quality=low"`. `boot.mode` is `playing` and `$C state` shows `appMode` `playing` with the HUD scorebug.
- **Missing assets.** Run `$C goto "menu=1&seed=24&quality=low&noassets"`. Boot completes with stand-in figures; doctor's `boot` line is not the measure here (missing is empty because nothing was requested). There is no URL to make one file fail; a real missing file shows in `console.jsonl` as `http 404` and in `__boot.missing`, and the title menu says "Some 3D assets did not load, so simple stand-ins are used."
- **Proof.** `$C sheet --name boot --match boot-`. The sheet shows loading screen, then title.

## Gotchas

- `console.jsonl` always shows `GPU stall due to ReadPixels` and `KHR_parallel_shader_compile extension not supported` warnings during boot on this machine: harmless driver messages, not regressions.
- A prod build may print `[cb-assets] WARNING: … source file(s) changed since the derived assets were built`. Harmless for verification; do not run `npm run assets:derive` (it regenerates committed assets and needs network).
- Dev builds (`launch --dev`) log assertion errors from the animation code, e.g. `[elbow] <player> elbow 4.9 cm inside the torso (pitch)` or `[head-look]`: doctor shows them as a console WARN. They are real jank signals worth reporting, not harness failures; the prod build does not log them.
- Boot time depends on machine load (another agent renders video on the same GPU): 6-10 s here. Do not treat a slower tti as a regression without an A/B on the same machine state.
- The WebGL failure path cannot be reached with the GPU Chrome; launching with `--chrome-flags "--disable-gpu --disable-software-rasterizer"` is a stand-in, not the user's browser.
