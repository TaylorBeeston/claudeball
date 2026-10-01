"""Piper's ONNX export with the classic TorchScript exporter.

Recent PyTorch (2.9+) defaults to the dynamo exporter, which cannot trace VITS's data-dependent spline asserts. Piper's own script is
unchanged; we only ask torch.onnx.export for `dynamo=False`.
"""
import functools

import torch

torch.onnx.export = functools.partial(torch.onnx.export, dynamo=False)

from piper.train.export_onnx import main  # noqa: E402

main()
