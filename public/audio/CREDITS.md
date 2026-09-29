# Audio credits

Almost everything you hear is generated in the browser at runtime by `src/audio/synth.ts` (noise, damped resonances and
formant-filtered voices rendered into buffers) and `src/audio/organ.ts` (additive organ voices); that needs no licence and is the
fallback for every sound. The only recordings in the repo are three short applause clips (crowd one-shots) that replace the
synthesised applause when they load. They are listed in `manifest.json` (the app fetches only files listed there, so a missing file
can never cause a failed request) and are **CC0 / public domain only** (verified on each file's Wikimedia Commons page, licence
"Creative Commons Zero, Public Domain Dedication"). Total size ~120 KB (mono Vorbis, trimmed, faded, limited).

| file | derived from | author | licence | source |
|---|---|---|---|---|
| `applause_a.ogg` (5.0 s, from 8 s in), `applause_c.ogg` (2.6 s, from 24 s in) | "Sound Effects - Applause after a concert.ogg" | Amada44 (own work) | CC0 1.0 | https://commons.wikimedia.org/wiki/File:Sound_Effects_-_Applause_after_a_concert.ogg |
| `applause_b.ogg` (5.5 s) | "277021 sandermotions applause-2.wav" (audience applauding, De Doelen, Rotterdam) | Sandermotions (Freesound #277021, re-hosted on Commons) | CC0 1.0 | https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav |

Processing: trimmed, mono, 32 kHz, fade in/out, peak limited, encoded with `ffmpeg -c:a libvorbis -q:a 2`.

| what | source | licence |
|---|---|---|
| bat, ball, glove, dirt, fence, PA chime, crowd murmur / roar / cheers / groans, organ | procedurally synthesised by this repo's code | MIT (this repo) |
| organ melodies (charge figure, fanfare, ditties, stretch tune) | the "charge" figure is a traditional public-domain bugle call; the rest are original to this project | PD / MIT |
| announcer, umpire and commentary voices | the visitor's own browser `SpeechSynthesis` voices (nothing bundled or recorded) | n/a |

Other candidates that were checked and are **not** used: Commons "Applause i/ii.ogg" and "Clapping hurray.ogg" (public domain but
short/thin), "High school cafeteria.ogg" and the shopping-mall ambiences (public domain, but an indoor room tone, not a stadium);
no CC0/PD stadium roar, organ or baseball effect recordings turned up on Commons (searches: cheering crowd, crowd noise, stadium
crowd roar, sports crowd, applause, baseball crowd). OpenGameArt and Kenney.nl were not searched.
If more recordings are added, list each here (author, URL, licence; CC0 / public domain only) and add them to `manifest.json`.
