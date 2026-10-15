# Title menu, Game Setup and Settings

The title menu shows the match (away at home), its length, time of day and seed, with Start Game, Game Setup and Settings. Game Setup chooses the seed, the teams, the game length, the time of day and the pace of play, and offers a share link. Settings holds graphics quality, time of day, every sound level and switch, subtitles, camera, replays, game speed and broadcast graphics. Choices are remembered for the next visit; a link's parameters override them.

## Sub-features

- `menu-title` shows the matchup, chips (innings, time of day, seed) and the three buttons.
- `menu-start` starts the game from Start Game or Enter (this click also unlocks sound).
- `setup-seed` edits the seed, randomizes it, and copies a share link that reproduces the match.
- `setup-teams` picks away and home clubs or randomizes them.
- `setup-length` picks 9 · Full, 3 · Short or 1 · Demo innings.
- `setup-tempo` picks Broadcast, Standard or Quick pace (applies to the next game).
- `settings-quality` picks Auto, Low, Medium, High or Ultra and applies it at once.
- `settings-tod` picks Day, Dusk or Night.
- `settings-sound` sets volumes and switches (PA, commentary, chatter, organ, park music, effects, venue acoustics, mic perspective, mute).
- `settings-subtitles` sets subtitles (Off / Booth only / All voices), size, background, speaker labels and position.
- `settings-game` sets camera (Auto / Free), replays, game speed, broadcast graphics and box score at start.
- `settings-persist` remembers every choice across reloads; `Reset to defaults` (tap twice) clears them.

## How to get to it (user POV)

- Open the site without `autostart` (the title menu).
- Choose `Game Setup` or `Settings` on the title menu; `←` (Back) or Escape returns.
- During a game: ☰ Controls → `⚙ Menu`, or Escape / `p`, then `Settings` in the pause menu.
- Open a link with parameters (`?seed=7&tempo=quick&quality=high`): the menu notes "Some settings come from the link you opened."

## Driving it with cbv

Preconditions:

- A fresh session (`$C launch`, clean profile) with the default query `menu=1&seed=24&quality=low`; `$C doctor` exit 0.

- **Title.** Run `$C shot menu-1-title` and `$C aria menu-1-title`. The dialog `Claudeball menu` has heading `Claudeball`, text `Reno Skippers at Omaha Giants 9 innings Day Seed 24`, and buttons `Start Game`, `Game Setup`, `Settings`.
- **Open Settings.** Choose Settings. Run `$C click --text Settings` then `$C aria menu-2-settings`. Heading `Settings`; radiogroup `Graphics quality` has `Low [checked]` (from the URL).
- **Change quality.** Choose Medium. Run `$C click --role radio --name Medium --in "Claudeball menu"` then `$C eval "({ q: engine.qualityName, saved: JSON.parse(localStorage['claudeball.settings.v1']).quality })"`. Both are `medium`.
- **Persistence.** Reload without the quality parameter. Run `$C goto "menu=1&seed=24"`, `$C click --text Settings`, `$C aria menu-3-reloaded`. `Graphics quality` shows `Medium [checked]`.
- **Game Setup.** Run `$C press Escape`, `$C click --text "Game Setup"`, `$C aria menu-4-setup`. Textbox `Game seed` holds `24`; radiogroups `Game length`, `Time of day`, `Pace of play`; comboboxes `Away team` / `Home team`; buttons `Random seed`, `Copy link`, `🎲 Randomize teams`.
- **Pick a short game.** Run `$C click --role radio --name "1 · Demo"` then `$C press Escape` and `$C aria`. The title chips read `1 inning`.
- **Pace of play.** Run `$C click --text "Game Setup"`, `$C click --role radio --name Quick`, `$C press Escape`. Start the game (next bullet) and confirm the pace: at Quick the first pitch is near (`$C ff "s.time > 20" --speed 1` then `$C state`: `phase prePitch`, `hud.clock` `15 PITCH`), where Broadcast is still in its pregame until ~70 s.
- **Start.** Run `$C press Escape` then `$C click --testid start --settle 3000` and `$C state --save menu-5-started`. `appMode` `playing`, `audio.ctx` `running`, the scorebug text present.
- **Reset.** Open Settings, run `$C click --role button --name "Reset to defaults"`; the button now reads `Tap again to reset everything` (for 3 s), so run `$C click --role button --name "Tap again to reset everything"`. A `Settings reset` toast shows, the saved key is gone (`$C eval "localStorage['claudeball.settings.v1'] ?? 'removed'"` prints `removed`), and `$C aria` shows `Auto [checked]` under `Graphics quality`.
- **Proof.** `$C sheet --name menu --match menu-`, plus the `.aria.txt` files: before / after values and the reload readback.

## Gotchas

- URL parameters beat saved settings: proving persistence needs a reload without that parameter (`menu=1&seed=24`, no `quality`).
- Saved settings leak between recipes in one session (same profile). Launch a new session for a clean slate, or Reset to defaults.
- Tempo and game length changed during a game only toast `Applies to the next game`; in the menu they rebuild the frozen game behind it (the seed's timeline changes with the tempo).
- `--in "Claudeball menu"` scopes a name that appears twice (`Low` exists in quality and chatter).
- The menu shows the seed's clubs by name; a fixed seed with `away`/`home` on auto always shows the same matchup (seed 24: Reno Skippers at Omaha Giants).
- `Copy link` writes to the clipboard, which headless Chrome may refuse; the shown link text is the observable.
