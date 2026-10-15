# HUD, scoreboard and play-by-play

The broadcast graphics: a scorebug (teams, score, inning arrow, bases diamond, balls / strikes / outs, pitch clock), the pitch tracker (speed, type, location, then exit velocity, launch angle and distance on contact), name cards for the batter and pitcher with 20-80 rating bars and today's line, umpire call captions, a scrolling play-by-play ticker, a REPLAY tag, a box score, the FINAL banner, and a ☰ controls drawer. The park's own scoreboard shows the game too.

## Sub-features

- `hud-scorebug` shows teams, score, inning and half, bases, the count, outs and the clock.
- `hud-tracker` shows pitch speed and type, then contact numbers (exit velo, launch angle, distance).
- `hud-cards` shows AT BAT / PITCHING name cards (number, name, hand, position, line, rating bars).
- `hud-ticker` scrolls the play-by-play text.
- `hud-box` toggles the box score (`B`, or the drawer's `Box score`).
- `hud-controls` opens the controls drawer (Pause, speed 1x/2x/4x, Next batter, Next half, Box score, Camera, Replays, Sound, quality, time of day, Menu, fps).
- `hud-hide` hides the broadcast graphics (Settings → Broadcast graphics off, or `hud=0`).

## How to get to it (user POV)

- Start any game: the HUD appears with the first live frame.
- ☰ (`Controls`) in the top right, or move the mouse / tap / Tab to open the drawer; `⏭` (`Skip to the next batter`) is always visible.
- `B` toggles the box score.

## Driving it with cbv

Preconditions:

- A session; `$C goto "autostart&seed=24&tempo=broadcast&quality=low"`; `$C ff "ev?.type==='umpire_call' && ev.kind==='play_ball'" --timeout 120`; `$C doctor` exit 0.

- **Scorebug and cards.** Run `$C shot hud-1-pa`. `hud.scorebug` reads like `REN 0 OMA 0 ▲ 1 B S O 30 BATTER`; `hud.card` holds the AT BAT card text (number, name, `BATS RIGHT · C`, ratings). Compare with `game` in the same json: score, inning, half, outs, count agree.
- **Tracker and ticker after contact.** Run `$C ff "ev?.type==='contact'" --speed 1 --keep-replays` then `$C shot hud-2-contact` a second later. The tracker shows `EXIT VELO`, `LAUNCH ANGLE`, `DISTANCE`; `hud.ticker` grows with the play's text (`… puts it in play — 85 mph off the bat.`).
- **Box score.** Run `$C press b` then `$C shot hud-3-box` and `$C aria hud-3-box`. `hud.box` holds the table; ARIA shows a `Box score` region with batting rows. Press `b` again to close.
- **Controls drawer.** Open it the user's way: `$C click --role button --name Controls` (on a phone session, `$C tap 206 300` on the field), then `$C aria hud-4-controls`. Buttons `❚❚ Pause`, `Speed 1x`, `Speed 2x`, `Speed 4x`, `⏭ Next batter`, `⏭⏭ Next half`, `Box score`, `Camera: Auto`, `Replays`, `Sound`, `⚙ Menu`; `Controls` is `[expanded]`.
- **Drawer actions.** Run `$C click --role button --name "Speed 4x"` then `$C state`: `sim.speed` 4. Run `$C click --role button --name "⏭ Next batter"`: `sim.skipping` true, then a new `game.batter`.
- **Hide the HUD.** Run `$C goto "autostart&seed=24&quality=low&hud=0"`, `$C ff "s.time > 75"`, `$C shot hud-5-off`. No scorebug in the picture; `hud.scorebug` null.
- **Proof.** Shots with their state json (HUD text vs game state), the ARIA snapshots.

## Gotchas

- `state.hud` reports only text that is visible (`checkVisibility`); a card sliding out can still read as visible for a few frames.
- The HUD is hidden in the menu and during the loading curtain; `hud.*` are null there by design.
- Mouse movement and keyboard focus also open the drawer: a stray `click` elsewhere can open it and change what a later screenshot shows.
- The first frames after Start show a B-roll shot with the HUD over it; the pitch camera comes with the first pitch.
