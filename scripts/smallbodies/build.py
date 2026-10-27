"""Writes the explorer's small worlds (docs/EXPLORER-MECHANICS.md, "More worlds") as
public/assets/smallbodies/:

- asteroids-0.bin ... asteroids-3.bin: every asteroid in NASA JPL's Small-Body Database (SBDB) with
  an absolute magnitude H and a closed orbit, brightest (largest) first, in cumulative files of
  TIERS objects (the explorer's detail levels read the first one, two, three or all four). Each
  object is 16 bytes, little-endian: float32 semi-major axis (au); uint16 eccentricity (x 65535);
  uint16 inclination (/ pi x 65535); uint16 longitude of the ascending node, argument of
  perihelion and mean anomaly at the common epoch (/ 2 pi x 65536); uint16 packed absolute
  magnitude (high 12 bits: (H + 2) x 128) and class (low 4 bits, CLASSES). Angles are heliocentric
  ecliptic J2000. The mean anomaly is carried from each object's own epoch to the common one by its
  two-body mean motion (exactly what the explorer does from there).
- comets.json: the periodic comets (e < 1) with a total-magnitude law (M1, K1): their perihelion
  distance, eccentricity, angles and time of perihelion, as the SBDB gives them.
- worlds.json: the worlds the explorer can fly to. The dwarf planets and notable asteroids and
  comets from the SBDB's own record of each (elements at its epoch, H and G, size, shape, spin,
  pole, albedo, colour); the major moons of Mars, Jupiter, Saturn, Uranus, Neptune and Pluto from
  JPL's "Planetary Satellite Mean Elements" (mean elements on their reference planes, with the
  apsides' and nodes' precession), their mean radii and GM from JPL's "Planetary Satellite Physical
  Parameters", and their geometric albedos and shapes from NASA's NSSDCA fact sheets.
- manifest.json: the files' counts, sizes and sha256, the common epoch, the classes, and every
  query with the sha256 of its reply.

Every reply is kept in the download folder, so the files are rebuilt from the downloads alone; the
queries run only for what is missing. Nothing is typed by hand beyond which objects to fly to.

Usage: python3 -I scripts/smallbodies/build.py <download dir>            (the assets)
       python3 -I scripts/smallbodies/build.py <download dir> fixtures   (the Horizons fixture the
       unit tests check the explorer's propagation against: tests/support/astro/horizons-smallbodies.json)
"""

from __future__ import annotations

import hashlib
import html
import json
import math
import re
import struct
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "smallbodies"
FIXTURE = ROOT / "tests" / "support" / "astro" / "horizons-smallbodies.json"
SBDB_QUERY = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
SATS_ELEM = "https://ssd.jpl.nasa.gov/sats/elem/sep.html"
SATS_PHYS = "https://ssd.jpl.nasa.gov/sats/phys_par/sep.html"
NSSDC = "https://nssdc.gsfc.nasa.gov/planetary/factsheet/{}.html"
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
USER_AGENT = "kun-fayakun/0.1 (educational; github.com/SwameeW/kun-fayakun)"

# Cumulative object counts of the four files (Low reads the first, Medium two, High three, Ultra all).
TIERS = (20_000, 80_000, 250_000, 500_000)
PAGE = 50_000
# Classes, as the SBDB names them, and HIL: the Hildas (the 3:2 resonance with Jupiter, by the usual
# dynamical bounds: 3.7 < a < 4.2 au, e < 0.3, i < 20 degrees), which the SBDB counts in its outer belt.
CLASSES = ("MBA", "IMB", "OMB", "HIL", "TJN", "ATE", "APO", "AMO", "IEO", "MCA", "CEN", "TNO", "AST", "PAA", "HYA")
J2000 = 2451545.0
GAUSS_K = 0.01720209895
# The ecliptic's pole in the ICRF (J2000 obliquity 84381.448 arcseconds, IAU 1976, as JPL's elements use).
OBLIQUITY_DEG = 84381.448 / 3600

# Worlds to fly to: the SBDB's designation, the kind shown, and for the large, the name kept.
SMALL_WORLDS = (
    ("1", "dwarf"), ("134340", "dwarf"), ("136199", "dwarf"), ("136108", "dwarf"), ("136472", "dwarf"),
    ("4", "asteroid"), ("2", "asteroid"), ("10", "asteroid"), ("16", "asteroid"), ("433", "asteroid"),
    ("25143", "asteroid"), ("162173", "asteroid"), ("101955", "asteroid"), ("65803", "asteroid"), ("21", "asteroid"),
    ("243", "asteroid"), ("253", "asteroid"), ("951", "asteroid"), ("99942", "asteroid"), ("624", "asteroid"),
    ("617", "asteroid"), ("2060", "asteroid"), ("486958", "asteroid"), ("90377", "asteroid"), ("50000", "asteroid"),
    ("225088", "asteroid"), ("90482", "asteroid"),
    ("1P", "comet"), ("2P", "comet"), ("9P", "comet"), ("19P", "comet"), ("67P", "comet"), ("81P", "comet"),
    ("103P", "comet"), ("109P", "comet"), ("55P", "comet"), ("21P", "comet"), ("46P", "comet"),
)
# The IAU's rotation models (Archinal et al. 2018, Celest. Mech. Dyn. Astron. 130, 22) of the worlds
# with maps that are not locked to a planet, so they turn as they do: pole (ICRF right ascension and
# declination, degrees) and the prime meridian's angle W = W0 + rate x days since J2000 (TDB).
SPIN = {
    "1": (291.418, 66.764, 170.650, 952.1532),
    "4": (309.031, 42.235, 285.39, 1617.3329428),
    "134340": (132.993, -6.163, 302.695, 56.3625225),
}
# Sizes the SBDB does not carry, from the measurements that set them (stellar occultations, New
# Horizons, thermal and light-curve fits): semi-axes in km, and the paper (and the visual geometric
# albedo it measured, where the SBDB has none). Pluto's pole is the IAU's (Archinal et al. 2018);
# Pluto's and Charon's albedos are NSSDCA's Pluto fact sheet's (fact_sheet).
PUBLISHED = {
    "134340": {"axesKm": [1188.3, 1188.3, 1188.3], "pole": [132.993, -6.163], "ref": "Nimmo et al. 2017, Icarus 287, 12 (New Horizons)"},
    "136199": {"axesKm": [1163, 1163, 1163], "albedo": 0.96, "ref": "Sicardy et al. 2011, Nature 478, 493 (stellar occultation; geometric albedo 0.96)"},
    "136108": {"axesKm": [1161, 852, 513], "ref": "Ortiz et al. 2017, Nature 550, 219 (stellar occultation)"},
    "136472": {"axesKm": [717, 717, 711], "ref": "Brown 2013, ApJ 767, L7"},
    "90377": {"axesKm": [497.5, 497.5, 497.5], "ref": "Pal et al. 2012, A&A 541, L6 (thermal)"},
    "50000": {"axesKm": [555, 555, 555], "ref": "Braga-Ribas et al. 2013, ApJ 773, 26 (stellar occultation)"},
    "225088": {"axesKm": [615, 615, 615], "ref": "Kiss et al. 2019, Icarus 334, 3 (thermal and light curve)"},
    "90482": {"axesKm": [455, 455, 455], "ref": "Fornasier et al. 2013, A&A 555, A15 (thermal)"},
    "486958": {"axesKm": [18, 10, 5], "ref": "Spencer et al. 2020, Science 367, eaay3999 (New Horizons; a contact binary, drawn as an ellipsoid)"},
}
# The moons to fly to, by JPL satellite id, with the body they go round.
MOONS = {
    "401": "mars", "402": "mars",
    "501": "jupiter", "502": "jupiter", "503": "jupiter", "504": "jupiter", "505": "jupiter", "506": "jupiter",
    "601": "saturn", "602": "saturn", "603": "saturn", "604": "saturn", "605": "saturn", "606": "saturn", "607": "saturn", "608": "saturn", "609": "saturn",
    "701": "uranus", "702": "uranus", "703": "uranus", "704": "uranus", "705": "uranus",
    "801": "neptune", "802": "neptune", "808": "neptune",
    "901": "w:Pluto", "902": "w:Pluto", "903": "w:Pluto",
}
# NSSDCA's fact sheet for each host (the moons' albedos and shapes).
FACT_SHEETS = {"mars": "marsfact", "jupiter": "joviansatfact", "saturn": "saturniansatfact", "uranus": "uraniansatfact", "neptune": "neptuniansatfact", "w:Pluto": "plutofact"}
# The planets' IAU poles (Archinal et al. 2018, at J2000) for elements on their equators: Uranus,
# Neptune (its mean pole) and Pluto, the only equatorial frames used by the moons above.
EQUATOR_POLES = {"uranus": (257.311, -15.175), "neptune": (299.36, 43.46), "w:Pluto": (132.993, -6.163)}

# Points of the asteroid files whose places the unit tests check against Horizons (FIXTURE_OBJECTS): the
# SBDB's designation and the name the fixture keeps them under; the manifest records each one's record.
CHECKS = {"3": "Juno", "153": "Hilda", "588": "Achilles", "28978": "Ixion"}
# Horizons fixtures for tests/unit/small-bodies.spec.ts: two dates, and what each object is checked as.
FIXTURE_DATES = (2461339.5, 2464328.5)  # 2026-10-26.0 and 2035-01-01.0 TDB
# Juno, Hilda, Achilles (a Trojan) and Ixion (beyond Neptune) are among the asteroid files' points (CHECKS):
# their records, as quantised, are checked against Horizons too.
FIXTURE_OBJECTS = {
    "Juno": ("'3;'", "500@10"), "Hilda": ("'153;'", "500@10"), "Achilles": ("'588;'", "500@10"), "Ixion": ("'28978;'", "500@10"),
    "Ceres": ("'1;'", "500@10"), "Vesta": ("'4;'", "500@10"), "Hektor": ("'624;'", "500@10"),
    "Eris": ("'136199;'", "500@10"), "67P": ("'DES=67P;CAP;NOFRAG;'", "500@10"), "1P": ("'DES=1P;CAP;NOFRAG;'", "500@10"),
    "Io": ("'501'", "500@599"), "Titan": ("'606'", "500@699"), "Triton": ("'801'", "500@899"), "Charon": ("'901'", "500@999"),
    "Phobos": ("'401'", "500@499"), "Oberon": ("'704'", "500@799"),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(folder: Path, name: str, url: str) -> bytes:
    """A reply kept in the download folder (asked for only when it is missing)."""
    path = folder / name
    if not path.exists():
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=600) as reply:
            path.write_bytes(reply.read())
    return path.read_bytes()


def query_url(params: dict[str, str]) -> str:
    return f"{SBDB_QUERY}?{urllib.parse.urlencode(params)}"


# --- Asteroids ----------------------------------------------------------------------------------


def asteroid_pages(folder: Path) -> tuple[list[list[object]], list[dict[str, str]]]:
    """Every asteroid with H, brightest first, in pages of PAGE (the last tier's count, rounded up)."""
    rows: list[list[object]] = []
    queries: list[dict[str, str]] = []
    pages = math.ceil(TIERS[-1] / PAGE)
    for page in range(pages):
        params = {
            "fields": "pdes,a,e,i,om,w,ma,epoch,H,class",
            "sb-kind": "a",
            "sb-cdata": json.dumps({"AND": ["H|DF", "e|LT|1", "a|GT|0"]}, separators=(",", ":")),
            "sort": "H",
            "full-prec": "1",
            "limit": str(PAGE),
            "limit-from": str(page * PAGE),
        }
        name = f"asteroids-{page:02d}.json"
        data = fetch(folder, name, query_url(params))
        queries.append({"file": name, "url": query_url(params), "sha256": sha256(data)})
        reply = json.loads(data)
        if reply.get("fields") != params["fields"].split(","):
            raise SystemExit(f"{name}: unexpected fields {reply.get('fields')}")
        rows.extend(reply["data"])
    # Pages of a sort by H may share a boundary object: each designation once, in the order first met.
    seen: set[str] = set()
    unique = []
    for row in rows:
        # A few orbits lack an element (an assumed orbit with no mean anomaly): left out.
        if row[0] in seen or any(v is None for v in row[1:9]):
            continue
        seen.add(str(row[0]))
        unique.append(row)
    unique.sort(key=lambda r: (float(r[8]), str(r[0])))
    return unique, queries


def class_code(sbdb: str, a: float, e: float, i: float) -> int:
    if sbdb in ("OMB", "MBA") and 3.7 < a < 4.2 and e < 0.3 and i < 20:
        return CLASSES.index("HIL")
    return CLASSES.index(sbdb) if sbdb in CLASSES else CLASSES.index("AST")


def wrap(x: float) -> float:
    return x % (2 * math.pi)


def encode_asteroid(row: list[object], epoch: float) -> bytes:
    _, a, e, i, om, w, ma, ep, h, cls = row
    a, e, i, om, w, ma, ep, h = (float(v) for v in (a, e, i, om, w, ma, ep, h))  # type: ignore[arg-type]
    n = GAUSS_K / a ** 1.5
    m0 = wrap(math.radians(ma) + n * (epoch - ep))
    code = class_code(str(cls), a, e, i)
    hq = max(0, min(4095, round((h + 2) * 128)))
    u16 = lambda x, scale: max(0, min(65535, round(x * scale)))  # noqa: E731
    turn = lambda x: round(wrap(x) / (2 * math.pi) * 65536) % 65536  # noqa: E731
    return struct.pack(
        "<f6H", a, u16(e, 65535), u16(math.radians(i) / math.pi, 65535), turn(math.radians(om)), turn(math.radians(w)), turn(m0), (hq << 4) | code,
    )


# --- Comets -------------------------------------------------------------------------------------


def comets(folder: Path) -> tuple[list[list[object]], dict[str, str]]:
    params = {
        "fields": "pdes,full_name,q,e,i,om,w,tp,M1,K1,class",
        "sb-kind": "c",
        "sb-cdata": json.dumps({"AND": ["e|LT|1", "M1|DF", "K1|DF"]}, separators=(",", ":")),
        "full-prec": "1",
    }
    data = fetch(folder, "comets.json", query_url(params))
    reply = json.loads(data)
    out = []
    for pdes, full, q, e, i, om, w, tp, m1, k1, cls in reply["data"]:
        # Periodic comets only (a numbered or lettered P/), one apparition each (the SBDB lists fragments apart).
        name = str(full).strip()
        if not re.match(r"^(\d+P|P/)", name):
            continue
        out.append([name, round(float(q), 9), round(float(e), 9), round(float(i), 6), round(float(om), 6), round(float(w), 6), round(float(tp), 6), float(m1), float(k1), str(cls)])
    out.sort(key=lambda c: c[7])
    return out, {"file": "comets.json", "url": query_url(params), "sha256": sha256(data)}


# --- Named small worlds ----------------------------------------------------------------------------


def phys(record: dict, name: str) -> str | None:
    for p in record.get("phys_par", []) or []:
        if p.get("name") == name:
            return p.get("value")
    return None


def num(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def small_world(folder: Path, des: str, kind: str) -> tuple[dict, dict[str, str]]:
    params = {"sstr": des, "phys-par": "1", "full-prec": "1"}
    url = f"{SBDB}?{urllib.parse.urlencode(params)}"
    data = fetch(folder, f"sbdb-{des}.json", url)
    record = json.loads(data)
    if "orbit" not in record:
        raise SystemExit(f"sbdb {des}: no orbit in the reply ({str(record)[:200]})")
    obj = record["object"]
    orbit = record["orbit"]
    el = {e["name"]: num(e["value"]) for e in orbit["elements"]}
    full = str(obj["fullname"]).strip()
    # The name shown: the IAU name (Ceres, 67P/Churyumov-Gerasimenko), else the designation.
    if kind == "comet":
        name = full
    else:
        m = re.match(r"^\d+\s+([^(]+?)\s*(\(.*\))?$", full)
        name = m.group(1).strip() if m else full
    extent = phys(record, "extent")
    axes = None
    if extent:
        parts = [num(x) for x in re.split(r"\s*x\s*", extent.strip())]
        if all(p is not None for p in parts) and len(parts) in (2, 3):
            axes = [p / 2 for p in parts]  # type: ignore[operator]
            if len(axes) == 2:
                axes = [axes[0], axes[1], axes[1]]
    diameter = num(phys(record, "diameter"))
    pole = phys(record, "pole")
    pole_radec = None
    if pole and "/" in pole:
        ra, dec = (num(x) for x in pole.split("/"))
        if ra is not None and dec is not None:
            pole_radec = [ra, dec]
    world = {
        "id": f"w:{name}",
        "name": name,
        "designation": str(obj.get("des")),
        "kind": kind,
        "host": "sun",
        "class": obj.get("orbit_class", {}).get("code"),
        "elements": {
            "frame": "ecliptic",
            "epochJdTdb": float(orbit["epoch"]),
            "a": el.get("a"),
            "q": el.get("q"),
            "e": el["e"],
            "i": el["i"],
            "om": el["om"],
            "w": el["w"],
            "ma": el.get("ma"),
            "tp": el.get("tp"),
        },
        "H": num(phys(record, "H")),
        "G": num(phys(record, "G")),
        "M1": num(phys(record, "M1")),
        "K1": num(phys(record, "K1")),
        "radiusKm": diameter / 2 if diameter else (sum(axes) / 3 if axes else None),
        "axesKm": axes,
        "albedo": num(phys(record, "albedo")),
        "gm": num(phys(record, "GM")),
        "bv": num(phys(record, "BV")),
        "rotationHours": num(phys(record, "rot_per")),
        "pole": pole_radec,
        "spectral": phys(record, "spec_B") or phys(record, "spec_T"),
    }
    if des in SPIN:
        ra, dec, w0, rate = SPIN[des]
        world["spin"] = {"ra": ra, "dec": dec, "w0": w0, "degPerDay": rate}
        world["pole"] = [ra, dec]
    published = PUBLISHED.get(des)
    if published:
        world["axesKm"] = published["axesKm"]
        world["radiusKm"] = round(sum(published["axesKm"]) / 3, 1)
        world["sizeRef"] = published["ref"]
        if "albedo" in published and world["albedo"] is None:
            world["albedo"] = published["albedo"]
        if "pole" in published:
            world["pole"] = published["pole"]
    if world["radiusKm"] is None and world["H"] is not None:
        # No measured size: from H with the SBDB's albedo, or 0.14 (the size the SBDB's own diameter rule assumes; flagged).
        albedo = world["albedo"] or 0.14
        world["radiusKm"] = 1329 / math.sqrt(albedo) * 10 ** (-0.2 * world["H"]) / 2
        world["sizeFromH"] = True
    return world, {"file": f"sbdb-{des}.json", "url": url, "sha256": sha256(data)}


# --- Moons --------------------------------------------------------------------------------------


def table_cells(table: str) -> list[list[str]]:
    rows = re.findall(r"<tr.*?</tr>", table, re.S)
    return [[html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c))).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)] for r in rows]


def jd_of(date: str) -> float:
    """A TDB calendar date as the tables write it (2000-01-01.5) to a Julian date."""
    y, m, d = date.split("-")
    year, month, day = int(y), int(m), float(d)
    if month <= 2:
        year -= 1
        month += 12
    a = year // 100
    b = 2 - a + a // 4
    return math.floor(365.25 * (year + 4716)) + math.floor(30.6001 * (month + 1)) + day + b - 1524.5


def moon_elements(folder: Path) -> tuple[dict[str, dict], dict[str, str]]:
    data = fetch(folder, "sats-elem.html", SATS_ELEM)
    text = data.decode("utf-8", errors="replace")
    out: dict[str, dict] = {}
    pos = 0
    for m in re.finditer(r"<table.*?</table>", text, re.S):
        before = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text[max(pos, m.start() - 1500) : m.start()])))
        pos = m.end()
        epoch_match = re.search(r"Epoch: (\d{4}-\d\d-\d\d(?:\.\d+)?) TDB", before)
        if not epoch_match:
            continue
        frame = "laplace" if "Laplace" in before else "ecliptic" if "ecliptic" in before else "equatorial" if "equatorial" in before else None
        if frame is None:
            raise SystemExit(f"sats-elem: unknown frame in {before[-200:]}")
        cells = table_cells(m.group(0))
        head = cells[0]
        for row in cells[1:]:
            if len(row) != len(head):
                continue
            code = row[1]
            # A moon listed again further down (a later, narrower fit in another table) keeps its first row: the main ephemeris's.
            if code not in MOONS or code in out:
                continue
            value = dict(zip(head, row))
            periods = [num(value.get(k)) or 0.0 for k in ("Papsis(yr)", "Pnode(yr)")]
            entry = {
                "frame": frame,
                "epochJdTdb": jd_of(epoch_match.group(1)),
                "aKm": float(value["a(km)"]),
                "e": float(value["e"]),
                "w": float(value["ω(deg)"]),
                "ma": float(value["M(deg)"]),
                "i": float(value["i(deg)"]),
                "om": float(value["node(deg)"]),
                "periodDays": float(value["P(days)"]),
                "apsisYears": periods[0],
                "nodeYears": periods[1],
            }
            if frame == "laplace":
                entry["pole"] = [float(value["R.A.(deg)"]), float(value["Dec.(deg)"])]
            elif frame == "equatorial":
                entry["pole"] = list(EQUATOR_POLES[MOONS[code]])
            else:
                entry["pole"] = [270.0, 90 - OBLIQUITY_DEG]
            out[code] = {"name": row[0], "elements": entry}
    missing = sorted(set(MOONS) - set(out))
    if missing:
        raise SystemExit(f"sats-elem: no elements for {missing}")
    return out, {"file": "sats-elem.html", "url": SATS_ELEM, "sha256": sha256(data)}


def moon_physical(folder: Path) -> tuple[dict[str, dict[str, float]], dict[str, str]]:
    """Each satellite's GM (km^3/s^2) and mean radius (km), by name: the first two numbers of its row (references are bracketed)."""
    data = fetch(folder, "sats-phys.html", SATS_PHYS)
    text = data.decode("utf-8", errors="replace")
    out: dict[str, dict[str, float]] = {}
    for table in re.findall(r"<table.*?</table>", text, re.S):
        for row in table_cells(table):
            if len(row) < 4:
                continue
            numbers = [re.match(r"^-?[\d.]+", c) for c in row[1:]]
            values = [float(n.group(0)) for n in numbers if n]
            if len(values) >= 2:
                out[row[0]] = {"gm": values[0], "radiusKm": values[1]}
    return out, {"file": "sats-phys.html", "url": SATS_PHYS, "sha256": sha256(data)}


def sheet_rows(text: str) -> list[list[list[str]]]:
    tables = re.findall(r"<table.*?</table>", text, re.S | re.I)
    clean = lambda c: html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c))).replace("\xa0", " ").strip()  # noqa: E731
    return [[[clean(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S | re.I)] for r in re.findall(r"<tr.*?</tr>", t, re.S | re.I)] for t in tables]


def fact_sheet(folder: Path, sheet: str) -> tuple[dict[str, dict], dict[str, str]]:
    """Each moon's semi-axes (km) and visual geometric albedo from an NSSDCA fact sheet."""
    url = NSSDC.format(sheet)
    data = fetch(folder, f"{sheet}.html", url)
    tables = sheet_rows(data.decode("latin-1"))
    numbers = lambda cell: [float(x.replace(",", "")) for x in re.findall(r"[\d][\d,]*\.?\d*", cell)]  # noqa: E731
    out: dict[str, dict] = {}
    if sheet == "marsfact":
        # Phobos and Deimos: one column each, their three semi-axes and albedo by row.
        rows = {r[0]: r[1:] for r in tables[-1] if r}
        for k, name in enumerate(("Phobos", "Deimos")):
            axes = [float(rows[label][k]) for label in ("Subplanetary axis radius (km)", "Along-orbit axis radius (km)", "Polar axis radius (km)")]
            out[name] = {"axesKm": axes, "albedo": float(rows["Geometric albedo"][k])}
    elif sheet == "plutofact":
        # Pluto's small moons: mean diameters (or three diameters) and albedo.
        for row in tables[-1][1:]:
            if len(row) >= 6:
                d = numbers(row[4])
                out[re.sub(r"\s*\(.*$", "", row[0])] = {"axesKm": [x / 2 for x in d] if len(d) == 3 else None, "albedo": num(row[5])}
        # Pluto's own (the first table's Pluto column) and Charon's (in the figures that follow "Charon (P1)").
        first = {r[0]: r for r in tables[0] if r}
        out["Pluto"] = {"axesKm": None, "albedo": num(first["Geometric albedo"][1])}
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", data.decode("latin-1"))))
        charon = re.search(r"Charon \(P1\).*?Geometric Albedo ([\d.]+)", text)
        if not charon:
            raise SystemExit("plutofact: no albedo for Charon")
        out["Charon"] = {"axesKm": None, "albedo": float(charon.group(1))}
    else:
        # The satellite sheets' first table: mass, radius (or three radii), density, albedo. Only the first
        # row of each name (the second table lists the orbits by the same names).
        for row in tables[0]:
            if len(row) < 5 or not row[0]:
                continue
            name = re.sub(r"\s*\(.*$", "", row[0]).strip()
            r = numbers(row[2])
            if name in out or not r:
                continue
            out[name] = {"axesKm": r if len(r) == 3 else None, "albedo": num(row[4])}
    return out, {"file": f"{sheet}.html", "url": url, "sha256": sha256(data)}


# Each moon's phase is set from JPL Horizons: the mean elements' planes and shapes are kept, and the
# mean anomaly at CALIBRATION[0] and its rate are fitted to Horizons' positions of the moon on the two
# dates (the published tables' mean anomalies do not all reproduce Horizons' positions at their stated
# epoch: Saturn's and Uranus's are off by up to 200 degrees). Each planet's moons from its body
# (599 for Jupiter's, and so on); Pluto's from Pluto (999).
# 2026-01-01.0 TDB, then 3, 30 and 300 days on and 2034-01-01.0: each step's whole turns told apart by
# the rate the steps before it give (the table's period, for the first).
CALIBRATION = (2461041.5, 2461044.5, 2461071.5, 2461341.5, 2463963.5)
CENTRES = {"mars": "499", "jupiter": "599", "saturn": "699", "uranus": "799", "neptune": "899", "w:Pluto": "999"}


def horizons_vectors(folder: Path, name: str, command: str, center: str, dates: tuple[float, ...]) -> tuple[list[list[float]], dict[str, str]]:
    params = {
        "format": "json", "COMMAND": command, "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'VECTORS'",
        "CENTER": f"'500@{center}'", "REF_PLANE": "'ECLIPTIC'", "REF_SYSTEM": "'ICRF'", "VEC_TABLE": "'1'", "CSV_FORMAT": "'YES'",
        "OUT_UNITS": "'KM-S'", "TLIST": " ".join(f"'{jd}'" for jd in dates), "TLIST_TYPE": "'JD'", "TIME_TYPE": "'TDB'",
    }
    url = f"{HORIZONS}?{urllib.parse.urlencode(params)}"
    data = fetch(folder, f"horizons-{name}.json", url)
    result = json.loads(data)["result"]
    if "$$SOE" not in result:
        raise SystemExit(f"horizons {name}: no vectors ({result[-300:]})")
    block = result.split("$$SOE")[1].split("$$EOE")[0]
    rows = [[float(x) for x in line.split(",")[2:5]] for line in block.strip().splitlines()]
    if len(rows) != len(dates):
        raise SystemExit(f"horizons {name}: {len(rows)} rows")
    return rows, {"file": f"horizons-{name}.json", "url": url, "sha256": sha256(data)}


def rot_x(v: list[float], a: float) -> list[float]:
    c, s = math.cos(a), math.sin(a)
    return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]


def rot_z(v: list[float], a: float) -> list[float]:
    c, s = math.cos(a), math.sin(a)
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]


def moon_axes(el: dict, jd: float) -> tuple[list[float], list[float]]:
    """The orbit's perifocal unit axes in the ecliptic on a date (as src/explore/worlds/orbits.ts moonOffset turns them)."""
    dt = jd - el["epochJdTdb"]
    apsis = 360 * dt / (el["apsisYears"] * 365.25) if el["apsisYears"] else 0
    node = 360 * dt / (el["nodeYears"] * 365.25) if el["nodeYears"] else 0
    ra, dec = el["pole"]
    eps = math.radians(OBLIQUITY_DEG)
    axes = []
    for v in ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]):
        v = rot_z(v, math.radians(el["w"] + apsis))
        v = rot_x(v, math.radians(el["i"]))
        v = rot_z(v, math.radians(el["om"] - node))
        v = rot_x(v, math.radians(90 - dec))
        v = rot_z(v, math.radians(ra + 90))
        axes.append(rot_x(v, -eps))
    return axes[0], axes[1]


def mean_anomaly_at(el: dict, jd: float, r: list[float]) -> float:
    """The mean anomaly (degrees) that puts the moon where Horizons has it: its true anomaly in its own plane, through Kepler's equation."""
    p, q = moon_axes(el, jd)
    nu = math.atan2(sum(a * b for a, b in zip(r, q)), sum(a * b for a, b in zip(r, p)))
    e = el["e"]
    big_e = 2 * math.atan2(math.sqrt(1 - e) * math.sin(nu / 2), math.sqrt(1 + e) * math.cos(nu / 2))
    return math.degrees(big_e - e * math.sin(big_e))


def moon_position(el: dict, jd: float) -> list[float]:
    """Where the explorer puts the moon (src/explore/worlds/orbits.ts moonOffset), km, ecliptic."""
    p, q = moon_axes(el, jd)
    m = math.radians(el["ma"] + 360 * (jd - el["epochJdTdb"]) / el["periodDays"])
    e = el["e"]
    big_e = m
    for _ in range(50):
        big_e -= (big_e - e * math.sin(big_e) - m) / (1 - e * math.cos(big_e))
    x = el["aKm"] * (math.cos(big_e) - e)
    y = el["aKm"] * math.sqrt(1 - e * e) * math.sin(big_e)
    return [p[k] * x + q[k] * y for k in range(3)]


def angle(a: list[float], b: list[float]) -> float:
    c = sum(x * y for x, y in zip(a, b)) / math.hypot(*a) / math.hypot(*b)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def calibrate(folder: Path, code: str, host: str, el: dict) -> tuple[dict, dict[str, str]]:
    """
    The tables give the precession periods' sizes, not their sense (Io's apsides regress, locked in its
    resonance with Europa; a retrograde moon's node advances): each sense is the one whose fit puts the
    moon nearer Horizons' positions on the calibration dates (a positive apsisYears advances the
    argument of periapsis, a positive nodeYears regresses the node, as the tables mean them).
    """
    rows, query = horizons_vectors(folder, f"moon-{code}", f"'{code}'", CENTRES[host], CALIBRATION)
    best: tuple[float, dict] | None = None
    for apsis_sense in (1, -1):
        for node_sense in (1, -1):
            trial = dict(el)
            trial["apsisYears"] = el["apsisYears"] * apsis_sense
            trial["nodeYears"] = el["nodeYears"] * node_sense
            # The table's precession carried to the new epoch, so the planes stay where the table has them.
            dt = CALIBRATION[0] - el["epochJdTdb"]
            if trial["apsisYears"]:
                trial["w"] = round((el["w"] + 360 * dt / (trial["apsisYears"] * 365.25)) % 360, 6)
            if trial["nodeYears"]:
                trial["om"] = round((el["om"] - 360 * dt / (trial["nodeYears"] * 365.25)) % 360, 6)
            trial["epochJdTdb"] = CALIBRATION[0]
            m0 = mean_anomaly_at(trial, CALIBRATION[0], rows[0])
            rate = 360 / el["periodDays"]
            for jd, r in zip(CALIBRATION[1:], rows[1:]):
                span = jd - CALIBRATION[0]
                m = mean_anomaly_at(trial, jd, r)
                turns = round((rate * span - (m - m0)) / 360)
                rate = (m - m0 + 360 * turns) / span
            trial["ma"] = round(m0 % 360, 6)
            trial["periodDays"] = round(360 / rate, 9)
            miss = max(angle(moon_position(trial, jd), r) for jd, r in zip(CALIBRATION, rows))
            if best is None or miss < best[0]:
                best = (miss, trial)
    assert best is not None
    fitted = best[1]
    fitted["tablePeriodDays"] = el["periodDays"]
    fitted["calibrationMissDeg"] = round(best[0], 4)
    return fitted, query


def moons(folder: Path) -> tuple[list[dict], list[dict[str, str]]]:
    elements, q1 = moon_elements(folder)
    physical, q2 = moon_physical(folder)
    queries = [q1, q2]
    sheets: dict[str, dict] = {}
    for host, sheet in FACT_SHEETS.items():
        rows, q = fact_sheet(folder, sheet)
        sheets[host] = rows
        queries.append(q)
    out = []
    for code, host in MOONS.items():
        e = elements[code]
        name = e["name"]
        p = physical.get(name)
        if not p:
            raise SystemExit(f"sats-phys: no radius for {name}")
        f = sheets[host].get(name, {})
        # Triaxial where the fact sheet gives three semi-axes; JPL's mean radius in any case.
        axes = f.get("axesKm")
        fitted, q = calibrate(folder, code, host, e["elements"])
        queries.append(q)
        out.append({
            "id": f"w:{name}",
            "name": name,
            "designation": code,
            "kind": "moon",
            "host": host,
            "elements": fitted,
            "gm": p["gm"],
            "radiusKm": p["radiusKm"],
            "axesKm": axes,
            "albedo": f.get("albedo"),
            # Synchronous: the major moons keep one face to their planet (Hyperion and the irregulars tumble or spin freely: flagged).
            "synchronous": code not in ("607", "609", "506", "802", "902", "903"),
        })
    return out, queries


RING_SHEETS = {"uranus": "uranringfact", "neptune": "nepringfact"}


def ring_value(cell: str) -> float | None:
    """A fact sheet's ring figure: '~0.3', '0.5-2.3' (a range: its geometric mean), '<<0.01' (far below: a hundredth of it)."""
    text = cell.replace("~", "").replace("+", "").replace(",", "").strip().rstrip("-")
    if text.startswith("<<"):
        v = num(text[2:].strip())
        return v / 100 if v else None
    if text.startswith("<"):
        return None
    parts = [num(p.strip()) for p in re.split(r"\s*-\s*", text) if p.strip()]
    if not parts or any(p is None for p in parts):
        return None
    return math.sqrt(parts[0] * parts[-1]) if len(parts) == 2 else parts[0]  # type: ignore[operator]


def rings(folder: Path) -> tuple[dict[str, list[dict]], list[dict[str, str]]]:
    """Uranus's and Neptune's rings from NSSDCA's ring fact sheets: radius, width (km), normal optical depth, albedo."""
    out: dict[str, list[dict]] = {}
    queries = []
    for planet, sheet in RING_SHEETS.items():
        url = NSSDC.format(sheet)
        data = fetch(folder, f"{sheet}.html", url)
        queries.append({"file": f"{sheet}.html", "url": url, "sha256": sha256(data)})
        found = []
        for row in sheet_rows(data.decode("latin-1"))[0][2:]:
            # A ring row: name, radius, radius in planet radii, optical depth, albedo (x 1e-3), width. The arcs
            # in Neptune's Adams ring (their longitudes move) and rows without a depth are left out.
            if len(row) < 6 or row[0].startswith("Arcs") or row[0] in ("Courage", "Liberté", "Egalité 1", "Egalité 2", "Fraternité"):
                continue
            radius, tau, albedo, width = ring_value(row[1]), ring_value(row[3]), ring_value(row[4]), ring_value(row[5])
            # A width given only as a bound ("< 100"): half of it.
            if width is None and row[5].strip().startswith("<"):
                width = (ring_value(row[5].replace("<", "")) or 0) / 2 or None
            if radius is None or tau is None or width is None:
                continue
            # Lassell's radius is its inner edge, at Le Verrier's: it reaches out to Arago (the sheet's footnote).
            if row[0].startswith("Lassell"):
                radius += width / 2
            found.append({"name": re.sub(r"\s*\(.*\)$", "", row[0]), "radiusKm": radius, "widthKm": width, "tau": round(tau, 6), "albedo": round((albedo or 15) / 1000, 4)})
        out[planet] = found
    return out, queries


# --- Fixtures -------------------------------------------------------------------------------------


def fixtures(folder: Path) -> None:
    out: dict[str, object] = {
        "$comment": "Written by scripts/smallbodies/build.py fixtures. Geometric Horizons vectors (km) that tests/unit/small-bodies.spec.ts checks the explorer's propagation of the small worlds against.",
        "frame": "ecliptic and mean equinox of J2000 (REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF)",
        "timeScale": "TDB",
        "epochsJdTdb": list(FIXTURE_DATES),
        "objects": {},
    }
    for name, (command, center) in FIXTURE_OBJECTS.items():
        params = {
            "format": "json", "COMMAND": command, "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'VECTORS'",
            "CENTER": f"'{center}'", "REF_PLANE": "'ECLIPTIC'", "REF_SYSTEM": "'ICRF'", "VEC_TABLE": "'1'", "CSV_FORMAT": "'YES'",
            "OUT_UNITS": "'KM-S'", "TLIST": " ".join(f"'{jd}'" for jd in FIXTURE_DATES), "TLIST_TYPE": "'JD'", "TIME_TYPE": "'TDB'",
        }
        url = f"{HORIZONS}?{urllib.parse.urlencode(params)}"
        data = fetch(folder, f"horizons-{name}.json", url)
        result = json.loads(data)["result"]
        block = result.split("$$SOE")[1].split("$$EOE")[0]
        rows = [[float(x) for x in line.split(",")[2:5]] for line in block.strip().splitlines()]
        if len(rows) != len(FIXTURE_DATES):
            raise SystemExit(f"horizons {name}: {len(rows)} rows")
        out["objects"][name] = {"command": command, "center": center, "url": url, "sha256": sha256(data), "km": rows}  # type: ignore[index]
    FIXTURE.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")


# --- Main ---------------------------------------------------------------------------------------


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    folder = Path(sys.argv[1]).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 2 and sys.argv[2] == "fixtures":
        fixtures(folder)
        return
    OUT.mkdir(parents=True, exist_ok=True)

    rows, queries = asteroid_pages(folder)
    # The worlds flown to are drawn as themselves (their own elements at full precision), not among the points.
    named = {des for des, kind in SMALL_WORLDS if kind != "comet"}
    rows = [r for r in rows if str(r[0]) not in named]
    # The common epoch: the one most of the elements are given at (the SBDB's standard epoch).
    epoch = Counter(float(r[7]) for r in rows[: TIERS[-1]]).most_common(1)[0][0]
    tiers = []
    counts: Counter[str] = Counter()
    start = 0
    for k, end in enumerate(TIERS):
        chunk = rows[start:end]
        blob = b"".join(encode_asteroid(r, epoch) for r in chunk)
        name = f"asteroids-{k}.bin"
        (OUT / name).write_bytes(blob)
        for r in chunk:
            counts[CLASSES[class_code(str(r[9]), float(r[1]), float(r[2]), float(r[3]))]] += 1  # type: ignore[arg-type]
        tiers.append({"file": name, "count": len(chunk), "cumulative": start + len(chunk), "hMax": float(chunk[-1][8]), "bytes": len(blob), "sha256": sha256(blob)})  # type: ignore[arg-type]
        start = end

    comet_rows, comet_query = comets(folder)
    queries.append(comet_query)
    comet_doc = {
        "$comment": "Generated by scripts/smallbodies/build.py. Periodic comets: name, q (au), e, i, node, argument of perihelion (degrees, ecliptic J2000), time of perihelion (TDB JD), M1, K1 (total magnitude M1 + 5 log10(delta) + K1 log10(r)), SBDB class.",
        "comets": comet_rows,
    }
    blob = (json.dumps(comet_doc, separators=(",", ":")) + "\n").encode()
    (OUT / "comets.json").write_bytes(blob)

    worlds = []
    for des, kind in SMALL_WORLDS:
        world, q = small_world(folder, des, kind)
        worlds.append(world)
        queries.append(q)
    moon_list, moon_queries = moons(folder)
    worlds.extend(moon_list)
    queries.extend(moon_queries)
    # Pluto's GM, for its place about the barycentre with Charon: the "Planet GM" of JPL's table of Pluto's satellites.
    phys_text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", (folder / "sats-phys.html").read_text(encoding="utf-8", errors="replace"))))
    pluto_gm = re.search(r"Satellites of Pluto Planet GM: ([\d.]+)", phys_text)
    if not pluto_gm:
        raise SystemExit("sats-phys: no GM for Pluto")
    pluto_sheet, _ = fact_sheet(folder, "plutofact")
    for w in worlds:
        if w["id"] == "w:Pluto":
            w["gm"] = float(pluto_gm.group(1))
            if w["albedo"] is None:
                w["albedo"] = pluto_sheet["Pluto"]["albedo"]
    ring_list, ring_queries = rings(folder)
    queries.extend(ring_queries)
    worlds_doc = {
        "$comment": "Generated by scripts/smallbodies/build.py. The worlds the explorer can fly to: elements (degrees; a in au for the Sun's, aKm for moons), sizes in km, poles as ICRF right ascension and declination (degrees). Rings: radius and width (km), normal optical depth, albedo.",
        "worlds": worlds,
        "rings": ring_list,
    }
    (OUT / "worlds.json").write_bytes((json.dumps(worlds_doc, indent=1) + "\n").encode())

    manifest = {
        "$comment": "Generated by scripts/smallbodies/build.py. Do not edit by hand.",
        "epochJdTdb": epoch,
        "record": "16 bytes, little-endian: float32 a (au); uint16 e x 65535; uint16 i / pi x 65535; uint16 node, argument of perihelion, mean anomaly at epochJdTdb / 2 pi x 65536; uint16 ((H + 2) x 128) << 4 | class",
        "classes": list(CLASSES),
        "counts": {c: counts[c] for c in CLASSES if counts[c]},
        "tiers": tiers,
        # (Each record's index in the files, cumulative.)
        "checks": {name: next(k for k, r in enumerate(rows) if str(r[0]) == des) for des, name in CHECKS.items()},
        "comets": {"file": "comets.json", "count": len(comet_rows), "sha256": sha256(blob)},
        "worlds": {"file": "worlds.json", "count": len(worlds), "sha256": sha256((OUT / "worlds.json").read_bytes())},
        "sources": ["jpl-sbdb", "jpl-sat-elements", "jpl-sat-physical", "nssdca-fact-sheets"],
        "queries": queries,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {len(tiers)} asteroid files ({start} objects), {len(comet_rows)} comets, {len(worlds)} worlds")


if __name__ == "__main__":
    main()
