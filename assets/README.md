# Claudeball assets

Generated with Blender 5.2 (via the Blender MCP) from the scripts in `src/` — the scripts are the source of truth
(`.blend` files are not committed; procedural textures are generated with numpy and embedded in the GLBs).
Re-run: in Blender, `CB_SRC="<repo>/assets/src"; exec(open(CB_SRC+"/ball.py").read())` (same for bat/field/stadium/players).

## Conventions (all GLBs)
- Units: meters. glTF Y-up. **Origin = home plate apex (back tip of the plate)**, `+Y` up, `+Z` toward center field, `+X` toward first base (right-hand).
- `ball.glb` / `bat.glb` are object-local (origin at ball center / bat knob) so the engine positions them from the sim.
- Textures are embedded JPEG (albedo + normal). Materials are glTF PBR; ground materials also use `COLOR_0` vertex colors (mowing stripes) multiplied with tiled world-space UVs (`uv = xz / 4 m`), so the texture repeats every 4 m — use `RepeatWrapping`.
- Ground layers are stacked a few mm apart (0, 0.010, 0.020, 0.026, 0.034 m); use `logarithmicDepthBuffer` or `polygonOffset` if you see z-fighting at distance.

## ball.glb
Node `ball` (leather, r = 36.9 mm → 73.8 mm diameter) with child `ball_stitches` (108 red V-stitches as real geometry). ~6k tris. Spin about any axis; origin at center.

## bat.glb
Node `bat`, 0.864 m (34 in) long. **Origin at the knob; barrel extends along local +Y** (glTF). Max barrel diameter 66.6 mm, handle 23 mm. Drive it by placing the origin at the sim's hands/knob position and orienting +Y toward the bat tip.

## field.glb  (see also `field_layout.json` for exact numbers: bases, fence polyline, foul poles, ground outline)
Nodes: `Grass_Outfield`, `Grass_Infield`, `Dirt`, `Dirt_Cutouts` (home circle, base cutouts), `WarningTrack` (15 ft), `Mound` (18 ft dia, 10 in high), `PitchersRubber` (front edge 60 ft 6 in), `HomePlate`, `Base_1B/2B/3B` (15 in), `Chalk` (foul lines, batter's/catcher's boxes, 3 ft lane, coach boxes, on-deck circles), `FoulPole_L/R`, `Dugout_1B/3B` (shells), `Bullpen_L/R` (+`_Plate`).
Fence: distance from apex = `330 ft + 70 ft * cos(2a)` where `a` is the angle from the center-field line (330 ft at poles, 400 ft to center), listed in `field_layout.json`.
Approximations: coach-box and catcher's-box placement, dugout/bullpen placement and foul-territory outline are plausible, not surveyed.
