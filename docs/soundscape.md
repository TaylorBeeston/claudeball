# The park soundscape: what to listen for

The game's sound is mixed the way a TV broadcast is. The ballpark has its own sound: the organ, the PA announcer, the park music, the crowd,
the bat and the gloves all sound **in the park**. They ring around the stands and bounce back off the upper deck and the scoreboard. The
broadcast picks this up through **microphones fixed around the park**, not from the cameras. The picture cuts from camera to camera and the
sound stays put. The two announcers are separate: they talk into headset mics in the booth, close and clear, and the park sits back
whenever they speak.

## What to listen for

- **The organ is in the park.** It comes out of the stadium's loudspeakers, so it is thinner than a studio organ: no deep bass, no
  sparkle on top. Each note rings on for about two seconds around the bowl, with a faint echo off the upper deck about a fifth of a second
  later. The park music and the PA announcer ("Now batting ...") sound the same way.
- **The bat crack.** The close dish behind home plate catches it sharp and up front. A moment later, about 0.3 s, the same crack arrives
  faint and dull from the outfield mics, then the stands answer with a tail. Listen to `final-impulse.wav`.
- **Things happen where they are.**
  - The picture's main camera looks in from centre field, so **third base is on the right and first base on the left**.
  - A tag at third, the home dugout (on the third-base side) and the left-field fence sound right of centre; the first-base side sounds left.
  - The plate, the mound and centre field are in the middle.
  - Cutting to another camera does not move anything.
- **The crowd is a crowd of sections.** Home fans fill most of the park. Visiting fans sit on the first-base side and in the right-field
  bleachers.
  - After a visitor's home run, the home sections groan while a pocket on the left cheers.
  - The wave goes around the bowl section by section.
  - A home-team home run fills the whole park and its echo.
- **The booth stays on top.** When an announcer talks, the park dips about 7 dB, and the part of it that clashes with voices (1-4 kHz)
  dips a little more. The crowd still sounds big, but the words stay clear. When they stop, the park comes back over about a second.
  On a home-run roar the dip is shallower, so the moment stays big under the call.
- **The camera whooshes and replay stings** are part of the broadcast package. They stay clean and centred, outside the park.

## The foley: what each sound is and when you hear it

All synthesised (nothing sampled), several variations each, played in rotation with a little pitch and level variation, so a repeat
never sounds identical. Each one is heard by the mics near where it happens, so the outfield is far and faint and the plate is close.

| sound | what it is | when |
|---|---|---|
| catcher's mitt pop | the iconic pop: a leather crack, a tiny paper-like snap of the laces, the pocket slapping shut, a low thump that grows with the pitch's speed; four speeds (under 80, 80-88, 88-95, 95+ mph) | every pitch caught; deader when caught off the edge of the mitt |
| block | a thud on the chest protector, a dull mitt, a puff of dirt | a pitch in the dirt |
| framing creak | the mitt's leather creaking as he holds it still | a pitch on the corner, caught clean |
| fielder's glove | soft (a return), firm (a throw), hard (a line drive, a pickoff), the outfield "thwup", the grounder scoop, the webbing / edge | every catch, by what was caught and how; backhands thinner, a juggle grabs twice |
| bare hand | a skin smack | a tag with the bare hand; a ball kid picking up a ball |
| transfer | leather rustle, the ball into the palm | the ball moved from the glove to the throwing hand |
| bat | the crack (ordinary, solid, the sweet spot: brighter and sharper), a jammed "thunk", a "tock" off the end, a foul tip, a bunt; wood, no metallic ring | contact, by exit speed and launch angle |
| bat on the ground | wooden knocks on the dirt | the batter dropping the bat as he runs |
| the pitch | a faint whip as the ball passes the plate | heard only by the dish behind home |
| throws | a zip that rises and falls as it passes, the seams fluttering; lob / throw / hard throw | every throw and return |
| bounces | grass (a soft thud), infield dirt (a puff and the skitter of grit), the warning track (crunchy), the plate and mound (hard) | every bounce, by where it lands |
| the wall | padding (a deep thud), the top rail (rings) | a ball or a fielder into the wall |
| backstop | the padding and the net rattling | a wild pitch or passed ball reaching the backstop |
| seats | a plastic clack, then fans scrambling | a home run landing; a foul fly into the stands (or the net behind home) |
| body | a dull thud and cloth | hit by pitch |
| tags and slides | the glove swiped across the jersey and the impact; a miss through the air; the slide's scrape, cloth and dust | tags, slides |
| feet and bases | cleats on grass / dirt / the track (only near the base and plate mics), a foot on a bag or the plate | runners |
| rituals | Velcro batting gloves, a knock on the helmet, the bat against the spikes, the rosin bag, the umpire's pouch and gear, gloves slapped on thighs, the dugout rail, a bat into the rack | between pitches and batters, time-outs, runs, the end of a half-inning |

Not covered (the sim has no event for them): a barehanded catch, a batted ball hitting a runner or a fielder.

## The knobs (Settings > Sound)

| setting | what it does |
|---|---|
| **Venue acoustics**: Dry / Normal / Big | How much the park rings. Dry is a small open park, with about 1 s of tail and little echo. Normal is a big-league bowl, about 2 s. Big is an enclosed giant, about 2.5 s, with a stronger echo. |
| **Mic perspective**: Broadcast mix / Close | Broadcast mix is the TV balance. Close brings the field mics up and the crowd and stadium back: more bat, mitt and dirt, less roar. |
| **Under the commentary**: Light / Normal / Strong | How far the park dips while the booth talks: about 4, 7 or 10 dB. |
| the volume sliders | Same as before. Effects, Crowd, Organ, Park music and PA announcer set each part of the park. Announcers sets the booth (and the PA). Broadcast effects sets the camera stings. Master sets everything. |

## One limitation

The full booth treatment needs the **HD voices** or your own **custom voice**:
- the headset EQ and compression;
- the PA announcer sounding through the stadium speakers;
- the umpire heard from the field.

Those voices play inside the game's audio engine. The browser's built-in voices play outside it, and nothing can be added to them. With
them the park still dips while the booth talks (the game knows when a line is being spoken), but the voices themselves stay dry.

## Listening files

The render tool plays a scripted moment through the real mix and saves WAVs to `~/claudeball-audio-renders/` (never into the repo):

```
npx tsx tools/audio/render.ts --tag mine            # game, impulse, duck, organ, pa-noise
npx tsx tools/audio/render.ts --tag big --venue big # the same in the Big venue
npx tsx tools/audio/render.ts --tag phone --lowpower
```

The script:
- an organ charge;
- the PA announcer;
- a pitch and a home-run crack;
- the ball hitting the left-field fence;
- the roar;
- the booth over it.

For the booth and PA lines the tool uses your first recording in `~/claudeball-voice/wavs`. The renders made for this change:

| file | what |
|---|---|
| `before-game.wav` | the old mix (camera-relative, dry organ) |
| `final-game.wav` | the new mix |
| `final-dry-game.wav` / `final-big-game.wav` | the same moment in the Dry and Big venues |
| `final-phone-game.wav` | the lighter phone mix |
| `final-impulse.wav` | one bat crack and the park's answer |
| `final-duck.wav` | a booth line over the crowd |
| `final-organ.wav` | the organ through the PA |
| `foley-montage.wav` | every catch, the bat, the ball on things and the rituals in a row, through the mics |
| `foley-game.wav` | the game moment with the new foley |
| `foley/<sound>.wav` | each foley sound, every variation in a row (`npx tsx tools/audio/foley.ts` remakes them with a table of measurements) |

`?audiodebug=1` in the game shows a live panel with a meter per microphone, the duck, the crowd sections and the venue.
The technical details are in `src/audio/README.md` (*The park soundscape*).
