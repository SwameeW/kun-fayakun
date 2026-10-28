"""Evenly spaced streamlines on the sphere, drawn into an equirectangular texture.

The polarisation lines of Chapter 2's globe (polarisation.py). A line-integral convolution
texture (ESA's way, at full-sky print sizes) turns to mush on a globe about 500 pixels across:
its grain is finer than the screen, and the temperature map's own spots are as fine. So the
direction field is drawn as thin, evenly spaced lines instead, as iron filings show a magnet's
field (Jobard & Lefer 1997, "Creating evenly-spaced streamlines of arbitrary density"):

  * A line starts at a seed at least SPACING_DEG from every line drawn so far, grows both ways
    along the field (midpoint steps of STEP_DEG, the headless direction kept continuous), and
    stops on coming within TEST_DEG of another line or of itself, on leaving the region where
    there is polarisation to draw, or at MAX_DEG. Lines shorter than MIN_DEG are dropped.
  * Seeds are tried first beside the lines already drawn (SPACING_DEG to either side, so the
    next line runs alongside), then from a shuffled grid that covers the sky.
  * Each line darkens texels within EDGE_DEG of it (fully within CORE_DEG), in proportion to
    the opacity there (the apodised mask times the strength of the polarisation) and tapering
    over TAPER_DEG at its ends. Where the lines run is measured; where they start, and how far
    apart they are, is not.

Directions and opacities are read from equirectangular grids of the field (bilinear in
longitude and latitude; the field is a 3D tensor, so the poles need no special care).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import healpy as hp
import numpy as np
from numpy.typing import NDArray

import projection

FloatArray = NDArray[np.float64]

SPACING_DEG = 1.5
TEST_DEG = 0.75
STEP_DEG = 0.1
MIN_DEG = 2.0
MAX_DEG = 40.0
TAPER_DEG = 1.0
CORE_DEG = 0.1
EDGE_DEG = 0.3
# Lines run only where the opacity is at least this.
MIN_OPACITY = 0.1
SEED_NSIDE = 128
HASH_NSIDE = 64
MAX_REACH_U = 48
SEED_ORDER = 20150204  # ESA's polarisation image: 4 February 2015


@dataclass(frozen=True)
class FieldGrid:
    """The field on a top-down (north first) equirectangular grid of texel centres."""

    tensor: FloatArray  # (H, W, 6): xx, xy, xz, yy, yz, zz
    opacity: FloatArray  # (H, W)

    @property
    def shape(self) -> tuple[int, int]:
        h, w = self.opacity.shape
        return h, w


def _corners(grid: FieldGrid, x: float, y: float, z: float) -> tuple[int, int, int, int, float, float]:
    h, w = grid.shape
    lon = math.degrees(math.atan2(y, x)) % 360.0
    lat = math.degrees(math.asin(max(-1.0, min(1.0, z))))
    fx = ((0.5 - lon / 360.0) % 1.0) * w - 0.5
    fy = (0.5 - lat / 180.0) * h - 0.5  # rows top-down
    x0 = math.floor(fx)
    y0 = math.floor(fy)
    tx, ty = fx - x0, fy - y0
    xa, xb = x0 % w, (x0 + 1) % w
    ya, yb = min(max(y0, 0), h - 1), min(max(y0 + 1, 0), h - 1)
    return xa, xb, ya, yb, tx, ty


def _bilinear(a: FloatArray, c: tuple[int, int, int, int, float, float]) -> FloatArray:
    xa, xb, ya, yb, tx, ty = c
    top = a[ya, xa] * (1 - tx) + a[ya, xb] * tx
    bottom = a[yb, xa] * (1 - tx) + a[yb, xb] * tx
    result: FloatArray = top * (1 - ty) + bottom * ty
    return result


def direction(grid: FieldGrid, p: tuple[float, float, float]) -> tuple[tuple[float, float, float], float]:
    """Headless polarisation direction (IAU angle from north through east) and opacity at p."""
    x, y, z = p
    c = _corners(grid, x, y, z)
    xx, xy, xz, yy, yz, zz = _bilinear(grid.tensor, c)
    opacity = float(_bilinear(grid.opacity, c))
    # East and north at p.
    r = math.hypot(x, y) or 1e-12
    ex, ey, ez = -y / r, x / r, 0.0
    nx, ny, nz = y * ez - z * ey, z * ex - x * ez, x * ey - y * ex
    pn = (xx * nx + xy * ny + xz * nz, xy * nx + yy * ny + yz * nz, xz * nx + yz * ny + zz * nz)
    q = pn[0] * nx + pn[1] * ny + pn[2] * nz
    u = pn[0] * ex + pn[1] * ey + pn[2] * ez
    psi = 0.5 * math.atan2(u, q)
    c0, s0 = math.cos(psi), math.sin(psi)
    return (c0 * nx + s0 * ex, c0 * ny + s0 * ey, c0 * nz + s0 * ez), opacity


def _step(p: tuple[float, float, float], d: tuple[float, float, float], h: float) -> tuple[float, float, float]:
    x, y, z = p[0] + h * d[0], p[1] + h * d[1], p[2] + h * d[2]
    n = math.sqrt(x * x + y * y + z * z)
    return x / n, y / n, z / n


def _aligned(d: tuple[float, float, float], ref: tuple[float, float, float]) -> tuple[float, float, float]:
    return d if d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2] >= 0 else (-d[0], -d[1], -d[2])


class _Index:
    """Points of the lines drawn so far, bucketed by HEALPix pixel for distance queries."""

    def __init__(self) -> None:
        self.points: list[tuple[float, float, float]] = []
        self.buckets: dict[int, list[int]] = {}

    def add(self, pts: list[tuple[float, float, float]]) -> None:
        start = len(self.points)
        self.points.extend(pts)
        pix = hp.vec2pix(HASH_NSIDE, *np.array(pts).T)
        for k, p in enumerate(pix.tolist()):
            self.buckets.setdefault(p, []).append(start + k)

    def near(self, p: tuple[float, float, float], radius_deg: float) -> bool:
        if not self.points:
            return False
        pix = hp.query_disc(HASH_NSIDE, p, math.radians(radius_deg), inclusive=True)
        limit = math.cos(math.radians(radius_deg))
        for b in pix.tolist():
            for i in self.buckets.get(b, ()):
                q = self.points[i]
                if p[0] * q[0] + p[1] * q[1] + p[2] * q[2] > limit:
                    return True
        return False


class _Own:
    """The line being grown, by position along it, so it can stop before running into itself."""

    def __init__(self) -> None:
        self.buckets: dict[int, list[tuple[tuple[float, float, float], int]]] = {}
        self.skip = int(math.ceil(TEST_DEG / STEP_DEG)) + 2

    def add(self, p: tuple[float, float, float], at: int) -> None:
        self.buckets.setdefault(int(hp.vec2pix(HASH_NSIDE, *p)), []).append((p, at))

    def near(self, p: tuple[float, float, float], at: int) -> bool:
        limit = math.cos(math.radians(TEST_DEG))
        for b in hp.query_disc(HASH_NSIDE, p, math.radians(TEST_DEG), inclusive=True).tolist():
            for q, k in self.buckets.get(b, ()):
                if abs(k - at) > self.skip and p[0] * q[0] + p[1] * q[1] + p[2] * q[2] > limit:
                    return True
        return False


def _grow(grid: FieldGrid, index: _Index, own: _Own, seed: tuple[float, float, float], sign: int) -> tuple[list[tuple[float, float, float]], list[float]]:
    h = math.radians(STEP_DEG)
    d0, _ = direction(grid, seed)
    prev = (sign * d0[0], sign * d0[1], sign * d0[2])
    p = seed
    pts: list[tuple[float, float, float]] = []
    ops: list[float] = []
    for k in range(1, int(MAX_DEG / STEP_DEG / 2) + 1):
        d1, _ = direction(grid, p)
        d1 = _aligned(d1, prev)
        mid = _step(p, d1, h / 2)
        d2, _ = direction(grid, mid)
        d2 = _aligned(d2, d1)
        q = _step(p, d2, h)
        _, opacity = direction(grid, q)
        # Stop where there is too little to draw, beside another line, or (round a point where the
        # field turns) beside itself.
        if opacity < MIN_OPACITY or index.near(q, TEST_DEG) or own.near(q, sign * k):
            break
        own.add(q, sign * k)
        pts.append(q)
        ops.append(opacity)
        prev = d2
        p = q
    return pts, ops


def trace(grid: FieldGrid) -> list[tuple[FloatArray, FloatArray]]:
    """All lines, each as (points (n, 3), opacity (n,)) in order along it."""
    index = _Index()
    rng = np.random.default_rng(SEED_ORDER)
    pool = np.stack(hp.pix2vec(SEED_NSIDE, rng.permutation(hp.nside2npix(SEED_NSIDE))), axis=-1).tolist()
    queue: deque[tuple[float, float, float]] = deque()
    lines: list[tuple[FloatArray, FloatArray]] = []
    spacing = math.radians(SPACING_DEG)
    while queue or pool:
        seed = tuple(queue.popleft()) if queue else tuple(pool.pop())
        s = (float(seed[0]), float(seed[1]), float(seed[2]))
        _, opacity = direction(grid, s)
        if opacity < MIN_OPACITY or index.near(s, SPACING_DEG):
            continue
        own = _Own()
        own.add(s, 0)
        back, back_ops = _grow(grid, index, own, s, -1)
        fore, fore_ops = _grow(grid, index, own, s, 1)
        pts = back[::-1] + [s] + fore
        ops = back_ops[::-1] + [opacity] + fore_ops
        if (len(pts) - 1) * STEP_DEG < MIN_DEG:
            continue
        index.add(pts)
        arr = np.array(pts)
        lines.append((arr, np.array(ops)))
        # Seeds alongside: a spacing to either side of every few points.
        for k in range(0, len(pts), 4):
            p = arr[k]
            d, _ = direction(grid, (float(p[0]), float(p[1]), float(p[2])))
            side = np.cross(p, d)
            for sgn in (1.0, -1.0):
                c = p + sgn * spacing * side
                queue.append(tuple((c / np.linalg.norm(c)).tolist()))
    return lines


def rasterise(lines: list[tuple[FloatArray, FloatArray]], width: int, height: int) -> FloatArray:
    """Line darkness 0..1 at the texel centres of a top-down width x height grid."""
    dark = np.zeros(height * width)
    sub = STEP_DEG / 4
    pts_all: list[FloatArray] = []
    ops_all: list[FloatArray] = []
    for pts, ops in lines:
        # Resample at a quarter step, with the taper toward both ends.
        n = len(pts)
        along = np.arange(n) * STEP_DEG
        fine = np.arange(0.0, along[-1] + 1e-9, sub)
        idx = np.minimum((fine / STEP_DEG).astype(int), n - 2)
        t = (fine - along[idx]) / STEP_DEG
        p = pts[idx] * (1 - t)[:, None] + pts[idx + 1] * t[:, None]
        p /= np.linalg.norm(p, axis=1, keepdims=True)
        o = ops[idx] * (1 - t) + ops[idx + 1] * t
        end = np.minimum(fine, along[-1] - fine)
        taper = np.clip(end / TAPER_DEG, 0.0, 1.0)
        o *= taper * taper * (3 - 2 * taper)
        pts_all.append(p)
        ops_all.append(o)
    p = np.concatenate(pts_all)
    o = np.concatenate(ops_all)
    lon = np.degrees(np.arctan2(p[:, 1], p[:, 0])) % 360.0
    lat = np.degrees(np.arcsin(np.clip(p[:, 2], -1.0, 1.0)))
    fx = projection.u_from_lon(lon) * width - 0.5
    fy = (1.0 - projection.v_from_lat(lat)) * height - 0.5
    reach_v = int(math.ceil(EDGE_DEG / (180.0 / height))) + 1
    cos_edge = math.cos(math.radians(EDGE_DEG))
    tex_lon, tex_lat = projection.texel_centres(width, height)
    cosb = np.cos(np.radians(lat))
    # Within about a degree and a half of the poles a line's width in u is cut short there: unseen.
    reach_u_all = np.minimum(np.ceil(EDGE_DEG / (360.0 / width) / np.maximum(cosb, 1e-3)).astype(int) + 1, MAX_REACH_U)
    for reach_u in np.unique(reach_u_all):
        sel = reach_u_all == reach_u
        cx, cy = np.rint(fx[sel]).astype(int), np.rint(fy[sel]).astype(int)
        ps, os = p[sel], o[sel]
        for dy in range(-reach_v, reach_v + 1):
            row = np.clip(cy + dy, 0, height - 1)
            for dx in range(-int(reach_u), int(reach_u) + 1):
                col = np.mod(cx + dx, width)
                tv = projection_vectors(tex_lon[row, col], tex_lat[row, col])
                cosd = np.sum(tv * ps, axis=1)
                near = cosd > cos_edge
                if not np.any(near):
                    continue
                d = np.degrees(np.arccos(np.clip(cosd[near], -1.0, 1.0)))
                s = np.clip((EDGE_DEG - d) / (EDGE_DEG - CORE_DEG), 0.0, 1.0)
                value = os[near] * s * s * (3 - 2 * s)
                np.maximum.at(dark, row[near] * width + col[near], value)
    return dark.reshape(height, width)


def projection_vectors(lon_deg: FloatArray, lat_deg: FloatArray) -> FloatArray:
    l, b = np.radians(lon_deg), np.radians(lat_deg)
    return np.stack([np.cos(b) * np.cos(l), np.cos(b) * np.sin(l), np.sin(b)], axis=-1)
