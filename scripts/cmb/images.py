"""Colour-mapped texture and its mip chain, written as lossless PNGs."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image

import colormap
import config

Rgb8 = NDArray[np.uint8]


def srgb_to_linear(rgb8: Rgb8) -> NDArray[np.float64]:
    c = rgb8.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(linear: NDArray[np.float64]) -> Rgb8:
    c = np.clip(linear, 0.0, 1.0)
    encoded = np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)
    return np.round(encoded * 255.0).astype(np.uint8)


def halve(rgb8: Rgb8) -> Rgb8:
    """2x box filter in linear light, which is how the GPU blends sRGB texels.

    The 2:1 equirectangular grid stays power-of-two, so pairs never straddle the
    longitude seam or the poles; no wrap or clamp policy is needed.
    """
    height, width, _ = rgb8.shape
    fy = 2 if height > 1 else 1
    fx = 2 if width > 1 else 1
    linear = srgb_to_linear(rgb8).reshape(height // fy, fy, width // fx, fx, 3)
    return linear_to_srgb(linear.mean(axis=(1, 3)))


def mip_chain(level0: Rgb8) -> list[Rgb8]:
    levels = [level0]
    while levels[-1].shape[0] > 1 or levels[-1].shape[1] > 1:
        levels.append(halve(levels[-1]))
    return levels


def write_png(path: Path, rgb8: Rgb8) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb8, mode="RGB").save(path, format="PNG", compress_level=6)


def level_path(index: int) -> Path:
    return config.LEVELS_DIR / f"level-{index:02d}.png"


def build_images() -> list[Path]:
    """Writes the lossless full-size PNG (north up) and one PNG per mip level.

    The level PNGs are stored bottom-up (first row = south galactic pole) so the
    KTX2 files hold rows in texture-coordinate order: three's KTX2Loader keeps
    flipY = false, so v = 0 samples the first stored row. ktx create is then told
    --assign-texcoord-origin bottom-left, which only records that orientation
    (its --convert-texcoord-origin crashes on multi-level input in v4.4.2).
    """
    grid = np.load(config.GRID_PATH)
    if grid.shape != (config.HEIGHT, config.WIDTH):
        raise SystemExit(f"Grid shape {grid.shape} does not match {config.WIDTH}x{config.HEIGHT}")
    rgb = colormap.apply(colormap.load_table(), grid)
    write_png(config.LOSSLESS_PNG, rgb)

    if config.LEVELS_DIR.exists():
        for old in config.LEVELS_DIR.glob("level-*.png"):
            old.unlink()
    paths = []
    for index, level in enumerate(mip_chain(rgb)):
        path = level_path(index)
        write_png(path, np.ascontiguousarray(level[::-1]))
        paths.append(path)
    return paths
