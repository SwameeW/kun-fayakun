"""Builds the mip chain of every planet texture from the pinned sources.

Each map is decoded, checked against landmarks (landmarks.py; a failure stops the build),
cleaned where the source has gaps, resampled once to its widest level and reduced level by
level down to 1 x 1 (resample.py: wrap in longitude, clamp at the poles, linear light for
colour). Every level is written as a lossless PNG with its rows bottom-up (first row = south
pole), the order the KTX2 files store and three samples: three never flips KTX2 textures, so
v = 0 is the first stored row (src/core/loader.ts). encode.py turns the levels into KTX2.

Output: .cache/planets/work/<body>/<map>/level-<width>.png and
.cache/planets/reports/build-<body>.json (landmark values, fills, measured facts).

Usage: python scripts/planets/build.py [earth|moon|jupiter|saturn|rings ...]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
from numpy.typing import NDArray
from PIL import Image, ImageDraw

import config
import landmarks
import resample as rs

Image.MAX_IMAGE_PIXELS = config.MAX_IMAGE_PIXELS
Float = NDArray[np.float32]
Codes = NDArray[np.uint8]


# --- Output ---------------------------------------------------------------------------------


def level_path(body: str, name: str, width: int) -> Path:
    return config.WORK / body / name / f"level-{width:05d}.png"


def write_levels(body: str, name: str, levels: list[Codes]) -> list[int]:
    """Writes north-up 8-bit levels as bottom-up PNGs; returns their widths."""
    folder = config.WORK / body / name
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("level-*.png"):
        old.unlink()
    widths = []
    for level in levels:
        mode = {1: "L", 3: "RGB", 4: "RGBA"}[1 if level.ndim == 2 else level.shape[2]]
        image = Image.fromarray(np.ascontiguousarray(np.flipud(level)), mode=mode)
        image.save(level_path(body, name, level.shape[1]), format="PNG", compress_level=1)
        widths.append(level.shape[1])
    print(f"  {body}/{name}: {len(levels)} levels, {levels[0].shape[1]} x {levels[0].shape[0]} down to {levels[-1].shape[1]} x {levels[-1].shape[0]}")
    return widths


def write_report(body: str, report: dict[str, Any]) -> None:
    config.REPORTS.mkdir(parents=True, exist_ok=True)
    path = config.REPORTS / f"build-{body}.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=float) + "\n", encoding="utf-8")


# --- Decoding -------------------------------------------------------------------------------


def read_image(key: str) -> NDArray[Any]:
    source = config.FILES[key]
    if source.path.suffix.lower() in (".tif", ".tiff"):
        array = tifffile.imread(source.path)
        # OPAL's Saturn TIFF is stored plane by plane (3 x H x W).
        if array.ndim == 3 and array.shape[0] in (3, 4) and array.shape[2] not in (3, 4):
            array = np.moveaxis(array, 0, -1)
        return array
    return np.asarray(Image.open(source.path))


def linear_columns(codes: Codes, width: int, srgb: bool) -> Float:
    """8-bit codes to linear values, resampled along longitude band by band (keeps memory low)."""
    out = np.empty((codes.shape[0], width, *codes.shape[2:]), dtype=np.float32)
    for r0 in range(0, codes.shape[0], 1024):
        band = codes[r0 : r0 + 1024]
        values = rs.srgb_to_linear(band) if srgb else band.astype(np.float32) / 255.0
        out[r0 : r0 + 1024] = rs.resample_columns(values, width) if values.shape[1] != width else values
    return out


def colour_levels(linear_top: Float, box: bool = False) -> list[Codes]:
    return [rs.linear_to_srgb(level) for level in rs.chain(linear_top, box)]


def grey_levels(top: Float, box: bool = False) -> list[Codes]:
    return [rs.to_unorm8(level) for level in rs.chain(top, box)]


def top_size(width_cap: int) -> tuple[int, int]:
    return width_cap, width_cap // 2


# --- Gaps in the giant-planet maps ------------------------------------------------------------


def invalid_rows(codes: Codes) -> NDArray[np.bool_]:
    """Rows the observation does not cover: black (no data) rows, and the dimming rows next to them.

    OPAL leaves the poles (and on Saturn the band the rings hide) black, and the rows beside a gap
    fade toward it. A row is dropped if more than 0.5% of it is black, then neighbours of dropped
    rows are dropped while they are darker than 95% of the next row further from the gap.
    """
    y = landmarks.luma(codes)
    lum = y.mean(axis=1)
    bad = (y < 2.0).mean(axis=1) > 0.005
    changed = True
    while changed:
        changed = False
        for r in range(1, len(lum) - 1):
            if bad[r]:
                continue
            for step in (-1, 1):
                gap, far = r - step, r + step
                if 0 <= gap < len(lum) and 0 <= far < len(lum) and bad[gap] and not bad[far] and lum[r] < 0.95 * lum[far]:
                    bad[r] = True
                    changed = True
                    break
    return bad


def running_median(values: NDArray[np.float32], radius: int = 30) -> NDArray[np.float32]:
    """Median along each row over +/- radius pixels, wrapping in longitude."""
    from numpy.lib.stride_tricks import sliding_window_view

    padded = np.concatenate([values[:, -radius:], values, values[:, :radius]], axis=1)
    return np.median(sliding_window_view(padded, 2 * radius + 1, axis=1), axis=-1).astype(np.float32)


def rough_polar_rows(codes: Codes, within_deg: float = 15.0, threshold: float = 15.0, fraction: float = 0.003) -> NDArray[np.bool_]:
    """Rows near a pole whose mosaic tiles meet in coloured, saw-toothed fringes (OPAL Saturn).

    Saturn's bands are smooth along longitude, so a row near the pole where more than 0.3% of the
    pixels stand out from the running median is a limb-fringe row; it and every row poleward of it
    count as unobserved.
    """
    h = codes.shape[0]
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    y = landmarks.luma(codes).astype(np.float32)
    rough = np.zeros(h, dtype=bool)
    polar = np.nonzero(np.abs(lat) >= 90.0 - within_deg)[0]
    rough[polar] = (np.abs(y[polar] - running_median(y[polar])) > threshold).mean(axis=1) > fraction
    out = np.zeros(h, dtype=bool)
    north = np.nonzero(rough & (lat > 0))[0]
    south = np.nonzero(rough & (lat < 0))[0]
    if north.size:
        out[: north.max() + 1] = True
    if south.size:
        out[south.min() :] = True
    return out


def repair_transits(codes: Codes, rows: NDArray[np.bool_], threshold: float = 9.0) -> tuple[Codes, int]:
    """Removes moons and moon shadows that crossed Saturn while OPAL mapped it.

    Saturn's clouds at this resolution vary along latitude, hardly along longitude, so a moon
    (a bright dot) or its shadow (a dark one) stands out from the running median along its row.
    Pixels more than 9 codes of luma away from it (twice the 99.9th percentile of the map's own
    deviations), and two pixels around them, take that median's colour. Only `rows` are looked at.
    """
    y = landmarks.luma(codes).astype(np.float32)
    candidates = np.nonzero(rows)[0]
    bad = np.zeros(y.shape, dtype=bool)
    bad[candidates] = np.abs(y[candidates] - running_median(y[candidates])) > threshold
    grown = bad.copy()
    for step in (1, 2):
        for dy, dx in ((-step, 0), (step, 0), (0, -step), (0, step)):
            grown |= np.roll(np.roll(bad, dy, axis=0), dx, axis=1)
    grown &= rows[:, None]
    out = codes.copy()
    touched = np.nonzero(grown.any(axis=1))[0]
    for c in range(codes.shape[2]):
        base = running_median(codes[touched, :, c].astype(np.float32))
        channel = out[touched, :, c]
        channel[grown[touched]] = np.rint(base[grown[touched]]).astype(np.uint8)
        out[touched, :, c] = channel
    return out, int(grown.sum())


def fill_rows(linear: Float, bad: NDArray[np.bool_], blend_deg: float = 1.0) -> tuple[Float, list[dict[str, Any]]]:
    """Fills unobserved rows in linear light.

    A gap between observed rows is interpolated column by column between the three rows on either
    side, each smoothed along longitude over 31 pixels, so no single noisy edge row is smeared
    across the gap. A polar cap (a gap touching the first or last row) takes the mean colour of the
    last 2 degrees observed, and the last degree observed eases into it, so the unobserved cap is a
    quiet even tone rather than a seam.
    """

    def smooth_along(row: Float, width: int = 31) -> Float:
        half = width // 2
        padded = np.concatenate([row[-half:], row, row[:half]], axis=0)
        kernel = np.ones(width, dtype=np.float32) / width
        return np.stack([np.convolve(padded[:, c], kernel, mode="valid") for c in range(row.shape[1])], axis=-1)

    out = linear.copy()
    h = linear.shape[0]
    per_degree = h / 180.0
    fills = []
    runs: list[tuple[int, int]] = []
    r = 0
    while r < h:
        if bad[r]:
            start = r
            while r < h and bad[r]:
                r += 1
            runs.append((start, r))
        else:
            r += 1
    lat = lambda row: round(90.0 - (row + 0.5) * 180.0 / h, 2)  # noqa: E731
    for start, end in runs:
        if start == 0 or end == h:
            north = start == 0
            edge = end if north else start - 1  # first observed row next to the cap
            span = max(1, round(2.0 * per_degree))
            rows = slice(edge, edge + span) if north else slice(edge - span + 1, edge + 1)
            cap = linear[rows].reshape(-1, linear.shape[-1]).mean(axis=0)
            out[start:end] = cap
            ease = max(1, round(blend_deg * per_degree))
            for i in range(ease):
                row = edge + i if north else edge - i
                t = (i + 0.5) / ease  # 0 at the cap, 1 at full data
                out[row] = cap * (1.0 - t) + linear[row] * t
            fills.append({"rows": [start, end], "latitudes": [lat(start), lat(end - 1)], "fill": "polar cap: mean of the last 2 degrees observed"})
        else:
            above = smooth_along(linear[max(0, start - 3) : start].mean(axis=0))
            below = smooth_along(linear[end : end + 3].mean(axis=0))
            for i, row in enumerate(range(start, end)):
                t = (i + 1) / (end - start + 1)
                out[row] = above * (1.0 - t) + below * t
            fills.append({"rows": [start, end], "latitudes": [lat(start), lat(end - 1)], "fill": "interpolated between the observed rows either side"})
    return out, fills


# --- Normals ----------------------------------------------------------------------------------


def normals(height_m: Float, radius_km: float, exaggeration: float, water: Float | None = None) -> Codes:
    """Tangent-space normals (x east, y north, z out) from heights on an equirectangular grid.

    Slopes are true slopes on the sphere (metres per metre) times the exaggeration; east
    differences wrap, north differences are one-sided at the poles. cos(latitude) is held at
    0.02 or more so the converging meridians next to a pole cannot blow small height steps up.
    Water (0..1) pulls the normal to flat: the sea and lakes have no relief.
    """
    h, w = height_m.shape
    radius = radius_km * 1000.0
    lat = np.radians(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    coslat = np.maximum(np.cos(lat), 0.02).astype(np.float32)[:, None]
    dlon = 2.0 * np.pi / w
    dlat = np.pi / h
    east = (np.roll(height_m, -1, axis=1) - np.roll(height_m, 1, axis=1)) / (2.0 * radius * dlon * coslat)
    north = np.empty_like(height_m)
    if h > 2:
        north[1:-1] = (height_m[:-2] - height_m[2:]) / (2.0 * radius * dlat)
    north[0] = (height_m[0] - height_m[1]) / (radius * dlat) if h > 1 else 0.0
    north[-1] = (height_m[-2] - height_m[-1]) / (radius * dlat) if h > 1 else 0.0
    n = np.stack([-exaggeration * east, -exaggeration * north, np.ones_like(height_m)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    if water is not None:
        wet = np.clip(water, 0.0, 1.0)[..., None]
        n = n * (1.0 - wet) + np.array([0.0, 0.0, 1.0], dtype=np.float32) * wet
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return rs.to_unorm8(n * 0.5 + 0.5)


def normal_levels(height_top: Float, body: str, water_levels: list[Float] | None = None) -> list[Codes]:
    heights = rs.chain(height_top)
    out = []
    for i, level in enumerate(heights):
        water = water_levels[i] if water_levels is not None else None
        out.append(normals(level, config.MEAN_RADIUS_KM[body], config.RELIEF_EXAGGERATION[body], water))
    return out


# --- Earth --------------------------------------------------------------------------------------


def rasterise_water(width: int, height: int, supersample: int = 4) -> Float:
    """Water fraction from Natural Earth land and lake polygons, drawn at 4 x 4 supersampling."""
    big_w, big_h = width * supersample, height * supersample
    land = Image.new("L", (big_w, big_h), 0)
    draw = ImageDraw.Draw(land)

    def ring_xy(ring: list[list[float]]) -> list[tuple[float, float]]:
        coords = np.asarray(ring, dtype=np.float64)[:, :2]
        if coords[:, 0].min() < -180.0 - 1e-9 or coords[:, 0].max() > 180.0 + 1e-9:
            raise SystemExit("Natural Earth ring crosses the antimeridian; split it before rasterising")
        # Pillow treats integer coordinates as pixel centres; the map's edges are pixel edges.
        x = (coords[:, 0] + 180.0) / 360.0 * big_w - 0.5
        y = (90.0 - coords[:, 1]) / 180.0 * big_h - 0.5
        return list(zip(x.tolist(), y.tolist()))

    def polygons(path: Path) -> list[list[list[list[float]]]]:
        data = json.loads(path.read_text(encoding="utf-8"))
        out = []
        for feature in data["features"]:
            geometry = feature["geometry"]
            if geometry["type"] == "Polygon":
                out.append(geometry["coordinates"])
            elif geometry["type"] == "MultiPolygon":
                out.extend(geometry["coordinates"])
        return out

    for polygon in polygons(config.FILES["neLand"].path):
        draw.polygon(ring_xy(polygon[0]), fill=255)
        for hole in polygon[1:]:
            draw.polygon(ring_xy(hole), fill=0)
    for polygon in polygons(config.FILES["neLakes"].path):
        draw.polygon(ring_xy(polygon[0]), fill=0)
        for island in polygon[1:]:
            draw.polygon(ring_xy(island), fill=255)
    blocks = np.asarray(land).reshape(height, supersample, width, supersample)
    land_frac = blocks.mean(axis=(1, 3), dtype=np.float32) / 255.0
    return (1.0 - land_frac).astype(np.float32)


def night_floor(codes: Codes) -> float:
    """The faint floor over unlit land: the 99th percentile in four large regions without towns."""
    regions = [
        landmarks.Place("central Sahara", 22.0, 12.0, 3.0),
        landmarks.Place("western Amazon", -5.0, -68.0, 3.0),
        landmarks.Place("Yakutia", 64.0, 125.0, 3.0),
        landmarks.Place("Australian interior", -25.0, 128.0, 3.0),
    ]
    values = np.concatenate([landmarks.patch(codes, p, "earth").ravel() for p in regions])
    return float(np.percentile(values, 99.0))


def build_earth() -> dict[str, Any]:
    width, height = top_size(config.TOP_WIDTH)
    report: dict[str, Any] = {"body": "earth", "maps": {}}

    print("earth/day: Blue Marble Next Generation, July 2004")
    day = read_image("bmng")
    report["maps"]["day"] = {"source": list(day.shape), "landmarks": landmarks.earth_day(day, "BMNG source")}
    top = rs.resample_rows(linear_columns(day, width, srgb=True), height)
    del day
    write_levels("earth", "day", colour_levels(top))
    del top

    print("earth/night: Black Marble 2016")
    night = read_image("blackMarble")
    lm = landmarks.earth_night(night, "Black Marble source")
    floor = night_floor(night)
    lifted = rs.srgb_to_linear(night)
    floor_linear = float(rs.srgb_to_linear(np.array([round(floor)], dtype=np.uint8))[0])
    lifted = np.clip((lifted - floor_linear) / (1.0 - floor_linear), 0.0, 1.0)
    del night
    top = rs.resample(lifted, width, height)
    del lifted
    levels = [rs.linear_to_srgb(level) for level in rs.chain(top)]
    report["maps"]["night"] = {"landmarks": lm, "landFloorCode": floor, "note": "floor subtracted in linear light, then re-encoded with the sRGB curve"}
    write_levels("earth", "night", levels)
    del top, levels

    print("earth/clouds: Blue Marble 2002 clouds")
    clouds = read_image("clouds")
    if clouds.ndim == 3:
        if not (np.array_equal(clouds[..., 0], clouds[..., 1]) and np.array_equal(clouds[..., 1], clouds[..., 2])):
            raise SystemExit("cloud_combined_8192.tif: channels differ; expected a grey image stored as RGB")
        clouds = np.ascontiguousarray(clouds[..., 0])
    report["maps"]["clouds"] = {"landmarks": landmarks.earth_clouds(clouds, "clouds source")}
    top = rs.resample(clouds.astype(np.float32) / 255.0, width, height)
    del clouds
    write_levels("earth", "clouds", grey_levels(top))
    del top

    print("earth/water: Natural Earth land and lakes")
    water = rasterise_water(width, height)
    report["maps"]["water"] = {"landmarks": landmarks.earth_water(water, "water mask (rasterised)")}
    water_levels = rs.chain(water, box=True)
    write_levels("earth", "water", [rs.to_unorm8(level) for level in water_levels])

    print("earth/normal: ETOPO 2022 relief")
    relief = np.asarray(read_image("etopo"), dtype=np.float32)
    report["maps"]["normal"] = {"landmarks": landmarks.earth_relief(relief, "ETOPO source")}
    # Below sea level only the water mask decides what is water; heights under 0 m are held at 0
    # so the sea floor adds no relief at the coast (dry depressions lose a few hundred metres).
    np.maximum(relief, 0.0, out=relief)
    top = rs.resample(relief, width, height)
    del relief
    normal = normal_levels(top, "earth", water_levels)
    report["maps"]["normal"]["landmarksTop"] = landmarks.earth_normals(normal[0], "normal map (top level)")
    report["maps"]["normal"]["exaggeration"] = config.RELIEF_EXAGGERATION["earth"]
    write_levels("earth", "normal", normal)
    return report


# --- Moon ---------------------------------------------------------------------------------------


def build_moon() -> dict[str, Any]:
    report: dict[str, Any] = {"body": "moon", "maps": {}}
    print("moon/colour: SVS CGI Moon Kit, lroc_color_poles_8k")
    colour = read_image("moonColour")
    if colour.shape[:2] != (4096, 8192):
        raise SystemExit(f"lroc_color_poles_8k.tif is {colour.shape}, expected 4096 x 8192")
    lm = landmarks.moon_colour(colour, "LROC colour source")
    levels = colour_levels(rs.srgb_to_linear(colour))
    del colour
    # SVS's own 2k and 4k files must agree with this reduction of the 8k (same texel grid).
    agreement = {}
    for key, width in (("moonColour2k", 2048), ("moonColour4k", 4096)):
        theirs = read_image(key).astype(np.float64)
        ours = next(level for level in levels if level.shape[1] == width).astype(np.float64)
        shifts = {}
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                shifts[(dx, dy)] = float(np.abs(np.roll(np.roll(ours, dy, axis=0), dx, axis=1) - theirs)[2:-2].mean())
        best = min(shifts, key=lambda k: shifts[k])
        agreement[key] = {"meanAbsDiff": round(shifts[(0, 0)], 3), "bestShift": list(best)}
        print(f"  {key}: mean |difference| {shifts[(0, 0)]:.2f} codes, best shift {best}")
        if best != (0, 0) or shifts[(0, 0)] > 6.0:
            raise SystemExit(f"{key}: this reduction does not line up with SVS's own ({agreement[key]})")
    report["maps"]["colour"] = {"landmarks": lm, "svsReductions": agreement}
    write_levels("moon", "colour", levels)
    del levels

    print("moon/normal: LOLA heights (ldem_16_uint)")
    raw = read_image("moonHeight")
    # Half-metres above a 1,727,400 m sphere, i.e. 10 km below the 1,737,400 m reference.
    height_m = raw.astype(np.float32) * 0.5 - 10_000.0
    del raw
    report["maps"]["normal"] = {"landmarks": landmarks.moon_height(height_m, "LOLA source")}
    width = next(m.max_width for m in config.MAPS if m.body == "moon" and m.map == "normal")
    top = rs.resample(height_m, width, width // 2)
    del height_m
    normal = normal_levels(top, "moon")
    report["maps"]["normal"]["landmarksTop"] = landmarks.moon_normals(normal[0], "Moon normal map (top level)")
    report["maps"]["normal"]["exaggeration"] = config.RELIEF_EXAGGERATION["moon"]
    write_levels("moon", "normal", normal)
    return report


# --- Jupiter and Saturn -------------------------------------------------------------------------


def build_giant(body: str, key: str) -> dict[str, Any]:
    spec = next(m for m in config.MAPS if m.body == body and m.map == "colour")
    print(f"{body}/colour: Hubble OPAL 2025a")
    codes = read_image(key)
    bad = invalid_rows(codes)
    report: dict[str, Any] = {"body": body, "maps": {"colour": {"source": list(codes.shape)}}}
    if body == "saturn":
        bad |= rough_polar_rows(codes)
        # The OPAL README warns that moons and their shadows cross the Saturn mosaics.
        codes, repaired = repair_transits(codes, ~bad)
        report["maps"]["colour"]["transitPixelsRepaired"] = repaired
        print(f"  {repaired} pixels of moon and moon-shadow transits replaced by their row's running median")
    linear, fills = fill_rows(rs.srgb_to_linear(codes), bad)
    filled = rs.linear_to_srgb(linear)
    report["maps"]["colour"]["filledRows"] = fills
    for f in fills:
        print(f"  filled rows {f['rows']} (latitudes {f['latitudes'][0]} to {f['latitudes'][1]}): {f['fill']}")
    if body == "jupiter":
        observed: list[float] = []
        report["maps"]["colour"]["landmarks"] = landmarks.jupiter_red_spot(filled, "OPAL Jupiter source", observed)
        report["maps"]["colour"]["greatRedSpot"] = {
            "latitudePlanetographic": observed[0],
            "westLongitudeSystemIII": observed[1],
            "date": "2025-12-11",
            "method": "centre of the reddest 3-degree patch (red minus blue) within 60 degrees of the equator",
        }
        print(f"  Great Red Spot at {observed[0]} deg (planetographic), {observed[1]} deg W (System III)")
    else:
        report["maps"]["colour"]["landmarks"] = landmarks.saturn_seasons(filled, "OPAL Saturn source")
    top = rs.resample(linear, spec.max_width, spec.max_width // 2)
    write_levels(body, "colour", colour_levels(top))
    return report


# --- Saturn's rings -------------------------------------------------------------------------------


def ring_profile() -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    """Radius (km), normal optical depth and its threshold from the RSS table (columns 1, 7, 9)."""
    table = np.loadtxt(config.RINGS_TABLE, delimiter=",", usecols=(0, 6, 8), dtype=np.float64)
    radius, tau, threshold = table[:, 0], table[:, 1], table[:, 2]
    if abs(radius[0] - config.RINGS_INNER_KM) > 1e-6 or abs(radius[-1] - config.RINGS_OUTER_KM) > 1e-6:
        raise SystemExit(f"RSS profile spans {radius[0]} to {radius[-1]} km, expected the span in config.py")
    return radius, tau, threshold


def texel_average(radius: NDArray[np.float64], values: NDArray[np.float64], width: int) -> NDArray[np.float64]:
    """Mean of a piecewise-linear profile over each texel's span of radius (exact, via its integral)."""
    edges = np.linspace(config.RINGS_INNER_KM, config.RINGS_OUTER_KM, width + 1)
    integral = np.concatenate([[0.0], np.cumsum(0.5 * (values[1:] + values[:-1]) * np.diff(radius))])
    at = np.interp(edges, radius, integral)
    return np.diff(at) / np.diff(edges)


def ring_colour(width: int, opacity: NDArray[np.float64]) -> tuple[NDArray[np.float64], dict[str, Any]]:
    """Colour along radius from PIA11142, registered to the RSS profile.

    The mosaic shows the lit face from 10 degrees below it, so the rings are arcs of an ellipse.
    Along the ellipse's major axis (the arcs' apex, where they run vertically) the image is a
    straight cut along radius, so each column there maps linearly to a radius. The apex row
    drifts slowly across the mosaic, so it is found from the inner and outer edges of the rings.
    The column-to-radius line is then fitted to the RSS opacity profile by correlating edges.
    """
    image = read_image("ringColour").astype(np.float32)
    y = landmarks.luma(image)
    lit = y > 8.0
    rows = np.arange(image.shape[0])
    first = np.array([np.argmax(r) if r.any() else -1 for r in lit])
    last = np.array([len(r) - 1 - np.argmax(r[::-1]) if r.any() else -1 for r in lit])
    # Only rows that cross the whole ring system (the mosaic's corners hold partial arcs).
    span = np.where(first >= 0, last - first, 0)
    covered = span > 0.8 * span.max()
    apex_inner = int(rows[covered][np.argmax(first[covered])])
    apex_outer = int(rows[covered][np.argmax(last[covered])])
    x_inner, x_outer = int(first[apex_inner]), int(last[apex_outer])

    def apex_row(x: NDArray[np.float64]) -> NDArray[np.float64]:
        return apex_inner + (x - x_inner) * (apex_outer - apex_inner) / (x_outer - x_inner)

    columns = np.arange(image.shape[1], dtype=np.float64)
    centre = np.clip(np.rint(apex_row(columns)).astype(int), 8, image.shape[0] - 9)
    # sRGB codes, averaged over 17 rows along the apex (W x 3).
    profile = np.stack([image[centre + d, columns.astype(int)] for d in range(-8, 9)]).mean(axis=0)
    profile_y = landmarks.luma(profile)

    # The mosaic's radial scale drifts across its 15 frames, so column -> radius is piecewise
    # linear through ring edges found in both the image and the RSS opacity: the C ring's inner
    # edge, the B ring's inner and outer edges, the A ring's inner and outer edges.
    edges_km = np.linspace(config.RINGS_INNER_KM, config.RINGS_OUTER_KM, width + 1)
    centres_km = 0.5 * (edges_km[1:] + edges_km[:-1])
    op_grad = np.gradient(np.convolve(opacity, np.ones(3) / 3.0, mode="same"))
    smooth = np.convolve(profile_y, np.ones(5) / 5.0, mode="same")
    img_grad = np.gradient(smooth)

    def rss_feature(lo_km: float, hi_km: float, kind: str) -> float:
        window = np.nonzero((centres_km > lo_km) & (centres_km < hi_km))[0]
        if kind == "rise":
            return float(centres_km[window][np.argmax(op_grad[window])])
        if kind == "fall":  # the first texel that is nearly empty after dense ring material
            return float(centres_km[window][np.nonzero(opacity[window] < 0.1)[0][0]])
        empty = window[opacity[window] < 0.02]  # a gap: the middle of its empty texels
        return float(centres_km[empty].mean())

    def image_feature(guess: float, reach: int, kind: str) -> int:
        lo, hi = max(0, int(guess) - reach), min(len(img_grad), int(guess) + reach + 1)
        if kind == "rise":
            return lo + int(np.argmax(img_grad[lo:hi]))
        if kind == "fall":
            return lo + int(np.argmin(img_grad[lo:hi]))
        return lo + int(np.argmin(smooth[lo:hi]))

    # The two ends: first ring material, and the start of the wide empty band before the F ring.
    c_inner_km = float(centres_km[np.nonzero(opacity > 0.03)[0][0]])
    a_outer_km = float(centres_km[np.nonzero((centres_km < 139_000.0) & (opacity > 0.2))[0][-1]])
    span_x = slice(x_inner, x_outer + 1)
    dark = smooth < 0.1 * float(np.percentile(profile_y[span_x], 95))
    runs, start = [], None
    for x in range(x_inner, x_outer + 1):
        if dark[x] and start is None:
            start = x
        elif not dark[x] and start is not None:
            runs.append((x - start, start))
            start = None
    if not runs:
        raise SystemExit("PIA11142: no dark band between the A ring and the F ring found")
    anchors = {"C ring inner edge": (c_inner_km, x_inner), "A ring outer edge": (a_outer_km, max(runs)[1])}

    def column_for(km: float) -> float:
        pts = sorted(anchors.values())
        rk, xk = [p[0] for p in pts], [p[1] for p in pts]
        return float(np.interp(km, rk, xk))

    # Each feature is placed where the anchors so far predict it, then searched for nearby.
    for name, lo_km, hi_km, kind, reach in (
        ("B ring outer edge", 117_300.0, 117_900.0, "fall", 400),
        ("B ring inner edge", 91_500.0, 92_500.0, "rise", 250),
        ("A ring inner edge", 121_700.0, 122_400.0, "rise", 150),
        ("Encke Gap", 133_400.0, 133_800.0, "gap", 40),
        ("Colombo Gap", 77_700.0, 78_050.0, "gap", 40),
        ("Maxwell Gap", 87_400.0, 87_650.0, "gap", 40),
    ):
        km = rss_feature(lo_km, hi_km, kind)
        anchors[name] = (km, image_feature(column_for(km), reach, kind))

    pts = sorted(anchors.values())
    rk, xk = np.array([p[0] for p in pts]), np.array([p[1] for p in pts], dtype=np.float64)
    if np.any(np.diff(xk) <= 0):
        raise SystemExit(f"PIA11142: ring edges out of order: {anchors}")
    # Check: the Keeler Gap (from the RSS profile, not an anchor) must be the darkest point near
    # where the mapping puts it.
    keeler_km = rss_feature(136_400.0, 136_600.0, "gap")
    found_x = image_feature(column_for(keeler_km), 12, "gap")
    keeler_found = float(np.interp(found_x, xk, rk))
    slopes = np.diff(rk) / np.diff(xk)
    px = np.interp(centres_km, rk, xk, left=np.nan, right=np.nan)
    below, above = centres_km < rk[0], centres_km > rk[-1]
    px[below] = xk[0] + (centres_km[below] - rk[0]) / slopes[0]
    px[above] = xk[-1] + (centres_km[above] - rk[-1]) / slopes[-1]
    colour = np.stack([np.interp(px, columns, profile[:, c], left=0.0, right=0.0) for c in range(3)], axis=-1)
    info = {
        "apexRows": [apex_inner, apex_outer],
        "anchors": {name: {"km": round(km, 1), "column": int(x)} for name, (km, x) in sorted(anchors.items(), key=lambda kv: kv[1][0])},
        "kmPerPixel": [round(float(s), 3) for s in slopes],
        "keelerGap": {"rssKm": round(keeler_km, 1), "foundKm": round(keeler_found, 1)},
        "method": (
            "17 rows averaged along the arcs' apex; column to radius piecewise linear through ring edges and gaps found "
            "in both the image and the RSS opacity; the Keeler Gap checks it"
        ),
    }
    if abs(keeler_found - keeler_km) > 40.0 or not np.all((slopes > 5.0) & (slopes < 8.0)):
        raise SystemExit(f"PIA11142 does not line up with the RSS profile: {info}")
    return colour, info


def build_rings() -> dict[str, Any]:
    width = next(m.max_width for m in config.MAPS if m.map == "rings")
    print("saturn/rings: Cassini RSS optical depth and PIA11142 colour")
    radius, tau, threshold = ring_profile()
    # Below the noise floor the depth can come out negative; above the threshold it is only a
    # lower bound (the B ring core), so it is held there.
    saturated = float(np.mean(tau >= threshold))
    tau_clamped = np.clip(tau, 0.0, threshold)
    transmission = texel_average(radius, np.exp(-tau_clamped), width)
    opacity = 1.0 - transmission

    def opacity_at(km0: float, km1: float) -> float:
        centres = config.RINGS_INNER_KM + (np.arange(width) + 0.5) * (config.RINGS_OUTER_KM - config.RINGS_INNER_KM) / width
        return float(opacity[(centres >= km0) & (centres <= km1)].mean())

    checks = landmarks.Checks("RSS profile", "saturn")
    checks.expect("B ring core opacity (105,000-110,000 km)", opacity_at(105_000, 110_000), ">", 0.9)
    checks.expect("Cassini Division opacity (118,500-119,500 km)", opacity_at(118_500, 119_500), "<", 0.4)
    checks.expect("Encke Gap opacity (133,480-133,700 km)", opacity_at(133_480, 133_700), "<", 0.15)
    checks.expect("C ring opacity (80,000-88,000 km)", opacity_at(80_000, 88_000), "<", 0.4)
    checks.expect("inside the C ring opacity (72,800-74,000 km)", opacity_at(72_800, 74_000), "<", 0.03)
    lm = checks.report()

    codes_along_radius, registration = ring_colour(width, opacity)
    print(f"  colour registered: {registration['kmPerPixel']} km per pixel between features; Keeler Gap check {registration['keelerGap']}")
    # Colour where the mosaic shows empty space (gaps, beyond the edges) is taken from the nearest
    # ring material, so filtering never pulls black into the rings (alpha is straight, not premultiplied).
    srgb = codes_along_radius / 255.0
    lum = srgb.mean(axis=1)
    material = (lum > 0.06) & (opacity > 0.02)
    idx = np.arange(width)
    filled = np.stack([np.interp(idx, idx[material], srgb[material, c]) for c in range(3)], axis=-1)
    colour_linear = rs.srgb_to_linear(rs.to_unorm8(filled.astype(np.float32)))

    strip = np.concatenate([colour_linear, opacity[:, None].astype(np.float32)], axis=-1)[None, :, :]  # (1, W, 4)
    levels = [strip]
    while levels[-1].shape[1] > 1:
        top = levels[-1]
        pairs = top.reshape(1, top.shape[1] // 2, 2, 4)
        alpha = pairs[..., 3]
        weight = np.where(alpha.sum(axis=-1, keepdims=True) > 1e-6, alpha, 1.0)
        rgb = (pairs[..., :3] * weight[..., None]).sum(axis=2) / weight.sum(axis=-1, keepdims=True)
        levels.append(np.concatenate([rgb, alpha.mean(axis=-1, keepdims=True)], axis=-1).astype(np.float32))
    codes = [np.concatenate([rs.linear_to_srgb(lv[..., :3]), rs.to_unorm8(lv[..., 3:])], axis=-1) for lv in levels]
    write_levels("saturn", "rings", codes)
    return {
        "body": "saturn",
        "maps": {
            "rings": {
                "landmarks": lm,
                "saturatedFraction": round(saturated, 4),
                "colourRegistration": registration,
                "radiusKm": [config.RINGS_INNER_KM, config.RINGS_OUTER_KM],
            }
        },
    }


BUILDERS = {
    "earth": build_earth,
    "moon": build_moon,
    "jupiter": lambda: build_giant("jupiter", "jupiter"),
    "saturn": lambda: build_giant("saturn", "saturn"),
    "rings": build_rings,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bodies", nargs="*", help=f"any of {', '.join(BUILDERS)} (default: all)")
    names = parser.parse_args().bodies or list(BUILDERS)
    unknown = [n for n in names if n not in BUILDERS]
    if unknown:
        parser.error(f"unknown: {', '.join(unknown)}")
    for name in names:
        write_report(name, BUILDERS[name]())


if __name__ == "__main__":
    main()
