# Bisect play-laptop (laptop), medians over 2 interleaved repeats

JS = the engine tick (rAF) on the main thread; main = rAF + timer callbacks (audio controller tick, duck follower, booth timers): what the main thread spends per frame.
off / on = sound off (`noaudio`) / on (muted Chrome, fake voices). tick = the audio controller tick (ms of main thread per second); nodes/s = Web Audio nodes created per second;
graph = Web Audio nodes standing when the scene starts; audio thr = share of the audio render thread (trace); fps p5 with sound on.

| preset | scene | build | JS off | JS on | main p95 on | Δ main on-off | tick ms/s | timers ms/s | nodes/s | params/s | graph | audio thr | fps p5 | calls | tris | game t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| high | play | p00-perfbase | 8.8 | 9.7 | 15.3 | 0.97 | 2.25 | 2.41 | 7 | 98 | 510 | 2.4% | 44.2 | 360 | 4.30M |  |
| high | play | p08-repo | 9.7 | 9.0 | 13.3 | -0.63 | 2.04 | 2.19 | 8 | 53 | 518 | 2.6% | 57.1 | 278 | 2.51M |  |
| high | play | p09-announcers | 11.6 | 11.3 | 24.2 | -0.14 | 2.75 | 2.96 | 9 | 56 | 518 | 3.5% | 34.1 | 208 | 1.40M |  |
| high | play | p10-soundscape | 9.2 | 9.6 | 17.6 | 0.96 | 2.88 | 3.09 | 14 | 281 | 919 | 11.9% | 43.0 | 206 | 1.31M |  |
| high | play | p11-jank | 9.0 | 9.0 | 13.6 | -0.01 | 2.65 | 2.84 | 14 | 281 | 884 | 11.4% | 54.8 | 200 | 1.42M |  |

<details><summary>machine load per run</summary>

```
p00-perfbase off r0: load 3.75/3.46/3.44 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 25 %, 3725 MiB, 65, 2325 MHz, 58.57 W
p00-perfbase on r0: load 2.62/3.1/3.31 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 47 %, 3709 MiB, 66, 2325 MHz, 70.94 W
p08-repo off r0: load 3.98/3.31/3.35 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 57 %, 4716 MiB, 69, 2325 MHz, 72.68 W
p08-repo on r0: load 3.46/3.38/3.38 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 44 %, 4852 MiB, 69, 2325 MHz, 72.97 W
p09-announcers off r0: load 4.23/3.69/3.49 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 70 %, 5471 MiB, 76, 2310 MHz, 110.56 W
p09-announcers on r0: load 5.89/4.56/3.84 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 93 %, 7712 MiB, 81, 2310 MHz, 121.49 W
p10-soundscape off r0: load 6.03/5.16/4.16 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 75 %, 8202 MiB, 81, 2310 MHz, 117.05 W
p10-soundscape on r0: load 5.14/5.17/4.3 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 85 %, 8103 MiB, 82, 2310 MHz, 121.10 W
p11-jank off r0: load 4.68/5.25/4.46 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 78 %, 7545 MiB, 82, 2310 MHz, 119.70 W
p11-jank on r0: load 5.44/5.31/4.58 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 69 %, 7428 MiB, 82, 2310 MHz, 114.60 W
p00-perfbase off r1: load 6.32/5.59/4.77 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 70 %, 7358 MiB, 84, 2310 MHz, 124.25 W
p00-perfbase on r1: load 9.03/6.92/5.38 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 79 %, 7750 MiB, 82, 2310 MHz, 109.03 W
p08-repo off r1: load 11.21/8.24/6.05 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 95 %, 8382 MiB, 84, 2310 MHz, 125.00 W
p08-repo on r1: load 11.06/9.49/6.82 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 79 %, 7178 MiB, 83, 2310 MHz, 122.88 W
p09-announcers off r1: load 9/9.38/7.14 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 84 %, 8046 MiB, 83, 2310 MHz, 118.83 W
p09-announcers on r1: load 19.5/12.84/8.67 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 72 %, 8813 MiB, 84, 2310 MHz, 113.19 W
p10-soundscape off r1: load 16.93/14.9/10.06 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 88 %, 8784 MiB, 85, 2310 MHz, 124.46 W
p10-soundscape on r1: load 9.28/12.8/9.93 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 64 %, 6989 MiB, 83, 2310 MHz, 115.87 W
p11-jank off r1: load 11.16/11.91/9.93 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 72 %, 7043 MiB, 83, 2310 MHz, 112.76 W
p11-jank on r1: load 7.24/10.3/9.6 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 68 %, 7115 MiB, 80, 2310 MHz, 107.46 W
```
</details>
