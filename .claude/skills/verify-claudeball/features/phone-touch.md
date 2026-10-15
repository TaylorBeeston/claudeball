# Phone and touch layout

On a phone the game is touch-first: the menu stacks into one column with a big Start Game button, the HUD sizes itself to the short side (scorebug on top in portrait, name card and tracker at the bottom, compact caption bar), a tap on the field opens the controls drawer, the ☰ and ⏭ buttons sit top right within the safe area, a hint asks to rotate when that helps, and graphics follow a pixel budget (Auto picks at most Medium; 1k player textures).

## Sub-features

- `phone-menu` lays the title menu out in one column for portrait.
- `phone-hud` puts the scorebug on top and the card / tracker at the bottom in portrait.
- `phone-tap` opens the controls drawer with a tap on the field.
- `phone-start` starts the game (and sound) with a tap on Start Game.
- `phone-quality` caps Auto at Medium and keeps the pixel count within the phone budget.
- `phone-rotate` shows a rotate hint where the layout needs it.

## How to get to it (user POV)

- Open the site on a phone (the user's Samsung Z Fold 7: inner screen ~750x832, cover screen ~412x915).

## Driving it with cbv

Preconditions:

- A phone session: `$C launch --no-build --emu 412x915@2.625 --query "menu=1&seed=24"` (no `quality`, so Auto runs). `$C doctor` exit 0 and `$C state` shows `render.viewport 412x915@2.625`, `coarse true`.

- **Menu.** Run `$C shot phone-1-title`. One column: `REAL BASEBALL SIMULATION`, `CLAUDEBALL`, the matchup, chips, a full-width `START GAME`, `Game Setup`, `Settings`.
- **Tap Start.** Run `$C click --testid start --settle 6000` (on a phone session cbv sends a touch at the button's center). `$C state`: `appMode playing`, `audio.ctx running`.
- **Portrait HUD.** Run `$C shot phone-2-playing`. Scorebug at the top left, ☰ and ⏭ top right, AT BAT card and pitch tracker at the bottom, ticker below.
- **Tap for controls.** Run `$C tap 206 300` then `$C shot phone-3-controls` and `$C aria phone-3-controls`. The drawer is open (`Controls [expanded]`) with Pause, speeds, Next batter, Next half, Box score, Camera, Replays, Sound, quality and time-of-day selects, Menu, and the fps line.
- **Quality policy.** `$C state`: `render.quality` is `medium` or `low` (never high on a touch device with Auto); `render.scale` near 1.
- **Inner screen.** Repeat with `--emu 750x832@2.625` (closest proxy for the unfolded Fold 7).
- **Proof.** The three shots, the ARIA snapshot and the state json (viewport, coarse, quality).

## Gotchas

- Emulation lives in the keeper's CDP session: if `doctor` says the keeper is gone, the page falls back to the desktop viewport. Relaunch.
- Playwright's mouse click on an emulated phone races the menu's fade-out and reports a false timeout even though the game started; cbv's `click` sends a real touch on `--emu` sessions instead. Use `tap X Y` for anything without a role or test id.
- The emulation is a CPU and layout proxy only; the GPU is still the laptop's 4090. Frame times on the emulated phone say nothing about the real phone (`npm run perf:phone` drives the real one over adb, only when the user plugs it in).
- The Auto tuner's choice is remembered per device signature in `localStorage`; a fresh session (fresh profile) re-runs it.
