# Performance findings (t-0012, 2026-10-02)

Measured with the tools in this folder: headed Chrome 150 on the RTX 4090 Laptop (ANGLE/GL; renderer string `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4090 Laptop GPU/PCIe/SSE2, OpenGL ES 3.2)`, GPU timer queries available), and the Galaxy Z Fold 7 (Chrome 154, `ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)`, 8 cores, 8 GB, 16 texture units, DPR 2.625, folded = cover screen 411x814 css; the phone has no GPU timer extension).
The laptop GPU is shared with other agent sessions (Chrome, Brave, Blender, wivrn: 45-99 % utilisation during the runs): every result file records `nvidia-smi` and the load average; compare within a run. Summary tables: `results/summary-2026-10-02.md`.

## 1. The problem was never fill rate: it was draw calls (and the triangles resubmitted by each pass)

Baseline (commit a8a48be), laptop, 1080p, `high`, day: **~7 700 draw calls and 24 M triangles per frame**, `renderer.render` = 64-74 ms of main-thread time. Phone, `medium`: 7 500 calls, 22.7 M triangles, 79 ms of the 83 ms frame was `render` submit. Low: 3 100 calls, 31 ms.
Evidence that it is call-bound, not pixel-bound: (a) CPU submit ms and GPU ms per pass are almost identical (`shadow 41.4 / 41.2 ms`), i.e. the GPU sits waiting for the command stream; (b) cost per draw call is a constant ~9-10 us on both devices (laptop 41 ms / 4 766 calls = 8.7 us; phone 31 ms / 3 100 = 10 us); (c) presets that change pixels (MSAA, resolution, DoF, AO half/full res) barely move the frame time, exactly what the user saw ("only high -> ultra changes anything": ultra adds a 4th cascade = +1 500 calls); (d) the whole CPU side of the game (sim, director, HUD, crowd update, puppets) was 2-3 ms.

Where the 7 700 calls came from (census, `tools/perf/census.ts`):
| source | detail |
|---|---|
| 47 puppets x ~25 visible skinned sub-meshes (Body_Skin 12k tris, Head 8.5k, Eyes 3.8k, Cleats 5k, Undershirt 4.8k, hands 3k each, caps, jersey, pants, socks, belt, buttons, piping, soles, spikes, eyebrows, lashes, cornea shell, wristbands, numbers ...) | **1 172 meshes, 2.96 M tris, 63 k tris per puppet** |
| every puppet part had `frustumCulled = false` | all 47 were drawn in every pass, even when the camera saw 5 of them |
| passes that redraw the puppets | main + GTAO depth/normal prepass + 3 sun cascades (+ each casting tower spot at night) = 5-9 submissions of the same 1 172 meshes |
| casters: 780 of the 1 172 meshes cast shadows (eyebrows, lashes, spikes, collars, undershirts, socks, belts ...) | shadow pass = 4 766 calls at medium |
| stadium crowd / seats: 484 azimuth-sector instanced chunks (24 sectors x ~20 mesh kinds) | main pass ~510 calls; also drawn again in the GTAO prepass |
| morph targets: 3-16 per mesh on 60 of 67 meshes (static per player), skinning, 2K textures x ~5 maps per material | adds per-draw uniform uploads (morphTargetInfluences, bone texture binds) |

## 2. What was NOT the problem (measured)
- sim `step` + `getState` (called at 120 Hz): 0.1 ms per frame together. `getState` frequency is fine; no worker needed.
- HUD, director, crowd uniforms, audio, env/CSM frustum update: < 0.5 ms together. DOM updates are negligible in the bench (HUD at 0.0 ms).
- puppet logic (mixer, look-at, IK, `updateMatrixWorld`): 1.8-3 ms on the laptop, 6-10 ms under 4x CPU throttle: worth trimming later, not the bottleneck.
- Texture memory / compile: not frame-time relevant after warm-up (the bench discards 90 warm-up frames; `renderer.info.programs` stays flat).
- Allocation: 150-280 MB/s (a minor GC every ~10 frames) but **66 % + 10 % of it is `gl.uniformMatrix4fv/3fv` called from three's `setValueM4/M3`** (sampling heap profile, `tools/perf/alloc.ts`): a native binding allocation per uniform upload, so it scales with draw calls, not with game code. Game-side garbage (interpolated state, poses) is ~10 % in total.
- the preset matrix: before the fixes `low` only differed from `medium` by 2 cascades fewer and no AO / bloom (both are cheap in GPU terms), so the call count dominated everything and presets looked identical.

## 3. Fixes applied (each measured; details and numbers in `results/summary-2026-10-02.md`)
1. **Culling**: puppets' skinned meshes now use a fixed 2.1 m sphere around the body (the bind-pose bounds that made earlier code set `frustumCulled = false`) -> out-of-view puppets cost nothing in the main pass, GTAO prepass and every shadow cascade. (`?nocull` = old behaviour.)
2. **Merged shadow proxy**: the casters of a puppet (body, head, hands, jersey, pants, cap/helmet, cleats, gloves, gear; no hair cards, eyebrows, lashes, spikes, undershirt, socks, belt ...) are merged once per template and variant set into ONE skinned mesh sharing the puppet's skeleton; it is visible only while `renderer.shadowMap.render` runs (the main pass list is built before the shadow pass starts). 25 shadow casters -> 1 per puppet per cascade. (`?noproxy` = old behaviour with the tightened caster list.) A same-frame screenshot A/B shows no visible difference in shadow shape.
3. **Puppet level of detail by projected size** (render layers, not `visible`, so the gear-variant logic is untouched): tier 1 (< 22 % of screen height at high, 14 % ultra, 30 % medium, 40 % low): cornea, eyebrows, lashes, buttons, piping, buckle, soles, spikes, wristbands, eye black, stubble, mustache, glove laces, cap logo are skipped by every pass; tier 2 (< 9 / 5 / 12 / 20 %): also eyes, belt, collar, undershirt, numbers, goatee, arm sleeves. Uses the camera's FOV, so a telephoto close-up is full detail and a wide shot drops to ~10 draws per player. (`?nolod`.)
4. **GTAO prepass**: draws the real body shapes but skips detail parts and the whole crowd (AO from spectators is invisible) - first attempt with the merged proxy produced AO blotches on the ground (depth/normals of the un-morphed proxy), so the proxy is shadow-only.
5. **Crowd / seat sectors per preset** (low 4, medium 8, high 12, ultra 24; rebuilt on preset change): 484 -> ~100-250 calls.
6. Shadow-casting list tightened (see 2); `Engine.tick` laps and `perf` hooks add < 0.05 ms (one boolean) when `?perf` is off.

Result on the laptop (vsync, 1080p, contended GPU): **every preset/scene now holds 60 fps** except ultra/wide (30-60) and occasional vsync misses at medium+ on wide shots; draw calls 7 700 -> 400-1 700, triangles 24 M -> 4-20 M, JS frame time 65-95 ms -> 6-19 ms. `low` is now 2x cheaper than `ultra` in JS time as well as GPU time.

## 4. Still open / next candidates (ordered by expected payoff)
- Real phone numbers after the fixes (the phone was unplugged mid-session; run `npm run perf:phone`). Emulated phone (4x CPU throttle, 412x915@2.625): low 30 fps vsync-locked at js 23-26 ms, medium/high 20-30 fps at js 34-40 ms: the remaining JS is `render` submit 14-31 ms and puppets 6-10 ms (throttled): the next levers are below.
- Main pass is now the biggest pass (400-1 000 calls): merge each puppet's visible parts by material (GLB side: `gltf-transform join` per skin/material; coordinate with t-0007), or a baked single-material far-LOD skinned mesh for tier 2.
- Triangles: 3-20 M per frame is still a lot for a phone GPU (63 k tris per puppet at full detail): ship / use the `optimized/lod1` players (30 % tris, 512 px textures; they exist in the repo but are not deployed) for tier 1/2 puppets, plus simplify the stands (2 M tris of seat/crowd instancing).
- Puppet CPU: skip `mixer.update` / IK / look-at for puppets outside the camera frustum (quarter rate), cache morph influences (static per player: bake them away), `root.updateMatrixWorld(true)` is called 3-4x per puppet per frame.
- Presets: add the start-up micro-benchmark to choose the default preset (needs the phone numbers), make the adaptive scaler also drop the crowd sectors / shadow cascades when CPU-bound.
- Deploy size 115 MB: textures are 2K WebP x 14 files; KTX2/ETC2 + 1K textures for far tiers would cut the phone download and GPU memory (`toktx` not installed here).

# Batch 2 (2026-10-03)

## What the real phone said about batch 1 (Z Fold 7, unfolded inner screen, see results/summary-phone-2026-10-03.md)
Low and Medium run 60 fps on the pitch / close-up shots (JS 10-15 ms, 230-580 calls), the wide shot at Medium+ dips (1 460-1 540 calls, JS 13-37 ms), Ultra is 20-30 fps; the phone reached Android thermal status 3 during a low -> ultra run, so the late rows are partly thermally throttled. The phone's CPU cost per frame is only **1.5-2x the laptop's**, so `perf:emu --cpu 2` is the right proxy; the 4-6x settings are pessimistic.

## What batch 2 changed (laptop 1080p, vsync; emulated phone; all numbers in results/summary-2026-10-03-batch2.md)
1. **Shadow maps were rendered twice per frame.** GTAO's depth/normal prepass is a second `renderer.render`, which re-ran the whole shadow update. Switched off inside the prepass: shadow draw calls halved (466 -> 234 in the wide shot), triangles -35 %.
2. **Puppets own their matrices.** `renderer.render`'s scene-wide `updateMatrixWorld` recomputed every puppet subtree (~100 nodes x 47) a second time; puppets now compose their own root and update their tree once per frame (three skips a node's own world matrix when `matrixWorldAutoUpdate` is false: a first version forgot that and left every puppet at the origin, caught by the draw-call count jumping 3x, and fixed).
3. **Off-screen and tiny puppets are simplified**: outside the camera frustum (and not the batter, pitcher, catcher, runner, ball holder or someone catching / throwing): advanced every other frame, quarter-rate mixer, no look-at / IK; tier-2 (tiny) players the same. Puppet CPU 7 ms -> 5 ms under 4x throttle in the pitch shot.
4. **Simplified player geometry** for small / distant players (tier >= 1, a third of the triangles, same skeleton / uvs / morph targets, uploaded and compiled during the warm-up): triangles in the wide shot 19 M -> 9.5 M, draw calls 1 600 -> 990.
5. **GTAO prepass**: only close players (tier 0) draw their body shapes; small ones and the crowd stay out (their contact shadow quad anchors them).
6. **Adaptive controller** (`AdaptiveScale`, tested): CPU-side load levels (puppet LOD thresholds x1.5, crowd sectors <= 4 and still crowd, tower shadows <= 1, far cascades every 2nd frame, AO + DoF off) next to the render scale; picks the lever from where the time goes (JS vs frame interval); the old controller could never restore resolution at 60 Hz vsync; back-off doubles when a restore is followed by a degrade.
7. **Start-up tuner** for Auto quality (`src/ui/tune.ts`): runs ~48 real frames of the park behind the loading screen, measures tick time and frame interval, steps the preset down (or up once, desktop only: phones cap at Medium) and remembers the result per device signature. It measures; the user agent only supplies the starting point. (Real-phone outcome not yet seen: the emulated 750x832 CPU x2 case lands on Low because the menu fly-around camera is a wide shot with tick 19-23 ms; thresholds may need loosening once the real phone's tuner result is known.)
8. **Assets / download**: unused role files are no longer shipped (deploy 115 -> 88 MB), `gear_defaults.json` replaces three whole player files, `players_1k/` for touch devices (`player_base` GPU memory 186 -> 71 MB), first-load download for a phone 85 -> ~46 MB (45.6 MB measured), desktop 52.8 MB. Also: `players/player_manifest.json` (clip event times, glove keys, foot speeds) was never part of the deploy; it is now.

Laptop result: **every preset and scene is 60 fps (p5 59.5)**, including Ultra in the wide shot (was 30), with JS 5-15 ms (batch 1: 6-28 ms) and 190-1 350 draw calls. Emulated inner screen (CPU x2): low 60 everywhere, medium / high 60 on pitch and close-up, 53 / 38 fps on the wide shot. Emulated, interleaved A/B at x3: wide shot 20 -> 30 fps, calls 1 169 -> 736, tris 15.7 M -> 8.2 M.

## Tried and dropped
- **The merged proxy for the GTAO prepass**: ambient-occlusion blotches on the ground (three attempts incl. mirrored winding and a stale skeleton; the stale-skeleton bug was real for shadows of culled puppets and is fixed there).
- **A one-draw-call "far look"** (merged proxy with a vertex colour per part): parts landed in the wrong place with wrong colours; reverted. Merging parts by material for the main pass was not attempted at tier 0 (few players are close, and the morph sets differ per part); the right place for it is the GLB (see the note to the assets thread in the report).
- KTX2: `toktx` is not installed; the 1k / 512 px WebP set is the alternative (a KTX2 encoder in WASM, e.g. `ktx2-encoder`, would also cut GPU memory 4x again).
