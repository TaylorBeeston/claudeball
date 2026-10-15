# Fielding and baserunning

Once the ball is in play, fielders read and chase it, catch it on the fly or field it on the ground, and throw to a base; runners run, take extra bases, steal, tag up, slide, and are tagged or forced out; umpires at the bases signal safe or out. Home runs clear the fence and the batter trots the bases. Every outcome comes from the physics and the players' attributes and decisions.

## Sub-features

- `field-catch` shows catches in the air and on the ground (`catch` with `inAir`, height, side), wall leaps and robbed home runs.
- `field-throw` shows throws to a base or the cutoff and the receiver's catch.
- `run-advance` shows runners advancing, taking extra bases, holding, and coaches waving or stopping them.
- `run-steal` shows steals and pickoff attempts, with the catcher's throw.
- `run-tag` shows tags made or avoided by a slide, and force outs.
- `run-touch` shows every base touched by each runner (`base_touch`), including the home-run trot.
- `run-extra` places the automatic runner on second from the 10th inning (and in extra innings of shorter games).
- `field-homerun` sends the ball over the fence (`homerun`, distance) and the batter around the bases.

## How to get to it (user POV)

- Watch any game; balls in play happen within the first innings.
- Use `.` (Next batter) to move between plate appearances.

## Driving it with cbv

Preconditions:

- A session and `$C doctor` exit 0.

- **A steal with a close play.** Run `$C goto "autostart&seed=3&tempo=broadcast&innings=9&quality=low"`, `$C ff "s.time >= 1215" --turbo`, `$C ff "ev?.type==='safe' && ev.closePlay" --speed 1 --keep-replays`. It hits at sim 1225.54 s: `safe` at base 2, margin -0.08 s, then `umpire_call` `safe` by `ump-2b`. `$C events --since 1215 --save field-steal`. The ticker reads `Throw! Gavin Carter is safe. Gavin Carter steals second.`
- **A home run.** Run `$C goto "autostart&seed=1&tempo=broadcast&innings=9&quality=low"`, `$C ff "s.time >= 1405" --turbo`, `$C ff "ev?.type==='homerun'" --speed 1 --keep-replays --pause` and `$C shot field-hr-1`. The event carries `distance` ~114 m. Unpause with `$C press Space` and let the trot run: `$C ff "ev?.type==='base_touch' && ev.base===4" --speed 1 --keep-replays`. `$C events --type base_touch,homerun,run --since 1405 --save field-hr` shows bases 1, 2, 3, 4 for the batter (and the runner from first) with `trot: true`.
- **Bases loaded, two outs.** Run `$C seek "s.outs===2 && s.runners.every(Boolean)" --seeds 6 --max 1` (or use the grand slam: seed 6 at 3536.7 s, bottom 5). Jump with `ff --turbo` to 10 s before and `$C state` shows `runners [true,true,true]`, `outs 2`; the scorebug diamond has all three bases lit.
- **Base touches on any play.** After a hit, run `$C events --type base_touch,out,safe,tag --tail 20`. Every runner who advanced has one `base_touch` per base passed.
- **Extra-inning runner.** Run `$C goto "autostart&seed=3&innings=1&tempo=quick&quality=low"`, `$C next half --until "s.inning===2"`. If the game was tied after one inning, `state` shows `runners [false,true,false]` at the start of the half.
- **Proof.** The `.events.jsonl` files plus shots at the moment of the play (`--pause`), each with its state json.

## Gotchas

- The live picture of a play is often a replay a second later: check `director.replaying` in the shot's state json before calling a frame "live".
- `ff` turns replays off during a jump; pass `--keep-replays` on the final approach or the play's replay never happens.
- Known product issue (2026-10-14, user report): runners do not always put a foot on the bag even when the sim logs `base_touch`; the event alone does not prove the visual. Frame the base (`tools/visual/jank.ts --cams body:<runner>`) when that is the question.
- Known product issue: fielders and runners pass through each other (no body collision yet).
- A play's details (who, where) depend on the tempo: seed 3 at Quick is a different game from seed 3 at Broadcast.
