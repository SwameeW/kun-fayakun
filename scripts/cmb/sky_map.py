"""Planck HEALPix FITS -> smoothed temperature map -> equirectangular grid (uK)."""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import healpy as hp
import numpy as np
from astropy.io import fits
from numpy.typing import NDArray

import config
import projection

# HEALPix pixels at or below this are the FITS BAD_DATA sentinel (-1.6375e30).
BAD_THRESHOLD = -1.0e30


@dataclass(frozen=True)
class SourceInfo:
    column: str
    unit_in_file: str
    ordering: str
    coordsys: str
    nside: int
    method: str
    bad_pixels: int
    native_beam_fwhm_arcmin: float | None


def _header_str(header: fits.Header, key: str) -> str:
    value = header.get(key, "")
    return str(value).strip()


def _fit_gaussian_fwhm_arcmin(beam: NDArray[np.float64]) -> float | None:
    """Gaussian FWHM that best matches a beam transfer function b_l over 0.2 < b_l < 0.9."""
    ell = np.arange(beam.size, dtype=np.float64)
    use = (beam > 0.2) & (beam < 0.9) & (ell > 0)
    if not np.any(use):
        return None
    sigma2 = -2.0 * np.log(beam[use]) / (ell[use] * (ell[use] + 1.0))
    sigma = float(np.sqrt(np.median(sigma2)))
    return float(np.degrees(sigma) * 60.0 * np.sqrt(8.0 * np.log(2.0)))


def read_temperature(path: Path) -> tuple[NDArray[np.float64], SourceInfo]:
    """Reads the temperature column in RING order, converted to microkelvin."""
    with fits.open(path, memmap=True) as hdul:
        table = hdul[1]
        header = table.header
        names = [_header_str(header, f"TTYPE{i}") for i in range(1, int(header["TFIELDS"]) + 1)]
        column = config.PREFERRED_COLUMN if config.PREFERRED_COLUMN in names else config.FALLBACK_COLUMN
        if column not in names:
            raise SystemExit(f"No temperature column in {path.name}: {names}")
        unit = _header_str(header, f"TUNIT{names.index(column) + 1}")
        ordering = _header_str(header, "ORDERING").upper()
        coordsys = _header_str(header, "COORDSYS").upper()
        nside = int(header["NSIDE"])
        method = _header_str(header, "METHOD")
        values = np.array(table.data.field(column), dtype=np.float64)

        beam_fwhm: float | None = None
        if len(hdul) > 2 and "INT_BEAM" in hdul[2].columns.names:
            beam_fwhm = _fit_gaussian_fwhm_arcmin(np.array(hdul[2].data.field("INT_BEAM"), dtype=np.float64))

    if unit != config.EXPECTED_UNIT:
        raise SystemExit(f"Unexpected unit {unit!r} for {column}; expected {config.EXPECTED_UNIT}")
    if coordsys != config.EXPECTED_COORDSYS:
        raise SystemExit(f"Unexpected coordinate system {coordsys!r}")
    if values.size != hp.nside2npix(nside):
        raise SystemExit(f"{values.size} pixels does not match NSIDE {nside}")

    bad = ~np.isfinite(values) | (values <= BAD_THRESHOLD)
    bad_count = int(bad.sum())
    if bad_count:
        # Smoothing a map with sentinel values would smear them across the sky.
        raise SystemExit(f"{bad_count} bad pixels in {column}; an inpainted column is required")

    if ordering == "NESTED":
        values = hp.reorder(values, n2r=True)
    elif ordering != "RING":
        raise SystemExit(f"Unknown HEALPix ordering {ordering!r}")

    values *= config.K_TO_MICROKELVIN
    info = SourceInfo(column, unit, ordering, coordsys, nside, method, bad_count, beam_fwhm)
    return values, info


def smooth(values: NDArray[np.float64], fwhm_arcmin: float) -> NDArray[np.float64]:
    """Gaussian smoothing in harmonic space (ring weights, 3 Jacobi iterations)."""
    smoothed = hp.smoothing(values, fwhm=np.radians(fwhm_arcmin / 60.0), use_weights=True, iter=3)
    return np.asarray(smoothed, dtype=np.float64)


def to_equirect(ring_map: NDArray[np.float64], width: int, height: int) -> NDArray[np.float32]:
    """Bilinear HEALPix interpolation at every texel centre; rows top (north) to bottom."""
    lon, lat = projection.texel_centres(width, height)
    grid = np.empty((height, width), dtype=np.float32)
    rows_per_chunk = 128
    for start in range(0, height, rows_per_chunk):
        stop = min(start + rows_per_chunk, height)
        grid[start:stop] = hp.get_interp_val(ring_map, lon[start:stop], lat[start:stop], lonlat=True)
    return grid


def _disc_mean(grid: NDArray[np.float32], lon0: float, lat0: float, radius_deg: float) -> float:
    """Area-weighted mean of the grid inside a disc (cos-latitude weights)."""
    height, width = grid.shape
    lon, lat = projection.texel_centres(width, height)
    inside = projection.angular_distance_deg(lon, lat, lon0, lat0) <= radius_deg
    weights = np.cos(np.radians(lat))[inside]
    return round(float(np.sum(grid[inside] * weights) / np.sum(weights)), 2)


def _band_std(grid: NDArray[np.float32], lat_min: float, lat_max: float) -> float:
    height, width = grid.shape
    _, lat = projection.texel_centres(width, height)
    rows = (np.abs(lat[:, 0]) >= lat_min) & (np.abs(lat[:, 0]) < lat_max)
    return round(float(np.std(grid[rows])), 2)


def checks(ring_map: NDArray[np.float64], grid: NDArray[np.float32]) -> dict[str, Any]:
    """Self-checks of the documented (u, v) convention and of known sky features."""
    rng = np.random.default_rng(20180717)
    lon = rng.uniform(0.0, 360.0, 20000)
    lat = np.degrees(np.arcsin(rng.uniform(-0.98, 0.98, lon.size)))
    direct = hp.get_interp_val(ring_map, lon, lat, lonlat=True)

    def rms_vs_direct(sample_lon: NDArray[np.float64], sample_lat: NDArray[np.float64]) -> float:
        diff = projection.sample_bilinear(grid, sample_lon, sample_lat) - direct
        return round(float(np.sqrt(np.mean(diff**2))), 2)

    cold_lon, cold_lat = config.COLD_SPOT_LON_LAT
    return {
        "conventionCheck": {
            "description": (
                "grid sampled at the documented (u,v) of 20000 random (l,b) vs direct HEALPix "
                "lookup; the residual is texel-scale interpolation. Controls: same with l mirrored "
                "(as if l increased to the right) and with b flipped."
            ),
            "rmsDifferenceUk": rms_vs_direct(lon, lat),
            "controlMirroredLonRmsUk": rms_vs_direct(360.0 - lon, lat),
            "controlFlippedLatRmsUk": rms_vs_direct(lon, -lat),
            "mapRmsUk": round(float(np.std(direct)), 2),
        },
        "coldSpot": {
            "description": "area-weighted mean within 5 deg; controls are the mirrored positions",
            "at_l209_b-57": _disc_mean(grid, cold_lon, cold_lat, 5.0),
            "control_l151_b-57": _disc_mean(grid, 360.0 - cold_lon, cold_lat, 5.0),
            "control_l209_b+57": _disc_mean(grid, cold_lon, -cold_lat, 5.0),
        },
        "galacticPlane": {
            "description": "std of the grid by |b| band; a foreground stripe would inflate the first",
            "stdAbsB0to5": _band_std(grid, 0.0, 5.0),
            "stdAbsB30to60": _band_std(grid, 30.0, 60.0),
        },
    }


def build_grid() -> dict[str, Any]:
    """Runs FITS -> grid and writes the float32 grid plus a stats file."""
    t0 = time.monotonic()
    values, info = read_temperature(config.FITS_PATH)
    t_read = time.monotonic()
    monopole, dipole = hp.fit_dipole(values)
    raw_stats = {
        "meanUk": float(np.mean(values)),
        "stdUk": float(np.std(values)),
        "minUk": float(np.min(values)),
        "maxUk": float(np.max(values)),
        "fittedMonopoleUk": float(monopole),
        "fittedDipoleAmplitudeUk": float(np.linalg.norm(dipole)),
    }
    smoothed = smooth(values, config.SMOOTHING_FWHM_ARCMIN)
    del values
    t_smooth = time.monotonic()
    grid = to_equirect(smoothed, config.WIDTH, config.HEIGHT)
    t_grid = time.monotonic()

    config.WORK.mkdir(parents=True, exist_ok=True)
    np.save(config.GRID_PATH, grid)
    percentiles = np.percentile(grid, [0.1, 1, 50, 99, 99.9])
    stats: dict[str, Any] = {
        "source": asdict(info),
        "rawMap": raw_stats,
        "grid": {
            "width": config.WIDTH,
            "height": config.HEIGHT,
            "minUk": float(grid.min()),
            "maxUk": float(grid.max()),
            "stdUk": float(grid.std()),
            "percentilesUk": {k: float(p) for k, p in zip(("p0.1", "p1", "p50", "p99", "p99.9"), percentiles)},
            "fractionOutsideRange": float(
                np.mean((grid < config.RANGE_MICROKELVIN[0]) | (grid > config.RANGE_MICROKELVIN[1]))
            ),
        },
        "checks": checks(smoothed, grid),
        "seconds": {"read": t_read - t0, "smooth": t_smooth - t_read, "resample": t_grid - t_smooth},
    }
    return stats
