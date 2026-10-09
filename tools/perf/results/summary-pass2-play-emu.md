# Bisect play-emu (emu 750x832@2.625 cpu x2), medians over 2 interleaved repeats

JS = the engine tick (rAF) on the main thread; main = rAF + timer callbacks (audio controller tick, duck follower, booth timers): what the main thread spends per frame.
off / on = sound off (`noaudio`) / on (muted Chrome, fake voices). tick = the audio controller tick (ms of main thread per second); nodes/s = Web Audio nodes created per second;
graph = Web Audio nodes standing when the scene starts; audio thr = share of the audio render thread (trace); fps p5 with sound on.

| preset | scene | build | JS off | JS on | main p95 on | Δ main on-off | tick ms/s | timers ms/s | nodes/s | params/s | graph | audio thr | fps p5 | calls | tris | game t |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| medium | play | p00-perfbase | 14.6 | 14.4 | 19.9 | -0.15 | 3.86 | 4.12 | 7 | 94 | 469 | 2.1% | 29.6 | 233 | 2.91M |  |
| medium | play | p08-repo | 14.3 | 14.7 | 20.0 | 0.54 | 2.69 | 2.98 | 7 | 34 | 411 | 2.8% | 29.5 | 174 | 1.09M |  |
| medium | play | p09-announcers | 14.5 | 14.5 | 21.2 | -0.02 | 2.71 | 2.96 | 6 | 33 | 409 | 2.5% | 29.6 | 169 | 1.03M |  |
| medium | play | p10-soundscape | 14.3 | 14.3 | 21.9 | -0.25 | 2.88 | 4.16 | 9 | 152 | 546 | 5.5% | 29.9 | 170 | 1.16M |  |
| medium | play | p11-jank | 14.5 | 15.0 | 24.2 | 0.76 | 3.00 | 4.42 | 9 | 158 | 556 | 5.9% | 29.3 | 167 | 1.12M |  |

<details><summary>machine load per run</summary>

```
p00-perfbase off r0: load 6.85/9.03/9.22 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 69 %, 7042 MiB, 81, 2310 MHz, 105.78 W
p00-perfbase on r0: load 5.96/7.96/8.8 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 65 %, 7094 MiB, 79, 2310 MHz, 102.16 W
p08-repo off r0: load 5.87/7.44/8.51 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 63 %, 7254 MiB, 80, 2310 MHz, 109.87 W
p08-repo on r0: load 4.25/6.3/7.95 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 67 %, 7337 MiB, 79, 2310 MHz, 98.40 W
p09-announcers off r0: load 6.28/6.2/7.69 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 71 %, 7257 MiB, 79, 2310 MHz, 104.01 W
p09-announcers on r0: load 4.69/5.56/7.26 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 46 %, 7291 MiB, 78, 2310 MHz, 95.87 W
p10-soundscape off r0: load 4.8/5.25/6.92 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 67 %, 7385 MiB, 79, 2310 MHz, 107.70 W
p10-soundscape on r0: load 3.75/4.74/6.52 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 72 %, 7500 MiB, 81, 2310 MHz, 110.79 W
p11-jank off r0: load 4.23/4.61/6.24 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 69 %, 7608 MiB, 80, 2310 MHz, 109.84 W
p11-jank on r0: load 4.48/4.56/6.01 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 73 %, 7487 MiB, 81, 2310 MHz, 111.35 W
p00-perfbase off r1: load 4.12/4.55/5.83 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 66 %, 7484 MiB, 80, 2310 MHz, 105.86 W
p00-perfbase on r1: load 4.3/4.47/5.64 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 85 %, 7700 MiB, 81, 2310 MHz, 116.95 W
p08-repo off r1: load 4.35/4.49/5.5 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 79 %, 7792 MiB, 82, 2310 MHz, 116.71 W
p08-repo on r1: load 3.61/4.14/5.24 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 61 %, 7897 MiB, 82, 2310 MHz, 111.74 W
p09-announcers off r1: load 4.48/4.29/5.15 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 86 %, 7971 MiB, 83, 2310 MHz, 119.14 W
p09-announcers on r1: load 4.87/4.35/5.05 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 76 %, 7873 MiB, 82, 2310 MHz, 114.89 W
p10-soundscape off r1: load 4.27/4.29/4.94 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 82 %, 7662 MiB, 83, 2310 MHz, 118.70 W
p10-soundscape on r1: load 3.9/4.32/4.88 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 70 %, 7352 MiB, 82, 2310 MHz, 116.55 W
p11-jank off r1: load 3.64/4.14/4.75 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 63 %, 7164 MiB, 81, 2310 MHz, 108.22 W
p11-jank on r1: load 5.1/4.55/4.82 gpu NVIDIA GeForce RTX 4090 Laptop GPU, 69 %, 7158 MiB, 81, 2310 MHz, 111.14 W
```
</details>
