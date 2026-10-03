# Perf summary, batch 2 (2026-10-03, t-0012)

Same deterministic bench as batch 1 (fixed 1/60 s step, seed 15, scaler off, day, medians over 240 frames). Laptop = Chrome 150 headed, RTX 4090 Laptop (shared GPU), 1080p vsync. 'batch 1' = main at 0919a46; 'batch 2' = this branch.

## Laptop: batch 1 -> batch 2

| preset | scene | fps b1 | fps b2 | p5 b1 | p5 b2 | JS ms b1 | b2 | calls b1 | b2 | tris b1 | b2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| low | pitchcam | 59.9 | 59.9 | 59.5 | 59.5 | 7.6 | 7.1 | 409 | 419 | 5.2M | 4.7M |
| low | wide | 59.9 | 59.9 | 59.5 | 59.5 | 10.6 | 11.2 | 755 | 755 | 7.5M | 6.4M |
| low | follow | 59.9 | 59.9 | 59.2 | 59.5 | 8.2 | 7.7 | 482 | 482 | 6.3M | 5.9M |
| low | faces | 59.9 | 59.9 | 58.8 | 59.5 | 6.7 | 5.5 | 244 | 244 | 3.1M | 3.0M |
| low | crowd | 59.9 | 59.9 | 59.2 | 59.5 | 5.6 | 5.3 | 187 | 187 | 2.9M | 2.8M |
| medium | pitchcam | 59.9 | 59.9 | 29.9 | 59.5 | 16.6 | 9.7 | 730 | 486 | 9.4M | 5.0M |
| medium | wide | 59.9 | 59.9 | 29.9 | 59.5 | 18.6 | 13.7 | 1614 | 986 | 18.9M | 9.5M |
| medium | follow | 59.9 | 59.9 | 58.5 | 59.5 | 13.7 | 10.4 | 1099 | 699 | 16.4M | 9.0M |
| medium | faces | 59.9 | 59.9 | 58.8 | 59.5 | 13.6 | 8.3 | 405 | 308 | 4.4M | 2.5M |
| medium | crowd | 59.9 | 59.9 | 59.2 | 59.5 | 11.4 | 7.5 | 342 | 237 | 4.8M | 2.9M |
| high | pitchcam | 59.9 | 59.9 | 29.8 | 59.5 | 16.5 | 11.4 | 890 | 608 | 10.4M | 5.7M |
| high | wide | 59.9 | 59.9 | 29.9 | 59.5 | 18.1 | 14.2 | 1690 | 1061 | 19.9M | 10.5M |
| high | follow | 59.9 | 59.9 | 29.9 | 59.5 | 18.7 | 10.6 | 1166 | 766 | 16.3M | 8.9M |
| high | faces | 59.9 | 59.9 | 58.5 | 59.5 | 14.4 | 8.3 | 376 | 279 | 4.1M | 2.3M |
| high | crowd | 59.9 | 59.9 | 59.5 | 59.5 | 8.4 | 7.6 | 345 | 240 | 4.8M | 2.9M |
| ultra | pitchcam | 59.9 | 59.9 | 29.4 | 59.5 | 18.2 | 12.1 | 891 | 675 | 8.9M | 4.9M |
| ultra | wide | 30.0 | 59.9 | 20.2 | 59.5 | 27.8 | 14.9 | 2048 | 1354 | 23.5M | 12.5M |
| ultra | follow | 59.9 | 59.9 | 59.5 | 59.5 | 15.2 | 12.2 | 1447 | 976 | 20.0M | 10.7M |
| ultra | faces | 59.9 | 59.9 | 58.1 | 59.5 | 15.5 | 9.2 | 435 | 359 | 3.7M | 2.3M |
| ultra | crowd | 59.9 | 59.9 | 58.8 | 59.5 | 14.6 | 8.8 | 398 | 330 | 4.1M | 2.8M |

## Emulated phone, cover screen 412x915@2.625, CPU x4 (pessimistic): batch 1 (pre-fix emu run) -> batch 2

| preset | scene | fps b1 | fps b2 | p5 b1 | p5 b2 | JS ms b1 | b2 | calls b1 | b2 | tris b1 | b2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| low | pitchcam | 30.1 | 29.9 | 29.9 | 19.9 | 23.1 | 28.2 | 282 | 282 | 4.4M | 4.5M |
| low | wide | 30.1 | 29.9 | 28.7 | 20.0 | 25.8 | 27.7 | 357 | 357 | 5.8M | 5.6M |
| low | faces | 30.1 | 29.9 | 28.7 | 20.0 | 25.1 | 28.7 | 198 | 175 | 2.7M | 2.2M |
| medium | pitchcam | 29.9 | 20.0 | 20.0 | 14.4 | 34.4 | 45.3 | 466 | 292 | 7.8M | 4.3M |
| medium | wide | 20.0 | 25.9 | 19.9 | 15.0 | 40.1 | 36.6 | 680 | 442 | 10.6M | 5.8M |
| medium | faces | 29.9 | 23.7 | 20.0 | 15.0 | 35.7 | 37.0 | 271 | 214 | 3.2M | 1.8M |
| high | pitchcam | 29.9 | 20.0 | 20.0 | 15.0 | 36.0 | 42.0 | 489 | 337 | 8.0M | 4.4M |
| high | wide | 20.0 | 19.9 | 19.9 | 13.4 | 39.7 | 51.7 | 681 | 443 | 10.6M | 5.8M |
| high | faces | 29.9 | 29.9 | 19.9 | 13.8 | 35.4 | 36.0 | 257 | 237 | 3.1M | 2.2M |

## Emulated phone, inner screen 750x832@2.625, CPU x2 (closest to the real Z Fold 7): batch 2 final run

| preset | scene | canvas | fps | p5 | JS ms | render submit ms | calls | tris |
|---|---|---|---|---|---|---|---|---|
| low | pitchcam | 900x999 | 59.9 | 59.5 | 12.4 | 8.8 | 308 | 4.5M |
| low | wide | 900x999 | 59.9 | 59.5 | 15.8 | 12.0 | 531 | 6.0M |
| low | faces | 900x999 | 59.9 | 59.5 | 11.1 | 7.4 | 171 | 2.0M |
| medium | pitchcam | 1125x1248 | 59.9 | 59.5 | 15.5 | 12.2 | 341 | 4.5M |
| medium | wide | 1125x1248 | 52.9 | 28.2 | 22.4 | 18.4 | 735 | 8.2M |
| medium | faces | 1125x1248 | 59.9 | 29.9 | 17.0 | 13.4 | 225 | 1.8M |
| high | pitchcam | 1125x1248 | 59.9 | 29.9 | 18.3 | 14.7 | 388 | 4.8M |
| high | wide | 1125x1248 | 37.6 | 29.8 | 22.9 | 18.8 | 772 | 8.8M |
| high | faces | 1125x1248 | 59.9 | 30.0 | 16.6 | 13.0 | 245 | 2.2M |

## Emulated phone, cover screen, CPU x6 (medium only)

| scene | fps | p5 | JS ms | calls |
|---|---|---|---|---|
| pitchcam | 15.0 | 10.0 | 60.8 | 292 |
| wide | 14.1 | 8.6 | 66.1 | 442 |
| faces | 20.0 | 15.0 | 50.7 | 214 |

First-load download (resource timing, preview server, no compression): phone-class (`1k` texture set) 45.6 MB, desktop (`2k`) 52.8 MB; before batch 2 about 85 MB (9 player files). Deploy size 115 MB -> 88 MB.

## Emulated phone, interleaved A/B (the fair comparison): inner screen 750x832@2.625, CPU x3, medium, runs ordered A B A B on the same machine state
(JS times of runs made minutes apart on this shared machine drift by up to 40 %, as the cover-x4 table above shows; draw calls and triangles do not.)

| scene | batch 1 fps | batch 2 fps | JS ms b1 (2 runs) | JS ms b2 (2 runs) | calls b1 -> b2 | tris b1 -> b2 |
|---|---|---|---|---|---|---|
| pitchcam | 29.9 | 30.0 | 29.7 / 30.4 | 25.3 / 24.3 | 535 -> 345 | 8.3M -> 4.6M |
| wide | 20.0 | 29.9 | 44.0 / 45.0 | 32.9 / 33.9 | 1169 -> 736 | 15.7M -> 8.2M |
| faces | 29.9 | 30.0 | 30.1 / 31.7 | 26.6 / 25.1 | 359 -> 280 | 3.5M -> 2.0M |
