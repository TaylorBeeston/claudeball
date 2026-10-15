# Pitching, batting and the pitch clock

Each plate appearance plays out pitch by pitch: the batter walks up, the catcher gives signs, the pitcher may shake off, then winds up or sets from the stretch and delivers; the batter takes, swings and misses, fouls it off or puts it in play; the plate umpire signals the call and the count updates. MLB pitch-clock rules run underneath: a clock in the scorebug and on four park clocks counts down, with violations called as an automatic ball or strike.

## Sub-features

- `pitch-routine` shows the batter's walk-up and routine, the catcher's signs, shake-offs and the delivery.
- `pitch-call` shows the umpire's call (ball, called / swinging strike, foul) as a HUD caption timed to his signal, and the count in the scorebug.
- `pitch-tracker` shows pitch speed and type (e.g. `89MPH FOUR-SEAM FASTBALL`) and the location box.
- `clock-hud` shows the pitch clock at the end of the scorebug: digits, `PITCH` / `BATTER` / `BREAK` / `CHANGE` / `TIME`, disengagement pips with a runner on, amber under 10 s, red under 5.
- `clock-park` shows the same clock on the backstop and batter's-eye clocks and a `CLOCK` field on the main scoreboard.
- `clock-violation` calls `PITCH CLOCK VIOLATION · AUTOMATIC BALL / STRIKE` with the umpire's signal and flashes the clock.

## How to get to it (user POV)

- Start any game; the first pitch comes after the pregame (about 70 s of game time at Broadcast pace, sooner at Quick).
- Press `.` (Next batter) or `3` (4x) to move on faster.

## Driving it with cbv

Preconditions:

- A session; `$C goto "autostart&seed=24&tempo=broadcast&quality=low"`; `$C doctor` exit 0.

- **First pitch.** Let the pregame pass. Run `$C ff "ev?.type==='umpire_call' && ev.kind==='play_ball'" --timeout 120`. It hits at sim time 69.9 s (seed 24). Run `$C shot pitch-1-playball`: scorebug `REN 0 OMA 0 ▲ 1 B S O` followed by the clock (`30 BATTER` between batters).
- **A called pitch.** Run `$C ff "ev?.type==='umpire_call' && /ball|strike/.test(ev.kind)" --speed 1 --keep-replays`, then at once `$C shot pitch-2-call`. `hud.call` shows the call (`BALL`, `STRIKE`), `game.count` matches the scorebug dots, the tracker shows speed and pitch type.
- **The clock running.** Run `$C ff "s.pitchClock?.running && s.pitchClock.kind==='pitch' && s.pitchClock.remainingSec < 9" --speed 1` and `$C shot pitch-3-clock-amber`. `hud.clock` reads a number under 10 with `PITCH`; the cell is amber in the picture.
- **Events of one plate appearance.** Run `$C events --type pitch,umpire_call,contact,signs_given,shake_off --since <t> --save pitch-pa`. Each `pitch` (type, speed) is followed by an `umpire_call` or `contact`.
- **Violation (measured: seed 16, Broadcast, 9 innings, batter violation at 2929.23 s, top 5, count 0-1 → 0-2).** Run `$C goto "autostart&seed=16&tempo=broadcast&innings=9&quality=low"`, `$C ff "s.time >= 2921" --turbo` (~2 min wall), `$C ff "!!s.pitchClock?.violation" --speed 1 --keep-replays`, wait 0.5 s, `$C shot pitch-4-violation`: `hud.call` `PITCH CLOCK VIOLATION · AUTOMATIC STRIKE`, `hud.clock` flashes `0 PITCH`, the booth caption reads `Time! Violation, strike!`; events show `umpire_call clock_violation_strike`. To find others: `$C seek "!!s.pitchClock?.violation || /clock_violation/.test(ev?.kind ?? '')" --seeds 9-30 --max 1` (about 0.19 per broadcast game, none at Quick or Standard); jump with `$C goto "autostart&seed=<seed>&tempo=broadcast&quality=low"`, `$C ff "s.time >= <simTime - 8>" --turbo`, `$C ff "!!s.pitchClock?.violation" --speed 1 --keep-replays`, `$C shot pitch-4-violation`. `hud.call` shows `PITCH CLOCK VIOLATION · AUTOMATIC BALL` (or `STRIKE`), the clock flashes.
- **Park clocks.** With the game paused on a pitch (`--pause` on the ff above), the backstop clocks are in the pitch camera's view: `$C shot pitch-5-park-clock`. (Close-up framing needs `director.bench`: a harness knob, see tools/visual/look.ts `--cams plate`.)

## Gotchas

- Seed 24 at Broadcast: the booth welcome is at ~31 s and `play_ball` at 69.9 s; a pregame B-roll runs before that, so the first screenshot is not the pitch camera.
- The HUD clock cell is absent (takes no room) until the first clock starts; `hud.clock` null in the pregame is correct.
- Calls are timed to the umpire's signal peak, after the ball crossed the plate: the caption lags the `umpire_call` event by a fraction of a second. Take the shot right after `ff` returns, at `--speed 1`.
- Violations are rare: none in seeds 1-12 at Quick; at Broadcast the first in seeds 9-22 was seed 16. Record any seed you find in this file.
- The scorebug count dots can show the final count of a finished plate appearance (3 balls, 2 strikes) while the ticker already reports the result; read `game.count` and events, not only the dots.
