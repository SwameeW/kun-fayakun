"""Resampling and mip chains for equirectangular maps, in numpy.

A texture that wraps around a planet must wrap in longitude and stop at the poles, so every
filter here wraps horizontally and clamps (repeats the edge row) vertically. `ktx create`'s own
mip generator has one wrap mode for both axes, which would bleed one pole into the other, so
the chains are built here and handed to ktx level by level.

Colour is filtered in linear light (the GPU blends sRGB texels after decoding them, so the
mips must average light, not code values). Arrays are float32 and processed in bands of rows
or columns to keep memory near the size of the output.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
from numpy.typing import NDArray

Float = NDArray[np.float32]
Kernel = Callable[[NDArray[np.float64]], NDArray[np.float64]]

# Rows (or columns) per band: bounds the temporary arrays to a few hundred MB.
BAND = 512


def lanczos2(x: NDArray[np.float64]) -> NDArray[np.float64]:
    """Lanczos, a = 2: sharper than a box or tent with little ringing at coastlines."""
    ax = np.abs(x)
    return np.where(ax < 2.0, np.sinc(x) * np.sinc(x / 2.0), 0.0)


def taps(n_in: int, n_out: int, wrap: bool, kernel: Kernel = lanczos2, support: float = 2.0) -> tuple[NDArray[np.int64], Float]:
    """Source indices and weights for each output sample along one axis.

    Output sample i covers the same span of the axis as input samples (i + 0.5) * n_in / n_out
    - 0.5 around it (pixel-is-area on both grids, so the map's edges stay at -180/180 and +/-90).
    When reducing, the kernel is widened by the ratio so it averages everything it covers.
    """
    scale = n_in / n_out
    widen = max(scale, 1.0)
    radius = support * widen
    centres = (np.arange(n_out, dtype=np.float64) + 0.5) * scale - 0.5
    first = np.floor(centres - radius).astype(np.int64) + 1
    count = int(np.ceil(2.0 * radius)) + 1
    index = first[:, None] + np.arange(count, dtype=np.int64)[None, :]
    weight = kernel((index - centres[:, None]) / widen)
    weight /= weight.sum(axis=1, keepdims=True)
    index = np.mod(index, n_in) if wrap else np.clip(index, 0, n_in - 1)
    return index, weight.astype(np.float32)


def resample_columns(src: Float, width: int, wrap: bool = True, kernel: Kernel = lanczos2) -> Float:
    """Resamples along axis 1 (longitude by default: wraps)."""
    index, weight = taps(src.shape[1], width, wrap, kernel)
    out = np.empty((src.shape[0], width, *src.shape[2:]), dtype=np.float32)
    shape = (1, width) + (1,) * (src.ndim - 2)
    for r0 in range(0, src.shape[0], BAND):
        band = src[r0 : r0 + BAND]
        acc = np.zeros((band.shape[0], width, *src.shape[2:]), dtype=np.float32)
        for t in range(index.shape[1]):
            acc += band[:, index[:, t]] * weight[:, t].reshape(shape)
        out[r0 : r0 + BAND] = acc
    return out


def resample_rows(src: Float, height: int, wrap: bool = False, kernel: Kernel = lanczos2) -> Float:
    """Resamples along axis 0 (latitude by default: clamps at the poles)."""
    index, weight = taps(src.shape[0], height, wrap, kernel)
    out = np.empty((height, *src.shape[1:]), dtype=np.float32)
    shape = (height,) + (1,) * (src.ndim - 1)
    for c0 in range(0, src.shape[1], BAND * 4):
        band = src[:, c0 : c0 + BAND * 4]
        acc = np.zeros((height, *band.shape[1:]), dtype=np.float32)
        for t in range(index.shape[1]):
            acc += band[index[:, t]] * weight[:, t].reshape(shape)
        out[:, c0 : c0 + BAND * 4] = acc
    return out


def resample(src: Float, width: int, height: int, kernel: Kernel = lanczos2) -> Float:
    """Equirectangular resample to width x height: wrap in longitude, clamp in latitude."""
    out = src if src.shape[1] == width else resample_columns(src, width, True, kernel)
    return out if out.shape[0] == height else resample_rows(out, height, False, kernel)


def halve_box(src: Float) -> Float:
    """Exact 2 x 2 average (for coverage masks and the ring strip, where ringing would be wrong)."""
    h, w = src.shape[:2]
    fy, fx = (2 if h > 1 else 1), (2 if w > 1 else 1)
    return src.reshape(h // fy, fy, w // fx, fx, *src.shape[2:]).mean(axis=(1, 3), dtype=np.float32)


def chain(level0: Float, box: bool = False) -> list[Float]:
    """Full mip chain down to 1 x 1 (or w x 1 / 1 x h), each level from the previous one."""
    levels = [level0]
    while levels[-1].shape[0] > 1 or levels[-1].shape[1] > 1:
        top = levels[-1]
        h, w = top.shape[:2]
        if box or min(h, w) < 4:
            levels.append(halve_box(top))
        else:
            levels.append(resample(top, max(1, w // 2), max(1, h // 2)))
    return levels


# --- sRGB -----------------------------------------------------------------------------------


def srgb_to_linear(codes: NDArray[np.uint8]) -> Float:
    """8-bit sRGB codes to linear light through a 256-entry table."""
    c = np.arange(256, dtype=np.float64) / 255.0
    table = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)
    return table[codes]


def linear_to_srgb(linear: Float) -> NDArray[np.uint8]:
    c = np.clip(linear, 0.0, 1.0)
    encoded = np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)
    return np.rint(encoded * 255.0).astype(np.uint8)


def to_unorm8(values: Float) -> NDArray[np.uint8]:
    return np.rint(np.clip(values, 0.0, 1.0) * 255.0).astype(np.uint8)
