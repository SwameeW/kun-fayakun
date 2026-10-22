"""Equirectangular sky-map convention shared by every pipeline step.

Astronomical orientation, as the sky is seen from inside the sphere:
galactic longitude l = 0 at the horizontal centre, increasing to the LEFT;
north galactic pole at the top.

Texture coordinates (u, v) are in [0, 1], with v measured from the BOTTOM:

    u = (0.5 - l / 360) mod 1       l = 180 - 360 u   (wrapped to [0, 360))
    v = 0.5 + b / 180               b = 180 v - 90

so u = 0 and u = 1 both sit at l = 180, and v = 0 is the south galactic pole.
Texel centres are at u = (i + 0.5) / W and v = (k + 0.5) / H, where k counts
rows from the bottom.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]


def lon_from_u(u: FloatArray) -> FloatArray:
    """Galactic longitude in degrees, in [0, 360)."""
    return np.mod(180.0 - 360.0 * u, 360.0)


def lat_from_v(v: FloatArray) -> FloatArray:
    """Galactic latitude in degrees; v is measured from the bottom (south)."""
    return 180.0 * v - 90.0


def u_from_lon(lon_deg: FloatArray) -> FloatArray:
    return np.mod(0.5 - lon_deg / 360.0, 1.0)


def v_from_lat(lat_deg: FloatArray) -> FloatArray:
    return 0.5 + lat_deg / 180.0


def texel_centres(width: int, height: int) -> tuple[FloatArray, FloatArray]:
    """(lon, lat) in degrees of every texel centre, as (height, width) arrays.

    Row 0 is the TOP row (north), matching PNG row order. The KTX2 files store
    rows bottom-up instead (see encode step), so their first row is the south.
    """
    u = (np.arange(width, dtype=np.float64) + 0.5) / width
    v_from_bottom = 1.0 - (np.arange(height, dtype=np.float64) + 0.5) / height
    lon = lon_from_u(u)
    lat = lat_from_v(v_from_bottom)
    return np.broadcast_to(lon, (height, width)), np.broadcast_to(lat[:, None], (height, width))


def sample_bilinear(grid: NDArray[np.float32], lon_deg: FloatArray, lat_deg: FloatArray) -> FloatArray:
    """Samples a top-down equirectangular grid at (lon, lat) using the convention above.

    Longitude wraps; latitude clamps at the poles. Used only to check the grid
    against direct HEALPix lookups, i.e. to test the documented convention.
    """
    height, width = grid.shape
    x = u_from_lon(lon_deg) * width - 0.5
    y = (1.0 - v_from_lat(lat_deg)) * height - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    xa = np.mod(x0, width)
    xb = np.mod(x0 + 1, width)
    ya = np.clip(y0, 0, height - 1)
    yb = np.clip(y0 + 1, 0, height - 1)
    g = grid.astype(np.float64)
    top = g[ya, xa] * (1 - fx) + g[ya, xb] * fx
    bottom = g[yb, xa] * (1 - fx) + g[yb, xb] * fx
    result: FloatArray = top * (1 - fy) + bottom * fy
    return result


def angular_distance_deg(
    lon1: FloatArray, lat1: FloatArray, lon2: float, lat2: float
) -> FloatArray:
    """Great-circle distance in degrees (haversine)."""
    l1, b1, l2, b2 = (np.radians(a) for a in (lon1, lat1, lon2, lat2))
    h = np.sin((b2 - b1) / 2) ** 2 + np.cos(b1) * np.cos(b2) * np.sin((l2 - l1) / 2) ** 2
    result: FloatArray = np.degrees(2 * np.arcsin(np.sqrt(np.clip(h, 0.0, 1.0))))
    return result
