# Graphics audit (t-0013, 2026-10-03)

How it was looked at: headed Chrome 150 on the RTX 4090 Laptop (`ANGLE (NVIDIA ... RTX 4090 Laptop GPU, OpenGL ES 3.2)`, GPU shared with other sessions),
production build, `tools/visual/look.ts`:
- **static** mode: seed 15, fixed 1/60 s step to game time 38 s, paused, ~20 named cameras (pitch cam, wide, follow, stadium, aerial, faces,
  catcher, mound, plate, wall, the director's own crowd and dugout shots, behind home), day / dusk / night, Low / Medium / High; depth of field
  follows the director's rule (`apertureFor(distance, slabFor(kind))`, wide shots deep-focus) so the pictures match what a viewer sees;
- **play** mode: the auto director plays the game (B-roll, cards, replays, home runs) and a picture is taken every few seconds of game time
  (seeds 15, 24 = home run, 12 = robbed home run, night, dusk);
- **ui** mode: loading screen, title, setup, settings, HUD, controls drawer, pause menu at 1920x1080, 390x844@3, 844x390@3, 750x832@2.625.

Contact sheets: `.herdr-project/claudeball-t-0013/library/audit/` (not committed).

Severity: **S1** = a viewer notices in the first seconds / breaks the "broadcast" illusion, **S2** = visible in common shots, **S3** = polish.
Effort: S (< 2 h), M (half a day), L (a day+). Risk: what it could break (perf, contracts).

## Priority list

| # | issue | where it shows | sev | effort | risk | plan |
|---|---|---|---|---|---|---|
| 1 | **Crowd reads as toy blocks.** Two styles mixed: the asset's `Crowd_1..8` (flat box torsos in saturated primaries with a painted face / chest octagon) and the engine's placeholder capsule + low-poly sphere heads that top up empty seats. No arms, no hair, no variety in pose, uniform saturated colours, sparse at Low / Medium (25 % / 55 % density). Behind the plate (every pitch-cam frame) and in every crowd B-roll it is the first thing the eye lands on. | pitch cam (whole upper half of the frame), crowd B-roll, walk-up, HR crowd reaction | S1 | L | perf (must not add calls), the `stadium.crowd` API (`excite`, `update`, `setDensity`, `setSectors`, `crowdVisible`) used by engine / audio | One impostor system: a single alpha-tested quad `InstancedMesh` per sector (replaces 8 kinds x 2 primitives + 2 placeholder meshes per sector: fewer draw calls, ~2 tris instead of ~72 per fan), an atlas of shaded spectators (heads with hair / caps, faces, shirts with a team-colour mask, arms; seated / standing / arms-up frames) with per-instance shirt / skin / hair tints, mirror, scale; receives CSM shadows and tower light; pose frames driven by the existing excitement uniform (cheers, the wave); fuller density at every tier because density no longer costs calls. |
| 2 | **Face close-up defects**: the mustache / goatee / full beard is an opaque dark shell with a hard rectangular edge (reads as a black bar, see `pitcherface`); spiky fringe / fuzzy halo around helmets, caps and the neck in DoF shots; pale, waxy skin on the batter. | faceCloseup, walkup, pitcherFace B-roll, every card shot | S1 | M | assets contract (`hair_beard` is opaque by design), DoF cost | Feather the facial-hair shells (engine: distance-to-boundary per vertex, alpha-to-coverage with fibre noise). DoF reads the GTAO prepass depth, which is half resolution at High and skips hair / caps / details, so those pixels get the background's depth: give DoF a full-resolution depth of the real scene (resolve the main pass depth). Check skin exposure / tone mapping (item 6). |
| 3 | **Night sky**: stars are drawn into the 512 px background cube, so at broadcast focal lengths every star is a big square (sharp shots) or a fuzzy blob (DoF); the sky is pure black over a lit park. | every night shot that shows sky | S1 | S | none | Stars as a real `Points` object in the scene (1-1.5 px, fainter, fewer near the horizon), sky gradient: dark navy with a warm light-pollution glow near the rim. |
| 4 | **Void outside the bowl**: beyond the stands there is nothing (grey haze / dark below the rim). The aerial B-roll and the stadium shots show the stadium floating in a grey nothing; the menu fly-around too. | aerial, stadium, menu backdrop, follow shots of deep fly balls | S1 | M | draw calls (+2-4) | A ground plane (parking / plaza / roads), a ring of low city / tree silhouettes at the horizon blended into the HDRI, horizon fog; cheap textured geometry, no shadows. |
| 5 | **Netting moiré / chicken wire**: the backstop net texture aliases into a dotted grid over the crowd behind the plate (pitch cam, walk-up, batter face). | pitch cam, walk-up, faces | S2 | S | none | Fade net alpha with distance / texel density, mipmapped alpha, lower contrast. |
| 6 | **Colour / tone**: grass very saturated and uniform; infield dirt a flat terracotta-orange (no moisture variation, no texture read); the whole image a touch "CG plastic". Chromatic aberration visible on towers. | everything | S2 | S-M | perf none | A/B tone mapping (the current Neutral vs AgX / ACES) and the grade's saturation / contrast; reduce aberration; dirt colour / roughness / variation (cut edge darker, moisture near the grass line and home plate, raked texture); grass hue / value. |
| 7 | **Dugouts**: interior is an unlit black box (seated players read as floating busts), the back wall flat saturated blue, roofs are huge plain grey slabs (dominant in the wide and aerial shots). | dugout B-roll, wide, aerial | S2 | M | dugout shots' camera framing | Interior lighting (a fill light / emissive ceiling strip, a lighter floor), darker painted roof with fascia / team colour, padded rail. |
| 8 | **Light towers**: the back of the lamp banks is a big flat black rectangle (stadium shot), poles are plain black cylinders. | stadium, aerial, HR wall shots | S2 | S-M | none | Grey steel material, lamp-bank frame / catwalk detail, lit lamps visible from behind as a rim. |
| 9 | **Jersey text font**: `jerseyText` asks for Impact / Haettenschweiler / Arial Black; Android has none of them (phones fall back to a generic sans). | name / number decals on phones | S2 | S | deploy size (+~30 KB font) | Ship one OFL block font (e.g. Anton or Oswald) and wait for it before drawing. |
| 10 | **Stands / concrete**: huge light-grey concrete aisles and walls dominate; no seat-row shading in the distance; no structure above the top tier (no roof / canopy / walkway). | pitch cam (upper half), stadium | S2 | M | none | Darker, warmer concrete, row AO, a canopy / roof edge or ribbon board on top of the bowl. |
| 11 | **Night look**: the field lighting is even and day-like (towers light everything about equally); no visible light falloff / pools, the stands as bright as the field, sky black. Haze cones exist. | night | S2 | M | perf (spots / shadows) | Darker stands vs field, falloff toward the corners, warmer tower white, a bit of bloom on lamps (already), sky gradient (3). |
| 12 | **Dusk**: the HDRI dusk sky is washed out to a near-white pink in many directions (background intensity 0.6 + exposure). | dusk | S3 | S | none | Re-balance background intensity / exposure; warmer sun rim. |
| 13 | **Player details** at broadcast distance: shin guard knee "balls" glossy black spheres, flat navy chest protector box, glove back has a ring artefact; eye black reads as black marks; helmet colour flat. | catcher / face shots | S3 | M | asset contract | Materials only (roughness / colour / normal strength), no geometry. |
| 14 | **Chalk lines**: the foul line runs through home plate and across the batter's boxes (should stop at the box), plate / boxes lines slightly too bright. | plate, catcher | S3 | S | field.glb contract | Mask or adjust in the asset (needs Blender, ask). |
| 15 | **Low / Medium tiers**: Low has no contact shadows and the placeholder sphere-head crowd at 25 %; phone shots look emptier and flatter than needed. | phones | S2 | — | perf budget | Covered by item 1 (density) plus making sure every new feature has a cheap Low path. |
| 16 | **HUD / UI**: menus and HUD are consistent and readable on all four viewports (no clipping seen); minor: the portrait game view is a narrow vertical crop of the wide-angle camera. | phones | S3 | — | — | No change planned now. |

Shots also checked without a defect worth a ticket: scorebug / pitch tracker / exit-velo panel / name cards (clean), pitch-cam composition, mound shape, base geometry, foul poles, ad boards (fictional sponsors read fine), scoreboard (readable).

## Order of work
1, 3, 2 (facial hair, then DoF depth), 5, 6, 4, 7, 8, 9, 10, 11, 12 — each as its own commit with a same-frame A/B (`look.ts` static mode, same seed / time / camera) and the checks:
typecheck, `npx vitest run`, `CB_BASE=/claudeball/ npm run build`, `npx tsx tools/perf/sanity.ts --prod`, `npm run perf:check`.
Blender work (14, possibly a rendered crowd atlas later) only after asking the coordinator.

## Tool
`npx tsx tools/visual/look.ts --help`-style usage is in the file header: `--mode static|play|ui`, `--tod day,dusk,night`, `--quality`, `--cams`,
`--emu 390x844@3`, `--sheet` (ImageMagick contact sheet).

## Status (end of the first pass, 2026-10-03)

| # | status | commit(s) |
|---|---|---|
| 1 crowd | done: billboard fans from an atlas of the player model, pre-baked and team-neutral (`public/crowd/`), excitement / the wave, fuller at every tier, fewer calls | 3fa5633, 88159d6 |
| 2 faces | done in the engine: stubble was a solid black beard (now a translucent film), beards feathered, DoF reads full-res scene depth, B-roll close-ups blur the background. Left for the assets thread: mustache / goatee shells are bars (stubble stands in), thin light streaks / fins at the neck of `Body_Skin` / `Head` in close-ups | 16e56bc, 27db0ea |
| 3 night sky | done | 16e56bc |
| 4 surroundings | done: plaza, parking lots, ring road, skyline (lit at night) | b7c7c88 |
| 5 net | done: dark thin cord | 27db0ea |
| 6 colour | done: ACES, clay / lawn / track look, less aberration | 0ebdab4 |
| 7 dugouts | done: dark roofs, lit interiors | 22a7b50 |
| 8 towers | done: grey lamp-bank backs, glare only from the front; fixed an AO bug that painted a dark slab over the sky behind every tower | 22a7b50 |
| 9 jersey font | done: Anton (OFL) shipped; decals now also show in the telephoto pitch cam | 04c5563, e608a1b |
| 10 concrete | partly: bowl concrete darker; no roof / canopy added | 88159d6 |
| 11 night look | partly: stands darker than the field, less spill; no per-corner falloff work | 88159d6 |
| 12 dusk | done: cooler haze, deeper sky | 7edef8b |
| 13 player gear | partly: catcher gear in team colours; glove / helmet materials untouched | 11b83f7 |
| 14 chalk through the plate | not done (field.glb, Blender) | |
| 15 Low / Medium | covered: fuller crowd; phone-proxy A/B shows no fps / JS change | |
| also | aerial B-roll camera was behind the upper deck (half the frame black) | d9c9f8a |

Not yet looked at closely: replay presentation and transitions, motion blur on fast pans, animation contact issues (feet sliding, glove clipping), the menu fly-around with the new surroundings on a real phone.

## Status (second pass, Blender + audit leftovers, 2026-10-03)
| item | status | commit(s) |
|---|---|---|
| 2 faces (assets part) | done: mustache / goatee / beard / stubble fitted to the MPFB mouth; no neck-seam cracks (morph fields fade to zero at the Head / Body_Skin cut) | 1ee8a5e |
| 10 stands | done: roof canopy over the upper deck, darker concrete | 6161da2, 88159d6 |
| 8 towers | done: 56 m towers with tapered masts, catwalk, braces, lamp-head frame | 6161da2 |
| 13 player gear | cap bill pre-curved 7.8 cm (was a band over the eyes), catcher gear team-coloured | 329e21e, 11b83f7 |
| 14 chalk | done: MLB layout | 0911e87 |
| scoreboard | MLB line score (innings, R/H/E, count lights, batter / pitcher) | 6161da2 |
| perf | lodgeo fixed and on by default (in-engine simplification), KTX2 for the world (GPU textures 533 -> 344 MB), gloved hand hidden | b4dc99b, 40867e1, 638b593 |
| replays / transitions | home-run trot camera stuck behind the dugout fixed; HR sequence + replay verified end to end | eb55ae3 |
| motion blur | shutter-normalized, jittered taps | 321ff3a |
| 11 night falloff | not done on purpose: MLB LED field lighting is uniform; the stands now sit darker than the field | |
Not done: mouth interior, finger detail, jersey folds, dirt / sweat masks, hairline (hidden under caps / small at broadcast distance); per-material joins in `player_base` (blocked by the head's UV remap; vertex-colour tinting would be the bigger lever but changes the recolour contract).
