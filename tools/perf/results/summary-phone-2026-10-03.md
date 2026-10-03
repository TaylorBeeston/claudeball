# Real phone (Galaxy Z Fold 7, UNFOLDED inner screen 750x832 css @ DPR 2.625, Chrome 154, Adreno 830), main = batch 1 (commit 0919a46), 2026-10-03

Deterministic bench, scaler off, day, medians over 240 frames. Baseline (before any fix) was measured on the COVER screen (411x814 css, 616x1221 px): low 30 fps / 3 100 calls / 31 ms render submit; medium 12 fps / 7 500 calls / 79 ms.
Thermal: battery 29.1 C -> 32.7 C, skin 37.8 C -> 45.0 C, AP 32 -> 53 C, Android thermal status 0 -> 3 (severe) by the end of the 4-preset run (order low, medium, high, ultra: the high/wide and ultra rows may be throttled).

| preset | scene | canvas px | fps med | fps p5 | frame ms | JS ms | render submit ms | draw calls | triangles | >25 ms frames (of 240) |
|---|---|---|---|---|---|---|---|---|---|---|
| low | pitchcam | 1015x885 | 59.9 | 59.9 | 16.7 | 11.4 | 7.5 | 328 | 4.7M | 0 |
| low | wide | 1015x885 | 59.9 | 59.5 | 16.7 | 10.1 | 7.8 | 688 | 7.3M | 7 |
| low | faces | 1015x885 | 59.9 | 59.9 | 16.7 | 11.6 | 6.3 | 231 | 2.9M | 0 |
| medium | pitchcam | 1125x981 | 59.9 | 59.5 | 16.7 | 14.7 | 11.3 | 577 | 8.3M | 11 |
| medium | wide | 1125x981 | 59.9 | 30.0 | 16.7 | 12.7 | 10.8 | 1465 | 17.6M | 14 |
| medium | faces | 1125x981 | 59.9 | 30.0 | 16.7 | 15.4 | 10.0 | 343 | 3.5M | 17 |
| high | pitchcam | 1125x981 | 59.9 | 59.5 | 16.7 | 10.8 | 8.5 | 638 | 8.9M | 9 |
| high | wide | 1125x981 | 30.0 | 20.0 | 33.3 | 37.3 | 32.6 | 1538 | 18.0M | 215 |
| high | faces | 1125x981 | 59.9 | 59.9 | 16.7 | 14.2 | 9.5 | 335 | 3.5M | 4 |
| ultra | pitchcam | 1500x1308 | 30.0 | 20.0 | 33.3 | 24.0 | 19.4 | 656 | 7.9M | 167 |
| ultra | wide | 1500x1308 | 20.0 | 12.0 | 50.0 | 34.1 | 29.6 | 1748 | 20.7M | 200 |
| ultra | faces | 1500x1308 | 30.0 | 20.0 | 33.3 | 23.9 | 16.2 | 302 | 2.4M | 211 |
