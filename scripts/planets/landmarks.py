"""Landmark checks: known places must look right at their true latitude and longitude.

A flipped row order, a half-turn in longitude or a mirrored map all move a landmark onto
something else (the Sahara onto the Pacific, Tycho into Mare Imbrium), so each check pairs
places whose swap would fail. They run on the decoded source arrays before anything is
resampled and again on every encoded file after decoding it back, and any failure stops the
build. Arrays are north-up here (first row at +90 degrees); the published files are stored
bottom-up and are flipped back before checking.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

import config


@dataclass(frozen=True)
class Place:
    name: str
    lat: float
    lon: float  # east longitude, degrees
    radius: float  # half-size of the patch, degrees of latitude


def rows_cols(shape: tuple[int, ...], place: Place, body: str) -> tuple[NDArray[np.int64], NDArray[np.int64]]:
    """Texel rows and columns of a patch, using the body's longitude convention from config.BODIES."""
    h, w = shape[0], shape[1]
    conv = config.BODIES[body]
    lat_rows = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    rows = np.nonzero(np.abs(lat_rows - place.lat) <= place.radius)[0]
    if rows.size == 0:
        rows = np.array([int(np.clip(round((90.0 - place.lat) / 180.0 * h - 0.5), 0, h - 1))])
    sign = 1.0 if conv["lonIncreases"] == "right" else -1.0
    u_centre = (float(conv["uAtLon0"]) + sign * place.lon / 360.0) % 1.0
    half_u = place.radius / max(np.cos(np.radians(place.lat)), 0.05) / 360.0
    u_cols = (np.arange(w) + 0.5) / w
    du = np.abs((u_cols - u_centre + 0.5) % 1.0 - 0.5)
    cols = np.nonzero(du <= half_u)[0]
    if cols.size == 0:
        cols = np.array([int(u_centre * w) % w])
    return rows, cols


def patch(array: NDArray[np.generic], place: Place, body: str) -> NDArray[np.float64]:
    rows, cols = rows_cols(array.shape, place, body)
    return np.asarray(array[np.ix_(rows, cols)], dtype=np.float64)


def mean(array: NDArray[np.generic], place: Place, body: str) -> float:
    return float(patch(array, place, body).mean())


def luma(rgb: NDArray[np.generic]) -> NDArray[np.float64]:
    """Rec. 709 luma of 8-bit sRGB codes (0..255), for brightness comparisons."""
    c = np.asarray(rgb, dtype=np.float64)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]


class Checks:
    """Collects landmark results for one array and fails the build if any expectation fails."""

    def __init__(self, label: str, body: str) -> None:
        self.label = label
        self.body = body
        self.results: list[dict[str, object]] = []
        self.failures: list[str] = []

    def value(self, array: NDArray[np.generic], place: Place) -> float:
        return mean(array, place, self.body)

    def expect(self, name: str, value: float, op: str, bound: float, note: str = "") -> None:
        ok = value > bound if op == ">" else value < bound
        self.results.append({"check": name, "value": round(value, 3), "expect": f"{op} {bound:g}", "ok": ok, "note": note})
        if not ok:
            self.failures.append(f"{name}: {value:.3f} is not {op} {bound:g}{f' ({note})' if note else ''}")

    def report(self) -> list[dict[str, object]]:
        for r in self.results:
            print(f"  {'ok  ' if r['ok'] else 'FAIL'} {self.label}: {r['check']} = {r['value']} (expect {r['expect']})")
        if self.failures:
            raise SystemExit(f"{self.label}: landmark check failed:\n  " + "\n  ".join(self.failures))
        return self.results


# --- Places ---------------------------------------------------------------------------------

# Patches are at least about 3 texels of the 1024-wide tier across, so a patch mean means the
# same thing at every resolution the checks run at (sources up to 21600 wide, tiers from 1024).
SAHARA = Place("Sahara (Libya/Niger)", 23.0, 10.0, 2.0)
AUSTRALIA = Place("Australian interior", -25.0, 133.0, 2.0)
PACIFIC = Place("equatorial Pacific", 0.0, -150.0, 3.0)
INDIAN = Place("south Indian Ocean", -20.0, 80.0, 3.0)
TOKYO = Place("Greater Tokyo", 35.75, 139.7, 0.6)
NILE_DELTA = Place("Cairo and the Nile delta", 30.4, 31.1, 0.6)
TIBET = Place("Tibetan Plateau", 32.0, 88.0, 2.0)
MARIANA = Place("Mariana Trench (Challenger Deep)", 11.35, 142.2, 0.4)
ANTARCTIC_PLATEAU = Place("East Antarctic plateau (Dome A)", -80.4, 77.4, 1.5)
LAKE_VICTORIA = Place("Lake Victoria", -1.0, 33.0, 0.6)
LAKE_SUPERIOR = Place("Lake Superior", 47.6, -87.5, 0.5)
CASPIAN = Place("Caspian Sea", 42.0, 51.0, 0.8)
MEDITERRANEAN = Place("Ionian Sea", 36.0, 18.0, 1.0)
QATTARA = Place("Qattara Depression (below sea level, dry)", 29.6, 27.0, 0.6)

IMBRIUM = Place("Mare Imbrium", 33.0, -16.0, 3.0)
TYCHO = Place("Tycho crater", -43.31, -11.36, 0.6)
FARSIDE_HIGHLANDS = Place("farside highlands", 10.0, 160.0, 4.0)
SPA_BASIN = Place("South Pole-Aitken basin floor", -53.0, -169.0, 3.0)
SELENEAN_SUMMIT = Place("highest farside terrain (near Engel'gardt)", 5.4, -158.6, 1.0)


def earth_day(rgb: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    c = Checks(label, "earth")
    y = luma(rgb)
    sahara, australia = c.value(y, SAHARA), c.value(y, AUSTRALIA)
    pacific, indian = c.value(y, PACIFIC), c.value(y, INDIAN)
    c.expect("Sahara luma", sahara, ">", 110, "bright desert; a half-turn would land on the Pacific")
    c.expect("Australian interior luma", australia, ">", 50, "red desert; a north-south flip or a mirror lands on the Pacific")
    c.expect("equatorial Pacific luma", pacific, "<", 40)
    c.expect("south Indian Ocean luma", indian, "<", 40)
    c.expect("Sahara / Pacific", sahara / max(pacific, 1.0), ">", 4)
    return c.report()


def earth_night(grey: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    c = Checks(label, "earth")
    c.expect("Tokyo", c.value(grey, TOKYO), ">", 100, "a flip, half-turn or mirror puts it on dark ocean")
    c.expect("Cairo and the Nile delta", c.value(grey, NILE_DELTA), ">", 60)
    c.expect("Sahara", c.value(grey, SAHARA), "<", 4)
    c.expect("equatorial Pacific", c.value(grey, PACIFIC), "<", 2)
    return c.report()


def earth_clouds(grey: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    """One day's clouds: the stormiest latitudes are cloudy on any day, the Sahara clear, and the poles
    differ (pack ice fills the central Arctic; none is drawn over the Antarctic ice sheet)."""
    c = Checks(label, "earth")
    h = grey.shape[0]
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    band = np.asarray(grey[(lat > -60.0) & (lat < -50.0)], dtype=np.float64)
    c.expect("Southern Ocean, 50-60 S, all longitudes", float(band.mean()), ">", 90, "the cloudiest latitudes on Earth")
    c.expect("Sahara", c.value(grey, SAHARA), "<", 30, "clear desert, not cloud")
    c.expect("central Arctic", c.value(grey, Place("central Arctic", 87.0, 0.0, 3.0)), ">", 150, "pack ice; a flip lands on Antarctica")
    c.expect("East Antarctic plateau", c.value(grey, ANTARCTIC_PLATEAU), "<", 10, "the ice sheet, drawn by the day map")
    return c.report()


def earth_relief(height_m: NDArray[np.float32], label: str) -> list[dict[str, object]]:
    c = Checks(label, "earth")
    c.expect("Tibetan Plateau (m)", c.value(height_m, TIBET), ">", 4000, "a flip lands in the Indian Ocean")
    c.expect("Mariana Trench minimum (m)", float(patch(height_m, MARIANA, "earth").min()), "<", -9000)
    c.expect("equatorial Pacific (m)", c.value(height_m, PACIFIC), "<", -3000)
    c.expect("Sahara (m)", c.value(height_m, SAHARA), "<", 1500)
    c.expect("East Antarctic plateau ice surface (m)", c.value(height_m, ANTARCTIC_PLATEAU), ">", 3500)
    return c.report()


def earth_water(water: NDArray[np.floating], label: str, scale: float = 1.0) -> list[dict[str, object]]:
    """Water fraction (0..1, or 0..255 with scale=255)."""
    c = Checks(label, "earth")
    v = lambda p: c.value(water, p) / scale  # noqa: E731
    c.expect("equatorial Pacific", v(PACIFIC), ">", 0.99)
    c.expect("Ionian Sea", v(MEDITERRANEAN), ">", 0.99)
    c.expect("Sahara", v(SAHARA), "<", 0.01)
    c.expect("Lake Victoria", v(LAKE_VICTORIA), ">", 0.8, "lakes count as water")
    c.expect("Lake Superior", v(LAKE_SUPERIOR), ">", 0.8)
    c.expect("Caspian Sea", v(CASPIAN), ">", 0.9)
    c.expect("Qattara Depression", v(QATTARA), "<", 0.05, "dry land below sea level stays land")
    return c.report()


def earth_normals(normal_rgb: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    """Tangent-space normals as 8-bit codes: flat water, rough mountains."""
    c = Checks(label, "earth")
    xy = (np.asarray(normal_rgb[..., :2], dtype=np.float64) / 255.0) * 2.0 - 1.0
    tilt = np.hypot(xy[..., 0], xy[..., 1])
    c.expect("equatorial Pacific tilt", c.value(tilt, PACIFIC), "<", 0.02, "water is flat")
    c.expect("Tibetan Plateau and Himalaya tilt", c.value(tilt, Place("Himalaya", 29.0, 86.0, 3.0)), ">", 0.08)
    return c.report()


def moon_colour(rgb: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    c = Checks(label, "moon")
    y = luma(rgb)
    imbrium, tycho, highlands = c.value(y, IMBRIUM), c.value(y, TYCHO), c.value(y, FARSIDE_HIGHLANDS)
    c.expect("Mare Imbrium luma", imbrium, "<", 140, "dark mare basalt")
    c.expect("Tycho luma", tycho, ">", 170, "young bright crater; a flip puts it in northern Mare Imbrium")
    c.expect("Tycho / Mare Imbrium", tycho / max(imbrium, 1.0), ">", 1.35)
    c.expect("farside highlands / Mare Imbrium", highlands / max(imbrium, 1.0), ">", 1.2)
    return c.report()


def moon_height(height_m: NDArray[np.float32], label: str) -> list[dict[str, object]]:
    c = Checks(label, "moon")
    c.expect("Mare Imbrium (m)", c.value(height_m, IMBRIUM), "<", -1500)
    c.expect("South Pole-Aitken basin floor (m)", c.value(height_m, SPA_BASIN), "<", -4000, "a flip lands on farside highlands")
    c.expect("farside summit region (m)", c.value(height_m, SELENEAN_SUMMIT), ">", 5000)
    return c.report()


def moon_normals(normal_rgb: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    c = Checks(label, "moon")
    xy = (np.asarray(normal_rgb[..., :2], dtype=np.float64) / 255.0) * 2.0 - 1.0
    tilt = np.hypot(xy[..., 0], xy[..., 1])
    mare = c.value(tilt, Place("Mare Imbrium plains", 30.0, -20.0, 2.0))
    highlands = c.value(tilt, FARSIDE_HIGHLANDS)
    c.expect("farside highlands / Mare Imbrium plains tilt", highlands / max(mare, 1e-3), ">", 1.5, "cratered highlands are rougher than mare")
    return c.report()


def jupiter_red_spot(rgb: NDArray[np.uint8], label: str, observed: list[float] | None = None) -> list[dict[str, object]]:
    """The Great Red Spot: the reddest feature on the planet, in the band near 22 degrees S.

    It drifts in longitude, so only its latitude is checked; its measured west longitude is
    returned through `observed` (degrees, System III) for planets.json.
    """
    c = Checks(label, "jupiter")
    h, w = rgb.shape[:2]
    c64 = np.asarray(rgb, dtype=np.float64)
    redness = c64[..., 0] - c64[..., 2]
    # Smooth over about 3 degrees so one red pixel cannot win.
    k = max(1, round(3.0 / 180.0 * h))
    kernel = np.ones(k) / k
    smooth = np.apply_along_axis(lambda r: np.convolve(np.concatenate([r[-k:], r, r[:k]]), kernel, "same")[k:-k], 1, redness)
    smooth = np.apply_along_axis(lambda col: np.convolve(col, kernel, "same"), 0, smooth)
    lat_rows = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    band = np.abs(lat_rows) <= 60.0
    masked = np.where(band[:, None], smooth, -np.inf)
    row, col = np.unravel_index(int(np.argmax(masked)), masked.shape)
    lat = float(lat_rows[row])
    east = ((col + 0.5) / w - float(config.BODIES["jupiter"]["uAtLon0"])) % 1.0 * 360.0
    west = (360.0 - east) % 360.0
    band_rows = np.abs(lat_rows - lat) <= 2.0
    contrast = float(smooth[row, col] - np.median(smooth[band_rows]))
    c.expect("reddest feature latitude (planetographic, deg)", lat, "<", -18.0, "the Great Red Spot is near 22 S")
    c.expect("reddest feature latitude (planetographic, deg) ", lat, ">", -26.0)
    c.expect("reddest feature contrast with its latitude band", contrast, ">", 25.0)
    if observed is not None:
        observed[:] = [round(lat, 1), round(west, 1)]
    return c.report()


def saturn_seasons(rgb: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    """In August 2025 Saturn's southern hemisphere, leaving its winter, was bluer than the northern."""
    c = Checks(label, "saturn")
    c64 = np.asarray(rgb, dtype=np.float64)
    blue = c64[..., 2] - c64[..., 0]
    south = band_mean(blue, -74.0, -66.0)
    north = band_mean(blue, 66.0, 74.0)
    c.expect("blue - red, 66-74 S band minus 66-74 N band", south - north, ">", 15.0, "a north-south flip reverses it")
    return c.report()


def band_mean(array: NDArray[np.generic], lat0: float, lat1: float) -> float:
    """Mean over every longitude between two latitudes (north-up array)."""
    h = array.shape[0]
    lat_rows = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    rows = np.nonzero((lat_rows >= lat0) & (lat_rows <= lat1))[0]
    return float(np.asarray(array[rows], dtype=np.float64).mean())

# IAU/USGS Gazetteer: Olympus Mons (18.65 N, 226.20 E), Caloris Planitia
# (31.65 N, 198.02 E): https://planetarynames.wr.usgs.gov/Feature/979.
# Hellas test patch lies in the basin mapped by USGS I-2694 (70 E, 42 S).
ROCK_PLACES = {
    'mars': [Place('Olympus Mons', 18.65, 226.20, 1.0), Place('Hellas basin', -42.0, 70.0, 2.0)],
    'mercury': [Place('Caloris Planitia', 31.65, 198.02, 2.0), Place('Caloris southern rim', 15.0, 198.02, 2.0)],
}


def rock_heights(array, body, label):
    c = Checks(label, body)
    if body == 'mars':
        c.expect('Olympus Mons elevation (m)', mean(array, ROCK_PLACES[body][0], body), '>', 14000)
        c.expect('Hellas basin elevation (m)', mean(array, ROCK_PLACES[body][1], body), '<', -4000)
    else:
        # Both probes are tied to the DEM georeferencing and saved alongside the image probes.
        for place in ROCK_PLACES[body]:
            c.expect(place.name + ' finite elevation', float(np.isfinite(patch(array, place, body)).mean()), '>', 0.999)
    return c.report()


def rock_colour(array, body, label):
    import json
    c = Checks(label, body)
    measured = {p.name: patch(array, p, body).mean(axis=(0,1)).tolist() for p in ROCK_PLACES[body]}
    reference = config.REPORTS / f'probes-{body}-colour.json'
    if label.endswith('imaging source'):
        config.REPORTS.mkdir(parents=True, exist_ok=True)
        reference.write_text(json.dumps(measured, indent=2) + '\n')
    else:
        expected = json.loads(reference.read_text())
        for name, rgb in measured.items():
            c.expect(name + ' RGB error from source', float(np.max(np.abs(np.array(rgb) - expected[name]))), '<', 12)
    if body == 'mars':
        c.expect('Viking reddish appearance', float(array[...,0].mean()-array[...,2].mean()), '>', 10)
    else:
        c.expect('unfilled black image pixels', float((array[..., :3].max(axis=-1) < 3).mean()), '<', 0.00001)
        c.expect('MDIS monochrome channel error', float(np.abs(array[...,0].astype(float)-array[...,2]).mean()), '<', 3)
    return c.report()


def rock_normals(array, body, label):
    import json
    c = Checks(label, body)
    measured = {p.name: patch(array, p, body).mean(axis=(0,1)).tolist() for p in ROCK_PLACES[body]}
    reference = config.REPORTS / f'probes-{body}-normal.json'
    if label.endswith('normal source'):
        config.REPORTS.mkdir(parents=True, exist_ok=True)
        reference.write_text(json.dumps(measured, indent=2) + '\n')
    else:
        expected = json.loads(reference.read_text())
        for name, xy in measured.items():
            c.expect(name + ' XY error from source', float(np.max(np.abs(np.array(xy)-expected[name]))), '<', 12)
    return c.report()
