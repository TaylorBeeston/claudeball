# Promo video (t-0019)

A hype trailer for Claudeball made only from the real game: real simulated games found by a headless scout, rendered frame by frame by the
real engine in headed Chrome on the real GPU, with the game's own audio rendered offline in the same pass. Outputs live outside the repo in
`~/claudeball-promo/` (never commit masters, stems or frame caches; the only committed media is `docs/media/teaser.webm`).

## Commands

```sh
npm run promo:scout -- --count 240 --jobs 12     # headless highlight search -> ~/claudeball-promo/scout.json
npm run promo:render                             # every shot (cached), audio, titles, edit, encodes
```

## TODO (resume here)

- [x] scout (`tools/promo/scout.ts`)
- [ ] gate 1: the browser game reproduces the scout's event times
- [ ] gate 2: `engine.tick` + `Page.captureScreenshot` captures exactly that frame
- [ ] `?promo` runtime: virtual clock, seek, scripted cameras, animation sync, offline audio
- [ ] shot list + storyboard, first preview render, jank pass 1
- [ ] titles / captions layer, music bed, mix + master, 1080p60 master
- [ ] 4K master, 9:16 vertical cut, teaser webm, contact sheet
