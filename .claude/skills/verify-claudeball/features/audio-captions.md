# Booth audio, captions, crowd and park music

The game sounds like a ballpark picked up by broadcast microphones: crowd beds and reactions (a pop on every contact, a crescendo on home runs, claps), the organ, the PA announcer and umpire calls in the park's acoustics, park music stingers after runs, bat / ball / glove effects, and two booth announcers (play-by-play and colour) on top, ducking the park. Subtitles can show what the announcers say. Sound starts with the Start Game click (or the first tap / key after an autostart link).

## Sub-features

- `audio-unlock` starts sound with the Start Game click; an autostart link waits for the first tap or key.
- `audio-booth` runs the booth: the pregame welcome, play-by-play and colour lines, chatter density (Low / Normal / High).
- `audio-park` plays crowd, organ, PA, umpire calls and effects in the park's acoustics (Venue acoustics: Dry / Normal / Big; Mic perspective).
- `audio-music` plays park music after runs, home runs, walk-ups and between innings when tracks exist.
- `audio-captions` shows subtitles (Off / Booth only / All voices) with size, background, labels and position.
- `audio-controls` sets volumes and switches in Settings, mutes from the drawer's `Sound`, and offers HD voices and the owner's own voice pack.

## How to get to it (user POV)

- Start Game from the menu (sound on), or any autostart link plus a first tap / key.
- Settings → Sound and Subtitles; the drawer's `Sound` button mutes.
- `?subtitles=all` in a link.

## Driving it with cbv

Preconditions:

- A session whose Chrome is muted (`--mute-audio`, always on in cbv) and has the keeper's fake speech voices (doctor: `speech voices 3`); `$C doctor` exit 0.
- `$C goto "menu=1&seed=24&tempo=broadcast&quality=low&subtitles=all"`.

- **Unlock by the click.** Before starting, `$C doctor` says `audio: no controller yet`. Run `$C click --testid start --settle 3000` and `$C state`: `audio.ctx` `running`, `audio.ready` true, `prepared` `168/168`, `organ` started.
- **Booth lines.** Let the pregame run: `$C ff "s.time > 45" --speed 1 --keep-replays`, then `$C state --save audio-booth`. `audio.booth` lists the welcome (`Good afternoon, everybody, and welcome to …`, voice `pxp`, tag `open.welcome`) and the colour man's reply (`open.hello`).
- **Captions.** With `subtitles=all`, `$C shot audio-captions` while a line is spoken: `hud.captions` holds the line with its speaker label; the picture shows the caption bar.
- **Sound actually flowing.** Run `$C audio audio-pregame --secs 6`. The `.webm` holds the park mix (crowd, organ, PA effects), and the RMS per second is around -33 dBFS (silence would be below -90). The clip has no announcer voice (fake voices make no sound).
- **Mute.** Run `$C click --role button --name Controls`, `$C click --role button --name Sound`, then `$C audio audio-muted --secs 3`: RMS drops to silence, and `$C state` shows `audio.muted` true.
- **Settings.** Open the pause menu (`$C press Escape`), `Settings`, and `$C aria audio-settings`: sliders `Master volume`, `Effects`, `Crowd`, `Organ volume`, `Announcers`, `PA announcer`, `Park music volume`, `Broadcast effects`; switches `PA announcer & umpire`, `Commentary`, `Stadium organ`, `Play park music`; radiogroups `Commentary chatter`, `Venue acoustics`, `Subtitles`.
- **Offline render (numbers without a browser session).** `npx tsx tools/audio/render.ts --scenes game --tag verify` writes WAVs and an analysis to `~/claudeball-audio-renders/` (outside the repo).
- **Proof.** The `.webm` + `.audio.json`, the state json with `audio`, and a caption screenshot.

## Gotchas

- Park music needs tracks in `public/audio/music/` (the user generates them; the repo ships an empty `manifest.json`): `audio.music` stays null and no stingers play in a fresh checkout. That is expected, not a failure.
- The real speech voices are out of process and absent in headless Chrome; with fake voices the booth schedule and captions are real but silent. Judge the announcer's sound with `tools/visual/booth.ts` (headed) or by ear.
- In headless Chrome an autostart link's audio context may run without a gesture; a real browser keeps it locked until the first tap or key. Test the unlock path through the menu click.
- Never let a session play out loud: cbv always passes `--mute-audio` (the promo render and the user are at this machine).
- `tools/announcer/script/data/*.jsonl` are often locally modified by the voice pipeline: leave them uncommitted and out of any verification commit.
