"""Verification previews: annotated maps, Mollweide views and KTX2 decode checks.

Everything here writes to .cache/cmb-work/preview and is for people to look at;
nothing in public/ depends on it except the numbers copied into cmb.json.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageDraw

import colormap
import config
import projection

Rgb8 = NDArray[np.uint8]

# Optional reference: the Planck 2018 results I SMICA figure (arXiv:1807.06205 source).
PAPER_FIGURE = config.CACHE / "planck-2018-I" / "src" / "moll_temp_v2.jpg"


def _load_rgb(path: Path) -> Rgb8:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def _resize(rgb: Rgb8, width: int) -> Rgb8:
    height = round(rgb.shape[0] * width / rgb.shape[1])
    return np.asarray(Image.fromarray(rgb).resize((width, height), Image.Resampling.BOX))


def _small_circle(lon0: float, lat0: float, radius_deg: float, points: int = 180) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Points at a fixed angular distance from (lon0, lat0)."""
    lat1, lon1, r = np.radians(lat0), np.radians(lon0), np.radians(radius_deg)
    bearing = np.linspace(0.0, 2 * np.pi, points)
    lat = np.arcsin(np.sin(lat1) * np.cos(r) + np.cos(lat1) * np.sin(r) * np.cos(bearing))
    lon = lon1 + np.arctan2(np.sin(bearing) * np.sin(r) * np.cos(lat1), np.cos(r) - np.sin(lat1) * np.sin(lat))
    return np.degrees(lon) % 360.0, np.degrees(lat)


def _to_pixel(lon: NDArray[np.float64], lat: NDArray[np.float64], width: int, height: int) -> NDArray[np.float64]:
    x = projection.u_from_lon(lon) * width
    y = (1.0 - projection.v_from_lat(lat)) * height
    return np.stack([x, y], axis=-1)


def annotate_equirect(rgb_north_up: Rgb8, out: Path, title: str) -> None:
    """Downscaled equirectangular map with a 30-degree graticule and the Cold Spot circled."""
    image = Image.fromarray(_resize(rgb_north_up, 2048))
    width, height = image.size
    draw = ImageDraw.Draw(image)
    grey = (90, 90, 90)
    for lon in range(0, 360, 30):
        x = float(projection.u_from_lon(np.array([float(lon)]))[0]) * width
        draw.line([(x, 0), (x, height)], fill=grey, width=1)
        draw.text((x + 3, height / 2 + 3), f"l={lon}", fill=(0, 0, 0))
    for lat in range(-60, 90, 30):
        y = (1.0 - float(projection.v_from_lat(np.array([float(lat)]))[0])) * height
        draw.line([(0, y), (width, y)], fill=grey, width=1)
        draw.text((3, y + 3), f"b={lat}", fill=(0, 0, 0))
    lon0, lat0 = config.COLD_SPOT_LON_LAT
    circle = _to_pixel(*_small_circle(lon0, lat0, 10.0), width, height)
    # Split the outline where it wraps across the u = 0/1 seam.
    segments = np.split(circle, np.nonzero(np.abs(np.diff(circle[:, 0])) > width / 2)[0] + 1)
    for segment in segments:
        if len(segment) > 1:
            draw.line([tuple(p) for p in segment], fill=(0, 0, 0), width=3)
    label_at = _to_pixel(np.array([lon0]), np.array([lat0 - 12.0]), width, height)[0]
    draw.text((label_at[0] - 120, label_at[1]), "Cold Spot (l=209, b=-57), 10 deg circle", fill=(0, 0, 0))
    draw.text((8, 8), title, fill=(0, 0, 0))
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)


def _mollweide_lonlat(width: int, height: int) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.bool_]]:
    """(l, b) for each pixel of a Mollweide image with l increasing to the left."""
    s2 = np.sqrt(2.0)
    x = ((np.arange(width) + 0.5) / width * 4 * s2 - 2 * s2)[None, :]
    y = (s2 - (np.arange(height) + 0.5) / height * 2 * s2)[:, None]
    inside = (x**2 / 8 + y**2 / 2) <= 1.0
    theta = np.arcsin(np.clip(y / s2, -1.0, 1.0))
    lat = np.degrees(np.arcsin(np.clip((2 * theta + np.sin(2 * theta)) / np.pi, -1.0, 1.0)))
    cos_theta = np.where(np.abs(np.cos(theta)) < 1e-9, 1e-9, np.cos(theta))
    east = np.degrees(np.pi * x / (2 * s2 * cos_theta))
    lon = np.mod(-east, 360.0)
    return np.broadcast_to(lon, (height, width)), np.broadcast_to(lat, (height, width)), inside


def mollweide(rgb_north_up: Rgb8, width: int) -> Rgb8:
    """Nearest-texel Mollweide reprojection of a north-up equirectangular image."""
    height = width // 2
    source = _resize(rgb_north_up, width * 2)
    sh, sw, _ = source.shape
    lon, lat, inside = _mollweide_lonlat(width, height)
    col = np.clip((projection.u_from_lon(lon) * sw).astype(np.int64), 0, sw - 1)
    row = np.clip(((1.0 - projection.v_from_lat(lat)) * sh).astype(np.int64), 0, sh - 1)
    out = np.full((height, width, 3), 255, dtype=np.uint8)
    out[inside] = source[row[inside], col[inside]]
    return out


def compare_with_paper(grid: NDArray[np.float32]) -> dict[str, Any] | None:
    """Correlates our grid with the temperatures read back from the Planck 2018 figure.

    The figure's colours are inverted through the same colour table. Controls use
    a mirrored longitude and a flipped latitude, which should not correlate.
    """
    if not PAPER_FIGURE.exists():
        return None
    with Image.open(PAPER_FIGURE) as image:
        paper = np.asarray(image.convert("RGB").rotate(90, expand=True)).astype(np.float64)
    dark = paper.max(axis=2) < 80
    dark[int(paper.shape[0] * 0.9) :] = False  # ignore the colour-bar labels
    rows, cols = np.nonzero(dark)
    cy, cx = (rows.min() + rows.max()) / 2, (cols.min() + cols.max()) / 2
    ry, rx = (rows.max() - rows.min()) / 2 - 3, (cols.max() - cols.min()) / 2 - 3

    table = colormap.load_table()
    low, high = config.RANGE_MICROKELVIN
    yy, xx = np.mgrid[0 : paper.shape[0], 0 : paper.shape[1]]
    s2 = np.sqrt(2.0)
    mx = (xx - cx) / rx * 2 * s2
    my = -(yy - cy) / ry * s2
    inside = (mx**2 / 8 + my**2 / 2) <= 0.97
    pixels = paper[inside]
    distance = np.linalg.norm(pixels[:, None, :] - table[None, ::4, :], axis=2)
    nearest = distance.argmin(axis=1) * 4
    on_scale = distance.min(axis=1) < 30  # drops the grey mask outline and JPEG fringes
    paper_t = low + (high - low) * nearest / 255.0

    theta = np.arcsin(np.clip(my[inside] / s2, -1, 1))
    lat = np.degrees(np.arcsin(np.clip((2 * theta + np.sin(2 * theta)) / np.pi, -1, 1)))
    lon = np.mod(-np.degrees(np.pi * mx[inside] / (2 * s2 * np.cos(theta))), 360.0)

    # Match the figure's resolution (~0.5 deg per pixel) before correlating.
    coarse = grid.reshape(256, 8, 512, 8).mean(axis=(1, 3))

    def corr(sample_lon: NDArray[np.float64], sample_lat: NDArray[np.float64]) -> float:
        ours = np.clip(projection.sample_bilinear(coarse, sample_lon, sample_lat), low, high)
        return round(float(np.corrcoef(ours[on_scale], paper_t[on_scale])[0, 1]), 3)

    return {
        "figure": "Planck 2018 results I, SMICA temperature map (arXiv:1807.06205 moll_temp_v2.jpg)",
        "pixelsCompared": int(on_scale.sum()),
        "pearsonR": corr(lon, lat),
        "controlMirroredLonR": corr(np.mod(-lon, 360.0), lat),
        "controlFlippedLatR": corr(lon, -lat),
    }


def _crop_comparison(lossless: Rgb8, decoded: Rgb8, out: Path) -> None:
    """Side-by-side, 2x-magnified crop around the Cold Spot: lossless left, decoded right."""
    height, width, _ = lossless.shape
    lon0, lat0 = config.COLD_SPOT_LON_LAT
    centre = _to_pixel(np.array([lon0]), np.array([lat0]), width, height)[0]
    half_w, half_h = width // 20, height // 16
    x0 = int(np.clip(centre[0] - half_w, 0, width - 2 * half_w))
    y0 = int(np.clip(centre[1] - half_h, 0, height - 2 * half_h))
    region = (slice(y0, y0 + 2 * half_h), slice(x0, x0 + 2 * half_w))
    gap = np.full((2 * half_h, 6, 3), 255, dtype=np.uint8)
    row = np.concatenate([lossless[region], gap, decoded[region]], axis=1)
    Image.fromarray(row).resize((row.shape[1] * 2, row.shape[0] * 2), Image.Resampling.NEAREST).save(out)


def _psnr(a: Rgb8, b: Rgb8) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else float(10 * np.log10(255.0**2 / mse))


def decoded_checks() -> dict[str, Any]:
    """Compares each KTX2 file's transcoded base level with the lossless level it encodes."""
    results: dict[str, Any] = {}
    for key, first_level in (("4096", 0), ("2048", 1)):
        decoded_path = config.DECODED_DIR / f"cmb-{key}-level0.png"
        if not decoded_path.exists():
            results[key] = "not decoded"
            continue
        decoded = _load_rgb(decoded_path)
        bottom_up = _load_rgb(config.LEVELS_DIR / f"level-{first_level:02d}.png")
        as_stored = _psnr(decoded, bottom_up)
        flipped = _psnr(decoded, bottom_up[::-1])
        # The extractor may or may not apply KTXorientation; we record which matched.
        rows_bottom_up = bool(as_stored >= flipped)
        north_up = decoded[::-1] if rows_bottom_up else decoded
        results[key] = {
            "psnrDbVsLossless": round(max(as_stored, flipped), 2),
            "extractRowsBottomUp": rows_bottom_up,
        }
        _crop_comparison(
            np.ascontiguousarray(bottom_up[::-1]),
            np.ascontiguousarray(north_up),
            config.PREVIEW_DIR / f"crop-{key}-lossless-vs-decoded.png",
        )
        annotate_equirect(
            np.ascontiguousarray(north_up),
            config.PREVIEW_DIR / f"decoded-{key}-annotated.png",
            f"Decoded from cmb-{key}.ktx2 ({config.KTX_CODEC} transcoded to RGBA8 by ktx extract)",
        )
    return results


def build_previews() -> dict[str, Any]:
    config.PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    lossless = _load_rgb(config.LOSSLESS_PNG)
    annotate_equirect(lossless, config.PREVIEW_DIR / "equirect-annotated.png", "Lossless PNG, north up, l increasing to the left")
    Image.fromarray(mollweide(lossless, 1600)).save(config.PREVIEW_DIR / "mollweide.png")

    grid = np.load(config.GRID_PATH)
    report: dict[str, Any] = {
        "paperComparison": compare_with_paper(grid),
        "decoded": decoded_checks(),
    }
    (config.PREVIEW_DIR / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report
