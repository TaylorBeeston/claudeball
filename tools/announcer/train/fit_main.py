"""Entry point for `piper.train fit` that tolerates a missing MOS predictor.

Piper's default callbacks also checkpoint on `val_mos` (UTMOS), which needs torchaudio and a one-time download from GitHub. When that is not
available (CB_DROP_MOS=1, set by train.py after a pre-flight check) the val_mos checkpoint callback is removed instead of crashing the run.
"""
import os
import sys

import piper.train.__main__ as m

if os.environ.get("CB_DROP_MOS") == "1":
    m._DEFAULT_CALLBACKS[:] = [c for c in m._DEFAULT_CALLBACKS if getattr(c, "monitor", None) != "val_mos"]

sys.argv[0] = "piper.train"
m.main()
