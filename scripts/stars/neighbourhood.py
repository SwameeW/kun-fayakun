"""Writes the stars around the Sun for the explorer's stellar neighbourhood (docs/NEIGHBOURHOOD.md,
ledger IS-2 to IS-4, IS-7) as public/assets/stars/neighbourhood.json:

- every star in the Hipparcos new reduction (van Leeuwen 2007, CDS I/311/hip2) with a parallax over
  40 mas (within 25 parsecs), with its magnitude, colour and spectral type from the Hipparcos main
  catalogue (ESA 1997, CDS I/239/hip_main);
- the Yale Bright Star Catalogue's stars (the explorer's sky) with their Hipparcos parallaxes (each
  HR star's HD number matched to Hipparcos, CDS V/50, I/239 and I/311), so the bright stars stand at
  their distances;
- names from the IAU's Catalog of Star Names (WGSN), by Hipparcos number;
- the planetary systems within 20 parsecs from the NASA Exoplanet Archive's Planetary Systems
  Composite Parameters table, each value that the archive calculated (rather than measured) flagged.

The queries are run by this script against VizieR's and the archive's TAP services; their results
are written beside the download folder, and their sha256 recorded in the output.

Usage: python -I scripts/stars/neighbourhood.py <download dir>   (queries what is missing)
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "stars" / "neighbourhood.json"
SKY = ROOT / "public" / "assets" / "sky" / "sky.json"
VIZIER = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
EXOPLANETS = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
QUERIES = {
    "bsc_hip.csv": (VIZIER, 'SELECT b.HR, b.HD, h.HIP, n.Plx, n.e_Plx FROM "V/50/catalog" AS b JOIN "I/239/hip_main" AS h ON b.HD = h.HD JOIN "I/311/hip2" AS n ON h.HIP = n.HIP'),
    "hip_25pc.csv": (VIZIER, 'SELECT n.HIP, n.RArad, n.DErad, n.Plx, n.e_Plx, h.Vmag, h."B-V", h.SpType, h.HD FROM "I/311/hip2" AS n JOIN "I/239/hip_main" AS h ON n.HIP = h.HIP WHERE n.Plx > 40'),
    # Every Hipparcos star, for the multiple systems' components (the CCDM numbers) and their parallaxes (scripts/stars/catalogue.py's query too).
    "hip_all.csv": (VIZIER, 'SELECT n.HIP, n.RArad, n.DErad, n.Plx, n.e_Plx, n.pmRA, n.pmDE, h.Vmag, h."B-V", h.CCDM FROM "I/311/hip2" AS n JOIN "I/239/hip_main" AS h ON n.HIP = h.HIP'),
    "exo_20pc.csv": (
        EXOPLANETS,
        "select pl_name,hostname,hip_name,hd_name,sy_dist,ra,dec,sy_snum,sy_pnum,pl_orbsmax,pl_orbsmax_reflink,pl_orbper,pl_orbeccen,pl_orbincl,pl_rade,pl_rade_reflink,pl_bmasse,pl_bmasse_reflink,pl_bmassprov,pl_eqt,st_spectype,st_teff,st_rad,st_mass,st_lum,discoverymethod,disc_year from pscomppars where sy_dist < 20",
    ),
}
# The parallaxes of a few systems measured better than Hipparcos did (mas, its error, the source's id
# in data/sources.json), by HIP number: Alpha Centauri A and B, Kervella et al. (2016), A&A 594, A107
# (Hipparcos's B, 796.92 +/- 25.9 mas, put it 0.07 pc from A, whose own is 754.81 +/- 4.11).
OVERRIDES = {
    71683: (747.17, 0.61, "kervella-2016-alpha-cen"),
    71681: (747.17, 0.61, "kervella-2016-alpha-cen"),
}
# Close components of one multiple system (the same CCDM number, within this many arcseconds, their
# parallaxes agreeing) share the parallax measured best: Proxima shares Alpha Centauri's number two
# degrees away, at its own distance.
PAIR_ARCSEC = 30
NAMES = ("IAU-CSN.txt","https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt", "84fac0c90f1b19abc491c2793469e0caa7b003ad1bc93a790ca41147010d0eb0")


def query(folder: Path, name: str) -> Path:
    path = folder / name
    if not path.exists():
        service, adql = QUERIES[name]
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "MAXREC": "200000" if name == "hip_all.csv" else "20000", "QUERY": adql} if service == VIZIER else {"query": adql, "format": "csv"}
        url = f"{service}?{urllib.parse.urlencode(params)}"
        urllib.request.urlretrieve(url, path)
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(text: str) -> float | None:
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def names_by_hip(folder: Path) -> dict[int, str]:
    file, url, pinned = NAMES
    path = folder / file
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    if sha256(path) != pinned:
        raise SystemExit(f"{path}: not the pinned {pinned}")
    out: dict[int, str] = {}
    # Fixed columns: the name with its diacritics is characters 19 to 36; the row ends with magnitude,
    # band, HIP, HD, right ascension, declination and date.
    tail = re.compile(r"(-?\d+\.\d+)\s+(\S+)\s+(\d+|_)\s+(\d+|_)\s+(\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d{4}-\d{2}-\d{2})")
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(("#", "$")) or not line.strip():
            continue
        m = tail.search(line)
        if not m or m.group(3) == "_":
            continue
        out[int(m.group(3))] = line[18:36].strip()
    return out


def calculated(reflink: str) -> bool:
    return "CALCULATED_VALUE" in (reflink or "")


def multiples(folder: Path, stars: dict[int, dict]) -> None:
    """Close components of one multiple system share the parallax measured best; then the cited ones (OVERRIDES). Each says where its parallax is from."""
    def direction(ra: float, dec: float) -> tuple[float, float, float]:
        a, d = math.radians(ra), math.radians(dec)
        return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))

    groups: dict[str, list[dict]] = {}
    with query(folder, "hip_all.csv").open() as f:
        for r in csv.DictReader(f):
            ccdm, plx, eplx = r["CCDM"].strip(), number(r["Plx"]), number(r["e_Plx"])
            if ccdm and plx is not None and eplx is not None:
                groups.setdefault(ccdm, []).append({"hip": int(r["HIP"]), "plx": plx, "eplx": eplx, "dir": direction(float(r["RArad"]), float(r["DErad"]))})
    for members in groups.values():
        for m in members:
            s = stars.get(m["hip"])
            if s is None:
                continue
            # Near on the sky, and parallaxes agreeing within twice their combined error (an optical pair's would not).
            near = [o for o in members if math.degrees(2 * math.asin(min(1.0, math.dist(m["dir"], o["dir"]) / 2))) * 3600 <= PAIR_ARCSEC and abs(o["plx"] - m["plx"]) <= 2 * math.hypot(o["eplx"], m["eplx"])]
            best = min(near, key=lambda o: o["eplx"])
            if best["hip"] != m["hip"] and best["eplx"] < s["ePlxMas"]:
                s["plxMas"], s["ePlxMas"], s["plxFrom"] = best["plx"], best["eplx"], f"HIP {best['hip']}"
    for hip, (plx, eplx, source) in OVERRIDES.items():
        if hip in stars:
            stars[hip]["plxMas"], stars[hip]["ePlxMas"], stars[hip]["plxFrom"] = plx, eplx, source


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    names = names_by_hip(folder)
    sky = json.loads(SKY.read_text())
    fields = sky["starFields"]
    by_hr = {int(row[fields.index("hr")]): row for row in sky["stars"]}

    stars: dict[int, dict] = {}
    # The nearby stars (all of Hipparcos within 25 pc).
    with query(folder, "hip_25pc.csv").open() as f:
        for r in csv.DictReader(f):
            hip = int(r["HIP"])
            plx, eplx, v = number(r["Plx"]), number(r["e_Plx"]), number(r["Vmag"])
            if plx is None or eplx is None or v is None:
                continue
            stars[hip] = {"hip": hip, "hr": None, "name": names.get(hip), "raDeg": round(float(r["RArad"]), 6), "decDeg": round(float(r["DErad"]), 6), "plxMas": plx, "ePlxMas": eplx, "vmag": v, "bv": number(r["B-V"]), "spType": (r["SpType"] or "").strip() or None}
    # The bright stars, at their Hipparcos distances.
    with query(folder, "bsc_hip.csv").open() as f:
        for r in csv.DictReader(f):
            hr, hip = int(r["HR"]), int(r["HIP"])
            row = by_hr.get(hr)
            plx, eplx = number(r["Plx"]), number(r["e_Plx"])
            if row is None or plx is None or eplx is None:
                continue
            entry = stars.get(hip) or {"hip": hip, "hr": hr, "name": names.get(hip), "raDeg": row[fields.index("raDeg")], "decDeg": row[fields.index("decDeg")], "plxMas": plx, "ePlxMas": eplx, "vmag": row[fields.index("vmag")], "bv": row[fields.index("bv")], "spType": None}
            entry["hr"] = hr
            stars[hip] = entry
    multiples(folder, stars)

    systems: dict[str, dict] = {}
    with query(folder, "exo_20pc.csv").open() as f:
        for r in csv.DictReader(f):
            host = r["hostname"]
            hip = re.match(r"HIP (\d+)", r["hip_name"] or "")
            s = systems.setdefault(host, {
                "host": host,
                "hip": int(hip.group(1)) if hip else None,
                "raDeg": number(r["ra"]),
                "decDeg": number(r["dec"]),
                "distPc": number(r["sy_dist"]),
                "stars": int(number(r["sy_snum"]) or 1),
                "spType": r["st_spectype"] or None,
                "teffK": number(r["st_teff"]),
                "radiusSun": number(r["st_rad"]),
                "massSun": number(r["st_mass"]),
                "logLumSun": number(r["st_lum"]),
                "planets": [],
            })
            s["planets"].append({
                "name": r["pl_name"],
                "aAu": number(r["pl_orbsmax"]),
                "aCalculated": calculated(r["pl_orbsmax_reflink"]),
                "periodDays": number(r["pl_orbper"]),
                "eccentricity": number(r["pl_orbeccen"]),
                "inclinationDeg": number(r["pl_orbincl"]),
                "radiusEarth": number(r["pl_rade"]),
                "radiusCalculated": calculated(r["pl_rade_reflink"]),
                "massEarth": number(r["pl_bmasse"]),
                "massCalculated": calculated(r["pl_bmasse_reflink"]),
                "massKind": r["pl_bmassprov"] or None,
                "eqTempK": number(r["pl_eqt"]),
                "method": r["discoverymethod"] or None,
                "year": int(number(r["disc_year"]) or 0) or None,
            })
    for s in systems.values():
        s["planets"].sort(key=lambda p: p["aAu"] if p["aAu"] is not None else 1e9)

    out = {
        "frame": "ICRS (J2000) equatorial: right ascension and declination in degrees, parallax in mas (distance in parsecs = 1000 / parallax)",
        "fields": ["hip", "hr", "name", "raDeg", "decDeg", "plxMas", "ePlxMas", "vmag", "bv", "spType", "plxFrom"],
        "stars": [[s["hip"], s["hr"], s["name"], s["raDeg"], s["decDeg"], s["plxMas"], s["ePlxMas"], s["vmag"], s["bv"], s["spType"], s.get("plxFrom")] for s in sorted(stars.values(), key=lambda s: s["vmag"])],
        "multiples": {"pairArcsec": PAIR_ARCSEC, "overrides": {str(k): {"plxMas": v[0], "ePlxMas": v[1], "source": v[2]} for k, v in OVERRIDES.items()}, "plxFrom": "where a star's parallax is not its own Hipparcos one: a close companion's (HIP n, measured better), or a cited source's id"},
        "systems": sorted(systems.values(), key=lambda s: s["distPc"] or 1e9),
        "sources": {
            "hipparcos": {"ids": ["hipparcos-van-leeuwen-2007", "hipparcos-esa-1997", "yale-bsc5", "kervella-2016-alpha-cen"], "queries": {name: {"service": QUERIES[name][0], "adql": QUERIES[name][1], "sha256": sha256(folder / name)} for name in ("bsc_hip.csv", "hip_25pc.csv", "hip_all.csv")}},
            "names": {"ids": ["iau-wgsn-names"], "file": NAMES[1], "sha256": NAMES[2]},
            "exoplanets": {"ids": ["nasa-exoplanet-archive-pscomppars"], "queries": {"exo_20pc.csv": {"service": QUERIES["exo_20pc.csv"][0], "adql": QUERIES["exo_20pc.csv"][1], "sha256": sha256(folder / "exo_20pc.csv"), "retrieved": "2026-10-26"}}},
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
