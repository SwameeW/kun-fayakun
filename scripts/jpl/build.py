"""Solar-system data for Chapter 7 from NASA JPL's Solar System Dynamics group.

Steps (run in order by scripts/preprocess-jpl.sh, or one at a time):
    fetch     JPL pages and the Horizons API -> .cache/jpl/ (sha256 recorded)
    build     -> public/assets/jpl/planets.json and moon.json
    sources   -> the "jpl-*" entries of data/sources.json

Planets: the Keplerian elements and their rates of Table 1 of "Approximate Positions of the
Planets" (E. M. Standish and J. G. Williams; mean ecliptic and equinox of J2000, valid 1800 to
2050 AD), copied number for number from the page, with mean radii from JPL's "Planetary Physical
Parameters". The scene solves Kepler's equation with them for any date in that range.

Moon: its geocentric position, one row per day from 2026-01-01 to 2036-01-01 (TDB), from the
Horizons system (ecliptic of J2000, kilometres), so its phase as seen from the Earth is the real
one for the visitor's date. Positions are rounded to 1 km.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
import urllib.parse
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "jpl"
PUBLIC = ROOT / "public" / "assets" / "jpl"
SOURCES = ROOT / "data" / "sources.json"
USER_AGENT = "kun-fayakun/0.1 (educational; github.com/SwameeW/kun-fayakun)"

ELEMENTS_URL = "https://ssd.jpl.nasa.gov/planets/approx_pos.html"
PHYSICAL_URL = "https://ssd.jpl.nasa.gov/planets/phys_par.html"
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
MOON_QUERY = {
    "format": "json",
    "COMMAND": "'301'",
    "OBJ_DATA": "'NO'",
    "MAKE_EPHEM": "'YES'",
    "EPHEM_TYPE": "'VECTORS'",
    "CENTER": "'500@399'",
    "START_TIME": "'2026-01-01'",
    "STOP_TIME": "'2036-01-01'",
    "STEP_SIZE": "'1 d'",
    "REF_PLANE": "'ECLIPTIC'",
    "REF_SYSTEM": "'ICRF'",
    "VEC_TABLE": "'1'",
    "CSV_FORMAT": "'YES'",
    "OUT_UNITS": "'KM-S'",
}
PLANETS = ["Mercury", "Venus", "EM Bary", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]
RADIUS_NAMES = {"Mercury": "Mercury", "Venus": "Venus", "EM Bary": "Earth", "Mars": "Mars", "Jupiter": "Jupiter", "Saturn": "Saturn", "Uranus": "Uranus", "Neptune": "Neptune"}

FILES = {
    "elements": CACHE / "approx_pos.html",
    "physical": CACHE / "phys_par.html",
    "moon": CACHE / "horizons-moon.json",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def get(url: str) -> bytes:
    """Fetched with curl, which uses the system's trust store (Python's may lack a proxy's CA)."""
    result = subprocess.run(["curl", "-fsSL", "--max-time", "300", "-A", USER_AGENT, url], capture_output=True, check=False)  # noqa: S603, S607
    if result.returncode != 0:
        raise SystemExit(f"{url}: curl failed ({result.returncode}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def step_fetch() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    FILES["elements"].write_bytes(get(ELEMENTS_URL))
    FILES["physical"].write_bytes(get(PHYSICAL_URL))
    FILES["moon"].write_bytes(get(HORIZONS_URL + "?" + urllib.parse.urlencode(MOON_QUERY)))
    for name, path in FILES.items():
        print(f"{name}: {path} sha256 {sha256(path)}")


def _text(raw: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", " ", raw))


def parse_elements() -> list[dict[str, Any]]:
    text = _text(FILES["elements"].read_text(encoding="utf-8"))
    start = text.find("Table 1")
    end = text.find("Table 2a", start)
    if start < 0 or end < 0:
        raise SystemExit("approx_pos.html: Table 1 not found; the page changed, check it by hand")
    table = text[start:end]
    if "valid for the time-interval 1800 AD - 2050 AD" not in " ".join(table.split()):
        raise SystemExit("approx_pos.html: Table 1 no longer says 1800 AD - 2050 AD")
    lines = [line.rstrip() for line in table.splitlines()]
    number = r"[-+]?\d+\.\d+"
    bodies = []
    for name in PLANETS:
        index = next((i for i, line in enumerate(lines) if line.strip().startswith(name)), None)
        if index is None:
            raise SystemExit(f"approx_pos.html: no row for {name}")
        values = [float(v) for v in re.findall(number, lines[index][len(name) + lines[index].index(name):])]
        rates = [float(v) for v in re.findall(number, lines[index + 1])]
        if len(values) != 6 or len(rates) != 6:
            raise SystemExit(f"approx_pos.html: {name} has {len(values)} elements and {len(rates)} rates, expected 6 and 6")
        keys = ["a", "e", "I", "L", "varpi", "Omega"]
        bodies.append({"name": RADIUS_NAMES[name], "row": name, "elements": dict(zip(keys, values)), "ratesPerCentury": dict(zip(keys, rates))})
    return bodies


def parse_radii() -> dict[str, float]:
    text = " ".join(_text(FILES["physical"].read_text(encoding="utf-8")).split())
    start = text.find("Planetary Physical Parameters")
    radii: dict[str, float] = {}
    for name in RADIUS_NAMES.values():
        # A planet's row: its name, the equatorial radius with a note and an uncertainty (±), then the mean radius (km).
        index = text.find(f" {name} ", start)
        if index < 0:
            raise SystemExit(f"phys_par.html: no row for {name}")
        numbers = [t for t in text[index + len(name) + 2 :].split()[:24] if re.fullmatch(r"\d+(\.\d+)?", t)]
        if len(numbers) < 2:
            raise SystemExit(f"phys_par.html: no mean radius for {name}")
        radii[name] = float(numbers[1])
    return radii


def parse_moon() -> dict[str, Any]:
    payload = json.loads(FILES["moon"].read_text(encoding="utf-8"))
    result = payload["result"]
    body = result[result.index("$$SOE") + 5 : result.index("$$EOE")]
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        jd, x, y, z = float(parts[0]), float(parts[2]), float(parts[3]), float(parts[4])
        rows.append((jd, round(x), round(y), round(z)))
    steps = {round(rows[i + 1][0] - rows[i][0], 6) for i in range(len(rows) - 1)}
    if steps != {1.0}:
        raise SystemExit(f"horizons: expected a 1-day step, got {sorted(steps)[:5]}")
    return {"startJdTdb": rows[0][0], "stepDays": 1, "count": len(rows), "positionsKm": [list(r[1:]) for r in rows], "horizonsVersion": payload.get("signature", {}).get("version")}


def step_build() -> None:
    bodies = parse_elements()
    radii = parse_radii()
    for body in bodies:
        body["meanRadiusKm"] = radii[body["name"]]
    PUBLIC.mkdir(parents=True, exist_ok=True)
    planets = {
        "$comment": "Generated by scripts/jpl/build.py. Do not edit by hand.",
        "source": ELEMENTS_URL,
        "table": "Table 1: Keplerian elements and their rates, mean ecliptic and equinox of J2000, valid 1800 AD - 2050 AD",
        "authors": "E. M. Standish and J. G. Williams (JPL)",
        "epochJd": 2451545.0,
        "units": {"a": "au (rate au per century)", "e": "(rate per century)", "I, L, varpi, Omega": "degrees (rates degrees per century)"},
        "earthRow": "EM Bary: the Earth-Moon barycentre stands in for the Earth",
        "radiiSource": PHYSICAL_URL,
        "bodies": bodies,
        "rawSha256": {"elements": sha256(FILES["elements"]), "physical": sha256(FILES["physical"])},
    }
    (PUBLIC / "planets.json").write_text(json.dumps(planets, indent=2) + "\n")
    moon = parse_moon()
    moon_file = {
        "$comment": "Generated by scripts/jpl/build.py. Do not edit by hand.",
        "source": "JPL Horizons system (" + HORIZONS_URL + "), Moon (301) relative to the Earth's centre (500@399)",
        "frame": "ecliptic and mean equinox of J2000 (Horizons REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF), kilometres",
        "timeScale": "TDB",
        **moon,
        "rawSha256": sha256(FILES["moon"]),
    }
    (PUBLIC / "moon.json").write_text(json.dumps(moon_file, separators=(",", ":")) + "\n")
    print(f"planets: {len(bodies)} bodies; moon: {moon['count']} days from JD {moon['startJdTdb']}")
    for body in bodies:
        print(f"  {body['name']:8s} a={body['elements']['a']:.6f} au  e={body['elements']['e']:.6f}  R={body['meanRadiusKm']} km")


def step_sources() -> None:
    sources = json.loads(SOURCES.read_text())
    today = date.today().isoformat()
    entries = [
        {
            "id": "jpl-approx-pos",
            "kind": "dataset",
            "title": "Approximate Positions of the Planets: Keplerian elements and their rates (Table 1, 1800 AD - 2050 AD)",
            "author": "E. M. Standish and J. G. Williams, NASA Jet Propulsion Laboratory, Solar System Dynamics",
            "url": ELEMENTS_URL,
            "version": f"retrieved {today}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Planet orbits: NASA/JPL-Caltech Solar System Dynamics, Approximate Positions of the Planets (Standish and Williams)",
            "notes": "Used by Chapter 7 to place the planets on their orbits for the visitor's date; sizes and distances are compressed in the scene and labelled not to scale.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "jpl-phys-par",
            "kind": "dataset",
            "title": "Planetary Physical Parameters (mean radii)",
            "author": "NASA Jet Propulsion Laboratory, Solar System Dynamics",
            "url": PHYSICAL_URL,
            "version": f"retrieved {today}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Planet radii: NASA/JPL-Caltech Solar System Dynamics",
            "notes": "Relative planet sizes in Chapter 7 (compressed, not to scale).",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "jpl-horizons",
            "kind": "dataset",
            "title": "JPL Horizons on-line solar system data and ephemeris computation service: the Moon's geocentric positions, 2026 to 2035",
            "author": "NASA Jet Propulsion Laboratory, Solar System Dynamics (Giorgini et al.)",
            "url": "https://ssd.jpl.nasa.gov/horizons/",
            "version": f"Horizons API, retrieved {today}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Moon positions: NASA/JPL-Caltech Horizons System",
            "notes": "Chapter 7 shows the Moon's real phase for the visitor's date from these positions.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
    ]
    rest = [s for s in sources["sources"] if not s["id"].startswith("jpl-")]
    rest.extend(entries)
    sources["sources"] = rest
    SOURCES.write_text(json.dumps(sources, indent=2, ensure_ascii=False) + "\n")
    print(f"updated {SOURCES}: {', '.join(e['id'] for e in entries)}")


STEPS = {"fetch": step_fetch, "build": step_build, "sources": step_sources}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=list(STEPS))
    STEPS[parser.parse_args().step]()


if __name__ == "__main__":
    sys.exit(main())
