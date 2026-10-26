"""Solar-system data for Chapter 7 from NASA JPL's Solar System Dynamics group.

Steps (run in order by scripts/preprocess-jpl.sh, or one at a time):
    fetch     JPL, NAIF and PDS files and the Horizons API -> .cache/jpl/ (sha256 recorded).
              Files already in the cache are kept, because Horizons stamps every reply with the
              time and a new download would change the hash moon.json records; --refresh
              downloads everything again.
    build     -> public/assets/jpl/planets.json, moon.json and physical.json
    sources   -> the JPL, NAIF and Cassini entries of data/sources.json
    reference -> tests/support/astro/horizons-reference.json: Horizons vectors at a few dates,
              which tests/unit/ephemeris.spec.ts checks src/astro against (not run by the script)
    deep      -> tests/support/astro/horizons-deep.json: Horizons vectors from 1600 to 2400, outside
              the Moon's table, which tests/unit/analytic.spec.ts checks the published theories
              (src/astro/analytic: Meeus's Moon, Standish's Table 2) against (not run by the script)

Planets: the Keplerian elements and their rates of Table 1 of "Approximate Positions of the
Planets" (E. M. Standish and J. G. Williams; mean ecliptic and equinox of J2000, valid 1800 to
2050 AD), copied number for number from the page, with each planet's row of JPL's "Planetary
Physical Parameters" (mean radius, mass, bulk density, sidereal rotation and orbital periods,
equatorial gravity, escape velocity). The scene solves Kepler's equation with them for any date in
that range; the explorer's object information shows the physical parameters as JPL gives them.

Moon: its geocentric position, one row per day from 2026-01-01 to 2036-01-01 (TDB), from the
Horizons system (ecliptic of J2000, kilometres), so its phase as seen from the Earth is the real
one for the visitor's date. Positions are rounded to 1 km.

Physical constants (physical.json). Each one is parsed from the file that defines it and never
typed in:
- The IAU rotation models and triaxial radii of the Sun, all eight planets and the Moon come
  from NAIF's generic PCK pck00011.tpc (IAU WGCCRE 2015 report). A model is the pole's right
  ascension and declination, the prime meridian W(t), and their nutation-precession terms.
- EMRAT (the Earth/Moon mass ratio), the astronomical unit and the GM of the Sun and of each
  planet's system come from the DE440 header (the Earth's and the Moon's split by EMRAT).
- The leap seconds and the TDB - TT terms come from NAIF's LSK naif0012.tls.
- The J2000 obliquity that Horizons uses for its ecliptic frame comes from its own reply.
- The radial span of Saturn's rings, and their structure across it, come from a Cassini
  radio-occultation optical-depth profile (PDS): the explorer draws the rings from its normal
  transmission, averaged into RING_BINS equal bins (about 35 km each).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import math
import html
import json
import re
import subprocess
import sys
import urllib.parse
from datetime import date, datetime
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
PCK_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"
DE440_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/ascii/de440/header.440"
LSK_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls"
RINGS_ROOT = (
    "https://pds-rings.seti.org/holdings/volumes/CORSS_8xxx/CORSS_8001/data/Rev007/Rev007E/"
    "Rev007E_RSS_2005_123_X43_E/RSS_2005_123_X43_E_TAU_10KM"
)
RINGS_CITATION = "Marouf, E., CASSINI ORBITER SATURN RSS RING RADIO OCCULTATIONS 2.0, CO-SR-RSS-4/5-OCC-V2.0, NASA Planetary Data System, 2018"
# Bins of the ring profile written to physical.json (a power of two: the explorer mipmaps it).
RING_BINS = 2048
# Columns of the TAU table (1-based in its label): ring radius, normal optical depth, and the
# optical depth above which the signal was lost (there the profile only says "at least this").
RING_COLUMNS = {"radius": 0, "tau": 6, "threshold": 8}
PLANETS = ["Mercury", "Venus", "EM Bary", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]
RADIUS_NAMES = {"Mercury": "Mercury", "Venus": "Venus", "EM Bary": "Earth", "Mars": "Mars", "Jupiter": "Jupiter", "Saturn": "Saturn", "Uranus": "Uranus", "Neptune": "Neptune"}

FILES = {
    "elements": CACHE / "approx_pos.html",
    "physical": CACHE / "phys_par.html",
    "moon": CACHE / "horizons-moon.json",
    "pck": CACHE / "pck00011.tpc",
    "de440": CACHE / "header.440",
    "lsk": CACHE / "naif0012.tls",
    "rings": CACHE / "RSS_2005_123_X43_E_TAU_10KM.TAB",
    "ringsLabel": CACHE / "RSS_2005_123_X43_E_TAU_10KM.LBL",
}
URLS = {
    "elements": ELEMENTS_URL,
    "physical": PHYSICAL_URL,
    "moon": HORIZONS_URL + "?" + urllib.parse.urlencode(MOON_QUERY),
    "pck": PCK_URL,
    "de440": DE440_URL,
    "lsk": LSK_URL,
    "rings": RINGS_ROOT + ".TAB",
    "ringsLabel": RINGS_ROOT + ".LBL",
}
# The day each cached file was downloaded, so that data/sources.json gives the day the data was
# retrieved and not the day the sources step last ran.
RETRIEVED = CACHE / "retrieved.json"

# The bodies whose rotation and shape go into physical.json, by NAIF id.
PHYSICAL_BODIES = {"Sun": 10, "Mercury": 199, "Venus": 299, "Earth": 399, "Moon": 301, "Mars": 499, "Jupiter": 599, "Saturn": 699, "Uranus": 799, "Neptune": 899}

REFERENCE = ROOT / "tests" / "support" / "astro" / "horizons-reference.json"
# Julian dates (TDB): the Moon table's first row and first mid-day; three mid-days inside it
# (12:00 on 2026-03-15, 2029-07-04 and 2033-11-20); its last mid-day and its last row.
REFERENCE_EPOCHS = ["2461041.5", "2461042.0", "2461115.0", "2462322.0", "2463922.0", "2464693.0", "2464693.5"]
# Julian dates (TDB) outside the Moon's table: 1600, 1700, 1800, 1850, 1900 and 1950 on 1 January,
# Meeus's example 47.a (1992-04-12 0h), 2000-01-01 12h, 2000-08-04, 2025-12-25, 2036-01-08, then
# 2050, 2100, 2150, 2200, 2300 and 2400 on 1 January.
DEEP = ROOT / "tests" / "support" / "astro" / "horizons-deep.json"
DEEP_EPOCHS = [
    "2305447.5", "2341972.5", "2378496.5", "2396758.5", "2415020.5", "2433282.5", "2448724.5", "2451545.0",
    "2451760.5", "2461034.5", "2464700.5", "2469807.5", "2488069.5", "2506331.5", "2524593.5", "2561117.5", "2597641.5",
]
DEEP_VECTORS = {
    "moonGeo": ("301", "500@399", "the Moon relative to the Earth's centre"),
    "mercuryHelio": ("199", "500@10", "Mercury relative to the Sun"),
    "venusHelio": ("299", "500@10", "Venus relative to the Sun"),
    "embHelio": ("3", "500@10", "the Earth-Moon barycentre relative to the Sun's centre"),
    "marsHelio": ("4", "500@10", "the Mars barycentre relative to the Sun"),
    "jupiterHelio": ("5", "500@10", "the Jupiter barycentre relative to the Sun"),
    "saturnHelio": ("6", "500@10", "the Saturn barycentre relative to the Sun"),
    "uranusHelio": ("7", "500@10", "the Uranus barycentre relative to the Sun"),
    "neptuneHelio": ("8", "500@10", "the Neptune barycentre relative to the Sun"),
}
REFERENCE_VECTORS = {
    "mercuryHelio": ("199", "500@10", "Mercury relative to the Sun"),
    "venusHelio": ("299", "500@10", "Venus relative to the Sun"),
    "marsHelio": ("499", "500@10", "Mars relative to the Sun"),
    "uranusHelio": ("799", "500@10", "Uranus relative to the Sun"),
    "neptuneHelio": ("899", "500@10", "Neptune relative to the Sun"),
    "moonGeo": ("301", "500@399", "the Moon relative to the Earth's centre"),
    "earthFromEmb": ("399", "500@3", "the Earth's centre relative to the Earth-Moon barycentre"),
    "embHelio": ("3", "500@10", "the Earth-Moon barycentre relative to the Sun's centre"),
    "earthHelio": ("399", "500@10", "the Earth's centre relative to the Sun's centre"),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def get(url: str) -> bytes:
    """Fetched with curl, which uses the system's trust store (Python's may lack a proxy's CA)."""
    result = subprocess.run(["curl", "-fsSL", "--max-time", "300", "-A", USER_AGENT, url], capture_output=True, check=False)  # noqa: S603, S607
    if result.returncode != 0:
        raise SystemExit(f"{url}: curl failed ({result.returncode}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def retrieved_dates() -> dict[str, str]:
    return json.loads(RETRIEVED.read_text()) if RETRIEVED.exists() else {}


def step_fetch(refresh: bool = False) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    dates = retrieved_dates()
    for name, path in FILES.items():
        if path.exists() and not refresh:
            print(f"{name}: {path} (cached) sha256 {sha256(path)}")
            continue
        path.write_bytes(get(URLS[name]))
        dates[name] = date.today().isoformat()
        print(f"{name}: {path} sha256 {sha256(path)}")
    RETRIEVED.write_text(json.dumps(dates, indent=2, sort_keys=True) + "\n")


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


# The columns of a planet's row in "Planetary Physical Parameters", in order (their units in the page's heading).
PHYSICAL_COLUMNS = [
    "equatorialRadiusKm", "meanRadiusKm", "massE24Kg", "densityGcm3", "rotationDays", "orbitYears",
    "absoluteMagnitude", "geometricAlbedo", "equatorialGravityMs2", "escapeVelocityKmS",
]


def parse_physical() -> dict[str, dict[str, float]]:
    """Each planet's row of the table: its ten values, number for number (notes and uncertainties dropped)."""
    text = " ".join(_text(FILES["physical"].read_text(encoding="utf-8")).split())
    start = text.find("Escape Velocity", text.find("Planetary Physical Parameters The following"))
    if start < 0:
        raise SystemExit("phys_par.html: the planets' table heading was not found; the page changed, check it by hand")
    if "(km) (km) (×10 24 kg) (g cm -3 ) (d) (y) (mag) (m s -2 ) (km s -1 )" not in text[start : start + 200]:
        raise SystemExit("phys_par.html: the table's units are not km, km, 10^24 kg, g cm^-3, d, y, mag, m s^-2, km s^-1")
    names = list(RADIUS_NAMES.values())
    rows: dict[str, dict[str, float]] = {}
    for i, name in enumerate(names):
        index = text.find(f" {name} ", start)
        if index < 0:
            raise SystemExit(f"phys_par.html: no row for {name}")
        end = text.find(f" {names[i + 1]} ", index) if i + 1 < len(names) else index + 400
        row = re.sub(r"\[\s*[^\]]*\]", " ", text[index + len(name) + 2 : end])
        values = [float(t) for t in row.split() if re.fullmatch(r"-?\d+(\.\d+)?", t)]
        if len(values) < len(PHYSICAL_COLUMNS):
            raise SystemExit(f"phys_par.html: {name} has {len(values)} values, expected {len(PHYSICAL_COLUMNS)}")
        rows[name] = dict(zip(PHYSICAL_COLUMNS, values[: len(PHYSICAL_COLUMNS)]))
    return rows


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


def _kernel_value(token: str) -> float | str:
    # SPICE text kernels write exponents the Fortran way (1.657D-3); dates start with @.
    return token if token.startswith("@") else float(token.replace("D", "E").replace("d", "e"))


def parse_kernel(path: Path) -> dict[str, list[float | str]]:
    """The assignments in a SPICE text kernel's data blocks (between \\begindata and \\begintext)."""
    text = path.read_text(encoding="utf-8")
    values: dict[str, list[float | str]] = {}
    for block in re.findall(r"\\begindata(.*?)(?:\\begintext|\Z)", text, flags=re.S):
        for name, op, raw in re.findall(r"([A-Za-z0-9_/]+)\s*(\+?=)\s*(\([^)]*\)|\S+)", block):
            tokens = [_kernel_value(t) for t in re.split(r"[\s,]+", raw.strip("()").strip()) if t]
            values[name] = (values.get(name, []) if op == "+=" else []) + tokens
    return values


def _numbers(kernel: dict[str, list[float | str]], name: str, count: int | None = None) -> list[float]:
    found = kernel.get(name)
    if found is None:
        raise SystemExit(f"kernel: {name} not found")
    if not all(isinstance(v, float) for v in found) or (count is not None and len(found) != count):
        raise SystemExit(f"kernel: {name} = {found}, expected {count or 'some'} numbers")
    return [float(v) for v in found]


def parse_pck() -> dict[str, Any]:
    """IAU rotation models and radii. RA and Dec are in deg, deg/century and deg/century^2; W is in deg, deg/day and deg/day^2."""
    kernel = parse_kernel(FILES["pck"])
    bodies: dict[str, Any] = {}
    for name, naif in PHYSICAL_BODIES.items():
        radii = _numbers(kernel, f"BODY{naif}_RADII", 3)
        if not (radii[0] >= radii[1] >= radii[2] > 0):
            raise SystemExit(f"pck00011: {name} radii {radii} are not a >= b >= c > 0")
        body: dict[str, Any] = {
            "naifId": naif,
            "radiiKm": radii,
            "poleRa": _numbers(kernel, f"BODY{naif}_POLE_RA", 3),
            "poleDec": _numbers(kernel, f"BODY{naif}_POLE_DEC", 3),
            "pm": _numbers(kernel, f"BODY{naif}_PM", 3),
            "nutPrec": None,
        }
        terms = [f"BODY{naif}_NUT_PREC_{part}" for part in ("RA", "DEC", "PM")]
        present = [t in kernel for t in terms]
        if any(present):
            if not all(present):
                raise SystemExit(f"pck00011: {name} has only some of {terms}")
            # The angles belong to the body's system (BODY3 for the Moon, BODY5 for Jupiter). Each
            # one is a polynomial in T of degree MAX_PHASE_DEGREE, which is 1 unless the kernel sets it.
            system = naif // 100
            key = f"BODY{system}_MAX_PHASE_DEGREE"
            degree = _numbers(kernel, key, 1)[0] if key in kernel else 1
            if degree not in (1, 2):
                raise SystemExit(f"pck00011: BODY{system} phase angles of degree {degree} are not supported")
            flat = _numbers(kernel, f"BODY{system}_NUT_PREC_ANGLES")
            stride = int(degree) + 1
            if len(flat) % stride:
                raise SystemExit(f"pck00011: BODY{system}_NUT_PREC_ANGLES has a count not divisible by the polynomial stride")
            angles = [flat[i : i + stride] for i in range(0, len(flat), stride)]
            ra, dec, pm = (_numbers(kernel, t) for t in terms)
            if max(len(ra), len(dec), len(pm)) > len(angles):
                raise SystemExit(f"pck00011: {name} has more nutation-precession terms than BODY{system} has angles")
            body["nutPrec"] = {"ra": ra, "dec": dec, "pm": pm, "angles": angles}
        bodies[name] = body
    return bodies


def parse_de440() -> dict[str, float]:
    """EMRAT and AU, from the DE440 header's constant names (GROUP 1040) and values (GROUP 1041)."""
    text = FILES["de440"].read_text(encoding="utf-8")

    def group(number: int) -> list[str]:
        match = re.search(rf"GROUP\s+{number}\s+(.*?)(?=GROUP\s+\d+|\Z)", text, flags=re.S)
        if not match:
            raise SystemExit(f"header.440: GROUP {number} not found")
        tokens = match.group(1).split()
        if len(tokens) - 1 != int(tokens[0]):
            raise SystemExit(f"header.440: GROUP {number} declares {tokens[0]} entries and has {len(tokens) - 1}")
        return tokens[1:]

    values = dict(zip(group(1040), (float(v.replace("D", "E")) for v in group(1041))))
    if values.get("DENUM") != 440:
        raise SystemExit(f"header.440: DENUM is {values.get('DENUM')}, expected 440")
    # GM in au^3/day^2 -> km^3/s^2; the Earth-Moon barycentre's split by EMRAT (Earth/Moon mass ratio).
    to_km3s2 = values["AU"] ** 3 / 86_400.0 ** 2
    emrat = values["EMRAT"]
    gm = {name: values[key] * to_km3s2 for name, key in (("Sun", "GMS"), ("Mercury", "GM1"), ("Venus", "GM2"), ("Mars", "GM4"), ("Jupiter", "GM5"), ("Saturn", "GM6"), ("Uranus", "GM7"), ("Neptune", "GM8"))}
    gm["Earth"] = values["GMB"] * to_km3s2 * emrat / (1 + emrat)
    gm["Moon"] = values["GMB"] * to_km3s2 / (1 + emrat)
    return {"emrat": emrat, "auKm": values["AU"], "gm": {name: gm[name] for name in PHYSICAL_BODIES}}


def _jd_utc(token: str) -> float:
    # '@1972-JAN-1' means 0h UTC on that day. JD = proleptic Gregorian ordinal + 1721424.5.
    day = datetime.strptime(token.lstrip("@").title(), "%Y-%b-%d").date()
    return day.toordinal() + 1721424.5


def parse_lsk() -> dict[str, Any]:
    """TAI - UTC after each leap second, and the terms of TDB - TAI = DELTA_T_A + K sin(E), E = M + EB sin(M), M = M0 + M1 t."""
    kernel = parse_kernel(FILES["lsk"])
    table = kernel.get("DELTET/DELTA_AT", [])
    if len(table) < 2 or len(table) % 2:
        raise SystemExit("naif0012.tls: DELTET/DELTA_AT is not a list of (count, @date) pairs")
    leaps = [{"jdUtc": _jd_utc(str(table[i + 1])), "taiMinusUtc": float(table[i])} for i in range(0, len(table), 2)]
    if any(b["jdUtc"] <= a["jdUtc"] or b["taiMinusUtc"] != a["taiMinusUtc"] + 1 for a, b in zip(leaps, leaps[1:])):
        raise SystemExit("naif0012.tls: the leap seconds are not one second apart in date order")
    m = _numbers(kernel, "DELTET/M", 2)
    return {
        "deltaTA": _numbers(kernel, "DELTET/DELTA_T_A", 1)[0],
        "k": _numbers(kernel, "DELTET/K", 1)[0],
        "eb": _numbers(kernel, "DELTET/EB", 1)[0],
        "m0": m[0],
        "m1": m[1],
        "leapSeconds": leaps,
    }


def parse_obliquity() -> float:
    """The obliquity by which Horizons rotates the ICRF for its 'Ecliptic of J2000.0' frame, as its reply states it."""
    result = json.loads(FILES["moon"].read_text(encoding="utf-8"))["result"]
    match = re.search(r"IAU76 obliquity of ([0-9.]+) arcseconds", result)
    if not match:
        raise SystemExit("horizons-moon.json: the reply no longer states the J2000 obliquity")
    return float(match.group(1))


def parse_rings() -> dict[str, Any]:
    """The radial span of the ring profile: the label's limits, checked against the table's first and last rows."""
    label = FILES["ringsLabel"].read_text(encoding="utf-8")
    limits = []
    for key in ("MINIMUM_RING_RADIUS", "MAXIMUM_RING_RADIUS"):
        match = re.search(rf"^{key}\s*=\s*([0-9.]+)\s*<km>", label, flags=re.M)
        if not match:
            raise SystemExit(f"rings label: {key} not found")
        limits.append(float(match.group(1)))
    rows = FILES["rings"].read_text(encoding="utf-8").strip().splitlines()
    span = [float(rows[0].split(",")[0]), float(rows[-1].split(",")[0])]
    if span != limits:
        raise SystemExit(f"rings: the table spans {span} km and the label says {limits}")
    product = re.search(r'^PRODUCT_ID\s*=\s*"([^"]+)"', label, flags=re.M)
    # The columns are read where the label says they are, so a reordered table cannot slip through.
    columns = {name: int(number) - 1 for name, number in re.findall(r'NAME\s*=\s*"([^"]+)"\s*COLUMN_NUMBER\s*=\s*(\d+)', label)}
    for key, name in (("radius", "RING RADIUS"), ("tau", "NORMAL OPTICAL DEPTH"), ("threshold", "NORMAL OPTICAL DEPTH THRESHOLD")):
        if columns.get(name) != RING_COLUMNS[key]:
            raise SystemExit(f"rings label: {name} is column {columns.get(name)}, expected {RING_COLUMNS[key] + 1}")
    # Mean normal transmission exp(-tau) per bin (the mean of what light gets through, so a bin
    # half gap and half opaque lets half through); tau below zero (noise) counts as 0 and tau at
    # or above the threshold as the threshold.
    sums = [0.0] * RING_BINS
    counts = [0] * RING_BINS
    width = (span[1] - span[0]) / RING_BINS
    for row in rows:
        values = row.split(",")
        radius = float(values[RING_COLUMNS["radius"]])
        tau = min(max(float(values[RING_COLUMNS["tau"]]), 0.0), float(values[RING_COLUMNS["threshold"]]))
        index = min(RING_BINS - 1, int((radius - span[0]) / width))
        sums[index] += math.exp(-tau)
        counts[index] += 1
    if min(counts) == 0:
        raise SystemExit("rings: a profile bin has no samples")
    transmission = bytes(round(255 * s / c) for s, c in zip(sums, counts))
    return {
        "innerKm": span[0],
        "outerKm": span[1],
        "samples": len(rows),
        "product": product.group(1) if product else None,
        "note": (
            "Radial span of the Cassini RSS normal optical-depth profile (ring radius from Saturn's centre). The main rings lie "
            "inside it: the C ring begins where the profile's optical depth rises from zero, and the A ring ends where it falls back."
        ),
        "profile": {
            "bins": RING_BINS,
            "binKm": width,
            "encoding": (
                "base64, one byte per bin from innerKm outward: round(255 x mean normal transmission exp(-tau)) over the bin's samples, "
                "tau taken as 0 where below 0 and as the threshold optical depth where at or above it"
            ),
            "transmission": base64.b64encode(transmission).decode("ascii"),
        },
        "citation": RINGS_CITATION,
    }


def step_build() -> None:
    bodies = parse_elements()
    table = parse_physical()
    for body in bodies:
        row = table[body["name"]]
        body["meanRadiusKm"] = row["meanRadiusKm"]
        body["physical"] = {k: v for k, v in row.items() if k != "meanRadiusKm"}
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
        "physicalUnits": {
            "equatorialRadiusKm": "km", "massE24Kg": "10^24 kg", "densityGcm3": "g cm^-3", "rotationDays": "sidereal, days (negative: retrograde)",
            "orbitYears": "sidereal, Julian years", "absoluteMagnitude": "V(1,0), mag", "geometricAlbedo": "", "equatorialGravityMs2": "m s^-2", "escapeVelocityKmS": "km s^-1",
        },
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
    de440 = parse_de440()
    physical = {
        "$comment": "Generated by scripts/jpl/build.py. Do not edit by hand.",
        "frames": {
            "poles": "pole right ascension and declination are in the ICRF (equatorial J2000)",
            "positions": "planets.json and moon.json are in the ecliptic of J2000, the ICRF rotated about its x axis by obliquityJ2000Arcsec",
        },
        "units": {
            "poleRa, poleDec": "degrees, degrees per Julian century, degrees per century squared (T = TDB centuries from J2000)",
            "pm": "W, the prime meridian: degrees, degrees per day, degrees per day squared (d = TDB days from J2000)",
            "nutPrec": "ra and pm terms multiply sin(angle), dec terms cos(angle); each angle is [degrees, degrees per century, optional degrees per century squared]",
            "radiiKm": "triaxial ellipsoid a, b, c in km (c along the pole)",
            "gmKm3S2": "GM, km^3 s^-2, from the DE440 header: the Sun's; Mercury's and Venus's; the Earth's and the Moon's (the barycentre's split by EMRAT); Mars to Neptune each with its moons (DE440 gives the systems')",
            "time": "TDB - TAI = deltaTA + k sin(E), E = M + eb sin(M), M = m0 + m1 t (t = seconds from J2000); taiMinusUtc in seconds from jdUtc on",
        },
        "auKm": de440["auKm"],
        "emrat": de440["emrat"],
        "gmKm3S2": de440["gm"],
        "obliquityJ2000Arcsec": parse_obliquity(),
        "bodies": parse_pck(),
        "saturnRings": parse_rings(),
        "time": parse_lsk(),
        "sources": {name: {"url": URLS[name], "sha256": sha256(FILES[name])} for name in ("pck", "de440", "lsk", "moon", "rings", "ringsLabel")},
        # Lets the validator catch a hand edit of the two data files this step has just written.
        "assets": {name: sha256(PUBLIC / name) for name in ("planets.json", "moon.json")},
    }
    (PUBLIC / "physical.json").write_text(json.dumps(physical, indent=2) + "\n")
    print(f"planets: {len(bodies)} bodies; moon: {moon['count']} days from JD {moon['startJdTdb']}")
    rings = physical["saturnRings"]
    print(f"physical: EMRAT {de440['emrat']}, AU {de440['auKm']} km; {', '.join(PHYSICAL_BODIES)}; rings {rings['innerKm']} to {rings['outerKm']} km")
    for body in bodies:
        print(f"  {body['name']:8s} a={body['elements']['a']:.6f} au  e={body['elements']['e']:.6f}  R={body['meanRadiusKm']} km")


def step_sources() -> None:
    sources = json.loads(SOURCES.read_text())
    existing = {s["id"]: s for s in sources["sources"]}
    dates = retrieved_dates()

    def retrieved(entry_id: str, *files: str) -> str:
        # The day those files were downloaded. Files cached before downloads were dated keep the
        # day the entry already gives.
        days = sorted(dates[f] for f in files if f in dates)
        if days:
            return days[-1]
        found = re.search(r"retrieved (\d{4}-\d{2}-\d{2})", str(existing.get(entry_id, {}).get("version", "")))
        return found.group(1) if found else date.today().isoformat()

    lsk = parse_lsk()
    last_leap = date.fromordinal(int(lsk["leapSeconds"][-1]["jdUtc"] - 1721424.5))
    rings = parse_rings()
    entries = [
        {
            "id": "jpl-approx-pos",
            "kind": "dataset",
            "title": "Approximate Positions of the Planets: Keplerian elements and their rates (Table 1, 1800 AD - 2050 AD)",
            "author": "E. M. Standish and J. G. Williams, NASA Jet Propulsion Laboratory, Solar System Dynamics",
            "url": ELEMENTS_URL,
            "version": f"retrieved {retrieved('jpl-approx-pos', 'elements')}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Planet orbits: NASA/JPL-Caltech Solar System Dynamics, Approximate Positions of the Planets (Standish and Williams)",
            "notes": "Used by Chapter 7 to place the planets on their orbits for the visitor's date; sizes and distances are compressed in the scene and labelled not to scale.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "jpl-phys-par",
            "kind": "dataset",
            "title": "Planetary Physical Parameters: radii, masses, bulk densities, sidereal rotation and orbital periods, equatorial gravity and escape velocities of the planets",
            "author": "NASA Jet Propulsion Laboratory, Solar System Dynamics",
            "url": PHYSICAL_URL,
            "version": f"retrieved {retrieved('jpl-phys-par', 'physical')}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Planet radii and physical parameters: NASA/JPL-Caltech Solar System Dynamics",
            "notes": "Relative planet sizes in Chapter 7 (compressed, not to scale), and the explorer's object information for each planet, shown as the table gives it (public/assets/jpl/planets.json).",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "jpl-horizons",
            "kind": "dataset",
            "title": "JPL Horizons on-line solar system data and ephemeris computation service: the Moon's geocentric positions, 2026 to 2035",
            "author": "NASA Jet Propulsion Laboratory, Solar System Dynamics (Giorgini et al.)",
            "url": "https://ssd.jpl.nasa.gov/horizons/",
            "version": f"Horizons API, retrieved {retrieved('jpl-horizons', 'moon')}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Moon positions: NASA/JPL-Caltech Horizons System",
            "notes": "Chapter 7 shows the Moon's real phase for the visitor's date from these positions.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "jpl-de440",
            "kind": "dataset",
            "title": "JPL Planetary and Lunar Ephemeris DE440/LE440: header constants (header.440)",
            "author": "NASA Jet Propulsion Laboratory, Solar System Dynamics",
            "url": DE440_URL,
            "version": f"DE440, retrieved {retrieved('jpl-de440', 'de440')}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Earth/Moon mass ratio, astronomical unit and GM values: NASA/JPL-Caltech DE440 planetary ephemeris",
            "notes": "EMRAT places the Earth's centre relative to the Earth-Moon barycentre (Earth = barycentre - Moon / (1 + EMRAT)). The GM of the Sun and of the Moon give the explorer's object information for them (mass in units of the Earth's, surface gravity GM/R^2, escape speed sqrt(2GM/R)). public/assets/jpl/physical.json records the file's sha256.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "naif-pck00011",
            "kind": "dataset",
            "title": "NAIF generic planetary constants kernel pck00011.tpc: IAU rotation models and radii",
            "author": "N. Bachman, NASA/JPL Navigation and Ancillary Information Facility, from Archinal et al., Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015, Celestial Mechanics and Dynamical Astronomy 130, 22 (2018)",
            "url": PCK_URL,
            "version": f"pck00011, retrieved {retrieved('naif-pck00011', 'pck')}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Rotation and size of the Sun, all eight planets and the Moon: IAU WGCCRE (Archinal et al. 2018), via NASA/JPL NAIF",
            "notes": "Pole, prime meridian and radii for src/astro/rotation.ts. The kernel carries the 2009 IAU values for the Earth and the Moon, because the 2015 report gives none for them. public/assets/jpl/physical.json records the file's sha256.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "naif-lsk-naif0012",
            "kind": "dataset",
            "title": "NAIF leapseconds kernel naif0012.tls: TAI - UTC and the TDB - TAI terms",
            "author": "NASA/JPL Navigation and Ancillary Information Facility",
            "url": LSK_URL,
            "version": f"naif0012, retrieved {retrieved('naif-lsk-naif0012', 'lsk')}",
            "license": "Public information from NASA/JPL",
            "licenseUrl": "https://www.jpl.nasa.gov/jpl-image-use-policy",
            "credit": "Leap seconds: NASA/JPL NAIF naif0012.tls",
            "notes": f"Converts the visitor's clock (UTC) to TT and TDB, the time scales of the JPL data (src/astro/time.ts). The last leap second it lists took effect on {last_leap.isoformat()}.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
        {
            "id": "cassini-rss-rings",
            "kind": "dataset",
            "title": f"Cassini Orbiter Saturn RSS ring radio occultations 2.0: optical depth profile {rings['product']}",
            "author": "E. Marouf, NASA Planetary Data System",
            "url": URLS["rings"],
            "version": f"CO-SR-RSS-4/5-OCC-V2.0, retrieved {retrieved('cassini-rss-rings', 'rings', 'ringsLabel')}",
            "license": "Public domain (NASA Planetary Data System archive)",
            "licenseUrl": None,
            "credit": RINGS_CITATION,
            "notes": f"public/assets/jpl/physical.json records the profile's radial span ({rings['innerKm']:,} to {rings['outerKm']:,} km), its normal transmission averaged into {rings['profile']['bins']:,} bins (the solar-system explorer draws the rings from it), and the sha256 of the table and its label.",
            "review": {"reviewer": None, "role": None, "date": None},
        },
    ]
    ids = {e["id"] for e in entries}
    rest = [s for s in sources["sources"] if s["id"] not in ids]
    rest.extend(entries)
    sources["sources"] = rest
    SOURCES.write_text(json.dumps(sources, indent=2, ensure_ascii=False) + "\n")
    print(f"updated {SOURCES}: {', '.join(e['id'] for e in entries)}")


def _vectors(result: str) -> list[tuple[float, list[float]]]:
    body = result[result.index("$$SOE") + 5 : result.index("$$EOE")]
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        rows.append((float(parts[0]), [float(parts[2]), float(parts[3]), float(parts[4])]))
    return rows


def step_reference(epochs: list[str] = REFERENCE_EPOCHS, wanted: dict[str, tuple[str, str, str]] = REFERENCE_VECTORS, out: Path = REFERENCE, step: str = "reference", spec: str = "tests/unit/ephemeris.spec.ts checks src/astro/ephemeris.ts") -> None:
    """Horizons vectors at the epochs, at full precision, for the unit tests of src/astro."""
    queries: dict[str, Any] = {}
    vectors: dict[str, Any] = {}
    version = None
    for name, (command, center, what) in wanted.items():
        params = {
            **MOON_QUERY,
            "COMMAND": f"'{command}'",
            "CENTER": f"'{center}'",
            "TLIST": " ".join(f"'{jd}'" for jd in epochs),
            "TLIST_TYPE": "'JD'",
            "TIME_TYPE": "'TDB'",
        }
        for key in ("START_TIME", "STOP_TIME", "STEP_SIZE"):
            del params[key]
        url = HORIZONS_URL + "?" + urllib.parse.urlencode(params)
        payload = json.loads(get(url))
        result = payload["result"]
        rows = _vectors(result)
        if [jd for jd, _ in rows] != [float(jd) for jd in epochs]:
            raise SystemExit(f"horizons {name}: got epochs {[jd for jd, _ in rows]}")
        source = re.search(r"Target body name:.*\{source: ([^}]+)\}", result)
        queries[name] = {"target": command, "center": center, "what": what, "ephemeris": source.group(1) if source else None, "params": params, "url": url}
        vectors[name] = [xyz for _, xyz in rows]
        version = payload.get("signature", {}).get("version")
    fixture = {
        "$comment": f"Written by scripts/jpl/build.py {step}. Geometric Horizons vectors that {spec} against.",
        "retrieved": date.today().isoformat(),
        "horizonsVersion": version,
        "frame": "ecliptic and mean equinox of J2000 (REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF)",
        "timeScale": "TDB",
        "units": "km",
        "epochsJdTdb": [float(jd) for jd in epochs],
        "queries": queries,
        "vectors": vectors,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"wrote {out}: {', '.join(vectors)} at {len(epochs)} epochs")


def step_deep() -> None:
    """Horizons vectors from 1600 to 2400 (DEEP_EPOCHS), for the unit tests of src/astro/analytic."""
    step_reference(DEEP_EPOCHS, DEEP_VECTORS, DEEP, "deep", "tests/unit/analytic.spec.ts checks src/astro/analytic.ts")


STEPS = {"fetch": step_fetch, "build": step_build, "sources": step_sources, "reference": step_reference, "deep": step_deep}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=list(STEPS))
    parser.add_argument("--refresh", action="store_true", help="fetch: download files that are already cached again")
    args = parser.parse_args()
    if args.step == "fetch":
        step_fetch(refresh=args.refresh)
    else:
        STEPS[args.step]()


if __name__ == "__main__":
    sys.exit(main())
