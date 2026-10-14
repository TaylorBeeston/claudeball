# Promo jank log (t-0019, from 2026-10-14)

Everything that looked wrong while making the promo: shot, evidence, root cause, fix, commit. Footage was watched as contact sheets of the
real broadcast (`npx tsx tools/promo/qa.ts`, a picture every 0.5 s of game time with the director's shot name, the sim events and an
**occlusion probe**: a ray from the camera to the director's look-at point against the park's meshes, printed as `BLOCKED:<mesh>`), production
build in headed Chrome 150 on the RTX 4090 Laptop, `tempo=standard`, HDRI skies as deployed. Sheets: `~/claudeball-promo/qa/` (not committed).

| # | issue | evidence | root cause | fix | commit |
|---|---|---|---|---|---|
| P1 | During a steal of third the broadcast showed a grey concrete wall for 12 s (the runner a sliver at the edge) | seed 30, sim 3908-3919, `base` shot, probe `BLOCKED:Dugout_3B@2.0/20.5`, camera (30.4, 2.4, 13.4) | the low base camera is offset sideways by a perpendicular that was not mirrored: on the first-base side it swings toward the outfield, on the third-base side toward home, into the third-base dugout | `sightLines.ts`: the offset always turns toward the outfield (first and third mirror each other), and the rig tries other placements until a ray to the bag misses the park's solid blocks (dugouts, their roofs, the batter's eye, read from the loaded field / stadium); `sightLines.test.ts` checks every base against the shipped models | (this branch) |
| P2 | The home-run shot "ball leaving the park" showed a black wall filling the frame | seed 30, sim 3925.5-3927, `hrwall`, probe `BLOCKED:BattersEye@18.9/35.7` | the camera 26 m to the side of where the ball crossed the fence did not know about the batter's eye: a ball to dead centre went over the block, which the camera filmed from behind (unlit, black) | the same line-of-sight rig: other side, further back or higher (5.5-27 m) until it sees the fence point and the ball's path over the block; the test checks every fence point of the shipped layout at three heights | (this branch) |
| P3 | A grounder with two on and nobody out was turned into three force outs (5-4-3) and the ticker said "grounds into a double play" | seed 23, sim 441-444: `out` x3, `plateAppearanceEnd result: 'double play'`; 7 such plays in 240 scouted games, all legal (0 outs, two on) | `rules.ts` called any play with two or more outs a double play | three outs = `triple play` (result and text), the crowd and the booth's game log treat it like a double play (the booth's own `out.tp` call already existed); `tripleplay.test.ts` | (this branch) |
| P4 | After a home-team home run the crowd heard fireworks but nothing was in the sky | seed 153 walk-off (sim 4700.5) at night: the `firework` cue plays at 1.6 s, the sky above centre field stays empty | the sound existed (`cues.ts`), the picture never did | `fireworks.ts`: a three-shell volley over centre field (one additive `Points` draw call, sparks computed on the GPU from birth time with drag and gravity, hidden when nothing is in the air) and `fireworksPlan.ts` shared with the sound, which now plays one burst per shell where and when it bursts | (this branch) |

Capture-only problems (the promo runtime, not the game): the loading screen's fade-out was frozen into the first frames when the virtual
clock took over CSS animations (now finished before the switch); a real mouse moving over the headed capture window opened the player's
control bar over the broadcast (the controls are hidden while capturing).

## Known, not fixed here (for the coordinator)
- No diving catch exists: the sim has no dive for fielders (only `dive_back` for runners), so the promo shows lunges and wall leaps instead.
- Steals: 19 successful steals in 240 scouted games and none avoided a tag (`tagAvoided` never fired on a steal).
- Bang-bang plays at first (`closePlay`, |margin| < 0.10 s) are rare: 1 in 240 games.
