# Claudeball performance tooling

Real-browser, real-GPU measurement for the 3D game: an in-page profiler, a deterministic benchmark, and runners for desktop Chrome, a phone-emulating Chrome and a USB-connected Android phone.

```
npm run perf -- --presets low,medium,high --scenes pitchcam,wide,faces   # laptop Chrome, vsync on (what a player sees)
npm run perf:gpu                                                         # same, vsync + frame limit off (how fast could it go)
npm run perf:emu -- --emu 412x915@2.625 --cpu 4                          # phone proxy: viewport, DPR, touch, CPU throttle
npm run perf:phone                                                       # Android Chrome over adb (see below)
npm run perf:check                                                       # draw-call / triangle budgets per preset (CI-friendly, deterministic)
npm run perf:report -- results/a.json [results/b.json]                   # markdown for one run, or a comparison of two
```
All runners build `dist/` (`vite build`) and serve it with `vite preview` unless `--no-build` (reuse `dist/`) or `--url <page>` (e.g. the deployed site).
Options: `--presets --scenes --tod day,dusk,night --frames 360 --warm 90 --seed 15 --tempo standard --scale 1 --repeat N --trace --shots --size 1920x1080 --angle gl|vulkan --label name --extra "k=v&k2=v2"`.
Results go to `tools/perf/results/<label>-<target>-<time>.json|.md` (git-ignored; traces in `results/traces/*.json.gz`, screenshots in `results/shots/`). Commit only the short summaries (`results/summary-*.md`).

## What is measured
- **Frame** = interval between two `requestAnimationFrame` callbacks (what the player feels); **JS** = the engine tick on the main thread; its **laps** add up to it
  (`sim`, `director`, `bat+side`, `puppets`, `ball+props`, `hud`, `post-setup`, `crowd`, `env`, `render`); **subs** are nested costs that overlap the laps (`sim.step`, `sim.getState`, ...).
- **Passes**: `shadow` (all shadow-map renders), `main`, `gtao_gbuf` (GTAO's depth/normal prepass, part of `gtao`), `gtao`, `dof`, `bloom`, `output`, `grade`: CPU submit ms (children excluded), GPU ms and draw calls / triangles.
  GPU ms come from `EXT_disjoint_timer_query_webgl2` (one query open at a time; nested passes switch the query), read back a few frames late. Desktop Chrome has it, **Chrome on Android does not** (the phone report says `gpu n/a`): there, "render CPU ms" is the draw-call submit cost and the frame time minus JS time is GPU / compositor wait.
- Heap (needs `--enable-precise-memory-info`, set by the launcher), GC events (heap drops), allocation MB/s, long frames > 25 ms with a cause (`cpu: <lap>`, `gc`, `gpu / vsync`, `browser`), `longtask` / long-animation-frame counts, `renderer.info` geometries / textures / programs, texture memory estimate.
- Device facts: GL renderer (`UNMASKED_RENDERER_WEBGL`), DPR, screen/viewport, cores, memory, texture units/size, MSAA samples; the runner adds `nvidia-smi` + load average before/after (the laptop is shared with other agent sessions: **always read those**, repeat runs with `--repeat`), and for the phone battery/skin temperatures and `thermalservice` status before/after each preset.

## In the game: `?perf=1`, `?bench=1`
- `?perf=1` shows an overlay (fps, laps, subs, per-pass cpu/gpu/calls/tris, heap, GC, last long frame, preset / scale / dpr / px) and exposes `window.__perf` (`stats(n, skip)`, `frames()`, `reset()`). Everything is behind one boolean: with the flag off there is no cost.
- `?bench=1&autostart&noaudio&seed=15&tempo=standard&quality=high&tod=day&scenes=pitchcam,wide,follow,infield,faces,crowd,dugout,stadium&frames=360&warm=90&scale=1`
  runs scripted static cameras with the game stepping a fixed 1/60 s per frame (so every preset plays the same game), the adaptive resolution scale **off** (so presets are comparable; `scale=` fixes it), and publishes `window.__bench` (`done`, `results[]`, `device`).
  `shots=1` makes each scene wait until the runner has saved a screenshot. Extra URL flags that help isolate costs: `?nopost`, `?noao`, `?nobloom`, `?nodof`.

## Desktop launcher (`lib.ts`)
Your own headed Chrome with a throwaway profile (`--user-data-dir=/tmp/cbperf-chrome-*`), `--remote-debugging-port=<free>`, `--use-angle=gl` (or `--angle vulkan`), `--enable-gpu-rasterization --ignore-gpu-blocklist`, background throttling off, then Playwright `connectOverCDP`.
The user's own browser (Brave) is never touched. Check the first report line: the renderer must read `NVIDIA ... RTX 4090 Laptop GPU`, not SwiftShader / llvmpipe.
`--uncapped` adds `--disable-frame-rate-limit --disable-gpu-vsync`. `--trace` records a Chrome trace (devtools.timeline, v8, gpu, viz) per (preset, scene) as `.json.gz` for ui.perfetto.dev / DevTools.

## Phone (`npm run perf:phone`)
1. On the phone: Settings > About phone > Software information > tap *Build number* 7 times; Developer options > **USB debugging** on; plug in, accept the RSA prompt (`adb devices` must say `device`). Unlock the screen and keep Chrome (`com.android.chrome`) installed. For the inner screen of a foldable, unfold it.
2. `npm run perf:phone -- --presets low,medium,high --scenes pitchcam,wide,faces`
   The script: checks `adb devices`, keeps the screen awake while USB-connected (`stay_on_while_plugged_in`, restored afterwards; left alone if already on), starts a **fresh Chrome tab** on `about:blank` (your tabs are never touched; the tab is closed afterwards), `adb forward`s **Chrome's own** DevTools socket (`chrome_devtools_remote_<pid>`; the generic `chrome_devtools_remote` socket is shared with other Chromium apps and may hang), serves the local build via `adb reverse` (the phone opens `http://localhost:<port>/`, a secure context) or uses `--url`, runs the same bench through CDP, records battery / thermal state, then removes the forward / reverse again.
3. Nothing is installed on the phone and no setting except stay-awake is changed.

## Phone emulation on the laptop
`perf:emu` sets `Emulation.setDeviceMetricsOverride` (default 412x915 @ 2.625), touch emulation (so `(pointer: coarse)` matches and the phone pixel-budget policy applies) and `Emulation.setCPUThrottlingRate` (default 4x). It is a proxy for the CPU side only; the GPU is still the 4090.

## Budgets (`perf:check`)
`tools/perf/check.ts` runs a short deterministic bench (a few scenes, `frames=30`) per preset and fails if draw calls or triangles per frame exceed `tools/perf/budgets.json`. These are machine-independent numbers (counts, not times), so they can run in CI. Update the budgets deliberately when assets change.
