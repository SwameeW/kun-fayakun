"""Writes the ground's heights for walking on the Moon, Mars, Mercury and Venus (docs/WALKING.md,
ledger GR-5): public/assets/walk/<world>/base.png (2 pixels a degree, the whole world) and
public/assets/walk/<world>/<col>-<row>.png (8 pixels a degree, eight 90 x 90 degree tiles), and
public/assets/walk/heights.json describing them.

Sources (all NASA mission data, public domain; credited in data/sources.json):
- the Moon: the CGI Moon Kit's LOLA displacement map, ldem_16_uint.tif (16 pixels a degree, unsigned
  16-bit half-metres above a radius of 1,727,400 m, centred on 0 degrees longitude), NASA SVS 4720;
- Mars: MOLA's Mission Experiment Gridded Data Record megt90n000eb.img (16 pixels a degree, signed
  16-bit big-endian metres above the areoid, starting at 0 degrees east), PDS Geosciences Node;
- Mercury: USGS's MESSENGER global DEM, Mercury_Messenger_USGS_DEM_Global_665m_v2.tif (64 pixels a
  degree, signed 16-bit half-metres (GDAL scale 0.5) above a 2,439.4 km sphere, starting at 0 degrees
  east), the same file the globe's relief comes from (sha256 pinned in scripts/planets/config.py);
- Venus: USGS's Magellan global topography, Venus_Magellan_Topography_Global_4641m_v02.tif (8192 x
  4096, 22.76 pixels a degree, signed 16-bit metres of radius above 6,051.0 km, -32768 where
  Magellan measured nothing, starting at 180 degrees west).

Each is averaged down to 8 and 2 pixels a degree (box means of the source's pixels: whole pixels
where the ratio is whole, the exact fractional overlap where it is not, as for Venus), re-centred so
the first column starts at 180 degrees west and the first row at the north pole, and stored
terrarium-encoded (height = R x 256 + G + B / 256 - 32768) in lossless PNG, to half a metre, so a
canvas decodes it exactly. Heights are metres above each world's datum: the Moon's 1,737.4 km sphere,
Mars's areoid, Mercury's 2,439.4 km sphere, and Venus's mean radius of 6,051.8 km (its radii less
800 m). Venus's gaps (its poles beyond 85 degrees, where walks do not go, and the strips Magellan
missed) are filled from around them (pull-push: the gap's coarser averages, finer where they exist,
then relaxed smooth between the measured edges); heights.json counts them.

Usage: python -I scripts/walk/heights.py <download dir> [world ...]   (downloads what is missing;
all four worlds when none is named; the others' entries in heights.json are kept)
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "walk"
SOURCES = {
    "moon": {
        "url": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif",
        "file": "ldem_16_uint.tif",
        "datumKm": 1737.4,
        "sourceId": "nasa-svs-cgi-moon-kit",
    },
    "mars": {
        "url": "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img",
        "file": "megt90n000eb.img",
        "datumKm": 3396.0,
        "sourceId": "pds-mola-megdr",
    },
    "mercury": {
        "url": "https://planetarymaps.usgs.gov/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif",
        "file": "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif",
        "sha256": "defce776241dcaf44cb0f081ee508c17dbea28aa5a22880bf7a5e8c25f96cbea",
        "datumKm": 2439.4,
        "sourceId": "usgs-dem-mercury",
    },
    "venus": {
        "url": "https://planetarymaps.usgs.gov/mosaic/Venus_Magellan_Topography_Global_4641m_v02.tif",
        "file": "Venus_Magellan_Topography_Global_4641m_v02.tif",
        "sha256": "92dd2c8850b128f9dcceb400f1367e3df96229f5309840fee4275b74f192ea11",
        "datumKm": 6051.8,
        "sourceId": "usgs-magellan-venus",
    },
}
DETAIL_PPD = 8
BASE_PPD = 2
TILE_DEG = 90
# Venus's file gives radius - 6,051,000 m; the walk measures from its mean radius, 6,051.8 km.
VENUS_DATUM_SHIFT_M = 800.0
# Smoothing steps over filled gaps (enough to carry the edges' heights some 40 pixels in).
RELAX_STEPS = 400


def fetch(world: str, folder: Path) -> Path:
    src = SOURCES[world]
    path = folder / src["file"]
    if not path.exists():
        urllib.request.urlretrieve(src["url"], path)
    pinned = src.get("sha256")
    if pinned:
        digest = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 24), b""):
                digest.update(chunk)
        if digest.hexdigest() != pinned:
            raise SystemExit(f"{path}: sha256 {digest.hexdigest()} is not the pinned {pinned}")
    return path


def gdal_scale(path: Path) -> float:
    """The GDAL metadata's scale for the first band (1 when none is given)."""
    with tifffile.TiffFile(path) as tif:
        tag = tif.pages[0].tags.get("GDAL_METADATA")
        if tag is None:
            return 1.0
        found = re.search(r'name="SCALE"[^>]*>([^<]+)<', str(tag.value))
        return float(found.group(1)) if found else 1.0


def heights(world: str, folder: Path) -> tuple[np.ndarray, float]:
    """The world's heights (metres above its datum, NaN where unknown) and their pixels a degree, first column at 180 W, first row at the north pole."""
    path = fetch(world, folder)
    if world == "moon":
        raw = tifffile.imread(path).astype(np.float64)
        return raw * 0.5 + 1_727_400.0 - 1_737_400.0, 16.0
    if world == "mars":
        raw = np.fromfile(path, dtype=">i2").reshape(2880, 5760).astype(np.float64)
        # The record starts at 0 degrees east; half the width on, 180 degrees west comes first.
        return np.roll(raw, -2880, axis=1), 16.0
    if world == "mercury":
        raw = tifffile.memmap(path)
        rows, cols = raw.shape
        scale = gdal_scale(path)
        # 64 pixels a degree is 4.2 GB as doubles: average to 16 a degree row band by row band first.
        out = np.empty((rows // 4, cols // 4), dtype=np.float64)
        for r in range(rows // 4):
            band = np.asarray(raw[r * 4 : (r + 1) * 4], dtype=np.float64) * scale
            out[r] = band.reshape(4, cols // 4, 4).mean(axis=(0, 2))
        # The DEM's centre is 180 degrees east, so its first column is 0 degrees east.
        return np.roll(out, -out.shape[1] // 2, axis=1), 16.0
    raw = tifffile.imread(path).astype(np.float64)
    raw[raw == -32768] = np.nan
    return raw - VENUS_DATUM_SHIFT_M, raw.shape[1] / 360.0


def mean_down(h: np.ndarray, factor: int) -> np.ndarray:
    rows, cols = h.shape
    return h.reshape(rows // factor, factor, cols // factor, factor).mean(axis=(1, 3))


def box_resample(h: np.ndarray, ppd_in: float, ppd_out: int) -> tuple[np.ndarray, np.ndarray]:
    """Box means onto a grid of ppd_out pixels a degree, each over the source pixels it overlaps (in part where in part), skipping NaN; and each mean's share of measured area."""
    valid = np.isfinite(h)
    values = np.where(valid, h, 0.0)

    def table(a: np.ndarray) -> np.ndarray:
        s = np.zeros((a.shape[0] + 1, a.shape[1] + 1))
        s[1:, 1:] = a.cumsum(axis=0).cumsum(axis=1)
        return s

    sums = table(values)
    counts = table(valid.astype(np.float64))
    ratio = ppd_in / ppd_out
    xs = np.arange(360 * ppd_out + 1) * ratio
    ys = np.arange(180 * ppd_out + 1) * ratio

    def at(s: np.ndarray, y: np.ndarray, x: np.ndarray) -> np.ndarray:
        # The table is exact at pixel corners and bilinear between them (a piecewise-constant image's integral).
        x0 = np.clip(np.floor(x).astype(int), 0, s.shape[1] - 2)
        y0 = np.clip(np.floor(y).astype(int), 0, s.shape[0] - 2)
        fx = (x - x0)[None, :]
        fy = (y - y0)[:, None]
        a = s[np.ix_(y0, x0)]
        b = s[np.ix_(y0, x0 + 1)]
        c = s[np.ix_(y0 + 1, x0)]
        d = s[np.ix_(y0 + 1, x0 + 1)]
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

    def box(s: np.ndarray) -> np.ndarray:
        corners = at(s, ys, xs)
        return corners[1:, 1:] - corners[:-1, 1:] - corners[1:, :-1] + corners[:-1, :-1]

    total = box(sums)
    measured = box(counts)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(measured > 1e-6, total / measured, np.nan)
    return mean, measured / (ratio * ratio)


def fill(h: np.ndarray) -> np.ndarray:
    """Pull-push: NaN filled from the gap's coarser averages, finer where they exist."""
    if not np.isnan(h).any():
        return h
    levels = [h.copy()]
    while min(levels[-1].shape) > 1:
        a = levels[-1]
        r, c = a.shape
        if r % 2 or c % 2:
            break
        blocks = a.reshape(r // 2, 2, c // 2, 2)
        valid = np.isfinite(blocks)
        n = valid.sum(axis=(1, 3))
        total = np.where(valid, blocks, 0.0).sum(axis=(1, 3))
        levels.append(np.where(n > 0, total / np.maximum(n, 1), np.nan))
    coarsest = levels[-1]
    coarsest[np.isnan(coarsest)] = np.nanmean(coarsest) if np.isfinite(coarsest).any() else 0.0
    for k in range(len(levels) - 2, -1, -1):
        up = np.repeat(np.repeat(levels[k + 1], 2, axis=0), 2, axis=1)
        gap = np.isnan(levels[k])
        levels[k][gap] = up[gap]
    # The pushed blocks relaxed into a smooth surface between the measured edges (Jacobi steps of
    # Laplace's equation over the gaps alone; wrapping in longitude, mirrored at the poles).
    out = levels[0]
    gap = np.isnan(h)
    for _ in range(RELAX_STEPS):
        padded = np.pad(out, ((1, 1), (0, 0)), mode="edge")
        mean = (padded[:-2] + padded[2:] + np.roll(out, 1, axis=1) + np.roll(out, -1, axis=1)) / 4.0
        out[gap] = mean[gap]
    return out


def terrarium(h: np.ndarray) -> np.ndarray:
    v = np.round((h + 32768.0) * 2.0) / 2.0
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.round((v - np.floor(v)) * 256.0)
    return np.dstack([r, g, b]).clip(0, 255).astype(np.uint8)


def write(world: str, folder: Path) -> dict:
    h, ppd = heights(world, folder)
    out = OUT / world
    out.mkdir(parents=True, exist_ok=True)
    filled = 0.0
    if float(ppd).is_integer() and not np.isnan(h).any():
        detail = mean_down(h, int(ppd) // DETAIL_PPD)
    else:
        detail, share = box_resample(h, ppd, DETAIL_PPD)
        filled = float(np.mean(share < 0.5))
        detail = fill(np.where(share < 0.5, np.nan, detail))
    base = mean_down(detail, DETAIL_PPD // BASE_PPD)
    Image.fromarray(terrarium(base)).save(out / "base.png", "PNG", optimize=True)
    side = TILE_DEG * DETAIL_PPD
    cols, rows = 360 // TILE_DEG, 180 // TILE_DEG
    for row in range(rows):
        for col in range(cols):
            tile = detail[row * side : (row + 1) * side, col * side : (col + 1) * side]
            Image.fromarray(terrarium(tile)).save(out / f"{col}-{row}.png", "PNG", optimize=True)
    src = SOURCES[world]
    entry = {
        "datumKm": src["datumKm"],
        "sourceId": src["sourceId"],
        "base": {"path": f"assets/walk/{world}/base.png", "ppd": BASE_PPD},
        "detail": {"path": f"assets/walk/{world}/{{col}}-{{row}}.png", "ppd": DETAIL_PPD, "tileDeg": TILE_DEG, "cols": cols, "rows": rows},
        "minM": float(np.floor(detail.min())),
        "maxM": float(np.ceil(detail.max())),
    }
    if filled > 0:
        entry["filledShare"] = round(filled, 4)
    return entry


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    wanted = sys.argv[2:] or list(SOURCES)
    listing = OUT / "heights.json"
    worlds = json.loads(listing.read_text())["worlds"] if listing.exists() else {}
    for world in wanted:
        worlds[world] = write(world, folder)
    manifest = {
        "encoding": "terrarium RGB: height (m above the datum) = R * 256 + G + B / 256 - 32768, to half a metre",
        "grid": "equirectangular, pixel-is-area: the first column starts at 180 degrees west (east longitude increasing to the right), the first row at the north pole",
        "worlds": {world: worlds[world] for world in SOURCES if world in worlds},
    }
    listing.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
