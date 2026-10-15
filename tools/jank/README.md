# tools/jank: the animation jank detector

Measures every way a player's body breaks, ranks the worst offenders and draws them. Built for the realism pass (Phase B0): measure first, then fix whole classes of problems.

```
npm run jank:check                                   # the ratchet: static + crossfade sweeps vs tools/jank/baseline.json (Node, ~15 s)
npm run jank:check -- --update                       # after an improvement: lock it in
npx tsx tools/jank/run.ts static                     # every clip x every shipped player file, raw
npx tsx tools/jank/run.ts fades                      # every clip switch in transitions.json, blended like three's mixer
npx tsx tools/jank/run.ts game --seeds 1,2,3         # seeded games in the real build, after all runtime overrides (~15 min per 9-inning game)
npx tsx tools/jank/run.ts sheets --top 16            # contact sheets of the worst frames (front, side, close-up of the joint)
npx tsx tools/jank/run.ts trace --seeds 1 --id <player id | role> --from 905 --to 915   # one puppet, frame by frame
npx tsx tools/jank/run.ts static --constrain          # also the clips through the game's passes after the mixer (look distribution, constraints)
npx tsx tools/jank/run.ts fades --constrain [--crossfade | --inertia]   # blends as the game does them / forced crossfade / forced inertialization
npx tsx tools/jank/run.ts game --seeds 1,2 --pre "globalThis.__noElbowFix = true"   # a switch flipped before the game (measure what a pass costs; trace takes it too;
                                                     # an object literal needs ./node_modules/.bin/tsx: npx brace-expands it)
npx tsx tools/jank/compare.ts tools/jank/out/before tools/jank/out/after   # before / after tables of two game sweeps (incl. the bat per clip)
```

`jank:check` gates four sections: the raw clips (`static`), raw blends (`fades`), and both through the runtime passes (`staticRuntime`,
`fadesRuntime`: pose/neck.ts and pose/constrain.ts as the game applies them).

Output goes to `tools/jank/out/` (git-ignored): `static.json`, `fades.json`, `game.json`, `report.md` (the ranked tables), `sheets/`.

## How it measures

- **Rig space, anatomical frames** (`src/engine/pose/skeleton.ts`): bone rotations are taken inside the model node, so the left-hander mirror and the
  height scale are divided out, and each bone's frame is its rotation times the inverse of its rest rotation: in the rest pose every joint is the
  identity in body axes (+Z forward, +Y up, +X the model's left), whatever the rig's bone roll.
- **Joint ranges** (`src/engine/pose/limits.ts`, shared with the runtime constraint layer): elbow / knee hinge flexion from the segment directions,
  signed against the flexion side (negative = bending backwards) plus the out-of-plane bend; shoulder / hip direction cones and twists
  (swing-twist); forearm pronation from neutral (the rig has no twist bones: the clips share it between the forearm and the hand, and
  `wrist.split` catches an unshared twist); neck + head and spine as axial twist plus swing (no Euler gimbal lock when the trunk bends forward).
- **The rest of `validate.ts`**: limb length drift, sole below / above the ground (the sim's ground: mound, dugout floor), planted heel or ball
  sliding, hand / elbow in the trunk, arm in the head, the bat (each fist on the handle, the fist's grip axis along the bat, the knob-side hand,
  barrel through the body or the ground, a dropped bat lying flat), one-frame flips (a step or an out-and-back pop), angular speed over human caps,
  running sideways. The game probe adds engine pops: the body mirrored between frames, the root jumping or spinning.
- **Attribution** (game sweep): every violation of the final pose is compared with the pose the mixer alone produced that frame: `clip` (the clip
  already does it), `blend` (the mixer was cross-fading), `override` (only the runtime look-at / IK / lunge / elbow fixes produce it).
- **Coverage**: joint angles are identical for every body build and for the mirror (rig space), so the static sweep runs each clip once per file;
  the bat clips also run mirrored as a self-test of the world-space checks (`jank:check` fails if they differ).

`jank:check` gates only the deterministic, sim-independent sweeps. The game sweep depends on the sim (another thread may change it) and is
reported as rates per 1000 puppet frames.
