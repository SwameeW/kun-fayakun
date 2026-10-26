"""Writes the ground's heights for walking on the Moon and Mars (docs/WALKING.md, ledger GR-5):
public/assets/walk/<world>/base.png (2 pixels a degree, the whole world) and
public/assets/walk/<world>/<col>-<row>.png (8 pixels a degree, eight 90 x 90 degree tiles), and
public/assets/walk/heights.json describing them.

Sources (both NASA, public domain; credited in data/sources.json):
- the Moon: the CGI Moon Kit's LOLA displacement map, ldem_16_uint.tif (16 pixels a degree, unsigned
  16-bit half-metres above a radius of 1,727,400 m, centred on 0 degrees longitude), NASA SVS 4720;
- Mars: MOLA's Mission Experiment Gridded Data Record megt90n000eb.img (16 pixels a degree, signed
  16-bit big-endian metres above the areoid, starting at 0 degrees east), PDS Geosciences Node.

Each is averaged down to 8 and 2 pixels a degree (box means of whole pixels), re-centred so the first
column starts at 180 degrees west and the first row at the north pole, heights in metres above the
datum (the Moon's 1,737.4 km sphere, Mars's areoid), and stored terrarium-encoded (height =
R x 256 + G + B / 256 - 32768) in lossless PNG, to half a metre, so a canvas decodes it exactly.

Usage: python -I scripts/walk/heights.py <download dir>   (downloads what is missing)
"""

from __future__ import annotations

import json
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
}
DETAIL_PPD = 8
BASE_PPD = 2
TILE_DEG = 90


def heights(world: str, folder: Path) -> np.ndarray:
    """The world's heights at 16 pixels a degree (metres above its datum), first column at 180 W, first row at the north pole."""
    src = SOURCES[world]
    path = folder / src["file"]
    if not path.exists():
        urllib.request.urlretrieve(src["url"], path)
    if world == "moon":
        raw = tifffile.imread(path).astype(np.float64)
        return raw * 0.5 + 1_727_400.0 - 1_737_400.0
    raw = np.fromfile(path, dtype=">i2").reshape(2880, 5760).astype(np.float64)
    # The record starts at 0 degrees east; half the width on, 180 degrees west comes first.
    return np.roll(raw, -2880, axis=1)


def mean_down(h: np.ndarray, factor: int) -> np.ndarray:
    rows, cols = h.shape
    return h.reshape(rows // factor, factor, cols // factor, factor).mean(axis=(1, 3))


def terrarium(h: np.ndarray) -> np.ndarray:
    v = np.round((h + 32768.0) * 2.0) / 2.0
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.round((v - np.floor(v)) * 256.0)
    return np.dstack([r, g, b]).clip(0, 255).astype(np.uint8)


def write(world: str, folder: Path) -> dict:
    h16 = heights(world, folder)
    out = OUT / world
    out.mkdir(parents=True, exist_ok=True)
    detail = mean_down(h16, 16 // DETAIL_PPD)
    base = mean_down(h16, 16 // BASE_PPD)
    Image.fromarray(terrarium(base)).save(out / "base.png", "PNG", optimize=True)
    side = TILE_DEG * DETAIL_PPD
    cols, rows = 360 // TILE_DEG, 180 // TILE_DEG
    for row in range(rows):
        for col in range(cols):
            tile = detail[row * side : (row + 1) * side, col * side : (col + 1) * side]
            Image.fromarray(terrarium(tile)).save(out / f"{col}-{row}.png", "PNG", optimize=True)
    src = SOURCES[world]
    return {
        "datumKm": src["datumKm"],
        "sourceId": src["sourceId"],
        "base": {"path": f"assets/walk/{world}/base.png", "ppd": BASE_PPD},
        "detail": {"path": f"assets/walk/{world}/{{col}}-{{row}}.png", "ppd": DETAIL_PPD, "tileDeg": TILE_DEG, "cols": cols, "rows": rows},
        "minM": float(np.floor(detail.min())),
        "maxM": float(np.ceil(detail.max())),
    }


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    manifest = {
        "encoding": "terrarium RGB: height (m above the datum) = R * 256 + G + B / 256 - 32768, to half a metre",
        "grid": "equirectangular, pixel-is-area: the first column starts at 180 degrees west (east longitude increasing to the right), the first row at the north pole",
        "worlds": {world: write(world, folder) for world in SOURCES},
    }
    (OUT / "heights.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
