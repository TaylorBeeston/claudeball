# Faces: stylized design, morph targets, emotion model (t-0025, Phase C)

The user's brief: faces are uncanny; deliberately stylized faces are fine; "what really does it is facial expressions: nobody expresses
any emotion ever". This file is the design (stage 1). Stage 2 builds it into the player files in ONE binary rebuild; stage 3 drives it
from the game.

## 1. What is wrong today (evidence)

Captured in the real game (prod build, headless Chrome on the RTX 4090, seed 24, broadcast tempo, quality high, day; cbv session
`20261021-201616-c3d4`), sheets `faces-01a` (the director's own face shots) and `faces-01b` (bench close-ups):

- **The eyes read as white dots.** The iris is small (29 deg angular radius) and pale; in the pitcherFace B-roll (head ~130 px tall at
  1080p) the eye is 3-4 px and only the sclera survives. The look-at driver also parks the eyes at the end of their range
  (`eyes_look_left/right` = 0.96-1.0 on several players in the probe), so the whites show on one side: a sideways stare.
- **No expression reaches the screen.** Only six MPFB keys exist (`eyes_blink`, `mouth_open`, `smile`, `brow_raise`, `brow_furrow`,
  `mouth_pucker`), at MPFB's subtle real-human amplitude; `mouth_open` is capped at 30 % of the MPFB opening because the inner-lip faces
  stretch into a pale sheet / spikes beyond it (there is no mouth interior). Rendered at the director's framings, joy / anger / dejection /
  shock / a wince are indistinguishable at the onDeck and pitcherFace sizes (sheet `faces-08`, rows "current").
- **Photo skin on a simplified head.** The CC0 photo albedo plus the pore / wrinkle normal map at full strength on an MPFB head makes
  waxy, rubbery skin in close-ups (realism mismatch between parts is the classic uncanny trigger).
- **Known leftovers**: the full beard renders as an opaque black rubber mask (and a dark patch behind the catcher's cage), the goatee as a
  black ball inside the cage, ragged hairline cards, no mouth interior / gums, caps sitting ~12 mm high with the bill tilted up (a beanie
  from the front).

The director's face shots, measured (`broll.ts` `tele()` spans = frame height at the subject): batterFace 0.95 m, shakeOff 1.7 m,
pitcherFace 2.0 m, walkup 2.6 m, onDeck 4.6 m. A head is ~0.24 m, so at 1080p it is ~270 / 150 / 130 / 100 / 55 px tall; on the user's
phone (Z Fold 7 cover screen, 1080 px tall in landscape) the pitcherFace head is under 1 cm. The pitch camera shows heads ~8 px tall
(faces irrelevant there).

## 2. Candidates (stage-1 lab renders)

Rendered with `tools/faces/facelab.py` (Blender 5.2 Eevee, background mode; the plain `player_base.glb` from the intermediates archive;
the MPFB face targets fitted into our space by `assets/src/mpfb_face_extract.py`, fit check: max |Pfit - base P| = 0.0). Lighting: the
game's own day HDRI (`sky_day.hdr`, 0.9) + a sun, grass ground for bounce; night = dusk HDRI at 0.06 + two banks of tower light. Six faces:
F1 light skin / cap, F2 dark skin / batting helmet, F3 full beard / cap, F4 catcher (hockey helmet + cage, goatee), F5 older / bare head /
receding gray hair / mustache, F6 stubble / eye black / cap. Three distances = the director's batterFace (0.95 m), pitcherFace (2.0 m) and
onDeck (4.6 m) framings at 1080p, cropped to a 0.42 m window and shown 1:1 (no upscaling except the marked x2 sheet). The control column
"current" is today's head through the same pipeline.

| | shape | eyes | skin | brows / lashes | expression amplitude | cap |
|---|---|---|---|---|---|---|
| **A clean broadcast** | small MPFB pushes: eyes +10 %, softer bags, younger, smaller nose, fuller lips, smaller ears | globe x1.06, iris 33 deg, partly flat iris, darker limbus | albedo blurred (no pores), normal 0.35 | a little bolder | x1.3 | lowered 12 mm, bill flatter |
| **B stylized sculpt** | stronger, simpler planes: eyes +20 %, relaxed upper lid, cheekbones and chin up, simplified nose (smaller, no hump, narrower wings), defined lips with cupid's bow, smaller ears | globe x1.12, iris 37 deg, clean graphic iris with a strong limbal ring | painted: heavy blur + broad tone zones, normal 0.12, warm painted zones (cheeks, ears, nose tip, lips), soft lash-line shading | bold, darker, thicker | x1.8 (brows x2.6, lids x2.0) + a dark mouth interior and the full jaw opening | lowered |
| **C graphic toon** | B pushed further, rounder | globe x1.24, iris 40 deg (little sclera) | 3-band cel ramp, emission, ink outline (inverted hull) | very bold | x2.0 | lowered |

Sheets (library): `faces-02` close / day, `faces-03` mid / day, `faces-04` broadcast / day (x2 and 1:1), `faces-05` close / night,
`faces-06` mid / night, `faces-07` / `faces-08` seven expressions (neutral, joy, shout, anger, dejected, shock, wince) x three faces x
four styles at close and mid. Known lab artifacts (not the design): a small dark notch at a mouth corner in some open-mouth frames (the
preview darkens the stretched inner-lip faces instead of building the real interior), teeth hidden in the open mouths, the cap
lowering is a deformation preview, and the beards are today's beards.

## 3. Decision: B, stylized sculpt

**Why B.**
- **Readable where it matters.** In the mid (pitcherFace) and broadcast (onDeck) sheets, B's eyes stay eyes (iris + dark limbus + lid line)
  where today's become white dots, and its expressions separate: joy / shout / shock read from the mouth shape (a dark open mouth) and
  the lids; anger / dejected / wince from brows and lids at close and mid. Today's six keys don't separate at any of those sizes.
- **Not cartoon-creepy.** The first B push (globe x1.19, iris 37) went bug-eyed with sclera all round the iris. The chosen B keeps the
  globe at x1.12 and drops the upper lid (rest closure 0.2) so the lid covers the top of the iris: a calm, alive look.
- **Fits the stadium.** B is still PBR-lit by the same sun / HDRI / tower lights as the uniforms and the park; only the face materials are
  simplified. C's cel ramp and ink lines look pasted onto the photographic park in every sheet (and the outline breaks up at onDeck size);
  A barely moves away from the current face (same waxy realism, tiny expressions).
- **Consistent across builds, tones, ages, facial hair and headwear**: the style is one smooth delta on the shared MPFB base mesh, so every
  existing head key (`head_narrow`, `jaw_square`, `nose_large` ...) still varies people on top of it, and every follower (hair, beards,
  caps, helmets, masks) is rebuilt on the styled head.
- **Same rig and budgets.** No new bones, no new draw calls: the eyes, brows, lashes and mouth stay the same nodes and materials. The
  cost is morph memory and per-frame morph work only on near (tier-0) faces (section 6).

**What ships whatever style is picked.** The dark mouth interior with the full jaw opening, the bigger and darker iris, the stronger
expression amplitude, the beard / hairline / cap fixes and the emotion system help any style. (A in the sheets got the interior too, at a
lower gain, 1.3 against B's 1.8, so part of "A barely differs" is that setting.) B's own contribution is the eye / lid proportion, the
painted skin and the bold brows: they are what keeps eyes and brows readable at the pitcherFace / onDeck sizes, and the skin no longer
fights the simplified head.

**What B needs from stage 2.**
1. **The style delta.** It is applied in `player_mpfb.base()` to `_B["P"]`, like `FOOT_K` and the hand map, so every part is built on the
   styled head. It is a weighted sum of MPFB shaping targets (the lab's `CANDS["B"]["style"]`, extracted by
   `mpfb_face_extract.py`), faded to zero at the neck seam (`_seam_fade`). The topology is unchanged: the shared skin atlas, the neck
   seam normals and the head keys keep working.
   - **Landmarks stay put.** The eye centres (+-.032, -.138, 1.732), `LM`, `HC`, `NECK_CUT`, the `teeth_morph` bands and the stomion values
     in `player_extra` don't move. The style targets only reshape around them, and `EYE_R` scales with `eye_s`.
   - Each moved landmark is re-measured after the build: the mouth line, the nose base, and the engine's `faceCenter` offset.
2. **Eyes.** The globe radius x1.12 and a regenerated iris equirect for every colour (37 deg iris, 12.5 deg pupil, flat radial gradient,
   strong limbal ring, clean sclera). The engine's eye shader darkening (`upgradeMaterial` `eye`) is re-tuned to the new texture.
3. **Skin.** A painted albedo: the photo atlas blurred (sigma ~16 px at 2K) and blended with its low-frequency tone zones, plus painted
   warmth (cheeks, ears, nose tip, lips) and soft lash-line / upper-lid shading. These go INTO the albedo atlas, so they survive the
   engine's LOD tier 1, which hides `Gear_Eyebrows` / `Gear_Eyelashes` (`LOD_TIER1`). Also painted into the atlas: a soft brow shape
   in the hair colour's darkness. The normal map strength drops to ~0.12 (pores gone, broad forms kept).
4. **Brows and lashes.** The brow cards are thicker (x1.6 vertical about their centre line), darker and more opaque. The lashes are darker
   and denser, so the lash line reads.
5. **Mouth interior** (the known leftover). The MPFB inner-lip faces that stretch when the jaw opens become a dark, rough
   `mouth_interior` region, a separate material slot on `Head` (no new draw call if it shares `face` with a dark region texture instead:
   preferred). Behind them goes a closed mouth bag (gum-coloured, skinned to `Head`), and the teeth / tongue are re-seated in it.
   `jaw_open` can then use the full MPFB opening (weight 1 = ~75 % of MPFB `mouth-open`), not 30 %.
6. **Hairline.** The cards of the default short hair get a soft alpha ramp over the last ~1.5 cm at the forehead and nape. The hairline
   cards are culled where they poke out under the lowered cap.
7. **Beards.** The beard / goatee / mustache get the stubble's feathered translucent edge and a lighter, strand-noise albedo (no
   opaque black mask). The full beard and goatee are thinned / clipped inside the catcher cage volume (the dark patch).
8. **Cap fit** (folded in). The crown is rebuilt ~12 mm lower and ~3 % wider at the band, seated on the styled skull, with the bill flatter
   (~4 deg down at the root, gently curved). It is fitted per head build via the existing head keys (`head_narrow` / `head_wide` /
   `brow_heavy` follow). The minimum clearance is checked at every key extreme like the helmets. Hair gets a stronger `hair_under_cap`.
9. **Batting stance re-key** (folded in, `player_anim.py`). The bottom (left) forearm supination is brought back inside its limit (88 deg;
   now -110 to -139) and the left wrist flexion ~10 deg less, proven with `jank:check` and the jank sheets.
10. **The morph targets** of section 4, with the follower assignment, then ONE `npm run assets:derive` commit after the binaries are
   final.

## 4. Morph targets (Head; ~20, glTF morph targets, the 22-bone rig unchanged)

Source: MPFB2 expression units (CC0, `data/targets/expression/units/caucasian`) fitted into our space by `mpfb_face_extract.py`
(same LBS + PCHIP fit as `mpfb_extract.py`), then scaled by the style's amplitude so that weight 1 is the full stylized expression.
L / R units come from MPFB's own per-side targets. Symmetric mouth units are split with a smooth x-mask (2 cm blend across the
midline) where a side is needed. The MPFB targets are exactly symmetric (measured: max mirror asymmetry 0.0 on all mouth units).

| target | MPFB source (weight) | amplitude | followers |
|---|---|---|---|
| `blink_L`, `blink_R` | `eye-{l,r}-closure` (1.0) | x1.0 (must close fully on the bigger globe: re-checked) | lashes, brows (a little) |
| `squint_L`, `squint_R` | `eye-{l,r}-slit` + 0.3 closure | x2.0 | lashes, eye black |
| `wide_L`, `wide_R` | `eye-{l,r}-opened-up` | x2.0 | lashes |
| `brow_up_L`, `brow_up_R` | `eyebrows-{l,r}-up` + 0.4 `extern-up` | x2.6 | brows, lashes (upper lid lift) |
| `brow_down_L`, `brow_down_R` | `eyebrows-{l,r}-down` | x2.6 | brows |
| `brow_inner_up_L`, `brow_inner_up_R` | `eyebrows-{l,r}-inner-up` | x2.6 | brows |
| `jaw_open` | `mouth-open` (0.75 of MPFB) | x1 | teeth / tongue (lower row rigid), beards, mouth bag |
| `smile_L`, `smile_R` | `mouth-corner-puller` + 0.4 `mouth-elevation` (x-masked) | x1.8 | beards, eye black (cheek raise) |
| `frown` | `mouth-depression` + 0.3 `depression-retraction` | x1.8 | beards |
| `lip_press` | `mouth-compression` | x1.8 | beards |
| `sneer` | `mouth-upward-retraction` + 0.6 `nose-{l,r}-elevation` | x1.8 | beards (mustache) |
| `pucker` | `mouth-pursing` | x1.5 | beards |
| `cheek_puff` | `mouth-compression` 0.5 + `{l,r}-cheek-volume-incr` x2 | x1 | beards |
| `eyes_look_left/right/up/down` | existing (on `Eyes`; the engine's cornea shell copies them) | | |

**Lefties (mirrored puppets).** The engine mirrors lefties with `scale.x = -1`, so every `_L` / `_R` target (and `eyes_look_left/right`)
shows on the visual opposite side for them. Symmetric presets don't care. Asymmetric ones do: a wink, a smirk, a one-brow glare, the blink
offset and the saccade direction. The emotion module therefore swaps L / R for mirrored puppets; stage 3 checks how today's look-at
handles eye yaw under the mirror. Stage 2 also measures which side (+X = model left, or -X) MPFB's `*-left-*` units move before naming the
targets. The lab only proved the mouth units are symmetric, not the side convention.

The kept head keys are the build keys `head_narrow`, `head_wide`, `jaw_square`, `nose_large`, `ears_large`, `brow_heavy`, `chin_strong`,
`cheeks_full`, `nose_narrow` and `eyes_deep`. They replace `eyes_blink`, `mouth_open`, `smile`, `brow_raise`, `brow_furrow` and
`mouth_pucker`; the engine's face driver is switched in the same branch. Caps, helmets, masks and hair get no expression keys: that keeps
morph memory and per-frame morph work off them. Memory: `Head` goes from 16 morph targets today to ~30 (10 build keys + 20 expression keys): ~4.5 k vertices x 30 x 12 B = ~1.6 MB
per file before quantization (was ~0.85 MB), plus the followers' few keys (meshopt-packed in the optimized files). Followers carry only the keys in the table.

The derived LOD geometry is simplified at runtime (`assets.ts` `simplifyMeshes`). `lodSwap` only engages when the morph counts match,
so stage 2 checks that the simplified heads keep every target.

## 5. Emotion model (stage 3; a pure-TS module `src/engine/face/emotion.ts` with unit tests, engine glue in `gltfCharacter.ts`)

Three layers, summed into target weights, then smoothed per weight by a critically damped spring. The spring is fast for lids and eyes
(omega ~ 30 /s), medium for brows and mouth (omega ~ 12 /s) and slow for the mood baseline (omega ~ 3 /s). Nothing pops, and an
expression that starts mid-blink blends.

1. **Mood.** A continuous valence (-1..1) and arousal (0..1) per person, eased toward event-driven goals and decaying to the personal
   baseline with tau 20-90 s.
   - Sources: team score swings, the at-bat result, the count (an 0-2 batter tenses), bases loaded or a late close game (tension), a slump
     (0-for-3 so far).
   - The mood sets the resting face: brow height, mouth corners, lid openness, blink rate (arousal up = more blinks) and chewing tempo.
2. **Reactions.** Short preset expressions with an attack / hold / release envelope (0.1-0.3 / 0.5-3 / 0.4-1.5 s).
   - Each has a priority. A new reaction pre-empts a lower one and queues behind a higher one; at most one runs per person, with the next
     cross-fading in.
   - Presets are weights on the section-4 targets: joy, grin, shout, fist-pump yell, frustration (lip press + brow down + head shake
     from the clip), dejection, anger / glare, argue (shout + brow down, jaw flapping), wince, flinch, shock, concentration, relief and
     smirk.
3. **Idle and life.**
   - Blinks: 2.5-6 s at rest, faster when aroused, double blinks; `blink_L` / `blink_R` with a 10-20 ms offset now and then.
   - Saccades: the eyes lead the head and the head follows, with fixations of 0.3-1.5 s. The eye offset is kept inside ~70 % of the range
     (no parked side-eye); the neck distribution / look-at owns the rest.
   - Micro brow flickers, a slight asymmetric smile for some people, and gum chewing (`jaw_open` 0.05-0.15 at 1.6-2 Hz plus a little
     `pucker`) for ~30 % of players.
   - The jaw moves when talking or shouting (mound visits, manager arguments, celebrations, coaches): a syllable-rate envelope.

**Personality** comes from the player id hash and ratings: expressiveness 0.5-1.3 (scales every reaction), calm (raises the mood's
inertia), fiery (anger and celebrations bigger), chews (bool) and a blink-rate factor. A veteran or a high-composure pitcher is calmer.

**Event -> reaction table.** Only events that already exist are used (sim and director events seen in the probe: `umpire_call` kinds
`strike_called` / `strike_swinging` / `strikeout` / `ball_four` / `foul` / `homerun` / `out` / `safe`, `contact`, `out`, `safe`, `run`,
`homerun`, `error`, `walk`, `hbp`, `steal`, `tag`, `collision`, `challenge`, `catch`, `shake_off`, `mound_visit`, `substitution`,
`half_inning`, `coach_signal`, `signs_given`, `ball_kid_retrieve`, `bat_boy_retrieve`, `play`; `broadcast.shot` / replay events). Anything
else is derived in the engine, never added to `src/sim`; sim outcomes stay bit-identical.

| situation | batter / runner | pitcher | catcher, fielders | dugouts, managers, coaches |
|---|---|---|---|---|
| strikeout swinging / called | frustration or dejection (+ glare at the umpire on a called third strike, fiery ones) | fist-pump yell (fiery) or calm nod | catcher calm / small smile | batting dugout dejected, fielding dugout cheer |
| walk | relief / small smile | frustration (lip press) | | |
| hit / run scores | joy at first base, runner shout crossing home | dejection / glare at the ground | fielder grimace if it got past | cheer / groan by side |
| home run | grin then shout around the bases, teammates shout at home plate | shock -> dejection, looks away | | big cheer / heads down |
| HBP (`hbp`) | wince, then glare at the pitcher (fiery) | concern | | |
| brushback (derived: pitch passes within ~0.35 m of the batter's head) | flinch then glare | stare back (fiery) | | |
| error (`error`) | | frustration | grimace on the fielder who erred | |
| bases loaded / late close game (derived from state) | tension (lip press, focused brows, more blinks) | tension | | anxious managers |
| pitching change (`substitution` of the pitcher) | | outgoing: dejection; incoming: concentration | | |
| close play / challenge (`challenge`, `closePlay`) | argue on an out call | | | manager anger (shout loop) on the challenge walk |
| shake-off (`shake_off`) | | slight frown + head shake (clip) | | |
| coach signs (`coach_signal`) | concentration while reading | | | coach concentration |
| ball kid retrieve | | | | ball kid delight (grin) |

The broadcast holds expressions in close-ups. A reaction started within ~0.5 s before or during a face close-up (batterFace,
pitcherFace, shakeOff, walkup, dugoutReaction, moundHuddle) is held through the shot's hold time, and its subject is the one the shot
frames. Stage 3 checks that `cameraDirector` / `broll` still centre the face with the new head (the `faceCenter` offset).

## 6. Budget and LOD rules

- **The face is driven by projected size, not the 12 m world distance.** The lodTier is already projected-size based. The probe in the
  live game confirmed the subject at tier 0 with the face driver running in pitcherFace, batterFace and walkup (shakeOff / onDeck were
  not caught with a subject: re-probed in stage 3). It found the pitcherFace B-roll camera 12.1 m from the pitcher (tier 0, but beyond the cornea's 12 m world gate, so the cornea
  shell was off in the pitcher's own close-up). Morph weights are set only for puppets that are tier 0 AND on screen (frustum test); the
  cornea follows the same rule (tier 0 + head taller than ~60 px). During one pitcherFace shot 36 puppets were tier 0, so the face
  driver must not run for off-screen ones.
- Only non-zero targets cost per vertex in three's morph shader. The driver writes at most ~8 non-zero expression weights per head
  (preset plus mood plus idle), and zeroes the rest.
- Tier 1+ (small, far): no face work at all. The painted albedo (brow shape, lash line, lips) still reads there, so faces stay faces at
  broadcast and phone sizes without brows / lashes geometry.
- `npm run perf:check` must stay green; stage 3 reports CPU per frame for the face driver and the draw calls (no new ones).

## 7. Stage-2 single-rebuild checklist

- [ ] `mpfb_face_extract.py` -> `assets/src/mpfb/face_targets.npz` (style + expression units; the fit is checked against `base_body.npz`)
- [ ] style delta in `base()`; landmarks re-measured; eye radius / iris textures
- [ ] painted skin atlas (albedo with the brow shape / lash line / warmth), normal strength
- [ ] brows / lashes thicker and darker
- [ ] mouth interior (dark region + mouth bag + teeth / tongue re-seated); `jaw_open` full range
- [ ] hairline alpha ramp; beards feathered, lighter; nothing dark behind the catcher cage
- [ ] cap: lower, wider band, flatter bill, fitted per build; clearance at every key extreme
- [ ] the 20 morph targets + follower keys; old expression keys removed; engine face driver switched to the new names
- [ ] `batting_stance` re-key: left forearm supination within 88 deg, left wrist -10 deg; `jank:check` + sheets prove it
- [ ] one player-binary build (`blender -b --factory-startup`, `CB_ASSETS` = this worktree), `perf_all.sh`, contract check
  (`tools/visual/glb-contract.mjs`), then ONE `npm run assets:derive` commit
- [ ] before / after renders: close, mid, broadcast; day and night; >= 6 faces including a beard, a helmet, a catcher in a mask; plus a real
  phone-emulation capture (`cbv launch --emu 412x915@2.625`) of a face B-roll
