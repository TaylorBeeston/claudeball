# Graphics quality, Auto tuner and performance

Graphics come in four presets (Low, Medium, High, Ultra) plus Auto. Auto measures a few dozen frames of the park behind the loading screen and picks the preset that fits 60 fps on this device (at most High on a desktop, Medium on a touch device), remembering the choice. During play an adaptive resolution scale (0.55-1.0) lowers the internal resolution when frames get slow and restores it with headroom. Quality and time of day can be changed in Settings, the drawer, or with `Q` / `T`.

## Sub-features

- `quality-presets` switches Low / Medium / High / Ultra (shadows, ambient occlusion, bloom, depth of field, crowd density, pixel ratio).
- `quality-auto` tunes at start-up and remembers the result per device.
- `quality-adaptive` scales the resolution with frame time.
- `quality-tod` switches Day / Dusk / Night.
- `quality-fps` shows fps and scale in the controls drawer.

## How to get to it (user POV)

- Settings → Graphics quality / Time of day; the drawer's quality and time-of-day selects; keys `Q` and `T` while playing.
- A link with `?quality=…`.

## Driving it with cbv

Preconditions:

- A session; `$C doctor` exit 0 with the GPU renderer (not SwiftShader). Keep runs short: the GPU is shared with other agents' work, and the measurement is a sample, not a benchmark.

- **Auto picks a preset.** In a fresh session without `quality` (`$C launch --no-build --query "menu=1&seed=24"`), `console.jsonl` has a `[boot] tuned <preset> [[preset, tickMs, intervalMs], …]` line and `$C state` shows `render.quality`. Run `$C eval "localStorage['cb.tune.v1']"` to see what was remembered.
- **Change a preset in play.** Run `$C goto "autostart&seed=24&quality=low"`, `$C ff "s.time > 72" --speed 1`, `$C shot q-low`, then `$C press q` and `$C state`: `render.quality` `medium`; `$C shot q-medium` after 2 s. The pictures differ in shadows, AO and crowd density.
- **Time of day.** `$C press t` twice and `$C shot q-night`: night sky, stadium lights on, `render.tod` `night`.
- **Frame times.** Run `$C perf --secs 5 --save q-sample`: frames, fps, p50 / p95 / max ms, quality, adaptive scale. Add `perf=1` to the query for `__perf.stats` laps (sim, director, puppets, render) and per-pass GPU ms.
- **Budgets (CI-style, deterministic).** `npm run perf:check -- --presets low,medium --scenes pitchcam` (its own build, headed Chrome; counts draw calls and triangles, not times). Only when the change touches rendering cost.
- **What Auto picks on a phone.** `npx tsx tools/perf/tunecheck.ts --emu 750x832@2.625 --cpu 2`.
- **Proof.** Shots per preset with their state json (quality, scale, fps) and the perf json.

## Gotchas

- This laptop is shared: another agent renders a promo video on the same GPU. Absolute fps from a cbv session are indicative only; a desktop session measured 37 fps and scale 0.60 at Medium at one point and 60 fps at another. Compare A/B in the same minute, never against a number from another day.
- `?quality=` and `?bench` skip the Auto tuner; so does `notune`.
- `render.fps` in `state` is a smoothed average; use `perf` for a distribution.
- The quality presets barely change fps on this laptop except high → ultra (it is CPU / draw-call bound, see tools/perf/FINDINGS.md); do not read a flat result as "presets broken".
