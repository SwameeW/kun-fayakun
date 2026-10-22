"""The Planck "Parchment" colour map: loading, applying and exporting legend stops."""

from __future__ import annotations

import hashlib
from pathlib import Path

import healpy
import numpy as np
from numpy.typing import NDArray

import config

Table = NDArray[np.float64]  # (256, 3) sRGB-encoded values in 0..255


def load_table() -> Table:
    """Loads healpy's copy of the table and checks it is the pinned one."""
    path = Path(healpy.__file__).parent / "data" / "planck_cmap.dat"
    table = np.loadtxt(path)
    if table.shape != (256, 3):
        raise SystemExit(f"Unexpected colour table shape {table.shape} in {path}")
    digest = hashlib.sha256(table.astype(np.uint8).tobytes()).hexdigest()
    if digest != config.COLORMAP_TABLE_SHA256:
        raise SystemExit(f"Colour table {path} changed: sha256 {digest}")
    return table


def _sample(table: Table, fraction: NDArray[np.float64]) -> NDArray[np.float64]:
    """Linear interpolation between the 256 entries, in sRGB-encoded space like CSS gradients."""
    index = np.clip(fraction, 0.0, 1.0) * (table.shape[0] - 1)
    entries = np.arange(table.shape[0], dtype=np.float64)
    return np.stack([np.interp(index, entries, table[:, c]) for c in range(3)], axis=-1)


def apply(table: Table, values_uk: NDArray[np.float32]) -> NDArray[np.uint8]:
    """Maps temperatures to 8-bit sRGB; values outside the range clamp to the end colours."""
    low, high = config.RANGE_MICROKELVIN
    fraction = (values_uk.astype(np.float64) - low) / (high - low)
    rgb = np.empty((*values_uk.shape, 3), dtype=np.uint8)
    rows_per_chunk = 256
    for start in range(0, values_uk.shape[0], rows_per_chunk):
        stop = start + rows_per_chunk
        rgb[start:stop] = np.round(_sample(table, fraction[start:stop])).astype(np.uint8)
    return rgb


def knots(table: Table, tolerance: float = 1.0) -> list[int]:
    """Fewest table indices whose linear interpolation reproduces the table within `tolerance`."""
    chosen = [0, table.shape[0] - 1]
    entries = np.arange(table.shape[0], dtype=np.float64)
    while True:
        ordered = sorted(chosen)
        approx = np.stack([np.interp(entries, ordered, table[ordered, c]) for c in range(3)], axis=-1)
        error = np.abs(approx - table).max(axis=1)
        if error.max() <= tolerance:
            return ordered
        chosen.append(int(error.argmax()))


def legend_stops(table: Table, subdivisions: int) -> list[tuple[float, str]]:
    """(position, '#rrggbb') stops for the DOM legend: every knot plus even subdivisions."""
    last = table.shape[0] - 1
    knot_list = knots(table)
    indices = [
        a + (b - a) * step / subdivisions
        for a, b in zip(knot_list[:-1], knot_list[1:])
        for step in range(subdivisions)
    ] + [float(last)]
    positions = np.array(indices) / last
    colours = np.round(_sample(table, positions)).astype(int)
    return [
        (round(float(p), 6), "#{:02x}{:02x}{:02x}".format(*(int(c) for c in rgb)))
        for p, rgb in zip(positions, colours)
    ]


def legend_max_error(table: Table, stops: list[tuple[float, str]]) -> float:
    """Largest per-channel difference (0..255) between the stops' gradient and the table."""
    positions = np.array([p for p, _ in stops])
    colours = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5)] for _, h in stops], dtype=np.float64)
    fraction = np.linspace(0.0, 1.0, 1024)
    gradient = np.stack([np.interp(fraction, positions, colours[:, c]) for c in range(3)], axis=-1)
    return float(np.max(np.abs(gradient - _sample(table, fraction))))
