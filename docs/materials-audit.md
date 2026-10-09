# Materials audit (t-0014, 2026-10-08)

The user: "Let's do a materials pass. I think that's what is making their clothes look so bad. They're shiny and smooth, they really shouldn't be ... up close
[a shirt] looked really good, but from afar the reflections on it just look really weird / off."

## How it was looked at
- Every material in the running scene dumped from the live renderer (type, roughness / metalness factors, maps and their formats / filtering,
  normal strength, sheen, clear coat, env intensity): 101 materials.
- Every roughness map (glTF ORM: R occlusion, G roughness, B metalness; KTX2 ETC1S) rendered by the GPU onto a 512 px target (mip 0) and a 16 px target
  (a far mip) and read back: mean and spread per channel.
- Same-frame A/B in real Chrome (RTX 4090, headed, `tools/visual/jank.ts --variants`, seed 15, t 38): the jersey's sheen, its normal strength and the
  environment intensity toggled one at a time, near (2 m) and far (30 m at a long lens), then the whole policy before / after at near and far, day
  and night (`library/materials-*.jpg`, not committed).

## What was wrong (the near / far difference)
1. **A white sheen of 0.7 on every uniform fabric** (`gltfCharacter.tinted`, `sheenColor` white, `sheenRoughness` 0.55). The sheen lobe adds a
   whitish grazing-angle haze over the cloth. Close up the knit normal map breaks it into fibre glints and it reads as fabric; from afar the normal
   detail has mipped away, the shape is smooth, and the haze lies over the whole jersey as a milky, plastic sheen: a blue jersey turned powder-blue
   with white blotches on the back and shoulders. With the sheen off the cloth keeps its colour near and far (A/B v0 vs v1); the normal strength
   barely changes it (v1 vs v3). **This was the "reflections look weird from afar".**
2. **The textures were not the problem.** The ORM maps are clean: metalness channel 0.00-0.04 on every non-metal, 1.00 on steel; roughness means
   survive the mip chain (mip 0 vs the 16 px mip within 0.01), so there is no Toksvig-style gloss gain from minification; normal maps are linear
   (no sRGB), albedo sRGB. ETC1S did not leak between channels in any material measured.
3. **Glossy factors on things that are not glossy**: the files carry roughness maps whose values suit varnish or plastic for vinyl padding (0.37),
   concrete (0.52), clay (0.66), the warning track (0.54), the bench (0.33), chest protectors / shin guards (0.25), batting gloves (0.37); and the
   engine put a clear coat of 0.25 on every leather item (gloves, batting gloves, chest protector, belts, cleats).
4. **Player textures had no anisotropic filtering** (aniso 1; the world uses 8): cloth and leather seen at an angle smeared and swam at a distance.
5. A few untextured factors: the catcher / umpire mask as half-metal (0.55), the canopy / fascia / press-box glass / donut with metalness 0.2-0.7
   (paint, glass and rubber are not metals), steel structures fully metallic at 0.41 roughness (mirror-like grey towers against the sky).

## The fix
One policy table, `src/engine/materials.ts` (`POLICY`), applied once per material at load (world GLBs, player templates, the bat / ball / donut, the
team-tinted clones and the shading tiers' upgraded materials). With a roughness map the factor is `target / measured map mean` (`TEX_ROUGH`), so the
map keeps its own variation; normal strength is absolute. Fabrics get a faint sheen (0.12-0.15) in their own colour (lifted 25 % toward white).
Player textures get 4x anisotropic filtering. No pass, draw call or texture was added. `src/engine/__tests__/materials.test.ts`: every material in the
shipped GLBs has a policy entry (or is exempt on purpose), and every entry is plausible for its kind (cloth roughness >= 0.7, no metal, no coat,
sheen <= 0.2; metal is metal; glass smooth; ...).

Kept as they were (tuned in the face pass / characterShading): skin, eyes, cornea, hair cards, brows, lashes, teeth, tongue, stubble, beards; light
sources (lamps), the scoreboard's emissive screen (only its roughness), the HUD, the crowd atlas (unlit-looking sprites, no specular).

## Table
Roughness is the mean the surface has (map mean x factor); "before" is what the GLB + engine gave.

| material | type | albedo | roughness before -> after | metal before -> after | normal before -> after | sheen / coat before -> after | why |
|---|---|---|---|---|---|---|---|
| uniform_jersey | fabric (polyester knit) | team colour | 0.92 -> 0.90 | 0 | 2.0 -> 1.2 | sheen 0.7 white -> 0.12 own colour | the white sheen was the milky far-away haze; strong knit normals shimmer when minified |
| uniform_pants | fabric (twill) | white / grey / team | 0.83 -> 0.88 | 0 | 1.6 -> 1.2 | sheen 0.7 white -> 0.12 | same |
| uniform_socks | fabric | team | 0.83 -> 0.90 | 0 | 2.0 -> 1.2 | 0.7 -> 0.12 | same |
| uniform_undershirt | fabric (performance tee) | team | 0.92 -> 0.85 | 0 | 2.0 -> 1.0 | 0.7 -> 0.15 | a little smoother than the jersey |
| cap | fabric (wool / poly) | team | 0.83 -> 0.88 | 0 | 1.6 -> 1.2 | - | |
| arm_sleeve | fabric (compression) | team / white / black | 0.83 -> 0.72 | 0 | 0.6 | - | compression fabric has a slight sheen of its own |
| piping, wristband | fabric | trim | 0.92 -> 0.88 / 0.95 | 0 | 0.6 | - | terry wristbands fully matte |
| jersey decals, numbers, cap / helmet logo | fabric (tackle twill / embroidery) | print | 0.85 / 0.8 / 0.7 -> 0.8 | 0 | - | - | |
| glove | leather | tan / brown / black | 0.47 -> 0.58 | 0 | 0.8 | coat 0.25 -> 0.08 | oiled leather, semi-matte with grain |
| glove_laces | leather | | 0.40 -> 0.60 | 0 | 0.4 | - | |
| batting_glove | leather (synthetic) | team | 0.37 -> 0.62 | 0 | 0.6 | coat 0.25 -> 0 | read as plastic |
| cleats | leather (synthetic, polished) | black / team | 0.37 -> 0.45 | 0 | 0.6 | coat 0.25 -> 0.15 | |
| belt | leather | black | 0.40 -> 0.50 | 0 | 0.6 | coat 0.25 -> 0.10 | |
| catcher_gear | plastic / vinyl | team | 0.25 -> 0.48 | 0 | 0.5 | coat 0.25 -> 0 | chest protector / shin guards looked lacquered |
| sole | rubber | | 0.59 -> 0.82 | 0 | 0.6 | - | |
| spikes, buckle | metal | steel | 0.30 / 0.28 -> 0.35 / 0.30 | 1 | - | - | |
| button | plastic | | 0.35 -> 0.42 | 0 | - | - | |
| helmet | plastic (glossy ABS) | team | 0.20 -> 0.27 | 0 | - | env 1 -> 0.85 | glossy is right, but not a mirror |
| mask | painted steel (powder coat) | black | 0.40 -> 0.50 | 0.55 -> 0 | - | - | the cage is coated, not bare metal |
| mask_pad | fabric | | 0.90 | 0 | - | - | |
| eyeblack | paint (grease) | near black | 0.95 | 0 | - | - | |
| bat_wood | wood (varnished) | ash / maple | 0.50 -> 0.45 | 0 | 0.7 | - | a little varnish |
| ball_leather / ball_thread | leather / cotton | white / red | 0.62 -> 0.65 / 0.75 -> 0.80 | 0 | 1.0 | - | matte-ish |
| donut | rubber | black | 0.42 -> 0.80 | 0.70 -> 0 | - | - | rubber is not a metal |
| grass | grass | greens | 0.71 -> 0.82 | 0 | 1.0 | - | broad sheen, never plastic |
| dirt (infield, mound, bullpens) | clay | terracotta | 0.66 -> 0.90 | 0 | 0.25 -> 0.35 | - | clay is matte (the wet / dry variation is in the albedo and the field look) |
| track | clay / crushed brick | | 0.54 -> 0.92 | 0 | 1.0 | - | |
| chalk | paint (chalk) | white | 0.95 | 0 | 0.8 | - | |
| base_white | fabric (canvas) | white | 0.83 -> 0.85 | 0 | 0.5 | - | |
| plate_white, rubber_white | rubber | white | 0.59 -> 0.80 | 0 | 0.25 | - | |
| pole_yellow, wall_yellow_line | paint | yellow | 0.50 -> 0.60 / 0.75 | 0 | - | - | |
| concrete, dugout_concrete | concrete | greys | 0.52 -> 0.90 | 0 | 0.9 | - | |
| steel (towers, roof posts) | painted steel | grey | 0.41 -> 0.60 | 1 -> 0.25 | 0.6 | - | mirror-like grey structures against the sky |
| dugout_steel (rail) | painted steel | dark (albedo x 0.2) | 0.41 -> 0.55 | 1 -> 0 | 0.7 | - | painted dark: as bare metal it reflected the dark pit (black), as the light texture it glared |
| Seats_T1-3 | plastic (molded) | team blue | 0.36 -> 0.52 | 0 | 0.5 | - | |
| wall_padding, dugout_padding | vinyl | green / navy | 0.37 -> 0.62 | 0 | 0.6 | - | |
| dugout_wood | wood (painted bench) | | 0.33 -> 0.58 | 0 | 0.8 | - | |
| ad_boards, fascia_dark, dugout roofs | vinyl / paint | print | 0.50-0.75 -> 0.72-0.78 | 0.2 -> 0 | - | - | printed vinyl / paint is not metal |
| canopy | painted metal | | 0.55 -> 0.68 | 0.35 -> 0.1 | - | - | |
| press_glass | glass | | 0.08 -> 0.06 | 0.6 -> 0 | - | - | glass is a dielectric |
| scoreboard_screen | emissive (LED) | | 0.50 -> 0.40 | 0 | - | - | |
| batters_eye, backstop_net, dugout_interior | paint / net | dark | 0.90-0.95 | 0 | - | - | unchanged values, now in the policy |

Not changed: skin (map 0.56, sheen 0.45 warm rim), eye (0.08, coat 0.35, from the face pass), cornea, hair / hair cards (0.5-0.55), brows, lashes,
teeth, tongue, stubble, beards, lamps, the legacy box crowd (hidden), the crowd atlas sprites, sky / clouds / haze cones (unlit or additive).
