"""Writes public/assets/sky/sky.json: the real night sky for the explorer.

- Stars: every star of the Yale Bright Star Catalogue, 5th Revised Edition (Hoffleit and Warren,
  1991; NASA Astronomical Data Center, the naked-eye sky to about V = 6.5) with a J2000 position:
  its HR number, right ascension and declination (J2000, degrees), V magnitude and B-V colour,
  brightest first. Entries without a position (removed objects, a nova) are left out.
- Names: the IAU Catalog of Star Names (IAU Working Group on Star Names), for the stars it names
  by HR number.
- Constellations: the 88 IAU constellations (Serpens in its two parts) from d3-celestial (Olaf Frohn, BSD-3-Clause): their
  names and label points, their figures (lines drawn after the IAU's charts) and their boundaries
  (Davenhall and Leggett 1989, from Delporte's IAU boundaries of 1930), all J2000.

Every input is pinned by sha256; nothing is typed by hand.

Usage: python3 -I scripts/sky/build.py   (downloads into .cache/sky on the first run)
"""

from __future__ import annotations

import gzip
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "sky"
OUT = ROOT / "public" / "assets" / "sky" / "sky.json"
D3 = "https://raw.githubusercontent.com/ofrohn/d3-celestial/7e720a3de062059d4c5400a379146a601d9010e0"
FILES = {
    "ybsc5.gz": ("http://tdc-www.harvard.edu/catalogs/ybsc5.gz", "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed"),
    "IAU-CSN.txt": ("https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt", "84fac0c90f1b19abc491c2793469e0caa7b003ad1bc93a790ca41147010d0eb0"),
    "constellations.json": (f"{D3}/data/constellations.json", "ab4ae692027cbc042c0d6791a84456a65eb7c55656107fd00c58ff6e55d4d8b2"),
    "constellations.lines.json": (f"{D3}/data/constellations.lines.json", "294f66bef5d5cf50b1e17f16d2efa1d97a15131612c68dd935adef6e7373e13c"),
    "constellations.bounds.json": (f"{D3}/data/constellations.bounds.json", "f2e2687af6b20b24567879f838c21874d412efcc93ecc1966be07e78431cc196"),
}
SOURCE_IDS = {"stars": "yale-bsc5", "names": "iau-wgsn-names", "constellations": "d3-celestial-constellations"}


def fetch(name: str) -> bytes:
    url, pinned = FILES[name]
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        # curl, as the other builders do (Python's own TLS store fails on some machines).
        subprocess.run(["curl", "-sSfL", "--max-time", "120", "-o", str(path), url], check=True)  # noqa: S603, S607
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != pinned:
        raise SystemExit(f"{name}: sha256 {digest} is not the pinned {pinned}")
    return data


def field(line: str, start: int, end: int) -> str:
    """Columns start..end, 1-based and inclusive, as the catalogue's ReadMe gives them."""
    return line[start - 1 : end].strip()


def parse_stars() -> list[list[float | int | None]]:
    stars = []
    for line in gzip.decompress(fetch("ybsc5.gz")).decode("latin-1").splitlines():
        if not field(line, 76, 77) or not field(line, 103, 107):
            continue
        hr = int(field(line, 1, 4))
        ra = (int(field(line, 76, 77)) + int(field(line, 78, 79)) / 60 + float(field(line, 80, 83)) / 3600) * 15
        dec = int(field(line, 85, 86)) + int(field(line, 87, 88)) / 60 + int(field(line, 89, 90)) / 3600
        if field(line, 84, 84) == "-":
            dec = -dec
        bv = field(line, 110, 114)
        stars.append([hr, round(ra, 4), round(dec, 4), float(field(line, 103, 107)), float(bv) if bv else None])
    stars.sort(key=lambda s: (s[3], s[0]))
    return stars


def parse_names(known: set[int]) -> list[list[int | str]]:
    names = []
    for line in fetch("IAU-CSN.txt").decode("utf-8").splitlines():
        if line.startswith(("#", "$")) or not line.strip():
            continue
        # Fixed columns: the ASCII name (1-18), the name with diacritics (19-36), the designation (37-49).
        designation = line[36:49].strip()
        if not designation.startswith("HR "):
            continue
        hr = int(designation[3:])
        if hr in known:
            names.append([hr, line[18:36].strip()])
    names.sort(key=lambda n: int(n[0]))
    return names


def ra360(lon: float) -> float:
    """d3-celestial keeps right ascension in -180..180 degrees; the sky file in 0..360."""
    return round(lon % 360, 4)


def parse_constellations() -> list[dict[str, object]]:
    """The 88, in id order; Serpens comes in two parts (Caput and Cauda) under one id in every file, kept as Ser1 and Ser2 in the files' order."""

    def by_id(name: str) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for f in json.loads(fetch(name))["features"]:
            out.setdefault(f["id"], []).append(f)
        return out

    names = by_id("constellations.json")
    lines = by_id("constellations.lines.json")
    bounds = by_id("constellations.bounds.json")
    out = []
    for cid in sorted(names):
        parts = names[cid]
        for i, feature in enumerate(parts):
            p = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"]
            figure = lines[cid][i]["geometry"]["coordinates"] if i < len(lines.get(cid, [])) else []
            rings = bounds[cid][i]["geometry"] if i < len(bounds.get(cid, [])) else {}
            polygons = rings.get("coordinates", []) if rings.get("type") == "Polygon" else [r for poly in rings.get("coordinates", []) for r in poly]
            out.append({
                "id": cid if len(parts) == 1 else f"{cid}{i + 1}",
                "name": p["name"],
                "label": [ra360(lon), round(lat, 4)],
                "lines": [[[ra360(x), round(y, 4)] for x, y in part] for part in figure],
                "bounds": [[[ra360(x), round(y, 4)] for x, y in ring] for ring in polygons],
            })
    return out


def main() -> None:
    stars = parse_stars()
    names = parse_names({int(s[0]) for s in stars})
    constellations = parse_constellations()
    out = {
        "$comment": "Generated by scripts/sky/build.py. Do not edit by hand. Positions J2000 (ICRF), degrees.",
        "sources": {
            key: {"id": SOURCE_IDS[key], "files": {n: {"url": FILES[n][0], "sha256": FILES[n][1]} for n in files}}
            for key, files in (("stars", ["ybsc5.gz"]), ("names", ["IAU-CSN.txt"]), ("constellations", ["constellations.json", "constellations.lines.json", "constellations.bounds.json"]))
        },
        "starFields": ["hr", "raDeg", "decDeg", "vmag", "bv"],
        "stars": stars,
        "names": names,
        "constellations": constellations,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(stars)} stars, {len(names)} names, {len(constellations)} constellations")


if __name__ == "__main__":
    main()
