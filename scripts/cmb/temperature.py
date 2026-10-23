"""Lossless temperature texture: the map itself (not its colours) as KTX2 R8 + zstd.

The colour-mapped Basis texture loses fine structure and saturation (about 18.6 dB
RGB PSNR at 4096). Storing temperature instead lets the shader apply the Planck
colour scale exactly through a small lookup table, and a single channel compresses
losslessly to a fraction of the size of RGB.

Encoding: the smoothed grid (uK) is box-filtered to 2048x1024 in linear temperature,
then the colour scale's range [-300, +300] uK maps linearly to 0..255 (2.35 uK per
step, far below anything visible once colour-mapped; values outside are clamped, as
the colour scale clamps them). Rows are written bottom-up (first row = south galactic
pole) like the colour textures, with a full box-filtered mip chain made by ktx.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

import config

WIDTH = 2048
HEIGHT = 1024
FILE_NAME = f"cmb-temperature-{WIDTH}.ktx2"
PNG_PATH = config.WORK / f"temperature-{WIDTH}-bottom-up.png"
KTX = config.KTX_PREFIX / "bin" / "ktx"
KTX_ARGS = [
    "create",
    "--format", "R8_UNORM",
    "--assign-tf", "linear",
    "--assign-texcoord-origin", "bottom-left",
    "--generate-mipmap",
    "--mipmap-filter", "box",
    "--zstd", "19",
]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_temperature() -> dict[str, Any]:
    grid = np.load(config.GRID_PATH)  # (2048, 4096) float32 uK, row 0 = north
    if grid.shape != (config.HEIGHT, config.WIDTH):
        raise SystemExit(f"unexpected grid shape {grid.shape}")
    # 2x2 box filter in linear temperature.
    half = grid.reshape(HEIGHT, 2, WIDTH, 2).mean(axis=(1, 3), dtype=np.float64)
    low, high = config.RANGE_MICROKELVIN
    scaled = np.clip((half - low) / (high - low), 0.0, 1.0)
    codes = np.rint(scaled * 255.0).astype(np.uint8)
    # Bottom-up rows, matching the colour textures and three's flipY = false for KTX2.
    Image.fromarray(np.flipud(codes), mode="L").save(PNG_PATH, optimize=True)

    out = config.PUBLIC / FILE_NAME
    result = subprocess.run([str(KTX), *KTX_ARGS, str(PNG_PATH), str(out)], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"ktx create failed: {result.stderr}")

    clipped = float(np.mean((half < low) | (half > high)))
    # Round trip: the quantisation error in uK (max half a step inside the range).
    restored = codes.astype(np.float64) / 255.0 * (high - low) + low
    inside = (half >= low) & (half <= high)
    error = np.abs(restored[inside] - half[inside])
    return {
        "file": FILE_NAME,
        "width": WIDTH,
        "height": HEIGHT,
        "bytes": out.stat().st_size,
        "sha256": _sha256(out),
        "format": "R8_UNORM, linear, zstd level 19 supercompression (lossless), box-filtered mip chain",
        "rows": "bottom-up (v = 0 is the south galactic pole)",
        "encoding": f"value = (T - ({low:.0f})) / {high - low:.0f} in uK, clamped to 0..1, stored as round(255 * value)",
        "range": [round(low), round(high)],
        "quantisationMaxErrorUk": round(float(error.max()), 3),
        "fractionClamped": round(clipped, 5),
        "tool": f"ktx {' '.join(KTX_ARGS)} (KTX-Software, unpacked by fetch-ktx.sh)",
    }
