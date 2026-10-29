"""Smoke test: load Audio8 on the GPU, say one line three times, print timing and VRAM. Usage: smoke.py OUT_DIR"""
import sys
import time
from pathlib import Path

import soundfile as sf
import torch

import a8

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
t = time.perf_counter()
m = a8.Audio8()
print("load_s", round(time.perf_counter() - t, 1), "vram_gib", round(torch.cuda.memory_allocated() / 2**30, 2))
for i in range(3):
    a, s = m.say("Now batting, number twenty-three, Tyler Vance.", seed=i)
    print(s)
    sf.write(out / f"smoke{i}.wav", a, a8.SR)
print("peak_vram_gib", round(torch.cuda.max_memory_allocated() / 2**30, 2))
