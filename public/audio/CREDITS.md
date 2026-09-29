# Audio credits

Claudeball ships **no third-party audio files**. Every sound is generated in the browser at runtime by `src/audio/synth.ts`
(noise, damped resonances and formant-filtered voices rendered into buffers) and `src/audio/organ.ts` (additive organ voices), so
there is nothing to license and nothing to download; the game is never silent because a file failed to load.

| what | source | license |
|---|---|---|
| bat, ball, glove, dirt, fence, crowd, PA chime, organ | procedurally synthesised by this repo's code | MIT (this repo) |
| organ melodies (charge figure, fanfare, ditties, stretch tune) | the "charge" figure is a traditional public-domain bugle call; the rest are original to this project | PD / MIT |
| announcer, umpire and commentary voices | the visitor's own browser `SpeechSynthesis` voices (nothing bundled or recorded) | n/a |

If real recordings are added later, list each file here with its author, URL and licence (CC0 / public domain only, so the
repo stays MIT-compatible), and keep the synthesised versions as the fallback.
