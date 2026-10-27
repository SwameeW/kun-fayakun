"""Writes the surface maps of the worlds the explorer can fly to (src/explore/worlds/bodies.ts) as
public/assets/smallbodies/maps/<world>.jpg, 2048 x 1024 equirectangular (east longitude 0 at the
middle, increasing to the right; north up), and maps/1k/<world>.jpg, 1024 x 512 (the Low detail
level's), and maps.json: each map's source, credit, sha256 and the share of the surface never imaged.

Sources: the global mosaics of the USGS Astrogeology Science Center (in the public domain, from NASA
missions' images): Dawn's of Ceres and Vesta, Galileo's and Voyager's of Io, Europa, Ganymede and
Callisto, Cassini's and Voyager's of Enceladus, Tethys, Rhea and Iapetus, Voyager 2's of Triton, and
New Horizons' of Pluto and Charon. Each is read with its ISIS label (its longitudes' range and
direction), turned to east longitudes, resampled by area, and scaled so its mean linear brightness is
MEAN: the explorer multiplies the map by the world's geometric albedo over MEAN, so a map gives the
pattern and the albedo the level. Grey maps stay grey.

Missing data (zeros: the parts no spacecraft imaged, as Triton's northern half, Pluto's and Charon's
far south) are not filled with a colour that could pass for a surface: they are a neutral grey a little
under the mean level with a faint grid every GRID_DEG degrees, the data fading into it over FEATHER_PX (no
jagged seam), and the explorer's readout says so (UniverseIllustration 'unimaged').

Usage: .cache/venv-worlds/bin/python -I scripts/smallbodies/maps.py <download dir>
       (Pillow and numpy; downloads what is missing into <download dir>/maps)
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "smallbodies" / "maps"
BUCKET = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"
USER_AGENT = "kun-fayakun/0.1 (educational; github.com/SwameeW/kun-fayakun)"
WIDTH, HEIGHT = 2048, 1024
SMALL = (1024, 512)
MEAN = 0.4
QUALITY = 86
# Unimaged parts: their grey (a share of the mean level: a flat cap at the full mean draws the eye
# as no surface does), the grid's spacing (degrees), its lines' width and depth (working pixels: twice
# the output's; share darker), and how far the data fades into them (working pixels).
GREY = 0.8
GRID_DEG = 15
GRID_LINE_PX = 3
GRID_DEPTH = 0.16
FEATHER_PX = 16
Image.MAX_IMAGE_PIXELS = 2_000_000_000

# World name -> (mosaic, credit).
MAPS = {
    "Ceres": ("Ceres_Dawn_FC_DLR_global_20ppd_Oct2015", "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA; USGS Astrogeology (Dawn FC global mosaic, DLR)"),
    "Vesta": ("Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd", "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA; USGS Astrogeology (Dawn FC HAMO global mosaic)"),
    "Io": ("Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km", "NASA/JPL; USGS Astrogeology (Galileo SSI and Voyager colour mosaic)"),
    "Europa": ("Europa_Voyager_GalileoSSI_global_mosaic_500m", "NASA/JPL; USGS Astrogeology (Voyager and Galileo SSI mosaic)"),
    "Ganymede": ("Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m", "NASA/JPL; USGS Astrogeology (Voyager and Galileo SSI colour mosaic)"),
    "Callisto": ("Callisto_Voyager_GalileoSSI_global_mosaic_1km", "NASA/JPL; USGS Astrogeology (Voyager and Galileo SSI mosaic)"),
    "Enceladus": ("Enceladus_Cassini_mosaic_global_110m", "NASA/JPL-Caltech/Space Science Institute; USGS Astrogeology (Cassini ISS mosaic)"),
    "Tethys": ("Tethys_Cassini_mosaic_global_293m", "NASA/JPL-Caltech/Space Science Institute; USGS Astrogeology (Cassini ISS mosaic)"),
    "Rhea": ("Rhea_Cassini_Voyager_mosaic_global_417m", "NASA/JPL-Caltech/Space Science Institute; USGS Astrogeology (Cassini and Voyager mosaic)"),
    "Iapetus": ("Iapetus_Cassini_Voyager_mosaic_global_783m", "NASA/JPL-Caltech/Space Science Institute; USGS Astrogeology (Cassini and Voyager mosaic)"),
    "Triton": ("Triton_Voyager2_ClrMosaic_GlobalFill_600m", "NASA/JPL; USGS Astrogeology (Voyager 2 colour mosaic, gaps filled)"),
    "Pluto": ("Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit", "NASA/JHUAPL/SwRI; USGS Astrogeology (New Horizons LORRI and MVIC mosaic)"),
    "Charon": ("Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit", "NASA/JHUAPL/SwRI; USGS Astrogeology (New Horizons LORRI and MVIC mosaic)"),
}


def fetch(folder: Path, name: str) -> Path:
    path = folder / name
    if not path.exists():
        request = urllib.request.Request(BUCKET + name, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=1800) as reply, open(path, "wb") as out:
            while chunk := reply.read(1 << 22):
                out.write(chunk)
    return path


def label(path: Path) -> dict[str, str]:
    text = path.read_text(errors="replace")
    keys = ("MinimumLongitude", "MaximumLongitude", "LongitudeDirection", "MinimumLatitude", "MaximumLatitude")
    out = {}
    for key in keys:
        m = re.search(rf"\b{key}\s*=\s*([-\w.]+)", text)
        if not m:
            raise SystemExit(f"{path.name}: no {key}")
        out[key] = m.group(1)
    return out


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def box_blur(x: np.ndarray, r: int) -> np.ndarray:
    """The mean over a (2r + 1) square about each pixel (edges clamped; longitudes wrap)."""
    p = np.pad(x, ((r + 1, r), (0, 0)), mode="edge")
    c = np.cumsum(p, axis=0)
    x = (c[2 * r + 1 :] - c[: -2 * r - 1]) / (2 * r + 1)
    p = np.concatenate([x[:, -(r + 1) :], x, x[:, :r]], axis=1)
    c = np.cumsum(p, axis=1)
    return (c[:, 2 * r + 1 :] - c[:, : -2 * r - 1]) / (2 * r + 1)


def unimaged(shape: tuple[int, int]) -> np.ndarray:
    """The unimaged parts' shade (linear, the mean level): grey with a faint grid of meridians and parallels."""
    rows, cols = shape
    per_deg = cols / 360
    lon = -180 + (np.arange(cols) + 0.5) / per_deg
    lat = 90 - (np.arange(rows) + 0.5) / per_deg
    near = lambda v: np.abs((v + GRID_DEG / 2) % GRID_DEG - GRID_DEG / 2) * per_deg  # noqa: E731
    line = np.maximum(np.clip(GRID_LINE_PX / 2 + 0.5 - near(lon)[None, :], 0, 1), np.clip(GRID_LINE_PX / 2 + 0.5 - near(lat)[:, None], 0, 1))
    return GREY * MEAN * (1 - GRID_DEPTH * line)


def build(folder: Path, world: str, mosaic: str) -> dict[str, object]:
    tif = fetch(folder, f"{mosaic}.tif")
    lbl = label(fetch(folder, f"{mosaic}.lbl"))
    image = Image.open(tif)
    image.draft("RGB" if image.mode not in ("L", "I;16", "I") else image.mode, (WIDTH * 2, HEIGHT * 2))
    if image.mode not in ("L", "RGB"):
        image = image.convert("RGB" if len(image.getbands()) >= 3 else "L")
    # Area-average down to twice the output first (memory), then take its pixels as sRGB-coded brightness.
    small = image.resize((WIDTH * 2, HEIGHT * 2), Image.Resampling.BOX)
    data = np.asarray(small, dtype=np.float64) / 255.0
    if data.ndim == 2:
        data = data[:, :, None]
    valid = data.max(axis=2) > 0.5 / 255
    linear = srgb_to_linear(data)
    # The map's own latitudes span -90..90 (all of these are global); its longitudes to east, from the left edge.
    # East longitude rises to the right in both kinds: a positive-east map's left edge is its minimum
    # longitude; a positive-west map's is its maximum west longitude, the negative of that east.
    lo, hi = float(lbl["MinimumLongitude"]), float(lbl["MaximumLongitude"])
    east = lbl["LongitudeDirection"].lower() == "positiveeast"
    start = lo if east else -hi
    cols = linear.shape[1]
    # Output columns: east longitude -180..180 left to right; each from the source column at that longitude.
    out_lon = -180 + (np.arange(WIDTH * 2) + 0.5) / (WIDTH * 2) * 360
    index = np.floor(((out_lon - start) % 360) / 360 * cols).astype(int) % cols
    linear = linear[:, index, :]
    valid = valid[:, index]
    lum = linear.mean(axis=2)
    mean = float(lum[valid].mean()) if valid.any() else 0.5
    linear *= MEAN / max(mean, 1e-6)
    # The unimaged parts: the data fades (inside its own edge) into the grey grid.
    weight = np.where(valid, box_blur(valid.astype(np.float64), FEATHER_PX), 0.0)[:, :, None]
    linear = weight * linear + (1 - weight) * unimaged(valid.shape)[:, :, None]
    # The share of the surface never imaged (by area: rows weighted by the cosine of their latitude).
    lat = (0.5 - (np.arange(valid.shape[0]) + 0.5) / valid.shape[0]) * np.pi
    area = np.cos(lat)[:, None] * np.ones(valid.shape[1])[None, :]
    share = float((area * ~valid).sum() / area.sum())
    result = Image.fromarray((linear_to_srgb(linear) * 255 + 0.5).astype(np.uint8).squeeze(), mode="L" if linear.shape[2] == 1 else "RGB")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "1k").mkdir(exist_ok=True)
    out = OUT / f"{world.lower()}.jpg"
    small = OUT / "1k" / f"{world.lower()}.jpg"
    result.resize((WIDTH, HEIGHT), Image.Resampling.BOX).save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    result.resize(SMALL, Image.Resampling.BOX).save(small, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return {
        "file": f"maps/{out.name}",
        "small": f"maps/1k/{small.name}",
        "colour": linear.shape[2] == 3,
        "mean": MEAN,
        "unimaged": round(share, 3),
        "source": BUCKET + f"{mosaic}.tif",
        "sourceSha256": hashlib.sha256(tif.read_bytes()).hexdigest(),
        "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        "smallSha256": hashlib.sha256(small.read_bytes()).hexdigest(),
    }


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    folder = Path(sys.argv[1]).resolve() / "maps"
    folder.mkdir(parents=True, exist_ok=True)
    maps = {}
    for world, (mosaic, credit) in MAPS.items():
        entry = build(folder, world, mosaic)
        entry["credit"] = credit
        maps[world] = entry
        print(f"{world}: {entry['file']}")
    doc = {
        "$comment": "Generated by scripts/smallbodies/maps.py. Surface maps of the worlds to fly to: 2048 x 1024 (`small`: 1024 x 512, the Low detail level's), east longitude 0 at the middle, north up; mean linear brightness `mean` (the explorer scales them by the world's albedo); `unimaged`: the share of the surface never imaged, drawn as a grey grid.",
        "license": "Public domain (USGS Astrogeology mosaics of NASA mission images)",
        "maps": maps,
    }
    (OUT.parent / "maps.json").write_text(json.dumps(doc, indent=1) + "\n")


if __name__ == "__main__":
    main()
