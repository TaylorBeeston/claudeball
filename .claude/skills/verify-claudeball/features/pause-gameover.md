# Pause, restart and game over

Escape, `P`, the drawer's `Pause` / `⚙ Menu` or leaving the tab pauses the game under a `Game paused` panel with Resume, Settings, Restart game and Quit to menu. At the end of a game the FINAL banner shows, and a few seconds later a summary with the final score, the winner and both box scores offers Play again (a new seed) and Menu. A game tied after its regulation innings goes to extra innings with the automatic runner on second.

## Sub-features

- `pause-open` pauses from Escape, `P`, the drawer, or hiding the tab.
- `pause-resume` resumes from Resume or Escape.
- `pause-settings` opens Settings over the paused game and returns to the pause panel.
- `pause-restart` replays the same game from the first pitch behind a curtain.
- `pause-quit` goes back to the title menu.
- `over-final` shows the FINAL banner, then the summary with score, winner and box scores.
- `over-again` starts a new game with a fresh seed (Play again) or returns to the menu.
- `over-extras` continues a tied game into extra innings.

## How to get to it (user POV)

- Press Escape or `P` while playing; ☰ → `❚❚ Pause` or `⚙ Menu`.
- Play a game to the end; a 1-inning game (Game Setup → `1 · Demo`) is the quickest.

## Driving it with cbv

Preconditions:

- A session; `$C doctor` exit 0.

- **Pause.** Run `$C goto "autostart&seed=24&quality=low"`, `$C ff "s.time > 72" --speed 1`, `$C press Escape`, `$C aria pause-1`, wait 2 s, `$C shot pause-1`. Dialog `Game menu` with `Game paused` and buttons `Resume`, `Settings`, `Restart game`, `Quit to menu`; `state.appMode` `paused`, `sim.paused` true.
- **Resume.** Run `$C click --role button --name Resume` and `$C state`: `appMode playing`, `sim.paused` false.
- **Restart.** Escape again, `$C click --role button --name "Restart game" --settle 8000`, `$C state`: `sim.time` back near 0, same teams and seed.
- **Quit.** Escape, `$C click --role button --name "Quit to menu" --settle 8000`, `$C state`: `appMode menu`, dialog `Claudeball menu`.
- **Game over (with extra innings).** Run `$C goto "autostart&seed=3&innings=1&tempo=quick&quality=low"`, then `$C next half --until "s.over" --max 12` (presses `n`). Seed 3 is 0-0 after one inning, goes to the 2nd with a runner on second (`runners [false,true,false]` at the start of the bottom half) and ends 4-1 for Reno at sim 901.96 s (the same in every run: the skips are deterministic too). Wait 9 s (the summary follows the FINAL banner after 4.5 s, then fades in; at 6 s it was still washed out), then `$C shot over-1` and `$C aria over-1`. `state.appMode` `over`, `hud.final` `FINAL REN 4 – RIC 1`; the dialog reads `Final REN 4 Reno Herons – RIC 1 Richmond Skippers Reno Herons win` with a `Box score` region (batting tables) and buttons `Play again`, `Menu`.
- **Play again.** Run `$C click --role button --name "Play again" --settle 8000` and `$C state`: a new seed in the URL (`seed=` changed), `appMode playing`, `sim.time` near 0.
- **Proof.** Shots and ARIA snapshots for pause and game over, the `next` output (press by press), and `events --type game_end,half_inning --save over`.

## Gotchas

- With the controls drawer open, the first Escape only closes the drawer; a second Escape pauses. Check `state.appMode` after pressing.
- Hot keys (`n`, `.`, digits) are off while any menu, the pause panel or the game-over summary is up: `cbv next` stops with "hot keys are off".
- The game-over summary appears 4.5 s after `game_end`; a shot right at `s.over` shows only the FINAL banner.
- Panels fade in: a shot taken within about a second of opening the pause panel or the summary shows it washed out. Wait 2-3 s (or `--settle 3000` on the click) before the shot.
- With `innings=1` a tie continues: do not assume two `n` presses end the game; use `next half --until "s.over"`.
- Restart keeps the seed (the same game); Play again draws a new random seed, so its game is not reproducible unless you read the new seed from the URL.
- Hiding the tab pauses the game (`visibilitychange`); headless Chrome never hides it, a headed window behind others may not either.
