"""Writes the atmospheres a visitor descends through (docs/ATMOSPHERES.md, ledger GR-6) from the probes
that measured them, as public/assets/descent/<world>.json:

- Venus, the Pioneer Venus probes (9 December 1978; NASA Planetary Data System, pv_sed bundle,
  doi:10.17189/m5zf-6f12):
  - the Large Probe's lower-atmosphere state (Seiff, P.I.): altitude above the 6,052.0 km radius at
    its landing site (4.4 N, 304.0 E), pressure, temperature and density, from 64.8 km to the ground;
  - above it, the Day Probe's entry (128 to 70.5 km above the same radius), the nearest measured
    column above the clouds;
  - the Large Probe's nephelometer (Ragent and Blamont): backscatter through the clouds, placed at
    the altitudes the Large Probe's own clock gives.
- Jupiter, the Galileo probe (7 December 1995; NASA PDS volumes gp-j-asi-3-entry-v1.0,
  gp-j-nep-3-entry-v1.0, gp-j-dwe-3-entry-v1.0):
  - the Atmospheric Structure Instrument's entry profile (above the clouds, from 1,028 km) and its
    descent profile (from 0.44 bar to 22 bar), altitude above the 1-bar level (Seiff et al. 1998);
  - the nephelometer's scattering (Ragent et al. 1998), by pressure;
  - the Doppler Wind Experiment's winds (Atkinson et al. 1998), by pressure.

Every value is the table's; where the two Venus probes leave a gap (64.8 to 70.5 km) the profile
says so, and the explorer interpolates across it in log pressure. A row with a missing value (one of
Galileo's descent rows gives its density as zero) is left out. Each source file's sha256 is pinned.

Usage: python -I scripts/descent/profiles.py <download dir>   (downloads what is missing)
"""

from __future__ import annotations

import csv
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "descent"
PV = "https://atmos.nmsu.edu/PDS/data/PDS4/pv_sed_bundle"
GP = "https://pds.nasa.gov/data"
FILES = {
    "las_low_atm_state.csv": (f"{PV}/data_atm_struct/descent_low_atm/las_low_atm_state.csv", "c18ff2f2f1acbf01961a7a44446bb76b29c7e9cf52d01c3bbf1be948ee80da67"),
    "sas_day_mid_atm_state.csv": (f"{PV}/data_atm_struct/entry_mid_atm/sas_day_mid_atm_state.csv", "f05d4f39b7d2778faf194cc318ded20bea792dc3aec69083af91999896a1c4a1"),
    "ln_backscatter.csv": (f"{PV}/data_neph/ln_backscatter.csv", "3ce434de66228b401c06de166e9e1ce96d90e0d2f77ef006f85d392c7f0ab3ae"),
    "UPPERATM.TAB": (f"{GP}/gp-j-asi-3-entry-v1.0/gp_0001/DATA/ASI/UPPERATM.TAB", "26841499aef14990d9a38a212fd9fe7ef1e3572cece4204e47d5496e506ae7de"),
    "DESCENT.TAB": (f"{GP}/gp-j-asi-3-entry-v1.0/gp_0001/DATA/ASI/DESCENT.TAB", "85cb03e024e4c26342545abad4b19ed960400e29137bfd5bb8f8701bcdd70d79"),
    "SCATTER.TAB": (f"{GP}/gp-j-nep-3-entry-v1.0/gp_0001/DATA/NEP/SCATTER.TAB", "6e0aa697e50cface17b9f8e058736c621c25f27764d8aceecb65c8161e070073"),
    "WIND.TAB": (f"{GP}/gp-j-dwe-3-entry-v1.0/gp_0001/DATA/DWE/WIND.TAB", "0413c0eda8fd536ba324790d67e08bf8742ddc0399dec49a8b276e17f985af89"),
}


def fetch(folder: Path, name: str) -> Path:
    url, pinned = FILES[name]
    path = folder / name
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != pinned:
        raise SystemExit(f"{path}: sha256 {digest} is not the pinned {pinned}")
    return path


def clock_seconds(text: str) -> float:
    """Seconds of the day from "18:49.646" (hours and decimal minutes) or "18:49:18.5" (hours, minutes, seconds)."""
    parts = text.strip().split(":")
    if len(parts) == 2:
        return int(parts[0]) * 3600 + float(parts[1]) * 60
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])


def interp(x: float, xs: list[float], ys: list[float]) -> float:
    """Linear interpolation in a table whose xs increase."""
    if x <= xs[0]:
        return ys[0]
    for i in range(1, len(xs)):
        if x <= xs[i]:
            t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + (ys[i] - ys[i - 1]) * t
    return ys[-1]


def thin(rows: list[list[float]], step_km: float) -> list[list[float]]:
    """Keeps a row at least every step_km of altitude (the first and last always): the tables sample far finer than a view needs."""
    out = [rows[0]]
    for r in rows[1:-1]:
        if abs(r[0] - out[-1][0]) >= step_km:
            out.append(r)
    out.append(rows[-1])
    return out


def venus(folder: Path) -> dict:
    las_rows = []
    clock_to_alt: list[tuple[float, float]] = []
    with fetch(folder, "las_low_atm_state.csv").open() as f:
        for row in csv.reader(f):
            if len(row) < 7 or not row[0].strip()[:1].isdigit():
                continue
            alt, p, t, rho = float(row[2]), float(row[3]), float(row[4]), float(row[5])
            las_rows.append([alt, p, t, rho])
            clock_to_alt.append((clock_seconds(row[0]), alt))
    sas_rows = []
    with fetch(folder, "sas_day_mid_atm_state.csv").open() as f:
        for row in csv.reader(f):
            if len(row) < 8 or not row[0].strip()[:1].isdigit():
                continue
            alt, rho, p_mb, t = float(row[2]), float(row[5]), float(row[6]), float(row[7])
            sas_rows.append([alt, p_mb / 1000.0, t, rho])
    # Highest first: the Day Probe's above the clouds, then the Large Probe's.
    sas_rows.sort(key=lambda r: -r[0])
    las_rows.sort(key=lambda r: -r[0])
    layers = thin(sas_rows, 1.0) + thin(las_rows, 0.25)
    # The nephelometer by the Large Probe's own clock, placed at its altitudes (within the state table's span).
    clocks = [c for c, _ in clock_to_alt]
    alts = [a for _, a in clock_to_alt]
    order = sorted(range(len(clocks)), key=lambda i: clocks[i])
    clocks = [clocks[i] for i in order]
    alts = [alts[i] for i in order]
    clouds = []
    with fetch(folder, "ln_backscatter.csv").open() as f:
        for row in csv.reader(f):
            if len(row) < 2 or not row[0].strip()[:1].isdigit():
                continue
            t = clock_seconds(row[0])
            if t < clocks[0] or t > clocks[-1]:
                continue
            clouds.append([round(interp(t, clocks, alts), 3), float(row[1])])
    clouds.sort(key=lambda r: -r[0])
    return {
        "world": "venus",
        "probe": "Pioneer Venus Large Probe",
        "date": "1978-12-09",
        "site": {"latDeg": 4.4, "lonDeg": -56.0},
        "radiusKm": 6052.0,
        "altitude": "km above the 6,052.0 km radius at the Large Probe's landing site",
        "gapKm": [round(las_rows[0][0], 3), round(sas_rows[-1][0], 3)],
        "fields": ["altitudeKm", "pressureBar", "temperatureK", "densityKgM3"],
        "layers": [[round(a, 3), p, t, rho] for a, p, t, rho in layers],
        "clouds": {"quantity": "backscatter, 1/(m sr)", "rows": thin(clouds, 0.1)},
        "winds": None,
        "sourceIds": ["pds-pioneer-venus-sed"],
    }


def jupiter(folder: Path) -> dict:
    upper = []
    site = (0.0, 0.0)
    for line in fetch(folder, "UPPERATM.TAB").read_text().splitlines():
        v = line.split()
        if len(v) < 12:
            continue
        alt, p_mb, t, rho = float(v[1]), float(v[2]), float(v[3]), float(v[4])
        if alt <= 200:
            upper.append([alt, p_mb / 1000.0, t, rho])
        site = (float(v[10]), float(v[11]))
    descent = []
    for line in fetch(folder, "DESCENT.TAB").read_text().splitlines():
        v = line.split()
        if len(v) < 5:
            continue
        alt, p, t, rho = float(v[1]), float(v[2]), float(v[3]), float(v[4])
        # One row (15.37 km, 0.514 bar) gives its density as 0.00000: a missing value, so the row is left out.
        if p <= 0 or t <= 0 or rho <= 0:
            continue
        descent.append([alt, p, t, rho])
    upper.sort(key=lambda r: -r[0])
    descent.sort(key=lambda r: -r[0])
    top_of_descent = descent[0][0]
    layers = thin([r for r in upper if r[0] > top_of_descent], 1.0) + thin(descent, 0.5)
    # Pressure to altitude, by the profile (pressure increasing downward).
    by_p = sorted(((r[1], r[0]) for r in layers), key=lambda x: x[0])
    ps = [p for p, _ in by_p]
    zs = [z for _, z in by_p]
    clouds = []
    for line in fetch(folder, "SCATTER.TAB").read_text().splitlines():
        v = line.split()
        if len(v) < 6:
            continue
        p = float(v[0])
        # The forward channels (5.8, 16 and 40 degrees) averaged: counts above the background, not calibrated.
        counts = (float(v[1]) + float(v[2]) + float(v[3])) / 3.0
        clouds.append([round(interp(p, ps, zs), 3), round(counts, 1)])
    clouds.sort(key=lambda r: -r[0])
    winds = []
    for line in fetch(folder, "WIND.TAB").read_text().splitlines():
        v = line.split()
        if len(v) < 5:
            continue
        p, w = float(v[3]), float(v[4])
        winds.append([round(interp(p, ps, zs), 3), round(w, 2)])
    winds.sort(key=lambda r: -r[0])
    return {
        "world": "jupiter",
        "probe": "Galileo probe",
        "date": "1995-12-07",
        "site": {"latDeg": round(site[0], 2), "lonDeg": round(site[1], 2)},
        "radiusKm": None,
        "altitude": "km above the 1-bar level at the probe's entry site",
        "gapKm": None,
        "fields": ["altitudeKm", "pressureBar", "temperatureK", "densityKgM3"],
        "layers": [[round(a, 3), p, t, rho] for a, p, t, rho in layers],
        "clouds": {"quantity": "nephelometer counts, mean of the 5.8, 16 and 40 degree channels (uncalibrated)", "rows": thin(clouds, 0.25)},
        "winds": {"quantity": "m/s, westerly positive", "rows": thin(winds, 0.5)},
        "sourceIds": ["pds-galileo-probe-asi", "pds-galileo-probe-nep", "pds-galileo-probe-dwe"],
    }


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    for build in (venus, jupiter):
        profile = build(folder)
        (OUT / f"{profile['world']}.json").write_text(json.dumps(profile, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
