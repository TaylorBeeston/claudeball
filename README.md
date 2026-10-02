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

### Menus, controls and URL parameters

The page opens on a **loading screen** (assets, sky, shaders and a warm-up game, so nothing pops in later; about 5 s on a desktop GPU), then a
**title screen**: *Start Game*, *Game Setup* (pick both teams from a 30-club league or leave them to the seed, randomize teams, seed box with a
random-seed button and a *Copy link* that reproduces the exact game, game length 9 / 3 / 1 innings, time of day) and *Settings* (quality preset
with a device-based *Auto*, sound: master / effects / crowd / voices, PA, commentary, chatter level, organ, mute; camera, replays, default speed, broadcast
graphics, box score; *Reset to defaults*). The game does not start until *Start Game*; that click also unlocks the browser's audio. Preferences
persist in `localStorage`. In game, `Esc` / `P` or the ☰ → *Menu* button opens the pause menu (resume, settings, restart this game, quit to menu); at the
end a *Final* screen with the box score offers *Play again* (new seed, same teams) and *Menu*.

Keys: Space pause · `1`/`2`/`3` speed 1×/2×/4× · `n` next half inning · `.` next batter · `c` auto/free camera · `b` box score · `q` quality · `t` time of day · `m` sound on/off · `Esc` menu.
Phones and tablets: tap the game to show the controls (☰ at the top right), one finger orbits and two fingers pinch-zoom in the free camera, the fullscreen button
and a "rotate your device" hint for portrait. The HUD respects notches (`safe-area-inset`), the render resolution is capped per device and quality preset.

| URL parameter | effect |
|---|---|
| `?seed=N` | game seed (digits, or any text, which is hashed); with the teams below it reproduces a game exactly |
| `?away=DEN&home=AUS` | clubs by abbreviation or index 0-29 (default: the teams the seed generates) |
| `?tempo=broadcast\|standard\|quick` | pace of play (default broadcast = slower, TV-like), passed to the sim when a game is created; 2x/4x speed still work |
| `?innings=1..9`, `?tod=day\|dusk\|night`, `?quality=auto\|low\|medium\|high\|ultra` | settings (a parameter beats the saved preference) |
| `?camera=free`, `?replays=0`, `?speed=1\|2\|4`, `?hud=0`, `?box=1`, `?chatter=low\|normal\|high` | more settings |
| `?menu=1` | show the menu even in an automated browser |
| `?autostart` or `?menu=0` | skip the menu and play at once. **Automated browsers (`navigator.webdriver`: Playwright, Puppeteer, Selenium) skip the menu by default** and use the fixed legacy seed 20260928 when no `?seed` is given, so existing scripts keep working; people get a random seed |
| `?mock`, `?noassets`, `?nopost`, `?noaudio` | dev: mock game, placeholders only, no post-processing, no audio |

Scripts can wait for `await page.waitForFunction('window.__boot && window.__boot.tti > 0')`; `window.__boot` holds `tti` (ms since navigation start), `steps` (ms per
preparation step), `stages` (the progress log) and `missing` (asset files that failed). `window.engine` is the engine.
`scripts/ui-shots.py` takes screenshots of loading, menus and HUD at the reference phone / tablet / desktop sizes.
Details in [`src/engine/README.md`](src/engine/README.md).

### Sound

A stadium soundscape driven by the same events as the picture: bat cracks that depend on how hard and how well the ball was hit, mitt pops scaled by pitch speed, glove pops, throws, bounces, dirt, fence and slide sounds panned and
attenuated by the broadcast camera, a crowd whose murmur and roar follow the situation (late innings, close score, runners in scoring position, two strikes, a ball in the air) and that reacts to the outcome (cheers for the home team,
groans, a gasp on a robbed home run), a real-sounding stadium organ (walk-up riffs, charge and rally builds, fanfares, soft beds between innings and the 7th-inning stretch with *Take Me Out to the Ball Game*), fireworks after home-team homers, a PA announcer (`Now batting, number 23, ...`), umpire calls and a two-voice broadcast booth (play-by-play and colour) with a director that takes turns like live TV, vocabulary for every kind of play, and short conversations built from what has actually happened in the game (pitch tendencies, streaks, matchups, close plays), with a chatter level (Low / Normal / High). The stadium announcer is a separate channel that can overlap the booth with the HD voices. Optional **HD voices** (Settings): neural voices (Kokoro, Apache-2.0) downloaded on request and run in the browser. A **dynamic crowd** that reacts to every ball in play (a pop sized by the contact, anticipation while a fly ball is in the air, a crescendo on home runs, groans and boos for the visitors' success, clap-claps on two strikes, lone claps, whistles and the wave), quiet **broadcast stings** for camera cuts and replays (*Broadcast effects* slider), and optional **park music** after runs, home runs and between innings (*Park music*; the organ stingers play when there are no track files, see [`docs/park-music-brief.md`](docs/park-music-brief.md)). Replays go dull and slow, pause quiets the field, fast-forward is silent.
Press `m` or use the 🔊 button in the ☰ controls (or the sound settings in the menu) to mute. Browsers need a click before they play audio: *Start Game* is that click (with `?autostart` the first tap or key press unlocks it). Sounds are synthesised in the browser (plus three CC0 applause clips),
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
| `src/ui/` | loading screen, title / setup / settings / pause / game-over screens, settings store and URL parameters, touch + fullscreen, boot sequence (`app.ts`) |
| `src/audio/` | Web Audio sound: synthesised effects, crowd, organ, PA/umpire/commentary voices; listens to the game's events, see [`src/audio/README.md`](src/audio/README.md) |
| `assets/` | Blender sources, glTF exports and the optimize script |
| `scripts/` | headless season sim (`simulate.ts`), diagnostics, HDRI fetch |

Coordinates (shared by sim and scene): metres, origin at home plate, +Y up, +Z toward center field, +X toward third base.
