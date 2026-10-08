# Bisect coarse-emu (emu 750x832@2.625 cpu x2), medians over 2 interleaved repeats

JS = the engine tick (rAF) on the main thread; main = rAF + timer callbacks (audio controller tick, duck follower, booth timers): what the main thread spends per frame.
off / on = sound off (`noaudio`) / on (muted Chrome, fake voices). tick = the audio controller tick (ms of main thread per second); nodes/s = Web Audio nodes created per second;
graph = Web Audio nodes standing when the scene starts; audio thr = share of the audio render thread (trace); fps p5 with sound on.

| preset | scene | build | JS off | JS on | main p95 on | Δ main on-off | tick ms/s | timers ms/s | nodes/s | params/s | graph | audio thr | fps p5 | calls | tris | game t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| low | faces | p00-perfbase | 9.5 | 11.3 | 15.6 | 1.97 | 3.56 | 3.69 | 4 | 95 | 410 | 1.2% | 59.3 | 212 | 2.82M | 17.97-25.61 |
| low | faces | p08-repo | 10.5 | 10.1 | 13.3 | -0.31 | 1.93 | 2.04 | 3 | 26 | 434 | 1.5% | 59.5 | 150 | 1.95M | 18.11-25.74 |
| low | faces | p09-announcers | 10.9 | 10.2 | 12.9 | -1.03 | 2.06 | 2.09 | 2 | 27 | 432 | 1.4% | 59.5 | 150 | 1.95M | 18.19-25.82 |
| low | faces | p10-soundscape | 9.5 | 9.9 | 12.5 | 0.12 | 2.27 | 3.37 | 9 | 182 | 619 | 4.3% | 59.3 | 150 | 1.95M | 18.06-25.69 |
| low | faces | p11-jank | 10.1 | 9.9 | 12.9 | -0.38 | 2.15 | 3.51 | 8 | 179 | 621 | 4.5% | 59.5 | 166 | 2.07M | 18.11-25.74 |
| low | pitchcam | p00-perfbase | 10.2 | 12.0 | 14.8 | 1.89 | 3.66 | 4.13 | 12 | 101 | 298 | 4.4% | 59.3 | 309 | 4.86M | 2.71-10.34 |
| low | pitchcam | p08-repo | 11.5 | 11.9 | 15.3 | 0.14 | 2.78 | 3.04 | 10 | 36 | 327 | 4.2% | 58.7 | 246 | 3.88M | 2.84-10.47 |
| low | pitchcam | p09-announcers | 11.5 | 11.4 | 15.6 | -0.07 | 2.30 | 2.69 | 10 | 33 | 327 | 4.6% | 59.2 | 246 | 3.88M | 2.92-10.56 |
| low | pitchcam | p10-soundscape | 10.7 | 10.7 | 13.5 | -0.07 | 2.69 | 3.98 | 13 | 128 | 444 | 5.3% | 59.5 | 246 | 3.87M | 2.79-10.43 |
| low | pitchcam | p11-jank | 11.0 | 11.3 | 14.2 | -0.05 | 2.36 | 3.68 | 12 | 129 | 449 | 5.5% | 59.5 | 265 | 3.85M | 2.84-10.48 |
| low | wide | p00-perfbase | 14.3 | 17.2 | 20.8 | 3.03 | 3.75 | 3.86 | 5 | 85 | 373 | 1.2% | 44.4 | 529 | 6.46M | 10.34-17.97 |
| low | wide | p08-repo | 16.3 | 14.8 | 18.3 | -1.42 | 2.44 | 2.57 | 6 | 28 | 392 | 1.5% | 50.9 | 472 | 5.29M | 10.47-18.11 |
| low | wide | p09-announcers | 15.5 | 15.5 | 17.7 | 0.09 | 2.42 | 2.53 | 6 | 25 | 392 | 1.5% | 44.8 | 472 | 5.29M | 10.56-18.19 |
| low | wide | p10-soundscape | 14.4 | 14.9 | 17.0 | 0.50 | 2.71 | 4.56 | 13 | 166 | 532 | 4.3% | 59.5 | 472 | 5.29M | 10.43-18.06 |
| low | wide | p11-jank | 14.6 | 14.7 | 17.0 | -0.21 | 2.76 | 4.14 | 14 | 165 | 528 | 4.3% | 58.1 | 476 | 5.29M | 10.48-18.11 |
| medium | faces | p00-perfbase | 13.8 | 13.8 | 16.5 | -0.04 | 3.63 | 3.83 | 4 | 92 | 410 | 1.1% | 59.3 | 232 | 1.94M | 17.96-25.59 |
| medium | faces | p08-repo | 15.4 | 14.8 | 17.6 | -0.80 | 2.19 | 2.29 | 3 | 25 | 434 | 1.6% | 59.3 | 190 | 1.62M | 17.97-25.61 |
| medium | faces | p09-announcers | 15.0 | 14.2 | 17.4 | -0.79 | 2.05 | 2.22 | 2 | 33 | 443 | 1.5% | 57.9 | 190 | 1.62M | 17.96-25.59 |
| medium | faces | p10-soundscape | 13.5 | 14.0 | 18.3 | 0.71 | 2.23 | 3.71 | 7 | 176 | 623 | 4.2% | 58.8 | 190 | 1.62M | 17.94-25.58 |
| medium | faces | p11-jank | 14.8 | 14.3 | 17.0 | -0.47 | 2.13 | 3.44 | 7 | 176 | 631 | 3.9% | 59.5 | 218 | 1.77M | 17.97-25.61 |
| medium | pitchcam | p00-perfbase | 14.5 | 14.8 | 17.7 | 0.33 | 3.52 | 3.88 | 10 | 97 | 309 | 4.0% | 44.7 | 342 | 4.49M | 2.69-10.32 |
| medium | pitchcam | p08-repo | 15.1 | 15.6 | 18.9 | 0.39 | 2.91 | 3.25 | 9 | 36 | 328 | 4.1% | 43.1 | 279 | 3.50M | 2.71-10.34 |
| medium | pitchcam | p09-announcers | 15.3 | 15.8 | 19.8 | 0.32 | 2.41 | 2.69 | 9 | 33 | 329 | 4.7% | 29.5 | 279 | 3.50M | 2.69-10.32 |
| medium | pitchcam | p10-soundscape | 13.9 | 15.3 | 18.6 | 1.43 | 3.00 | 4.29 | 12 | 124 | 445 | 5.4% | 44.6 | 279 | 3.50M | 2.68-10.31 |
| medium | pitchcam | p11-jank | 14.6 | 14.6 | 17.0 | -0.22 | 2.77 | 4.12 | 11 | 126 | 458 | 5.4% | 59.5 | 299 | 3.70M | 2.71-10.34 |
| medium | wide | p00-perfbase | 19.5 | 19.6 | 22.3 | 0.26 | 2.99 | 3.16 | 4 | 76 | 374 | 1.2% | 29.9 | 735 | 8.69M | 10.32-17.96 |
| medium | wide | p08-repo | 19.8 | 20.5 | 23.1 | 0.74 | 2.50 | 2.54 | 5 | 31 | 392 | 1.7% | 29.6 | 608 | 7.02M | 10.34-17.97 |
| medium | wide | p09-announcers | 21.0 | 20.2 | 23.2 | -1.14 | 2.58 | 2.66 | 6 | 26 | 391 | 1.7% | 29.9 | 608 | 7.02M | 10.32-17.96 |
| medium | wide | p10-soundscape | 18.6 | 19.3 | 22.7 | 0.90 | 2.63 | 3.83 | 11 | 147 | 530 | 4.0% | 29.4 | 608 | 7.02M | 10.31-17.94 |
| medium | wide | p11-jank | 19.8 | 19.4 | 22.8 | -0.36 | 2.71 | 3.80 | 11 | 149 | 536 | 4.2% | 29.4 | 615 | 7.03M | 10.34-17.97 |

<details><summary>machine load per run</summary>

```
p00-perfbase off r0: load 2.32/2.55/2.7 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 26 %, 3632 MiB, 61, 2025 MHz, 47.84 W
p00-perfbase on r0: load 2.95/2.65/2.72 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 61 %, 5523 MiB, 68, 2325 MHz, 81.97 W
p08-repo off r0: load 4.25/3.21/2.92 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 44 %, 5250 MiB, 68, 2325 MHz, 71.72 W
p08-repo on r0: load 4.35/3.59/3.08 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 44 %, 5371 MiB, 69, 2325 MHz, 76.42 W
p09-announcers off r0: load 4.27/3.84/3.23 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 28 %, 3819 MiB, 67, 2325 MHz, 64.65 W
p09-announcers on r0: load 3.89/3.81/3.27 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 49 %, 5040 MiB, 67, 2325 MHz, 64.14 W
p10-soundscape off r0: load 4.03/3.9/3.35 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 54 %, 3753 MiB, 66, 2175 MHz, 59.84 W
p10-soundscape on r0: load 3.66/3.79/3.36 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 41 %, 3855 MiB, 65, 2130 MHz, 58.99 W
p11-jank off r0: load 3.03/3.59/3.33 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 55 %, 3673 MiB, 66, 2280 MHz, 63.19 W
p11-jank on r0: load 4.06/3.77/3.42 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 32 %, 5420 MiB, 67, 2325 MHz, 67.90 W
p00-perfbase off r1: load 3.46/3.67/3.41 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 56 %, 3720 MiB, 66, 2325 MHz, 64.48 W
p00-perfbase on r1: load 2.45/3.3/3.31 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 31 %, 3733 MiB, 65, 2190 MHz, 59.68 W
p08-repo off r1: load 2.79/3.23/3.28 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 50 %, 3692 MiB, 65, 2325 MHz, 61.19 W
p08-repo on r1: load 3.69/3.35/3.31 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 31 %, 3686 MiB, 64, 2040 MHz, 54.58 W
p09-announcers off r1: load 4.77/3.77/3.47 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 47 %, 5438 MiB, 67, 2325 MHz, 68.03 W
p09-announcers on r1: load 4.04/3.87/3.54 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 44 %, 5400 MiB, 68, 2325 MHz, 72.32 W
p10-soundscape off r1: load 3.65/3.85/3.57 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 33 %, 3718 MiB, 67, 2325 MHz, 58.81 W
p10-soundscape on r1: load 2.72/3.48/3.46 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 33 %, 3707 MiB, 65, 2265 MHz, 61.55 W
p11-jank off r1: load 3.97/3.6/3.5 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 43 %, 3709 MiB, 65, 2130 MHz, 58.09 W
p11-jank on r1: load 3.35/3.46/3.45 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 32 %, 3656 MiB, 65, 2280 MHz, 59.29 W
```
</details>
