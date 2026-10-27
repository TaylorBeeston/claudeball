# Broadcast camera director and B-roll

An automatic director cuts the broadcast like TV: the center-field pitch camera for each pitch, follow and fielder shots on balls in play, base and action shots, the home-run sequence, and during lulls B-roll (walk-ups, face close-ups with rack focus, on-deck, dugouts, the catcher's signs, shake-offs, lead-offs, base coaches, bullpen, crowd, scoreboard, aerial, sky, mound visits, umpires). Some shots carry a lower-third card (ON DECK, WALKING UP, AT BAT, PITCHING, NOW WARMING, COMING IN). The viewer can switch to a free camera.

## Sub-features

- `cam-pitch` frames every pitch from center field.
- `cam-play` follows the ball and the play (follow, fielder, base, action shots) until things go quiet.
- `cam-broll` fills lulls with B-roll shots (2.5-6 s holds, no repeats within 4 shots, never during a windup or pitch).
- `cam-cards` shows a lower-third card for shots about a player.
- `cam-reaction` cuts, after a big moment, to the person reacting to it while his face still shows it (strikeout, walk, hit, hit by pitch,
  brushback, error, close call, home run, robbed homer, pitching change): `director.shot` `reaction`, a `shot` event of kind `reaction` with
  the subject. Paced per tempo (Broadcast: at most 3 a half inning, 18 s apart; Quick: 1, 60 s, only the big moments), only at 1x speed.
- `cam-transitions` cuts people and dissolves scenery (`cameraCut` kind `cut` / `dissolve` / `broll` / `replay`).
- `cam-free` lets the viewer take over with `C` or Settings → Camera → Free.

## How to get to it (user POV)

- Watch any game at Broadcast pace; the pregame and every between-batters lull have B-roll.
- `C` toggles Auto / Free camera; the drawer has `Camera: Auto`.

## Driving it with cbv

Preconditions:

- A session; `$C goto "autostart&seed=24&tempo=broadcast&quality=low"`; `$C doctor` exit 0.

- **Pregame B-roll.** Let 25 s of game pass at 1x: `$C ff "s.time > 25" --speed 1 --keep-replays`. Run `$C events --type broadcast.shot,broadcast.cameraCut --save cam-pregame`. Shots start and end in pairs (`phase start` / `end`, `kind` e.g. `aerial`, `crowd`, `infieldDrill`), with `cameraCut` kind `broll` between them.
- **A B-roll shot with a card.** Run `$C ff "ev?.type==='broadcast.shot' && ev.phase==='start' && ev.card" --speed 1 --keep-replays --timeout 240` then `$C shot cam-card`. The state's `director.broll` names the shot (`ondeck`, `walkup`, `faceCloseup` …); `hud.card` shows `ON DECK` / `WALKING UP` / `AT BAT` with the player named in the event's `subjectId`.
- **The pitch camera.** Run `$C ff "ev?.type==='pitch'" --speed 1 --keep-replays` and `$C shot cam-pitch`. `director.shot` is `pitch`; the picture is the center-field view of pitcher and batter.
- **Following a play.** Run `$C ff "ev?.type==='contact'" --speed 1 --keep-replays`, wait a second, `$C shot cam-follow`. `director.shot` is `follow`, `fielder`, `base` or `action`.
- **A reaction shot.** Find a moment with `$C seek "ev?.type==='pa_end' && ev.result.startsWith('strikeout')" --seeds 24 --max 1`, jump to
  10 s before it with `ff --turbo`, then `$C ff "ev?.type==='broadcast.shot' && ev.phase==='start' && ev.kind==='reaction'" --speed 1 --keep-replays`,
  wait ~0.5 s (the expression's attack) and `$C shot cam-reaction` plus `$C eval "engine.players.faceProbe('<subjectId>')"`: `on: true` (the face
  passed the head-size gate) and the reaction named. Without `--speed 1` there are none (reaction shots are off at 2x / 4x). Over whole games
  without a browser: `npx tsx tools/director/measure.ts --seeds 1,2,3,24 [--tempo quick] [--reactions off]` (sim + director + emotion model in
  Node, the table of moments, what the camera showed and the reaction shots per game).
- **Free camera.** Run `$C press c`, `$C state`: `director.auto` false. Press `c` again to return.
- **Proof.** `$C sheet --name cam --match cam-` and the events file: each picture's `director` block names the shot that the event log announced.

## Gotchas

- B-roll exists only in lulls the sim reports; at Quick pace there are few. Use Broadcast for this feature.
- `ff --turbo` and `next` skip B-roll (no lulls are rendered); approach at `--speed 1`.
- Dissolves blend two frames for up to a second; a screenshot right after `cameraCut kind dissolve` shows both shots.
- `tools/visual/look.ts --mode play --every 2.5 --sheet` gives a director contact sheet over a longer stretch (headed Chrome, its own build in `dist/`).
