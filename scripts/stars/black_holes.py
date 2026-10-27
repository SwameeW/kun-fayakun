"""Writes the black holes the explorer can fly to (docs/NEIGHBOURHOOD.md, "Black holes") as
public/assets/stars/black-holes.json: for each, its place on the sky (SIMBAD's ICRS position, queried
here, the result's sha256 recorded), its distance and its mass with their uncertainties as the cited
papers give them (each value's source id in data/sources.json), the light model it is drawn with,
and, for the two the Event Horizon Telescope imaged, the ring it measured.

The masses and distances are typed here from the papers (facts, credited); nothing is fitted. TON
618's distance is the comoving distance of its redshift in Planck 2018's flat cosmology (the same the
survey's galaxies are placed by), integrated by this script; its mass is the single-epoch estimate
from its H-beta line, given as the range two calibrations of the same spectrum give (such estimates
are uncertain by a factor of about three).

Usage: python3 -I scripts/stars/black_holes.py <download dir>   (queries SIMBAD if its result is missing)
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "stars" / "black-holes.json"
SIMBAD = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"
QUERY = ("simbad_bh.csv", "SELECT i.id, b.main_id, b.ra, b.dec FROM ident AS i JOIN basic AS b ON i.oidref = b.oid WHERE i.id IN ('NAME Sgr A*', 'M 87', 'Ton 618', 'Gaia DR3 4373465352415301632', 'Gaia DR3 5870569352746779008', 'Gaia DR3 4318465066420528000', 'HD 226868') ORDER BY 1")
# Planck 2018 VI (table 2, TT,TE,EE+lowE+lensing+BAO), as astropy's Planck18: H0, the matter density, the CMB's temperature, Neff.
COSMOLOGY = {"H0": 67.66, "Om0": 0.30966, "Tcmb": 2.7255, "Neff": 3.046}
C_KM_S = 299_792.458
G_M_SUN_KM = 1.32712440018e11  # IAU 2015 B3, km^3 s^-2
AU_KM = 149_597_870.7

# id, name, SIMBAD identifier, kind, model; mass [value, minus, plus] (Suns) and its source(s); distance (pc) [value, minus, plus] and its source; companion; observation.
HOLES = [
    {
        "id": "sgr-a", "name": "Sagittarius A*", "simbad": "NAME Sgr A*", "kind": "supermassive", "model": "hot-ring",
        "mass": {"value": 4.297e6, "minus": 0.042e6, "plus": 0.042e6, "source": "gravity-2022-sgr-a", "how": "the orbits of the stars round it (S2 and others), 0.012 statistical and 0.040 systematic (millions of Suns) combined"},
        "distance": {"pc": 8277, "minus": 31, "plus": 31, "source": "gravity-2022-sgr-a", "how": "the same orbits: 8,277 +/- 9 +/- 30 pc"},
        "observation": {"ringMicroArcsec": 51.8, "error": 2.3, "source": "eht-2022-sgr-a"},
        "inclinationDeg": 30, "inclinationNote": "illustrative: the Event Horizon Telescope's models disfavour more than 50 degrees",
    },
    {
        "id": "m87", "name": "M87*", "simbad": "M 87", "kind": "supermassive", "model": "hot-ring",
        "mass": {"value": 6.5e9, "minus": 0.73e9, "plus": 0.73e9, "source": "eht-2019-m87", "how": "the size of its ring, 0.2 statistical and 0.7 systematic (billions of Suns) combined"},
        "distance": {"pc": 16.8e6, "minus": 0.7e6, "plus": 0.8e6, "source": "eht-2019-m87", "how": "the distance the Event Horizon Telescope took"},
        "observation": {"ringMicroArcsec": 42, "error": 3, "source": "eht-2019-m87"},
        "inclinationDeg": 17, "inclinationNote": "its jet's angle to the line of sight, as the Event Horizon Telescope took it",
    },
    {
        "id": "ton-618", "name": "TON 618", "simbad": "Ton 618", "kind": "supermassive", "model": "thin-disc",
        "mass": {"value": 6.6e10, "minus": 2.5e10, "plus": 0.0, "source": "shemmer-2004-ton618", "how": "from the width of its H-beta line and its brightness (one epoch): log M = 10.82 (Shemmer et al. 2004); the same spectrum gives log M = 10.61, 4.1e10, in Ge et al. (2019); such estimates are uncertain by a factor of about three", "alsoSource": "ge-2019-ton618", "low": 4.07e10},
        "redshift": 2.219, "redshiftSource": "shemmer-2004-ton618",
        "inclinationDeg": 20, "inclinationNote": "illustrative: a quasar is seen near its disc's axis",
    },
    {
        "id": "gaia-bh1", "name": "Gaia BH1", "simbad": "Gaia DR3 4373465352415301632", "kind": "stellar", "model": "dormant",
        "mass": {"value": 9.62, "minus": 0.18, "plus": 0.18, "source": "el-badry-2023-gaia-bh1", "how": "the orbit of its companion, from Gaia's astrometry and radial velocities"},
        "distance": {"pc": 480, "minus": 8, "plus": 8, "source": "el-badry-2023-gaia-bh1", "how": "Gaia's parallax"},
        "companion": {"kind": "a Sun-like star (G dwarf)", "periodDays": 185.6},
    },
    {
        "id": "gaia-bh2", "name": "Gaia BH2", "simbad": "Gaia DR3 5870569352746779008", "kind": "stellar", "model": "dormant",
        "mass": {"value": 8.9, "minus": 0.3, "plus": 0.3, "source": "el-badry-2023-gaia-bh2", "how": "the orbit of its companion, from Gaia's astrometry and radial velocities"},
        "distance": {"pc": 1160, "minus": 20, "plus": 20, "source": "el-badry-2023-gaia-bh2", "how": "Gaia's parallax, from the orbit's fit"},
        "companion": {"kind": "a red giant", "periodDays": 1277},
    },
    {
        "id": "gaia-bh3", "name": "Gaia BH3", "simbad": "Gaia DR3 4318465066420528000", "kind": "stellar", "model": "dormant",
        "mass": {"value": 32.70, "minus": 0.82, "plus": 0.82, "source": "gaia-2024-bh3", "how": "the orbit of its companion, from Gaia's astrometry and radial velocities"},
        "distance": {"pc": 590, "minus": 10, "plus": 10, "source": "gaia-2024-bh3", "how": "Gaia's parallax"},
        "companion": {"kind": "an old, metal-poor giant of the galaxy's halo", "periodDays": 4237},
    },
    {
        "id": "cyg-x-1", "name": "Cygnus X-1", "simbad": "HD 226868", "kind": "stellar", "model": "thin-disc",
        "mass": {"value": 21.2, "minus": 2.2, "plus": 2.2, "source": "miller-jones-2021-cyg-x1", "how": "the orbit and the radio parallax"},
        "distance": {"pc": 2220, "minus": 170, "plus": 180, "source": "miller-jones-2021-cyg-x1", "how": "the radio parallax (VLBA)"},
        "companion": {"kind": "a blue supergiant (HDE 226868, O9.7 Iab)", "periodDays": 5.6},
        "inclinationDeg": 27.5, "inclinationNote": "the orbit's inclination (Miller-Jones et al. 2021); the disc taken to lie in it",
    },
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def comoving_pc(z: float) -> float:
    """Comoving distance (pc) in a flat cosmology with matter, radiation (photons and Neff massless neutrinos) and a constant dark energy: Simpson's rule in ln(1 + z)."""
    h = COSMOLOGY["H0"] / 100
    og = 2.4728e-5 * (COSMOLOGY["Tcmb"] / 2.7255) ** 4 / h**2
    orad = og * (1 + 0.2271 * COSMOLOGY["Neff"])
    om = COSMOLOGY["Om0"]
    ol = 1 - om - orad
    n = 20000
    top = math.log1p(z)
    total = 0.0
    for k in range(n + 1):
        x = top * k / n
        a1 = math.exp(x)  # 1 + z'
        f = a1 / math.sqrt(orad * a1**4 + om * a1**3 + ol)
        total += f * (1 if k in (0, n) else 4 if k % 2 else 2)
    integral = total * (top / n) / 3
    return C_KM_S / COSMOLOGY["H0"] * integral * 1e6


def lookback_gyr(z: float) -> float:
    """The light-travel time from redshift z (billions of years), in the same cosmology."""
    h = COSMOLOGY["H0"] / 100
    orad = 2.4728e-5 * (COSMOLOGY["Tcmb"] / 2.7255) ** 4 / h**2 * (1 + 0.2271 * COSMOLOGY["Neff"])
    om = COSMOLOGY["Om0"]
    ol = 1 - om - orad
    n = 20000
    top = math.log1p(z)
    total = 0.0
    for k in range(n + 1):
        a1 = math.exp(top * k / n)
        f = 1 / math.sqrt(orad * a1**4 + om * a1**3 + ol)
        total += f * (1 if k in (0, n) else 4 if k % 2 else 2)
    hubble_gyr = 977.792 / COSMOLOGY["H0"]
    return hubble_gyr * total * (top / n) / 3


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / QUERY[0]
    if not path.exists():
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": QUERY[1]}
        urllib.request.urlretrieve(f"{SIMBAD}?{urllib.parse.urlencode(params)}", path)
    with path.open() as f:
        places = {r["id"].replace("  ", " "): (float(r["ra"]), float(r["dec"]), r["main_id"]) for r in csv.DictReader(f)}
    holes = []
    for h in HOLES:
        ra, dec, main_id = places[h["simbad"]]
        entry = {k: v for k, v in h.items() if k != "simbad"}
        entry["simbad"] = {"id": h["simbad"], "mainId": " ".join(main_id.split())}
        entry["raDeg"] = round(ra, 7)
        entry["decDeg"] = round(dec, 7)
        if "redshift" in h:
            entry["distance"] = {"pc": round(comoving_pc(h["redshift"])), "minus": None, "plus": None, "source": "planck-2018-cosmology", "how": f"the comoving distance of redshift {h['redshift']} in Planck 2018's cosmology (H0 {COSMOLOGY['H0']}, matter {COSMOLOGY['Om0']}), as the survey's galaxies are placed"}
            entry["lookbackGyr"] = round(lookback_gyr(h["redshift"]), 2)
        rs_km = 2 * G_M_SUN_KM * h["mass"]["value"] / C_KM_S**2
        entry["schwarzschildKm"] = round(rs_km, 3) if rs_km < 1e6 else round(rs_km, -3)
        entry["schwarzschildAu"] = rs_km / AU_KM
        holes.append(entry)
    out = {
        "units": "masses in Suns, distances in parsecs, the Schwarzschild radius 2GM/c^2 (km and au) for the mass drawn (IAU 2015 B3's GM of the Sun)",
        "blackHoles": holes,
        "sources": {"simbad": {"ids": ["simbad-black-holes"], "service": SIMBAD, "adql": QUERY[1], "sha256": sha256(path)}},
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    for e in holes:
        print(f"{e['name']}: {e['distance']['pc']:.4g} pc, {e['mass']['value']:.4g} Suns, r_s {e['schwarzschildKm']:.4g} km ({e['schwarzschildAu']:.4g} au)")


if __name__ == "__main__":
    main()
