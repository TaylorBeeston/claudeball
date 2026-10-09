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

# Pass 2 (2026-10-08, t-0017): "the soundscape introduced a performance regression"

## Method
- The earlier bench always ran with `noaudio`, so it could not see audio costs at all. New in this pass:
  - `--audio` (muted Chrome, fake voices);
  - a build-agnostic probe, `probe.ts`: main thread outside the rAF tick, the audio controller tick and its parts, Web Audio churn, `playbackStats`;
  - the audio render thread's load from a trace (`--audiotrace`);
  - `--play` (the real game at 1x);
  - `bisect.ts` (interleaved builds, each run with sound off and on).
- Builds: the first-parent merges from the last perf pass (`771bd96`, which contains `perf: batch 2 summary`) to main, made with `work/bisect/build.sh` into `work/bisect/dist-*` (git-ignored). The labels used below:
  - p00 `771bd96` perf baseline;
  - p02 `e784f41` audio: crowd model, park music, stings;
  - p07 `cd1cd4d` graphics passes and UI;
  - p08 `ee33acc` repo diet;
  - p09 `4263662` announcers: pregame, broadcast open;
  - p10 `aa294db` **soundscape**;
  - p11 `9095720` jank pass (= main).
- Medians of 2 interleaved repeats. The laptop was shared: load 2-11, GPU 25-95 % busy with other sessions (each run's load is in the tables). Counts are exact; times are noisy.
- The real phone was not connected.
- Tables:
  - `results/summary-pass2-bisect-laptop.md` (1080p vsync, low / high, scripted scenes);
  - `results/summary-pass2-bisect-emu.md` (750x832@2.625, CPU x2);
  - `results/summary-pass2-play-laptop.md` / `-play-emu.md` (90 s of the real game).

## Findings
1. **No steady-state frame regression from p00 to main, with sound off or on.**
   - Laptop: JS per frame, GPU ms, sim (0.2 ms), `getState` (0.1 ms) and puppets are within noise at every merge. Examples: high / wide JS 11.9 -> 11.7 ms (off), 12.1 -> 12.1 (on); GPU 8.8 -> 8.2 ms.
   - Phone proxy: also within noise (medium / pitchcam JS 14.5 -> 14.6; real game 14.6 -> 14.5 off, 14.4 -> 15.0 on; fps p5 29.6 -> 29.3, 30 fps-locked in every build).
   - Draw calls and triangles went down with the graphics passes: high / wide 1059 -> 863 calls, 11.5 -> 7.8 M triangles. The jank pass added 8-50 calls.
   - In the real game on the laptop, fps p5 wanders between 34 and 57 with no build trend: the GPU was 70-95 % busy with other sessions. From p09 on, the pregame opening shows different shots (fewer calls), so p08 -> p09 is not a like-for-like comparison.
2. **The audio render thread** (a separate real-time thread) did about 2.5x more work from p10:

   | scripted pitch shot | before p10 | from p10 |
   |---|---|---|
   | laptop, desktop path | 4.2-5.7 % of a core | 11-13 % |
   | phone proxy, phone path, laptop CPU | ~4.4 % | 5.3-5.5 % |

   - Real game: laptop 2.4-3.5 % -> 11.4-11.9 %; phone path 2.1-2.8 % -> 5.5-5.9 %.
   - Nodes created per second about 4x, AudioParam calls about 5x.
   - No underruns in any run.
   - Cost by node type (`--audionodes`, desktop, ms per audio second): convolver 19.6, gain 18.9, biquad 14.2, buffer sources 6.4, worklet 4.2, compressors 4.2.
   - Phone mix, offline: 30.4 ms/s in total. Without the convolver 24.3; without the crowd beds 20.8.
3. **Main-thread audio** (timers outside the tick): the controller tick costs 2-3 ms/s, about 0.05 ms per frame; the soundscape added ~0.5 ms/s. The phone path's analyser duck follower adds ~1.3 ms/s. Commentary and director parts are below 0.5 ms/s; the tick p99 is 0.4 ms and its max 2.4 ms on the laptop.
4. **The startup freeze, the regression a player feels.** Every sound (101 effects and one-shots, 3 bed loops, the IR) was synthesised on the main thread when the game started. Jobs ran in 6 ms slices, but a single job could take up to 115 ms on the laptop.

   | phone proxy, sound on, first 20 s | timer work | longest task | frame p99 |
   |---|---|---|---|
   | p00 baseline | 65-67 ms/s | 213-215 ms | 67-83 ms |
   | p02 crowd model | 83-91 ms/s | 283-284 ms | 83-117 ms |
   | p09 announcers | 81-90 ms/s | 261-282 ms | 83-133 ms |
   | p10 soundscape | 93-112 ms/s | 278-329 ms | 100-134 ms |
   | p11 main | 97-118 ms/s | 273-361 ms | 116-133 ms |
   | **this pass (worker)** | **5.3-5.4 ms/s** | **7-8 ms** | **36-52 ms** |

   It existed before the soundscape, grew with the crowd model (p02), and grew again with the soundscape's mono resampling and IR synthesis.

## Fixes
- **Start-up synthesis in a worker** (`src/audio/synthJobs.ts`, `synthWorker.ts`): pure jobs, results turned into AudioBuffers as they land, and the IR made there too. See the startup table above.
  - The main-thread fallback (offline render tool, tests) runs the same functions, so the sound is unchanged.
  - All 101 sounds are ready and the beds start.
- **Hidden page**: the AudioContext is suspended while the page is hidden and resumed when it is shown. The park graph used to keep 5-13 % of a core busy behind another app, and the paused game's murmur played on.
- `mixer.level()` no longer allocates (8 KB, 10 times a second).
- `vite.config.ts`: the asset / HDRI plugins honour `--outDir`. `dist-dbg` had no assets, so `alloc.ts` and `cpuprof.ts` measured stand-ins.
- Guards: the `perf:check` audio stage with `budgets.json` `audio.desktop|phone`:
  - standing nodes 183 / 123, mics 16 / 9, IR 2.3 s stereo / 1.6 s mono;
  - peak voices, nodes made per second, main-thread audio ms per second.

## Tried, not adopted
- **32 kHz context on phones** (`?audiorate=32000`, kept as a flag).
  - Live, the phone graph's whole audio callback went 5.7 -> 4.4 % of a core (-24 %, resampler included), with no underruns and latency +1.5 ms.
  - Renders against the 48 kHz phone mix: game LUFS -16.19 -> -16.22; impulse -0.17 dB; duck +0.19 dB; **organ -0.56 dB**; true peak +0.5 dB (still <= -1.5 dBTP); the duck engages a little earlier.
  - The mix moves, so the decision is the owner's.
- **Re-targeting the crowd-bed parameters only on a 1.2 % change** (fewer automation events): no measurable audio-thread gain (phone 30.4 -> 31.3, desktop 59.2 -> 57.1 ms/s, within noise). Reverted.

## Open
- **Real phone**: only it can show whether the extra audio-thread work (~+3 % of a laptop core on the phone path) costs frames or heat. Run `npm run perf:phone -- --audio --audiotrace` once it is plugged in.
- If the phone's audio thread matters, the next levers change the sound and need render A/B first: fewer bed zones or loops on phones (the beds are ~30 % of the phone mix's cost), the 32 kHz context, a shorter phone IR.

## Pass 2, batch 2 (after main's foley pass)
- **Shared air filter per mic strip.** Far pickups (one-shot copies and the fixed wiring) now go through one air-absorption low-pass per strip instead of a new biquad per copy. Filters in series commute and sum linearly, so the mix is the same:
  - renders null against the previous mix at -85..-101 dB (the tool's run-to-run floor is about -91 dBFS);
  - LUFS and true peak are identical in all 8 renders (game, impulse, duck, organ; desktop and phone);
  - biquads made per second: 0.87 -> 0.10 (desktop), 0.67 -> 0.02 (phone);
  - in `perf:check`'s window, nodes made per second: phone 30 -> 12, desktop 78 -> 63 (this includes the foley pass's changes);
  - the desktop standing graph is 181 nodes (was 183).
  - The audio thread's load did not move measurably (the machine was at load 14-21).
- **Fewer crowd-bed zones on phones (3 instead of 4: the outfield folded behind home): rejected.** The phone game mix moved -0.37 LUFS (-16.56 vs -16.19), and no CPU saving was measurable. Each zone carries its own fans' reactions and direction, so any merge moves the mix.
- **Startup with the foley pass**: 168 synthesis jobs (~1 s on this laptop), all in the worker. On the phone proxy, all 151 sounds the mixer prepares were ready, the longest timer task was 8-13 ms and timers took 6-7 ms/s in the first 20 s.
- **The pregame's single missed vsyncs** (`--play` now tags every frame with the director's shot; real game, laptop, high, 150 s from the start, 2 runs):

  | shot | frames missed | JS median | GPU median | draw calls |
  |---|---|---|---|---|
  | `broll:aerial` | 8-10 % | ~16 ms | 11-12 ms | 780-860 |
  | `broll:dugout` (one run) | heavy too | 15 ms | 12 ms | 829 |
  | pitch camera | 1.2 % (background noise) | | | 240-330 |

  - The new bench scene `aerial` costs the same as the long-standing `wide` (high: JS 15.8 / 15.8 ms, GPU 11.5 / 11.3, 837 / 872 calls). It is a whole-park shot at the edge of the 60 Hz budget, not a new kind of cost.
  - The pregame opening simply shows more of them.
  - Census of the aerial at high: the 47 players are ~450 of its ~540 main-pass calls (~10 each, already on their smallest detail tier), the stadium ~110, the crowd 12.
  - Fewer draws per tiny player would change pixels (Medium+ must stay identical). The options are listed in the report: a far tier at Low only; the adaptive controller degrading before a scheduled whole-park B-roll; fewer aerials on phones.
