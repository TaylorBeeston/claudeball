# Bisect coarse-laptop (laptop), medians over 2 interleaved repeats

JS = the engine tick (rAF) on the main thread; main = rAF + timer callbacks (audio controller tick, duck follower, booth timers): what the main thread spends per frame.
off / on = sound off (`noaudio`) / on (muted Chrome, fake voices). tick = the audio controller tick (ms of main thread per second); nodes/s = Web Audio nodes created per second;
graph = Web Audio nodes standing when the scene starts; audio thr = share of the audio render thread (trace); fps p5 with sound on.

| preset | scene | build | JS off | JS on | main p95 on | Δ main on-off | tick ms/s | timers ms/s | nodes/s | params/s | graph | audio thr | fps p5 | calls | tris | game t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| high | faces | p00-perfbase | 8.0 | 7.5 | 11.8 | -0.67 | 1.75 | 1.79 | 4 | 91 | 409 | 1.1% | 59.3 | 274 | 2.45M | 17.42-25.05 |
| high | faces | p07-ui | 7.8 | 7.8 | 12.1 | 0.03 | 1.94 | 1.96 | 5 | 42 | 433 | 1.7% | 59.2 | 232 | 2.04M | 17.41-25.04 |
| high | faces | p08-repo | 7.9 | 7.8 | 12.4 | -0.13 | 1.75 | 1.84 | 6 | 45 | 426 | 1.7% | 59.2 | 232 | 2.04M | 17.42-25.06 |
| high | faces | p09-announcers | 7.9 | 7.8 | 12.6 | 0.04 | 1.96 | 2.02 | 5 | 51 | 437 | 1.6% | 59.2 | 232 | 2.04M | 17.43-25.06 |
| high | faces | p10-soundscape | 7.8 | 8.3 | 13.7 | 0.61 | 2.01 | 2.11 | 11 | 270 | 963 | 7.8% | 59.2 | 232 | 2.04M | 17.43-25.06 |
| high | faces | p11-jank | 8.1 | 8.2 | 12.9 | 0.19 | 2.08 | 2.13 | 11 | 272 | 976 | 8.3% | 59.2 | 265 | 2.23M | 17.43-25.06 |
| high | pitchcam | p00-perfbase | 9.4 | 9.6 | 13.3 | 0.38 | 1.96 | 2.15 | 14 | 104 | 282 | 4.6% | 59.3 | 565 | 5.74M | 2.15-9.79 |
| high | pitchcam | p07-ui | 9.3 | 9.5 | 12.5 | 0.16 | 1.85 | 2.10 | 15 | 62 | 292 | 5.2% | 59.3 | 483 | 3.97M | 2.14-9.78 |
| high | pitchcam | p08-repo | 9.2 | 9.4 | 13.1 | 0.23 | 1.77 | 2.05 | 15 | 58 | 289 | 4.2% | 59.3 | 483 | 3.97M | 2.16-9.79 |
| high | pitchcam | p09-announcers | 9.4 | 9.4 | 12.9 | -0.03 | 1.61 | 1.83 | 14 | 58 | 294 | 4.3% | 59.3 | 484 | 3.97M | 2.16-9.79 |
| high | pitchcam | p10-soundscape | 9.4 | 9.5 | 13.3 | 0.07 | 2.93 | 3.19 | 57 | 277 | 485 | 11.1% | 59.5 | 483 | 3.97M | 2.16-9.79 |
| high | pitchcam | p11-jank | 9.5 | 9.7 | 12.9 | 0.12 | 2.78 | 3.02 | 58 | 279 | 497 | 11.2% | 59.5 | 514 | 4.20M | 2.16-9.79 |
| high | wide | p00-perfbase | 11.9 | 12.1 | 14.0 | 0.13 | 1.88 | 1.92 | 5 | 95 | 371 | 1.2% | 59.5 | 1059 | 11.52M | 9.79-17.42 |
| high | wide | p07-ui | 11.7 | 12.1 | 14.0 | 0.49 | 1.74 | 1.81 | 7 | 43 | 388 | 1.7% | 59.5 | 863 | 7.76M | 9.78-17.41 |
| high | wide | p08-repo | 11.8 | 11.9 | 13.9 | -0.09 | 1.94 | 2.00 | 6 | 46 | 388 | 1.5% | 59.3 | 863 | 7.76M | 9.79-17.42 |
| high | wide | p09-announcers | 11.8 | 11.8 | 14.1 | 0.09 | 1.84 | 1.95 | 6 | 43 | 392 | 1.5% | 59.3 | 863 | 7.76M | 9.79-17.43 |
| high | wide | p10-soundscape | 11.7 | 12.2 | 15.0 | 0.45 | 2.08 | 2.11 | 16 | 257 | 849 | 7.4% | 59.5 | 863 | 7.76M | 9.79-17.43 |
| high | wide | p11-jank | 11.7 | 12.1 | 14.4 | 0.45 | 2.19 | 2.26 | 16 | 253 | 869 | 8.0% | 59.5 | 871 | 7.76M | 9.79-17.43 |
| low | faces | p00-perfbase | 7.4 | 7.8 | 11.9 | 0.40 | 2.32 | 2.36 | 4 | 95 | 408 | 1.7% | 58.8 | 240 | 3.08M | 17.46-25.09 |
| low | faces | p07-ui | 7.0 | 7.2 | 11.2 | 0.20 | 2.31 | 2.42 | 5 | 52 | 431 | 2.4% | 59.2 | 177 | 2.16M | 17.44-25.08 |
| low | faces | p08-repo | 7.5 | 6.9 | 11.4 | -0.29 | 2.08 | 2.14 | 5 | 45 | 438 | 2.3% | 59.0 | 177 | 2.16M | 17.46-25.09 |
| low | faces | p09-announcers | 7.2 | 6.5 | 10.1 | -0.58 | 2.05 | 2.15 | 5 | 50 | 432 | 2.1% | 59.2 | 177 | 2.16M | 17.43-25.06 |
| low | faces | p10-soundscape | 7.2 | 7.3 | 11.5 | 0.07 | 2.46 | 2.54 | 10 | 264 | 971 | 10.5% | 58.7 | 177 | 2.16M | 17.41-25.04 |
| low | faces | p11-jank | 7.3 | 7.4 | 11.5 | 0.05 | 2.33 | 2.42 | 11 | 270 | 968 | 10.0% | 58.8 | 197 | 2.31M | 17.47-25.11 |
| low | pitchcam | p00-perfbase | 7.5 | 7.8 | 13.1 | 0.34 | 2.29 | 2.54 | 14 | 105 | 282 | 5.7% | 59.0 | 409 | 5.34M | 2.19-9.83 |
| low | pitchcam | p07-ui | 7.3 | 7.8 | 12.5 | 0.57 | 1.94 | 2.19 | 15 | 57 | 290 | 6.2% | 59.2 | 347 | 4.23M | 2.18-9.81 |
| low | pitchcam | p08-repo | 7.4 | 7.2 | 11.9 | 0.01 | 1.64 | 1.94 | 16 | 55 | 290 | 5.7% | 59.2 | 347 | 4.23M | 2.19-9.83 |
| low | pitchcam | p09-announcers | 7.3 | 7.0 | 11.7 | -0.17 | 1.97 | 2.33 | 15 | 59 | 293 | 4.7% | 59.2 | 347 | 4.23M | 2.16-9.79 |
| low | pitchcam | p10-soundscape | 7.6 | 7.7 | 12.5 | 0.16 | 3.26 | 3.56 | 57 | 276 | 488 | 13.1% | 59.2 | 347 | 4.23M | 2.14-9.78 |
| low | pitchcam | p11-jank | 8.0 | 7.7 | 12.0 | -0.40 | 3.02 | 3.31 | 56 | 275 | 488 | 13.1% | 59.2 | 366 | 4.18M | 2.21-9.84 |
| low | wide | p00-perfbase | 9.3 | 9.5 | 14.4 | 0.54 | 1.98 | 2.02 | 6 | 92 | 369 | 1.4% | 59.2 | 755 | 7.53M | 9.83-17.46 |
| low | wide | p07-ui | 9.5 | 9.8 | 14.3 | 0.47 | 1.72 | 1.78 | 6 | 43 | 388 | 1.6% | 59.5 | 702 | 5.75M | 9.81-17.44 |
| low | wide | p08-repo | 9.5 | 9.7 | 12.3 | 0.12 | 1.82 | 1.88 | 6 | 44 | 392 | 1.5% | 59.3 | 702 | 5.75M | 9.83-17.46 |
| low | wide | p09-announcers | 9.8 | 9.7 | 12.7 | -0.25 | 1.99 | 2.08 | 6 | 41 | 389 | 1.4% | 59.3 | 702 | 5.75M | 9.79-17.43 |
| low | wide | p10-soundscape | 9.6 | 9.7 | 12.8 | 0.23 | 2.13 | 2.20 | 17 | 256 | 852 | 6.6% | 59.5 | 702 | 5.75M | 9.78-17.41 |
| low | wide | p11-jank | 9.4 | 9.7 | 12.2 | 0.11 | 2.25 | 2.29 | 17 | 255 | 851 | 7.8% | 59.5 | 704 | 5.75M | 9.84-17.47 |

<details><summary>machine load per run</summary>

```
p00-perfbase off r0: load 1.99/3.36/3.62 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 27 %, 3626 MiB, 57, 2025 MHz, 46.35 W
p00-perfbase on r0: load 1.81/3.03/3.48 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 27 %, 3605 MiB, 63, 2325 MHz, 67.94 W
p07-ui off r0: load 2.67/2.99/3.43 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 28 %, 3667 MiB, 64, 2325 MHz, 67.72 W
p07-ui on r0: load 2.48/2.93/3.38 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 50 %, 3648 MiB, 65, 2325 MHz, 72.96 W
p08-repo off r0: load 2.63/2.93/3.35 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 31 %, 3597 MiB, 64, 2325 MHz, 68.99 W
p08-repo on r0: load 1.91/2.7/3.24 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 26 %, 3600 MiB, 64, 2325 MHz, 67.62 W
p09-announcers off r0: load 2.83/2.81/3.23 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 36 %, 3651 MiB, 64, 2325 MHz, 71.01 W
p09-announcers on r0: load 2.58/2.72/3.16 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 38 %, 3666 MiB, 64, 2325 MHz, 70.54 W
p10-soundscape off r0: load 2.15/2.56/3.07 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 50 %, 3597 MiB, 65, 2325 MHz, 73.05 W
p10-soundscape on r0: load 2.29/2.54/3.02 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 30 %, 3593 MiB, 64, 2325 MHz, 70.57 W
p11-jank off r0: load 2.11/2.43/2.94 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 26 %, 3641 MiB, 64, 2325 MHz, 62.87 W
p11-jank on r0: load 3.41/2.69/2.99 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 33 %, 3622 MiB, 64, 2325 MHz, 69.33 W
p00-perfbase off r1: load 2.84/2.63/2.94 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 48 %, 3649 MiB, 66, 2325 MHz, 73.91 W
p00-perfbase on r1: load 2.23/2.47/2.86 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 64 %, 3647 MiB, 64, 2325 MHz, 71.49 W
p07-ui off r1: load 2.54/2.49/2.83 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 37 %, 3648 MiB, 65, 2325 MHz, 72.58 W
p07-ui on r1: load 2.58/2.58/2.84 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 40 %, 3635 MiB, 64, 2325 MHz, 70.13 W
p08-repo off r1: load 2.22/2.49/2.79 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 51 %, 3643 MiB, 66, 2325 MHz, 72.91 W
p08-repo on r1: load 2.88/2.65/2.82 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 50 %, 3613 MiB, 65, 2325 MHz, 73.48 W
p09-announcers off r1: load 3.08/2.75/2.84 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 45 %, 3635 MiB, 65, 2325 MHz, 66.79 W
p09-announcers on r1: load 2.54/2.67/2.81 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 47 %, 3631 MiB, 64, 2325 MHz, 69.29 W
p10-soundscape off r1: load 2.7/2.74/2.82 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 49 %, 3652 MiB, 65, 2325 MHz, 72.05 W
p10-soundscape on r1: load 2.35/2.63/2.78 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 29 %, 3647 MiB, 64, 2325 MHz, 56.43 W
p11-jank off r1: load 2.68/2.66/2.77 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 29 %, 3591 MiB, 64, 2325 MHz, 58.48 W
p11-jank on r1: load 2.24/2.47/2.69 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 30 %, 3652 MiB, 64, 2325 MHz, 68.04 W
```
</details>
