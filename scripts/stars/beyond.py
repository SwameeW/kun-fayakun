"""Writes the galaxies of the Local Group for the explorer's view beyond the stars (docs/NEIGHBOURHOOD.md,
ledger IS-6) as public/assets/stars/localgroup.json:

- every galaxy in McConnachie (2012), "The observed properties of dwarf galaxies in and around the
  Local Group" (AJ 144, 4; CDS J/AJ/144/4), but the Milky Way itself (drawn as its own model): its
  place, distance from the Sun, half-light radius, position angle, ellipticity, absolute magnitude
  and stellar mass, as the catalogue gives them;
- for the four largest (the Andromeda and Triangulum galaxies, the Large and Small Magellanic
  Clouds), the catalogue gives no half-light radius: their isophotal diameters and position angles
  from SIMBAD (which cites HyperLEDA, Paturel et al. 2003, and Crosby et al. 2014), and Andromeda's
  V magnitude, from which (with the catalogue's distance) its absolute magnitude, flagged as derived.

The queries are run by this script against VizieR's and SIMBAD's TAP services; their results are
written in the download folder, and their sha256 recorded in the output.

Usage: python -I scripts/stars/beyond.py <download dir>   (queries what is missing)
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
OUT = ROOT / "public" / "assets" / "stars" / "localgroup.json"
VIZIER = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
SIMBAD = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"
QUERIES = {
    # Quoted: the table has both "Vmag" (apparent) and "VMag" (absolute), which ADQL would otherwise fold together.
    "mcconnachie2012.csv": (VIZIER, 'SELECT "SubG", "Name", "MType", "RAJ2000", "DEJ2000", "D", "R1", "PA", "Ell", "VMag", "Mass" FROM "J/AJ/144/4/catalog"'),
    "simbad_large.csv": (
        SIMBAD,
        "SELECT ident.id, basic.galdim_majaxis, basic.galdim_minaxis, basic.galdim_angle, basic.galdim_bibcode, flux.flux AS vmag "
        "FROM basic JOIN ident ON ident.oidref = basic.oid LEFT JOIN flux ON flux.oidref = basic.oid AND flux.filter = 'V' "
        "WHERE ident.id IN ('M 31', 'M 33', 'NAME LMC', 'NAME SMC')",
    ),
}
# The catalogue's names for SIMBAD's identifiers.
LARGE = {"M  31": "Andromeda", "M  33": "Triangulum", "NAME LMC": "LMC", "NAME SMC": "SMC"}


def query(folder: Path, name: str) -> Path:
    path = folder / name
    if not path.exists():
        service, adql = QUERIES[name]
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}
        urllib.request.urlretrieve(f"{service}?{urllib.parse.urlencode(params)}", path)
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(text: str | None) -> float | None:
    try:
        return float(text) if text is not None and text.strip() != "" else None
    except ValueError:
        return None


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    catalogue = query(folder, "mcconnachie2012.csv")
    large_file = query(folder, "simbad_large.csv")

    large: dict[str, dict[str, float | str | None]] = {}
    with large_file.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = LARGE[row["id"]]
            large[name] = {"maj": number(row["galdim_majaxis"]), "min": number(row["galdim_minaxis"]), "pa": number(row["galdim_angle"]), "bib": row["galdim_bibcode"], "vmag": number(row["vmag"])}
    if set(large) != set(LARGE.values()):
        raise SystemExit(f"SIMBAD gave {sorted(large)}")

    galaxies = []
    with catalogue.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = row["Name"].strip()
            if name == "The Galaxy":
                continue
            dist = number(row["D"])
            if dist is None:
                raise SystemExit(f"{name}: no distance")
            absv = number(row["VMag"])
            derived = False
            extra = large.get(name)
            if absv is None and extra and isinstance(extra["vmag"], float):
                # V - 5 log10(d / 10 pc): no correction for extinction (Andromeda's A_V is about 0.17).
                absv = round(extra["vmag"] - 5 * math.log10(dist * 1000 / 10), 2)
                derived = True
            galaxies.append(
                [
                    name,
                    row["SubG"].strip(),
                    row["MType"].strip() or None,
                    # VizieR's TAP gives the catalogue's sexagesimal places in degrees.
                    round(float(row["RAJ2000"]), 5),
                    round(float(row["DEJ2000"]), 5),
                    dist,
                    number(row["R1"]),
                    number(row["PA"]),
                    number(row["Ell"]),
                    absv,
                    derived,
                    number(row["Mass"]),
                    extra["maj"] if extra else None,
                    extra["min"] if extra else None,
                    extra["pa"] if extra else None,
                ]
            )
    galaxies.sort(key=lambda g: g[5])
    out = {
        "$comment": "Generated by scripts/stars/beyond.py. Do not edit by hand.",
        "sources": {
            "catalogue": {"ids": ["mcconnachie-2012"], "title": "McConnachie (2012), AJ 144, 4 (CDS J/AJ/144/4/catalog)", "query": QUERIES["mcconnachie2012.csv"][1], "sha256": sha256(catalogue)},
            "large": {"ids": ["simbad-local-group"], "title": "SIMBAD (CDS): isophotal diameters (HyperLEDA, Paturel et al. 2003; Crosby et al. 2014) and V magnitudes", "query": QUERIES["simbad_large.csv"][1], "sha256": sha256(large_file)},
        },
        "fields": ["name", "group", "type", "raDeg", "decDeg", "distKpc", "rhArcmin", "paDeg", "ellipticity", "absV", "absVDerived", "massMsunMillions", "diamArcmin", "diamMinArcmin", "diamPaDeg"],
        "galaxies": galaxies,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(galaxies)} galaxies")


if __name__ == "__main__":
    main()
