# Replays and CLOSE PLAY

Interesting plays are replayed from a second angle, in slow motion, while the live game waits. A contested out or safe call cuts to the umpire making the call, then plays a 0.3x slow-motion replay from a low camera at the base with a slow push-in and a `CLOSE PLAY` caption, then a normal-speed replay from the opposite side. Home runs get their own sequence (ball leaving the park, crowd, trot, plate, replay). A `REPLAY` tag marks replays, and later lulls may show a play again.

## Sub-features

- `replay-close` plays the CLOSE PLAY slow-motion replay with its caption after a tight safe / out call.
- `replay-hr` plays the home-run sequence and its replay from across the field.
- `replay-play` replays other notable plays (infield / outfield variants).
- `replay-hold` holds the live game while a replay plays, so no pitch is missed.
- `replay-toggle` turns replays off (Settings → Replays, the drawer's `Replays`, `replays=0`).

## How to get to it (user POV)

- Watch a game until a close play or a home run.
- Turn replays on or off in Settings or the controls drawer.

## Driving it with cbv

Preconditions:

- A session; `$C doctor` exit 0.
- Seeds measured at commit 7f85bec (tempo broadcast, 9 innings): seed 3 close play (safe at 2B) at 1225.54 s; seed 1 home run at 1416.6 s. The rules-and-contact work (t-0021) moved these: see SKILL.md's measured situations (seed 3 close play at 6310.7 s; seed 3's steal of second at 1246.5 s).

- **Jump near the close play.** Run `$C goto "autostart&seed=3&tempo=broadcast&innings=9&quality=low"` then `$C ff "s.time >= 1215" --turbo` (harness knob; ~50 s wall). The state matches the Node seek: bottom 2, 1 out, runner on first, batter Ben Fernandez.
- **The play at 1x.** Run `$C ff "ev?.type==='safe' && ev.closePlay" --speed 1 --keep-replays`. It returns `simTime 1225.54`, `safe` at base 2, margin -0.077 s.
- **The replay.** Run `$C ff "ev?.type==='broadcast.replayStart'" --speed 1 --keep-replays` (returns `variant close`, `caption CLOSE PLAY`, `slow true` at 1227.24 s), then `$C shot replay-close-1`, wait 2 s, `$C shot replay-close-2`. The pictures show the `CLOSE PLAY` tag top left and the low camera at second base; the state shows `director.replaying true`, `replayCaption CLOSE PLAY`, `hud.replay CLOSE PLAY`, `sim.hold true`.
- **Events.** Run `$C events --type broadcast.replayStart,broadcast.replayEnd,broadcast.graphicShown,safe,umpire_call --since 1215 --save replay-close`. Order: `umpire_call strike_called`, `safe` (closePlay), `umpire_call safe` (ump-2b), `broadcast.replayStart` (close), `broadcast.graphicShown` (closePlay), later `broadcast.replayEnd`.
- **The game resumes.** Run `$C ff "ev?.type==='broadcast.replayEnd'" --speed 1 --keep-replays` then `$C state`: `sim.hold` false, sim time moving again.
- **Home run sequence.** Run `$C goto "autostart&seed=1&tempo=broadcast&innings=9&quality=low"`, `$C ff "s.time >= 1405" --turbo`, `$C ff "ev?.type==='broadcast.replayStart' && ev.variant==='hr'" --speed 1 --keep-replays --timeout 120`, `$C shot replay-hr`.
- **Replays off.** Run `$C goto "autostart&seed=3&tempo=broadcast&innings=9&quality=low&replays=0"`, jump as above; no `broadcast.replayStart` follows the close play.
- **Proof.** `$C sheet --name replay --match replay-` plus the events file.

## Gotchas

- `ff` disables replays during a jump unless `--keep-replays`, and restores the setting afterwards. Always pass it on the final approach.
- While a replay plays, `sim.time` stands still (`sim.hold`): a condition on `s.time` will not advance until it ends.
- The CLOSE PLAY threshold is the sim's `closePlay` flag or a margin under 0.10 s; a different tempo or seed gives different plays. Re-run `seek` after sim changes.
- After the CLOSE PLAY replay ends, the director cuts back to the pitch camera for about 1 s of live play and then starts a second slow replay (`variant infield`, no caption, `REPLAY` tag). The engine README describes the second one as a normal-speed replay from the opposite side; treat a mismatch as a finding to report, not a harness failure.
- The umpire cut comes before the replay: a shot taken right at the `safe` event shows the umpire, not the replay.
