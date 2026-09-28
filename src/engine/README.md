# Engine (`src/engine/`)

three.js (WebGL2) broadcast renderer. It only *renders* what the sim reports; it never decides outcomes.

```
npm install
npm run dev          # http://localhost:5173  (add ?mock to force the mock sim, ?noassets to skip glTF,
                     #   ?quality=low|medium|high|ultra, ?tod=day|dusk|night, ?nopost / ?noao / ?nobloom / ?nodof for debugging)
npm run build        # typecheck + production bundle (copies ./assets to dist/assets)
```
Set `CB_ASSETS_DIR=/path/to/assets` to serve a different assets folder in dev.

## Coordinates
Sim contract: metres, origin at home plate, +Y up, +Z center field, **+X toward third base** (1B at −X). That is a plain
right-handed frame, so scene == sim (`dims.ts` keeps `toScene()` as the single mapping point). Facing yaw = `atan2(dx, dz)`.

## Sim adapter
`simAdapter.ts` → `SimDriver`. Uses `src/sim/index.ts` (`createGame({seed})`, `step(dt)`, `getState()`, `on(cb)`) when it exists
(`import.meta.glob`), otherwise `mockSim.ts`. Types are in `types.ts`. The driver runs the sim on a fixed 120 Hz accumulator,
interpolates snapshots for rendering, records 30 s of history (used for replays) and derives pitch-crossing-plate from ball state.

## Modules
| file | what |
|---|---|
| `engine.ts` | renderer, main loop, wiring, keyboard (space, 1/2/3 speed, n next half, c camera, q quality, t time of day) |
| `environment.ts` | Sky → cube env (PMREM), time of day (day/dusk/night), cascaded shadow maps (CSM), ACES |
| `postfx.ts` | GTAO, depth-of-field (uses the GTAO depth), bloom, output, grade + grain + vignette |
| `field.ts`, `stadium.ts` | procedural placeholders with real MLB dimensions (used until/unless `field.glb`/`stadium.glb` load) |
| `assets.ts` | GLTFLoader + meshopt/Draco/KTX2, prefers `optimized/`, everything optional |
| `gltfCharacter.ts` | skinned glTF players: AnimationMixer state machine, head lookAt, batter arm IK to the sim's bat |
| `characters.ts` | procedural articulated fallback player (parametric clips + IK) |
| `players.ts` | player manager, ball (motion streak, batted-ball tracer), bat |
| `cameraDirector.ts` | broadcast shots: pitch (CF cam), follow, fielder, base, replay (slow-mo from history), cutaways |
| `hud.ts` | DOM/CSS: scorebug, pitch tracker, name cards, exit velo/LA/distance, ticker, controls |
| `quality.ts` | presets + adaptive resolution scale |
| `mockSim.ts` | dev-only mock game with real ball flight and chasing fielders |
