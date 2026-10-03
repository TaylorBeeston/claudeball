# Park music: the tracks to make

The game plays stadium ("park") music at the moments below. It works with **zero files** (the synthesised organ stingers play instead), so you can
add tracks one at a time: every trigger that has a file uses it, the others keep the organ. This page is the shopping list for generating them
with the YuE model (for example through WanGP), how to prepare the files, and how to register and check them in the game.

## Where the files go

```
public/audio/music/
  homeRun-1.ogg  homeRun-2.ogg  homeRun-3.ogg
  rally-1.ogg ...
  manifest.json          <- written by `npm run audio:music:index`, do not edit by hand (see "Tuning" for the exceptions)
```

* File name: `<trigger>-<n>.ogg`, `n` = 1, 2, 3 ... The triggers are exactly: `runScored`, `homeRun`, `rally`, `walkUp`, `inningBreak`,
  `pitchingChange`, `gameStart`, `finalWin`, `finalLoss`.
* Format: **stereo OGG Vorbis, 44.1 kHz, quality 4-5** (about 128-160 kbit/s). **At most 1.2 MB per file and 14 MB in all** (the list below comes to
  about 10 MB). Mono is fine for a stinger. mp3 / m4a work in browsers too, but the index script reads lengths of `.ogg` without extra tools.
* Mastering: about **-14 LUFS** integrated, true peak below -1.5 dB. The game plays music a little under the crowd and ducks it by 6 dB under the booth, so do not make it quieter than that.
* **Start with a transient**: the first sound must be on the very first sample (no lead-in silence, no slow fade-in): the game fades the music in itself (0.15 s for
  stingers, 1.5 s for the break loops), and a stinger that starts late feels late. Cut tails clean: end on a final hit or a short natural decay, not on a long
  silence.
* **Loops** (`inningBreak-*`): the file must end so that it runs straight back into its own start (cut on a bar line, last beat leading into the first). The game loops
  them until the break ends (about 25-60 s of game time, so a track is rarely heard to its end); the first 20 s matter most.
* No lyrics. Minimal chant vocals ("hey!", "oh-oh") are fine. **Nothing about real teams, players or people, and no samples or references to real songs or artists in
  the prompts or the result** (copyright). Keep the prompts to genre, instrument and mood words.

## The tracks (27 files)

Tempo about 100-130 BPM everywhere. "Level" is how it sits: stingers and celebrations are bright and big, the break loops are light and low.

| file | length | trigger (when it plays) | direction | genre tags for YuE (paste as the genre prompt) |
|---|---|---|---|---|
| `runScored-1.ogg` | 6-10 s | the home team scores a run | brass fanfare stab, snare roll, one big final hit | `brass band, fanfare, celebratory, marching snare, trumpets, trombones, energetic, instrumental, 120 bpm` |
| `runScored-2.ogg` | 6-10 s | same | stomp-clap-stomp and a rock guitar riff | `stadium rock, electric guitar riff, stomp, handclaps, energetic, instrumental, 112 bpm` |
| `runScored-3.ogg` | 6-10 s | same | ballpark-organ style hook with claps | `ballpark organ, pop, handclaps, bright, celebratory, instrumental, 124 bpm` |
| `runScored-4.ogg` | 6-10 s | same | big-band swing horn hit | `big band, swing, horns, upbeat jazz, fanfare, instrumental, 128 bpm` |
| `homeRun-1.ogg` | 15-25 s | the home team hits a home run | triumphant synth anthem that builds and releases | `synthwave, arpeggio, retro, triumphant, big drums, anthem, instrumental, 118 bpm` |
| `homeRun-2.ogg` | 15-25 s | same | hip-hop stadium hype, brass hits, a "hey!" crowd chant | `hip hop instrumental, trap drums, brass hits, 808 bass, stadium hype, crowd chant, 100 bpm` |
| `homeRun-3.ogg` | 15-25 s | same | carnival of percussion and horns | `latin percussion, salsa horns, carnival, celebration, congas, energetic, instrumental, 120 bpm` |
| `rally-1.ogg` | 15-20 s | the home team scores 2+ runs in an inning, or a big hit with runners on | drumline and brass, building | `marching band, drumline, brass, building tension, rally, instrumental, 124 bpm` |
| `rally-2.ogg` | 15-20 s | same | stomp-stomp-clap crowd groove | `stadium rock, stomp clap, gang chant "hey", driving, anthemic, 118 bpm` |
| `rally-3.ogg` | 15-20 s | same | fast hoedown | `country, banjo, fiddle, hoedown, fast, handclaps, instrumental, 130 bpm` |
| `walkUp-1.ogg` | 12-20 s | the home batter walks to the plate (stops at the windup) | cool, confident groove | `funk guitar, tight drums, bass groove, confident, instrumental, 108 bpm` |
| `walkUp-2.ogg` | 12-20 s | same | trap beat with a dark synth | `hip hop instrumental, 808 bass, dark synth, hi-hats, confident, 100 bpm` |
| `walkUp-3.ogg` | 12-20 s | same | country strut | `country rock, banjo, slide guitar, swagger, mid tempo, instrumental, 104 bpm` |
| `walkUp-4.ogg` | 12-20 s | same | electronic build | `electronic dance, four on the floor, pulsing synth bass, build, instrumental, 126 bpm` |
| `walkUp-5.ogg` | 12-20 s | same | latin guitar and percussion | `latin guitar, percussion, congas, warm, rhythmic, instrumental, 110 bpm` |
| `walkUp-6.ogg` | 12-20 s | same | heavy rock riff | `hard rock, heavy guitar riff, big drums, powerful, instrumental, 116 bpm` |
| `inningBreak-1.ogg` | 60-75 s | the break between innings (loop, low under the crowd) | light and friendly | `upbeat pop, ukulele, handclaps, light percussion, summer, feel good, instrumental, 105 bpm` |
| `inningBreak-2.ogg` | 60-75 s | same (loop) | relaxed funk | `funk, clean guitar, bass, light drums, laid back, instrumental, 100 bpm` |
| `inningBreak-3.ogg` | 60-75 s | same (loop) | brass band, easy | `brass band, new orleans, second line, easygoing, instrumental, 108 bpm` |
| `inningBreak-4.ogg` | 60-75 s | same (loop) | indie-pop with soft synths | `indie pop, soft synth, bright guitar, gentle drums, optimistic, instrumental, 110 bpm` |
| `pitchingChange-1.ogg` | 10-15 s | a pitching change | cinematic walk-in | `cinematic percussion, rising brass, entrance, tense, instrumental, 110 bpm` |
| `pitchingChange-2.ogg` | 10-15 s | same | cool riff | `blues rock, guitar riff, cool, steady drums, instrumental, 100 bpm` |
| `gameStart-1.ogg` | 18-24 s | the game starts (pregame hype) | arena build | `arena rock, big drums, building, anthem, pregame hype, instrumental, 120 bpm` |
| `gameStart-2.ogg` | 18-24 s | same | orchestral brass and drums | `orchestral, brass fanfare, timpani, epic, opening, instrumental, 116 bpm` |
| `finalWin-1.ogg` | 18-24 s | the home team wins | triumphant brass anthem | `triumphant, brass anthem, celebration, confetti, big drums, instrumental, 120 bpm` |
| `finalWin-2.ogg` | 18-24 s | same | pop-rock victory with "hey!" chants | `pop rock, victory anthem, handclaps, gang chant "hey", uplifting, 122 bpm` |
| `finalLoss-1.ogg` | 6-12 s | the home team loses (short) | reflective and neutral, not sad-trombone | `solo piano, soft strings, reflective, gentle, outro, 80 bpm, instrumental` |

(Start with `homeRun`, `runScored` and `walkUp`: they are the moments the user hears most. One variant per trigger is enough to begin with; the game picks a
random one and avoids repeating the last two.)

## Generating with YuE (WanGP)

* Use the genre tags above as the **genre prompt**. Short, comma-separated, English, one genre + instruments + mood + tempo. Do not name artists, bands, songs or
  teams.
* YuE is a song model and likes to sing. For **instrumental** tracks first try adding `instrumental` and `no vocals` to the tags and giving it no real lyrics (an
  empty or `[inst]` lyrics block, depending on the front-end). If it still sings:
  1. Use the "minimal vocals" lyrics: a chorus of only a chant, e.g. `[chorus]` then `Hey! Hey! Hey!` repeated, or `Oh-oh-oh, oh-oh-oh`. For the tracks that want a chant
     (`homeRun-2`, `rally-2`, `finalWin-2`) that is exactly what you want.
  2. Generate longer than needed and **trim to the instrumental part** (intros and outros are instrumental in most generations).
  3. Or remove the vocals with a source-separation tool and keep the "instrumental" stem (for example Demucs, which is MIT-licensed).
* Generate a few takes per file and keep the best; the length you need is short, so ask for a short segment (one verse / one chorus) when the front-end allows.
* Keep the tempo in the tags, then check it: the stingers and the loops sound best when the length is a whole number of bars.

## Preparing the files (ffmpeg)

Trim to the start of the first beat (no silence before it), loudness-normalise and encode. Replace the times:

```sh
# trim the lead-in (start at the first beat, here 0.31 s), normalise to about -14 LUFS, stereo 44.1 kHz OGG q4
ffmpeg -i take.wav -ss 0.31 -t 18 \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.003,afade=t=out:st=17.7:d=0.3" \
  -ar 44100 -ac 2 -c:a libvorbis -q:a 4 public/audio/music/homeRun-1.ogg
```

* For a stinger, `-t` is the length you want; the 0.3 s fade-out at the end only removes a click.
* For a **loop**, cut on a bar line (bar length in seconds = 4 x 60 / BPM; e.g. 105 BPM -> 2.286 s, 28 bars = 64.0 s), keep the fade-in at 3 ms and drop the fade-out,
  then listen to it looping (`?musictest=inningBreak` plays each break variant, or loop it in any player): if there is a click or a hiccup at the seam, move the
  cut to a zero crossing or crossfade the last 20-50 ms into the start.
* Check the size: `ls -l public/audio/music` (each <= 1.2 MB). Break loops of 60-75 s at q4 are about 1.0-1.2 MB; use `-q:a 3` for a longer one.

## Registering and checking

```sh
npm run audio:music:index       # scans the folder, reads lengths (ffprobe if installed, else the Ogg header), writes manifest.json
```

It prints one line per track and warns about: names that do not match, files over 1.2 MB, a total over 14 MB, lengths far from the wanted range, sample rates other than
44.1 kHz, more than two channels, and missing variants (a trigger with no track keeps the organ stinger, which is fine). Re-running it keeps the `gain`, `weight` and
`loop` you changed by hand in `manifest.json`.

Then hear them in the game (dev server or a build):

* `http://localhost:5199/?musictest=homeRun` plays every `homeRun` variant in turn (waiting out each one), `?musictest=homeRun,walkUp` several triggers, `?musictest=all`
  every trigger and variant. The console says what is playing (`[music-test] homeRun: homeRun-2.ogg (19.4 s)`); a trigger with no file plays its organ stinger and says so.
  The first click on the page unlocks the sound.
* In a real game: `__audioDebug.state.music` (in the console) shows what plays, the number of tracks and the last decisions.
* Settings > Sound has **Park music** (level and on/off, default on at a modest level) and the organ switch; the music never plays at 2x or faster, while paused, skipping
  or muted.

### Tuning

`manifest.json` is meant to be generated, but two fields are yours: `gain` (0-2, per-track level when a file is mastered a bit hot or quiet) and `weight` (how often a
variant is picked relative to its siblings). `loop` can be set to `false` for a break track you want played once.

## How the game uses them

| trigger | when | cooldown | priority |
|---|---|---|---|
| `finalWin` / `finalLoss` | game over, home win / home loss (a tie: nothing) | - | highest, cuts anything |
| `homeRun` | home team home run, about 1.2 s after the ball clears the wall (the crowd roars first) | 20 s | 90 |
| `rally` | the home team's 2nd run of a half inning, or a double / triple with the home team batting (once per half inning) | 45 s | 70 |
| `runScored` | the home team scores (not a walk-off: the final music follows) | 10 s | 60 |
| `gameStart` | first pitch coming up | - | 55 |
| `pitchingChange` | either team (quieter for the visitors) | 20 s | 40 |
| `walkUp` | the home batter is called; stops at the windup | - | 30 |
| `inningBreak` | break between half innings (not the 7th-inning stretch, which is the organ's), for the length of the break; the booth keeps to the calls while it plays; stops when the next batter is called | - | 20 |

A visitor's run or home run gets no music. A higher priority track cuts a lower one with a short fade; they never overlap (the organ stingers also stay quiet while a track plays).
Only the next likely files are fetched ahead (not on data saver), and a track is streamed, not decoded into memory, so it is light on phones. If a file is missing or fails
to play, the organ stinger of that moment plays instead and the file is not tried again.

## Licensing (read before committing tracks)

* **You own what you generate** only to the extent the model's licence says so. As of this writing (checked 2026-10-02):
  * the original **YuE** (`m-a-p/YuE-*` on Hugging Face) is **Apache-2.0**; its model card encourages using the outputs, including in commercial projects, and asks (does not
    require) credit "YuE by HKUST/M-A-P";
  * **YuE2** (`multimodal-art-projection/YuE`, GitHub) has the code under Apache-2.0 but the **model weights under CC BY-NC 4.0 with an additional creator permission**: personal
    users, content creators and musicians are free to use it and monetise the outputs, companies need a licence from the authors; credit ("YuE2" / `#YuE2`) is encouraged.
  Check which weights your WanGP loads and read that model card yourself; this is not legal advice.
* Claudeball is MIT-licensed. Decide how the **tracks** are licensed and say so in `public/audio/CREDITS.md` (the table at the end is waiting for it). Keep a record of how each
  was made: the model and version, the date, the genre prompt (a `public/audio/music/SOURCES.md` with one line per file is enough).
* Do not commit anything you cannot license: no tracks from anywhere else, no sound-alikes of real songs, no samples. The repo ships with **no tracks** and an empty manifest.
