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
