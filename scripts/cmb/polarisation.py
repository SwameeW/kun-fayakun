"""Planck CMB polarisation -> a line texture for the globe of Chapter 2.

What it shows: the direction in which the first light is polarised, drawn as thin lines over
the temperature map, after ESA's image of February 2015 ("Polarisation of the Cosmic Microwave
Background": colour for temperature, texture for the direction of the polarised light, filtered
to show mostly patterns a few degrees across). ESA drew a texture (line-integral convolution);
on a globe about 500 pixels across its grain is finer than the screen, so the field is drawn as
evenly spaced streamlines instead (streamlines.py). The directions are measured; where the
lines start, and how far apart they are, is not.

Source: Q_STOKES, U_STOKES and PMASK of the same SMICA file as the temperature map
(COM_CMB_IQU-smica_2048_R3.00_full.fits, Planck 2018 IV, A&A 641, A4). Nothing inpainted is
used: Q and U are taken where the polarisation mask keeps them and are zero elsewhere.

Steps (each from the file alone; intermediates go to .cache/cmb-work/polarisation):

  1. Mask. PMASK (Planck's common polarisation mask, 0 = masked) is apodised: zero inside,
     rising as a cosine over the first APODISE_DEG from its edge (holes included), so the
     Galactic plane fades out instead of cutting off. Q and U are multiplied by it.
  2. Filter. One spin-2 transform. At the few-degree scales a globe this size can show, Planck's
     polarisation is still faint against its noise: in the masked maps the B-mode power (noise
     and residuals, the CMB's own B being far smaller) is 40 to 70 per cent of the E-mode power
     between ell = 30 and 130. Filtered as ESA's image was (E and B, around 5 degrees) only
     about a sixth of what would be drawn is CMB signal. So only the E modes are kept, each
     weighted by the Wiener factor S / (S + N) measured from the maps themselves, with a cosine
     high-pass from ell = 20 to 30 (PR3's large-scale residuals) and a Gaussian low-pass of
     FIELD_FWHM_DEG: the best estimate of the sky's polarisation at patterns a few degrees
     across. The share of the drawn field that is signal is recorded (filter.signalFraction).
  3. Directions. Polarisation angle, IAU convention: psi = 1/2 atan2(U_IAU, Q), measured from
     Galactic north through east. The file is in the COSMO (HEALPix) convention
     (POLCCONV = 'COSMO'), whose U has the opposite sign: U_IAU = -U. Each pixel's Q and U
     become a tangent tensor on the sphere, P = Q (n n - e e) + U_IAU (n e + e n) with n and
     e the unit vectors toward north and east there, so they interpolate without any frame.
  4. Lines. Streamlines are traced on the sphere along the direction field and drawn at every
     texel centre of the temperature texture's own grid (projection.py: the same (l, b) per
     texel, rows bottom-up). The texture therefore needs no angle convention at run time: it is
     sampled at exactly the (u, v) of the temperature texel.
  5. Opacity. The lines fade with the apodised mask (masked areas are exactly neutral) and
     where the filtered polarisation is weak (its direction is then mostly noise), and stop there.

Checks (they stop the pipeline when they fail; numbers go to cmb-polarisation.json):

  * Convention, against the sky's own physics: around temperature hot spots the CMB is
    polarised tangentially at about 0.6 degrees and radially at about 1.2 degrees, and around
    cold spots the other way round (Komatsu et al. 2011, ApJS 192, 18, section 7; seen by
    Planck: Planck 2015 results XVI, A&A 594, A16, section 8). The same direction code that
    draws the lines is stacked around the map's own extrema. With the wrong sign of U (COSMO
    read as IAU) or a mirrored longitude, the rings average to nothing; with angles turned by
    90 degrees, they swap.
  * Texture frame: the lines' orientation measured in the published texture, read back and
    through the (u, v) convention of cmb.json, must follow the filtered directions, and must
    not when longitude is read the other way (the mirror).
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any

import healpy as hp
import numpy as np
from astropy.io import fits
from numpy.typing import NDArray
from PIL import Image

import config
import projection
import streamlines

FloatArray = NDArray[np.float64]

WORK = config.WORK / "polarisation"
FILE_NAME = "cmb-polarisation-2048.ktx2"
MANIFEST_NAME = "cmb-polarisation.json"
WIDTH = 2048
HEIGHT = 1024

EXPECTED_POLCCONV = "COSMO"
# HEALPix pixels at or below this are the FITS BAD_DATA sentinel (-1.6375e30).
BAD_THRESHOLD = -1.0e30

# --- Mask -------------------------------------------------------------------
MASK_NSIDE = 256
APODISE_DEG = 4.0

# --- Field ------------------------------------------------------------------
# E modes only, Wiener-weighted by how well Planck measured each scale, then band-limited:
# a cosine high-pass from ell = 20 to 30 and a Gaussian low-pass of FIELD_FWHM_DEG.
HIGHPASS_ELL = (20, 30)
FIELD_FWHM_DEG = 3.0
# Running mean over this many multipoles before the signal and noise power are compared.
WIENER_SMOOTH_ELL = 11
FIELD_NSIDE = 256
TRANSFORM_LMAX = 1024

# --- Lines (evenly spaced streamlines, streamlines.py) ------------------------------
# Lines fade out where the filtered polarisation amplitude falls from the second of these
# fractions of its median to the first (its direction is then mostly noise), and stop there.
WEAK_FRACTION = (0.15, 0.4)
# Texture code of "no line" (x = 0); a texel stores 128 + 127 x.
NEUTRAL_CODE = 128
# x is kept in steps of 1/LINE_STEPS (15 levels): the lines' shading looks the same on the
# globe as with all 255, and the file is smaller.
LINE_STEPS = 7
# What the line texture may add to Chapter 2's download.
BUDGET_BYTES = 1_100_000

# --- Checks ---------------------------------------------------------------------
STACK_FWHM_ARCMIN = 20.0
STACK_NSIDE = 512
STACK_RADIUS_DEG = 2.0
# Bin edges 0.1, 0.3, ... 1.9: bins centred on 0.2, 0.4, ... 1.8 degrees.
STACK_BINS_DEG = np.round(np.arange(0.1, 2.0, 0.2), 2)
ACOUSTIC_DEG = 0.6
TWICE_ACOUSTIC_DEG = 1.2

KTX = config.KTX_PREFIX / "bin" / "ktx"
KTX_ARGS = [
    "create",
    "--format", "R8_UNORM",
    "--assign-tf", "linear",
    "--assign-texcoord-origin", "bottom-left",
    "--generate-mipmap",
    "--mipmap-filter", "box",
    "--zstd", "19",
]


# ------------------------------------------------------------------------------
# Geometry
# ------------------------------------------------------------------------------


def unit_vectors(lon_deg: FloatArray, lat_deg: FloatArray) -> FloatArray:
    """Galactic Cartesian unit vectors (x toward l = 0, y toward l = 90, z toward the north pole)."""
    l, b = np.radians(lon_deg), np.radians(lat_deg)
    return np.stack([np.cos(b) * np.cos(l), np.cos(b) * np.sin(l), np.sin(b)], axis=-1)


def north_east(x: FloatArray) -> tuple[FloatArray, FloatArray]:
    """Unit vectors toward Galactic north (increasing b) and east (increasing l) at points x (..., 3)."""
    east = np.stack([-x[..., 1], x[..., 0], np.zeros_like(x[..., 0])], axis=-1)
    east /= np.maximum(np.linalg.norm(east, axis=-1, keepdims=True), 1e-12)
    north = np.cross(x, east)
    return north, east


def tensor_from_stokes(q: FloatArray, u_iau: FloatArray, x: FloatArray) -> FloatArray:
    """P = Q (n n - e e) + U (n e + e n) at points x: the six components xx, xy, xz, yy, yz, zz (6, N)."""
    n, e = north_east(x)
    out = np.empty((6, x.shape[0]))
    for k, (i, j) in enumerate(((0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2))):
        out[k] = q * (n[:, i] * n[:, j] - e[:, i] * e[:, j]) + u_iau * (n[:, i] * e[:, j] + e[:, i] * n[:, j])
    return out


def quadratic_form(tensor: FloatArray, a: FloatArray, b: FloatArray) -> FloatArray:
    """a^T P b for the symmetric tensor given by its six components (6, N) and vectors a, b (N, 3)."""
    xx, xy, xz, yy, yz, zz = tensor
    return (
        a[:, 0] * (xx * b[:, 0] + xy * b[:, 1] + xz * b[:, 2])
        + a[:, 1] * (xy * b[:, 0] + yy * b[:, 1] + yz * b[:, 2])
        + a[:, 2] * (xz * b[:, 0] + yz * b[:, 1] + zz * b[:, 2])
    )


def direction_from_tensor(tensor: FloatArray, x: FloatArray) -> tuple[FloatArray, FloatArray]:
    """Polarisation direction (unit tangent, headless) and amplitude at x, from the tensor there.

    In the local (north, east) frame Q = n^T P n and U = n^T P e; psi = 1/2 atan2(U, Q) is the
    IAU angle from north through east, and the direction is cos(psi) n + sin(psi) e.
    """
    n, e = north_east(x)
    q = quadratic_form(tensor, n, n)
    u = quadratic_form(tensor, n, e)
    psi = 0.5 * np.arctan2(u, q)
    d = np.cos(psi)[:, None] * n + np.sin(psi)[:, None] * e
    return d, np.hypot(q, u)


def interp(maps: FloatArray, nside: int, x: FloatArray) -> FloatArray:
    """Bilinear HEALPix interpolation of one or more RING maps (k, npix) at unit vectors x (N, 3)."""
    theta = np.arccos(np.clip(x[:, 2], -1.0, 1.0))
    phi = np.arctan2(x[:, 1], x[:, 0])
    pix, w = hp.get_interp_weights(nside, theta, phi)
    return np.einsum("kpn,pn->kn", maps[:, pix], w) if maps.ndim == 2 else np.sum(maps[pix] * w, axis=0)


# ------------------------------------------------------------------------------
# Source
# ------------------------------------------------------------------------------


def _header_str(header: fits.Header, key: str) -> str:
    return str(header.get(key, "")).strip()


def read_source() -> tuple[dict[str, FloatArray], dict[str, Any]]:
    """I (inpainted, as the temperature texture; for the check's extrema only), Q, U (uK, COSMO) and PMASK, in RING order."""
    with fits.open(config.FITS_PATH, memmap=True) as hdul:
        table = hdul[1]
        header = table.header
        names = [_header_str(header, f"TTYPE{i}") for i in range(1, int(header["TFIELDS"]) + 1)]
        info = {
            "polcconv": _header_str(header, "POLCCONV").upper(),
            "ordering": _header_str(header, "ORDERING").upper(),
            "coordsys": _header_str(header, "COORDSYS").upper(),
            "nside": int(header["NSIDE"]),
            "columns": ["Q_STOKES", "U_STOKES", "PMASK"],
        }
        for column in ("Q_STOKES", "U_STOKES", "I_STOKES_INP"):
            unit = _header_str(header, f"TUNIT{names.index(column) + 1}")
            if unit != config.EXPECTED_UNIT:
                raise SystemExit(f"Unexpected unit {unit!r} for {column}")
        maps = {
            "i": np.array(table.data.field("I_STOKES_INP"), dtype=np.float64),
            "q": np.array(table.data.field("Q_STOKES"), dtype=np.float64),
            "u": np.array(table.data.field("U_STOKES"), dtype=np.float64),
            "pmask": np.array(table.data.field("PMASK"), dtype=np.float64),
        }
    if info["polcconv"] != EXPECTED_POLCCONV:
        raise SystemExit(f"POLCCONV is {info['polcconv']!r}; this pipeline converts from {EXPECTED_POLCCONV}")
    if info["coordsys"] != config.EXPECTED_COORDSYS:
        raise SystemExit(f"Unexpected coordinate system {info['coordsys']!r}")
    if info["ordering"] == "NESTED":
        for key in maps:
            maps[key] = hp.reorder(maps[key], n2r=True)
    elif info["ordering"] != "RING":
        raise SystemExit(f"Unknown HEALPix ordering {info['ordering']!r}")

    keep = maps["pmask"] > 0.5
    bad = ~np.isfinite(maps["q"]) | ~np.isfinite(maps["u"]) | (maps["q"] <= BAD_THRESHOLD) | (maps["u"] <= BAD_THRESHOLD)
    info["badPixelsInsideMask"] = int(np.sum(bad & keep))
    if info["badPixelsInsideMask"]:
        raise SystemExit(f"{info['badPixelsInsideMask']} bad Q/U pixels where PMASK keeps them")
    for key in ("q", "u", "i"):
        maps[key] = np.where(bad & (key != "i"), 0.0, maps[key]) * config.K_TO_MICROKELVIN
    info["pmaskSkyFraction"] = round(float(np.mean(keep)), 4)
    return maps, info


# ------------------------------------------------------------------------------
# Mask
# ------------------------------------------------------------------------------


def apodised_mask(pmask: FloatArray) -> FloatArray:
    """PMASK at MASK_NSIDE: 0 wherever any of its pixels is masked, then a cosine rise over APODISE_DEG.

    Distances to the masked set are shortest paths over the 8-neighbour graph (within a few
    per cent of the great-circle distance), which is all a taper needs.
    """
    good = hp.ud_grade(pmask, MASK_NSIDE, power=0) > 0.999
    npix = hp.nside2npix(MASK_NSIDE)
    neighbours = hp.get_all_neighbours(MASK_NSIDE, np.arange(npix))
    centres = np.stack(hp.pix2vec(MASK_NSIDE, np.arange(npix)), axis=-1)
    valid = neighbours >= 0
    safe = np.where(valid, neighbours, 0)
    steps = np.degrees(np.arccos(np.clip(np.sum(centres[safe] * centres[None, :, :], axis=-1), -1.0, 1.0)))
    steps = np.where(valid, steps, np.inf)
    distance = np.where(good, np.inf, 0.0)
    for _ in range(int(APODISE_DEG / hp.nside2resol(MASK_NSIDE, arcmin=True) * 60) + 8):
        relaxed = np.min(distance[safe] + steps, axis=0)
        updated = np.minimum(distance, relaxed)
        if np.array_equal(updated, distance):
            break
        distance = updated
    ramp = np.clip(distance / APODISE_DEG, 0.0, 1.0)
    return 0.5 - 0.5 * np.cos(np.pi * ramp)


def mask_at(mask: FloatArray, nside: int, binary: FloatArray | None = None) -> FloatArray:
    """The apodised mask interpolated to another resolution's pixel centres (times a binary mask there)."""
    npix = hp.nside2npix(nside)
    out = np.empty(npix)
    chunk = 1 << 22
    for start in range(0, npix, chunk):
        stop = min(start + chunk, npix)
        theta, phi = hp.pix2ang(nside, np.arange(start, stop))
        out[start:stop] = hp.get_interp_val(mask, theta, phi)
    if binary is not None:
        out *= binary > 0.5
    return out


# ------------------------------------------------------------------------------
# Filter and stack
# ------------------------------------------------------------------------------


def _running_mean(values: FloatArray, width: int) -> FloatArray:
    pad = width // 2
    return np.convolve(np.pad(values, (pad, pad), mode="edge"), np.ones(width) / width, mode="valid")


def field_filter(cl_ee: FloatArray, cl_bb: FloatArray) -> dict[str, FloatArray]:
    """Weights for the E modes: Wiener S / (S + N) times the band, from the maps' own spectra.

    N is the B-mode power (at these scales the CMB's own B modes are far below Planck's noise,
    so what B holds is noise and foreground residuals) and S = E - N. Both are pseudo-spectra of
    the same masked maps, so the mask's sky fraction cancels in the ratio.
    """
    ell = np.arange(cl_ee.size, dtype=np.float64)
    total = _running_mean(cl_ee, WIENER_SMOOTH_ELL)
    noise = _running_mean(cl_bb, WIENER_SMOOTH_ELL)
    signal = np.clip(total - noise, 0.0, None)
    wiener = np.where(total > 0, signal / np.maximum(total, 1e-30), 0.0)
    low, high = HIGHPASS_ELL
    ramp = np.clip((ell - low) / (high - low), 0.0, 1.0)
    band = (0.5 - 0.5 * np.cos(np.pi * ramp)) * hp.gauss_beam(np.radians(FIELD_FWHM_DEG), lmax=cl_ee.size - 1)
    return {"ell": ell, "signal": signal, "total": total, "wiener": wiener, "weights": wiener * band}


def _filter_report(f: dict[str, FloatArray]) -> dict[str, Any]:
    ell, weights, signal, total = f["ell"], f["weights"], f["signal"], f["total"]
    modes = (2 * ell + 1) * weights**2
    shown = modes * signal
    cumulative = np.cumsum(shown) / np.sum(shown)
    return {
        "description": (
            "E modes only (B set to zero), each multipole weighted by the Wiener factor S/(S+N) from the maps' own "
            f"spectra (N = B-mode power, S = E - N, running mean over {WIENER_SMOOTH_ELL} multipoles), a cosine "
            f"high-pass from ell {HIGHPASS_ELL[0]} to {HIGHPASS_ELL[1]} and a Gaussian low-pass of FWHM {FIELD_FWHM_DEG} deg."
        ),
        "fwhmDeg": FIELD_FWHM_DEG,
        "highpassEll": list(HIGHPASS_ELL),
        "signalFraction": round(float(np.sum(shown) / np.sum(modes * total)), 3),
        "signalEllQuartiles": [int(np.searchsorted(cumulative, q)) for q in (0.25, 0.5, 0.75)],
        "wienerAt": {str(l): round(float(f["wiener"][l]), 3) for l in (30, 45, 60, 80, 100, 130)},
    }


def transforms(maps: dict[str, FloatArray], mask2048: FloatArray) -> dict[str, Any]:
    """One T,E,B transform of the masked maps; the filtered Q, U and the stack maps from it."""
    t0 = time.monotonic()
    alms = hp.map2alm([maps["i"], maps["q"] * mask2048, maps["u"] * mask2048], lmax=TRANSFORM_LMAX, pol=True, iter=0)
    cl = hp.alm2cl(alms)  # TT, EE, BB, TE, EB, TB
    f = field_filter(cl[1], cl[2])
    zero = np.zeros(TRANSFORM_LMAX + 1)
    filtered = [hp.almxfl(alms[0], zero), hp.almxfl(alms[1], f["weights"]), hp.almxfl(alms[2], zero)]
    _, q_field, u_field = hp.alm2map(filtered, FIELD_NSIDE, lmax=TRANSFORM_LMAX, pol=True)
    beam = hp.gauss_beam(np.radians(STACK_FWHM_ARCMIN / 60.0), lmax=TRANSFORM_LMAX)
    t_s, q_s, u_s = hp.alm2map([hp.almxfl(a, beam) for a in alms], STACK_NSIDE, lmax=TRANSFORM_LMAX, pol=True)
    return {
        "q_field": q_field, "u_field": u_field, "t_s": t_s, "q_s": q_s, "u_s": u_s,
        "filter": _filter_report(f),
        "seconds": round(time.monotonic() - t0, 1),
    }


def stack_profiles(t_s: FloatArray, q_s: FloatArray, u_s: FloatArray, mask_stack: FloatArray) -> dict[str, Any]:
    """Radial polarisation (positive radial, negative tangential) stacked around temperature extrema.

    Every local extremum of the smoothed temperature (hot: a maximum above zero; cold: a minimum
    below) more than APODISE_DEG inside the mask; the radial Stokes parameter r^T P r, with r the
    unit tangent pointing away from the extremum, averaged in rings, then over extrema. Uses the
    same tensor and direction code as the lines, with U_IAU = -U. Control: U left with the file's
    COSMO sign (the same as mirrored longitude). Turning every angle by 90 degrees would negate P,
    and so swap radial and tangential: the signs themselves test that.
    """
    nside = STACK_NSIDE
    npix = hp.nside2npix(nside)
    neighbours = hp.get_all_neighbours(nside, np.arange(npix))
    nb = np.where(neighbours >= 0, t_s[np.where(neighbours >= 0, neighbours, 0)], np.nan)
    inside = mask_stack >= 0.999
    hot = inside & (t_s > 0) & np.all(t_s[None, :] > np.nan_to_num(nb, nan=-np.inf), axis=0)
    cold = inside & (t_s < 0) & np.all(t_s[None, :] < np.nan_to_num(nb, nan=np.inf), axis=0)
    centres = np.stack(hp.pix2vec(nside, np.arange(npix)), axis=-1)
    variants = {
        "iau": tensor_from_stokes(q_s, -u_s, centres),
        "controlCosmoSign": tensor_from_stokes(q_s, u_s, centres),
    }
    bins = STACK_BINS_DEG
    out: dict[str, Any] = {}
    for name, peaks in (("hot", np.flatnonzero(hot)), ("cold", np.flatnonzero(cold))):
        per_peak: dict[str, list[FloatArray]] = {k: [] for k in variants}
        for p in peaks:
            disc = hp.query_disc(nside, centres[p], np.radians(STACK_RADIUS_DEG))
            x = centres[disc]
            cosang = np.clip(x @ centres[p], -1.0, 1.0)
            theta = np.degrees(np.arccos(cosang))
            radial = x * cosang[:, None] - centres[p][None, :]
            norm = np.linalg.norm(radial, axis=-1)
            ok = norm > 1e-9
            radial = radial[ok] / norm[ok, None]
            idx = np.digitize(theta[ok], bins) - 1
            use = (idx >= 0) & (idx < bins.size - 1)
            for key, tensor in variants.items():
                qr = quadratic_form(tensor[:, disc[ok]], radial, radial)
                prof = np.bincount(idx[use], weights=qr[use], minlength=bins.size - 1)
                n = np.bincount(idx[use], minlength=bins.size - 1)
                per_peak[key].append(np.where(n > 0, prof / np.maximum(n, 1), 0.0))
        result: dict[str, Any] = {"peaks": int(peaks.size)}
        for key in variants:
            arr = np.array(per_peak[key])
            mean = arr.mean(axis=0)
            err = arr.std(axis=0) / np.sqrt(arr.shape[0])
            result[key] = {"radialUk": [round(float(v), 4) for v in mean], "errorUk": [round(float(v), 4) for v in err]}
        out[name] = result
    out["binsDeg"] = [round(float(b), 2) for b in bins]
    return out


def judge_stack(stack: dict[str, Any]) -> dict[str, Any]:
    """The signs Komatsu et al. 2011 and Planck 2015 XVI describe, with their significance."""
    centres = 0.5 * (np.array(stack["binsDeg"][:-1]) + np.array(stack["binsDeg"][1:]))

    def at(kind: str, variant: str, deg: float) -> tuple[float, float]:
        i = int(np.argmin(np.abs(centres - deg)))
        return stack[kind][variant]["radialUk"][i], stack[kind][variant]["errorUk"][i]

    verdict: dict[str, Any] = {"description": (
        "radial polarisation (uK; positive radial, negative tangential) in the bins nearest 0.6 and 1.2 degrees. "
        "Expected: hot spots tangential at 0.6 and radial at 1.2; cold spots the reverse (Komatsu et al. 2011, "
        "section 7; Planck 2015 results XVI, section 8). The COSMO-sign control (U not converted, the same as a "
        "mirrored longitude) must lose the rings."
    )}
    ok = True
    for kind, sign in (("hot", 1.0), ("cold", -1.0)):
        v06, e06 = at(kind, "iau", ACOUSTIC_DEG)
        v12, e12 = at(kind, "iau", TWICE_ACOUSTIC_DEG)
        c06, _ = at(kind, "controlCosmoSign", ACOUSTIC_DEG)
        c12, _ = at(kind, "controlCosmoSign", TWICE_ACOUSTIC_DEG)
        sig06, sig12 = -sign * v06 / e06, sign * v12 / e12
        verdict[kind] = {
            "at0p6": v06, "at1p2": v12, "sigma0p6": round(sig06, 1), "sigma1p2": round(sig12, 1),
            "controlCosmoSign0p6": c06, "controlCosmoSign1p2": c12,
        }
        ok &= sig06 > 5 and sig12 > 5
        ok &= abs(c06) < 0.25 * abs(v06) and abs(c12) < 0.25 * abs(v12)
    verdict["pass"] = bool(ok)
    return verdict


# ------------------------------------------------------------------------------
# Lines
# ------------------------------------------------------------------------------


def _field_at(field_tensor: FloatArray, amplitude_ref: float, display_mask: FloatArray, width: int, height: int) -> dict[str, FloatArray]:
    """The field at the texel centres of a top-down width x height grid: tensor, direction, opacity, mask."""
    lon, lat = projection.texel_centres(width, height)
    x = unit_vectors(lon.ravel(), lat.ravel())
    tensor = interp(field_tensor, FIELD_NSIDE, x)
    d, amplitude = direction_from_tensor(tensor, x)
    weak = np.clip((amplitude / amplitude_ref - WEAK_FRACTION[0]) / (WEAK_FRACTION[1] - WEAK_FRACTION[0]), 0.0, 1.0)
    mask = interp(display_mask, MASK_NSIDE, x)
    return {
        "tensor": tensor.T.reshape(height, width, 6),
        "direction": d.reshape(height, width, 3),
        "opacity": (mask * weak * weak * (3 - 2 * weak)).reshape(height, width),
        "mask": mask.reshape(height, width),
    }


def draw_lines(field_tensor: FloatArray, amplitude_ref: float, display_mask: FloatArray) -> dict[str, Any]:
    """Evenly spaced streamlines (streamlines.py) drawn at the texel centres of the WIDTH x HEIGHT grid.

    Returns the line value in -1..0 (0 = no line; the lines only darken), with the field's
    direction, the opacity and the mask at each texel, rows top-down (north first), and the
    lines' count and length.
    """
    coarse = _field_at(field_tensor, amplitude_ref, display_mask, WIDTH // 2, HEIGHT // 2)
    lines = streamlines.trace(streamlines.FieldGrid(coarse["tensor"], coarse["opacity"]))
    dark = streamlines.rasterise(lines, WIDTH, HEIGHT)
    fine = _field_at(field_tensor, amplitude_ref, display_mask, WIDTH, HEIGHT)
    # Nothing at all where the mask is zero, whatever the rasteriser's reach.
    dark = np.where(fine["mask"] > 0.0, dark, 0.0)
    return {
        "line": -dark,
        "direction": fine["direction"],
        "opacity": fine["opacity"],
        "mask": fine["mask"],
        "count": len(lines),
        "lengthDeg": round(sum((len(p) - 1) * streamlines.STEP_DEG for p, _ in lines)),
    }


def orientation_check(value: FloatArray, direction: FloatArray, contrast: FloatArray, lon_increases: str) -> dict[str, Any]:
    """Line orientation in the texture, read through cmb.json's (u, v) convention, vs the field.

    The structure tensor of the texture (smoothed gradient outer products) has its minor axis
    along the lines. Texel steps are converted to angles on the sky: one texel in u is
    360/W degrees of longitude times cos(b), toward east when longitude increases to the right
    as stored and toward west when it increases to the left; one texel up in v is 180/H degrees
    north. Rows here are top-down (north first), as projection.texel_centres gives them.
    """
    lon, lat = projection.texel_centres(WIDTH, HEIGHT)
    gy, gx = np.gradient(value)  # gy: per row downward (south), gx: per column (increasing u)
    east_per_u = 1.0 if lon_increases == "right" else -1.0
    cosb = np.cos(np.radians(lat))
    # Gradient in sky units (per degree east, per degree north).
    g_east = gx / (360.0 / WIDTH * np.maximum(cosb, 1e-3)) * east_per_u
    g_north = -gy / (180.0 / HEIGHT)

    def smooth(a: FloatArray) -> FloatArray:
        k = np.ones(9) / 9.0
        a = np.apply_along_axis(lambda r: np.convolve(np.concatenate([r[-4:], r, r[:4]]), k, mode="valid"), 1, a)
        return np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, a)

    jee, jnn, jen = smooth(g_east * g_east), smooth(g_north * g_north), smooth(g_east * g_north)
    # Gradient direction angle (from north through east): the lines are perpendicular to it.
    grad_angle = 0.5 * np.arctan2(2 * jen, jnn - jee)
    streak = grad_angle + np.pi / 2
    n, e = north_east(unit_vectors(lon.ravel(), lat.ravel()))
    d = direction.reshape(-1, 3)
    field = np.arctan2(np.sum(d * e, axis=-1), np.sum(d * n, axis=-1)).reshape(value.shape)
    use = (contrast > 0.8) & (np.abs(lat) < 75)
    agreement = float(np.mean(np.cos(2 * (streak[use] - field[use]))))
    mirrored = float(np.mean(np.cos(2 * (-streak[use] - field[use]))))
    return {
        "description": (
            "mean cos 2(angle between the lines measured in the texture and the field's direction) over texels "
            "with full contrast within 75 degrees of the Galactic equator: 1 = parallel everywhere, 0 = unrelated. "
            "The control reads longitude the other way round (the mirror)."
        ),
        "texels": int(np.sum(use)),
        "agreement": round(agreement, 3),
        "controlMirroredLon": round(mirrored, 3),
        "pass": bool(agreement > 0.5 and abs(mirrored) < 0.2),
    }


# ------------------------------------------------------------------------------
# Build
# ------------------------------------------------------------------------------


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_polarisation() -> dict[str, Any]:
    """Runs every stage from the FITS file (about a minute; nothing is cached between runs)."""
    WORK.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    maps, source = read_source()
    display_mask = apodised_mask(maps["pmask"])
    result = transforms(maps, mask_at(display_mask, source["nside"], maps["pmask"]))
    del maps
    stack = stack_profiles(result["t_s"], result["q_s"], result["u_s"], mask_at(display_mask, STACK_NSIDE))
    q_field, u_field = result["q_field"], result["u_field"]
    report: dict[str, Any] = {
        "source": source,
        "filter": result["filter"],
        "stack": stack,
        "stackVerdict": judge_stack(stack),
        "seconds": {"transforms": result["seconds"]},
    }
    print(json.dumps(report["stackVerdict"], indent=2))
    if not report["stackVerdict"]["pass"]:
        raise SystemExit("polarisation convention check failed (see the stack verdict above)")

    centres = np.stack(hp.pix2vec(FIELD_NSIDE, np.arange(hp.nside2npix(FIELD_NSIDE))), axis=-1)
    field_mask = mask_at(display_mask, FIELD_NSIDE)
    tensor = tensor_from_stokes(q_field, -u_field, centres)
    amplitude = np.hypot(q_field, u_field)
    amplitude_ref = float(np.median(amplitude[field_mask >= 0.999]))
    t_lines = time.monotonic()
    lines = draw_lines(tensor, amplitude_ref, display_mask)
    report["seconds"]["lines"] = round(time.monotonic() - t_lines, 1)
    print(f"{lines['count']} lines, {lines['lengthDeg']} degrees in all, in {report['seconds']['lines']} s")

    codes = encode_line(lines["line"])
    png = WORK / f"polarisation-{WIDTH}-bottom-up.png"
    Image.fromarray(np.flipud(codes), mode="L").save(png, optimize=True)
    out = config.PUBLIC / FILE_NAME
    result_ktx = subprocess.run([str(KTX), *KTX_ARGS, str(png), str(out)], capture_output=True, text=True, check=False)
    if result_ktx.returncode != 0:
        raise SystemExit(f"ktx create failed: {result_ktx.stderr}")
    if out.stat().st_size > BUDGET_BYTES:
        raise SystemExit(f"{out.name} is {out.stat().st_size} bytes, over its {BUDGET_BYTES}-byte budget")

    # Read the published file back: level 0, rows as stored (bottom-up), must equal what was written.
    extracted = WORK / "decoded-level0.png"
    extracted.unlink(missing_ok=True)
    result_x = subprocess.run([str(KTX), "extract", "--level", "0", str(out), str(extracted)], capture_output=True, text=True, check=False)
    if result_x.returncode != 0:
        raise SystemExit(f"ktx extract failed: {result_x.stderr}")
    # ktx writes a single-channel level as a palette PNG whose entries carry the value in red.
    decoded = np.flipud(np.asarray(Image.open(extracted).convert("RGB"))[..., 0])
    if not np.array_equal(decoded, codes):
        raise SystemExit("the KTX2 file does not hold the texture written (or not bottom-up)")

    cmb = json.loads((config.PUBLIC / "cmb.json").read_text(encoding="utf-8"))
    orientation = orientation_check(decode_line(decoded), lines["direction"], lines["opacity"], cmb["lonIncreases"])
    print(json.dumps(orientation, indent=2))
    if not orientation["pass"]:
        raise SystemExit("texture orientation check failed")

    masked = lines["mask"] <= 0.0
    report.update({
        "file": FILE_NAME,
        "bytes": out.stat().st_size,
        "sha256": _sha256(out),
        "cmb": {key: cmb[key] for key in ("projection", "frame", "uAtLon0", "lonIncreases")},
        "orientation": orientation,
        "lossless": True,
        "maskedTexels": int(np.sum(masked)),
        "neutralWhereMasked": bool(np.all(codes[masked] == NEUTRAL_CODE)),
        "amplitudeMedianUk": round(amplitude_ref, 4),
        "lineCount": lines["count"],
        "lineLengthDeg": lines["lengthDeg"],
        "fractionOfTexelsOnLines": round(float(np.mean(np.abs(lines["line"]) > 0.05)), 3),
        "seconds": {**report.get("seconds", {}), "all": round(time.monotonic() - t0, 1)},
    })
    if not report["neutralWhereMasked"]:
        raise SystemExit("some masked texels carry lines")
    return report


def encode_line(line: FloatArray) -> NDArray[np.uint8]:
    """-1..1 -> 1..255, with 0 exactly at NEUTRAL_CODE: code = 128 + 127 x, x in steps of 1/LINE_STEPS."""
    steps = np.rint(np.clip(line, -1.0, 1.0) * LINE_STEPS) / LINE_STEPS
    return np.rint(NEUTRAL_CODE + 127.0 * steps).astype(np.uint8)


def decode_line(codes: NDArray[np.uint8]) -> FloatArray:
    return (codes.astype(np.float64) - NEUTRAL_CODE) / 127.0


def _versions() -> dict[str, str]:
    import platform
    from importlib import metadata

    return {"python": platform.python_version(), **{name: metadata.version(name) for name in ("healpy", "astropy", "numpy", "pillow")}}


def build_manifest(report: dict[str, Any]) -> dict[str, Any]:
    """public/assets/cmb/cmb-polarisation.json: what Chapter 2 needs, with provenance and the checks.

    Kept apart from cmb.json, which the interface fetches at startup (its bytes count toward the
    shell's loading budget); this one loads with Chapter 2.
    """
    source = report["source"]
    return {
        "$comment": "Generated by scripts/preprocess-cmb.sh (scripts/cmb/polarisation.py). Do not edit by hand.",
        "file": report["file"],
        "width": WIDTH,
        "height": HEIGHT,
        "bytes": report["bytes"],
        "sha256": report["sha256"],
        **report["cmb"],
        "rows": "bottom-up (v = 0 is the south galactic pole), texel for texel the grid of the temperature texture (cmb.json)",
        "format": "R8_UNORM, linear, zstd level 19 supercompression (lossless), box-filtered mip chain",
        "encoding": (
            f"line x = (255 s - {NEUTRAL_CODE}) / 127 in -1..1 (stored in steps of 1/{LINE_STEPS}), s the sampled value: "
            f"0 (code {NEUTRAL_CODE}) is no line "
            "(masked, or too little polarisation); negative is a line, -1 its darkest. "
            "Lines run along the direction of polarisation."
        ),
        "shows": (
            "The direction of polarisation of the CMB as evenly spaced streamlines along it (Jobard & Lefer 1997): "
            "the directions are measured; where the lines start, and how far apart they are, is not."
        ),
        "convention": (
            "IAU: psi = 1/2 atan2(U_IAU, Q) from Galactic north through east, with U_IAU = -U of the file "
            f"(POLCCONV = '{source['polcconv']}')."
        ),
        "filter": report["filter"],
        "mask": {
            "column": "PMASK",
            "skyFractionKept": source["pmaskSkyFraction"],
            "apodisation": f"0 inside, cosine rise over {APODISE_DEG} deg from the edge (holes included), at NSIDE {MASK_NSIDE}",
        },
        "lines": {
            "spacingDeg": streamlines.SPACING_DEG,
            "stopWithinDeg": streamlines.TEST_DEG,
            "stepDeg": streamlines.STEP_DEG,
            "lengthDeg": [streamlines.MIN_DEG, streamlines.MAX_DEG],
            "halfWidthDeg": [streamlines.CORE_DEG, streamlines.EDGE_DEG],
            "endTaperDeg": streamlines.TAPER_DEG,
            "seeds": f"beside the lines drawn so far, then a HEALPix NSIDE {streamlines.SEED_NSIDE} grid shuffled with seed {streamlines.SEED_ORDER}",
            "opacity": (
                f"the apodised mask times a smoothstep from {WEAK_FRACTION[0]} to {WEAK_FRACTION[1]} of the median "
                f"filtered polarisation ({report['amplitudeMedianUk']} uK); lines stop below {streamlines.MIN_OPACITY}"
            ),
            "count": report["lineCount"],
            "totalLengthDeg": report["lineLengthDeg"],
            "fractionOfTexelsOnLines": report["fractionOfTexelsOnLines"],
        },
        "credit": config.CREDIT,
        "source": {
            "file": config.FITS_NAME,
            "sha256": config.FITS_SHA256,
            "columns": source["columns"],
            "release": config.RELEASE,
            "method": config.METHOD,
            "url": config.FITS_URL,
        },
        "verification": {
            "stack": {**report["stackVerdict"], "profiles": report["stack"]},
            "orientation": report["orientation"],
            "losslessRoundTrip": report["lossless"],
            "neutralWhereMasked": report["neutralWhereMasked"],
        },
        "software": _versions(),
    }
