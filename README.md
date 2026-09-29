# Claudeball

[![Deploy](https://github.com/TaylorBeeston/claudeball/actions/workflows/deploy.yml/badge.svg)](https://github.com/TaylorBeeston/claudeball/actions/workflows/deploy.yml)

**Play it: https://taylorbeeston.github.io/claudeball/**

3D baseball in the browser: two AIs play a full, physically simulated game, shown like a TV broadcast.
Nothing is scripted — pitch flight, bat–ball contact, batted balls, fielding, throws, baserunning and the managers'
decisions all come from the simulation in `src/sim`; `src/engine` (three.js) only renders what the sim reports.

## Run it

Needs Node 20+ (Node 22+ recommended) and a GPU-accelerated browser with WebGL2.

```sh
npm install
npm run hdri      # optional: downloads two CC0 sky HDRIs (~10 MB) into public/hdri/
npm run dev       # http://localhost:5173  (Vite picks the next free port if that one is taken)
npm run build     # typecheck + production bundle in dist/  (npm run preview serves it)
npm run preview   # serves dist/ on 0.0.0.0:4173 (reachable over the LAN / tailscale, e.g. http://frenchfry:4173/?quality=medium)
```

Other commands:

```sh
npm test                      # vitest: simulation tests
npx tsc --noEmit              # typecheck src/sim, src/engine and scripts
npm run sim -- 60 7           # headless season: 60 games, seed 7, league stats (R/G, AVG, K%, BB%, ...)
```

### Sky HDRIs are optional

`npm run hdri` fetches a partly-cloudy day sky and a dusk sky from [Poly Haven](https://polyhaven.com/hdris) (CC0) into
`public/hdri/` (git-ignored). They provide the photographic background and image-based lighting; the sun direction is
found in the image and matched to the shadow-casting light. **Without them the app runs unchanged** with the procedural
sky (and night always uses the procedural sky + stars). The dev server / build publish `/hdri/index.json` listing the
files that exist, so a missing HDRI never causes a failed request or a console error.

### Assets

The stadium, field, players, bat and ball are glTF files in `assets/` (built in Blender, see `assets/README.md`).
The app loads `assets/optimized/*` (meshopt + WebP, produced by `assets/optimize.sh`) and falls back to the raw
exports and finally to procedural placeholders, so it works with any subset of them. No environment variable is needed:
the Vite plugin serves `assets/` at `/assets/` in dev and copies it to `dist/assets` on build (`CB_ASSETS_DIR=/other/dir`
overrides the folder). Re-run `assets/optimize.sh` after re-exporting from Blender.

### Controls and URL parameters

Space pause · `1`/`2`/`3` speed 1×/2×/4× · `n` skip to next half inning · `c` auto camera on/off · `q` quality ·
`t` time of day · `m` sound on/off. `?quality=low|medium|high|ultra`, `?tod=day|dusk|night`, `?mock` (dev mock game instead of the real
sim), `?noassets`, `?nopost`, `?noaudio`. Details in [`src/engine/README.md`](src/engine/README.md).

### Sound

A stadium soundscape driven by the same events as the picture: bat cracks that depend on how hard and how well the ball was hit, mitt pops scaled by pitch speed, glove pops, throws, bounces, dirt, fence and slide sounds panned and
attenuated by the broadcast camera, a crowd whose murmur and roar follow the situation (late innings, close score, runners in scoring position, two strikes, a ball in the air) and that reacts to the outcome (cheers for the home team,
groans, a gasp on a robbed home run), an organ, fireworks after home-team homers, a PA announcer (`Now batting, number 23, ...`), umpire calls and two-voice commentary that reuses the sim's play-by-play text. Replays go dull and slow, pause quiets the field, fast-forward is silent.
Press `m` or click 🔊 (top right) to mute; ⚙ has volumes and the announcer / commentary toggles. Browsers need one click or key press before they play audio (a small prompt says so). Sounds are synthesised in the browser (plus three CC0 applause clips),
and voices use your browser's speech synthesis (none in some headless/Linux setups: then only the effects play). See [`src/audio/README.md`](src/audio/README.md).

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`: `npm ci`, typecheck, `vitest`, a (non-fatal, cached) `npm run hdri`,
then `vite build` with `CB_BASE=/claudeball/` and a deploy to GitHub Pages. A failing typecheck or test blocks the deploy; a failed
HDRI download only means the site uses the procedural sky. The build ships `assets/optimized/*` and `field_layout.json` only
(not the raw Blender exports). To test the Pages build locally: `CB_BASE=/claudeball/ npm run build && npm run preview`, then open
`http://localhost:4173/claudeball/`. All runtime URLs go through `import.meta.env.BASE_URL`.

## Credits

- Sky HDRIs: [Poly Haven](https://polyhaven.com/hdris) (CC0), *Kloofendal 48d Partly Cloudy (Pure Sky)* and *Qwantani Dusk 2 (Pure Sky)*.
- Rendering: [three.js](https://threejs.org/). Models and animation are original, built in Blender.
- Sound: synthesised in the browser by `src/audio` plus three CC0 applause clips (Wikimedia Commons: Amada44, Sandermotions), voices from your browser's speech synthesis; see [`public/audio/CREDITS.md`](public/audio/CREDITS.md).

## License

Claudeball's own code and assets are released under the [MIT License](LICENSE). Bundled and downloaded third-party pieces keep
their own terms: [three.js](https://threejs.org/) is MIT, and the Poly Haven sky HDRIs (fetched by `npm run hdri`, not stored in this
repo) are CC0.

## Layout

| path | what |
|---|---|
| `src/sim/` | pure TypeScript baseball simulation (no rendering dependencies), see [`src/sim/README.md`](src/sim/README.md) |
| `src/engine/` | three.js renderer: stadium, players, cameras/replays, HUD, post-processing |
| `src/audio/` | Web Audio sound: synthesised effects, crowd, organ, PA/umpire/commentary voices; listens to the game's events, see [`src/audio/README.md`](src/audio/README.md) |
| `assets/` | Blender sources, glTF exports and the optimize script |
| `scripts/` | headless season sim (`simulate.ts`), diagnostics, HDRI fetch |

Coordinates (shared by sim and scene): metres, origin at home plate, +Y up, +Z toward center field, +X toward third base.
