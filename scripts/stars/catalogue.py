"""Writes the explorer's deep star catalogue (docs/NEIGHBOURHOOD.md, "More stars") as binary packs in
public/assets/stars/, with a manifest, catalogue.json:

- hipparcos.bin: every star of the Hipparcos new reduction (van Leeuwen 2007, CDS I/311/hip2; V and
  B-V from the main catalogue, ESA 1997, CDS I/239/hip_main) that is not one of the Bright Star
  Catalogue's (those are the explorer's sky, public/assets/sky/sky.json, matched to Hipparcos through
  their HD numbers, the neighbourhood's bsc_hip.csv). Close pairs of one multiple system (the same
  CCDM number, within 30 arcseconds, their parallaxes agreeing within twice their combined error)
  share the parallax measured best, and a few systems take a cited parallax instead (OVERRIDES), as
  the neighbourhood's file does.
- tycho2-0.bin, tycho2-1.bin, tycho2-2.bin: the Tycho-2 catalogue's stars (Hog et al. 2000, CDS
  I/259) that are not Hipparcos stars, as directions on the sky (Tycho-2 measured no parallaxes), in
  three packs, brightest first: no star is drawn twice. A Tycho-2 star with a HIP number is
  Hipparcos's; one without, but within 2 arcseconds of a Hipparcos star (its place carried to J2000
  by its proper motion), or 6 of a Bright Star Catalogue star, and within a magnitude of it, is taken
  to be the same star and left out too.
  V and B-V from Tycho's BT and VT by the catalogue's own relations (V = VT - 0.090 (BT - VT),
  B-V = 0.850 (BT - VT)).
- band.bin: the Milky Way's band as Tycho-2's faint stars trace it: the number of its stars fainter
  than V = 9 per square degree across the sky (galactic longitude and latitude, 512 by 256, smoothed
  over about two cells), on a logarithmic scale, and their mean colour.

Records (little-endian; directions are ICRS unit vectors, octahedrally encoded in two uint16):
- hipparcos.bin, 16 bytes: uint32 HIP, uint16 x2 direction, float32 parallax (mas), uint16 its
  error (0.01 mas), uint8 V ((V + 1.5) * 16), uint8 B-V ((B-V + 0.5) * 64; 255 not measured).
- tycho2-*.bin, 6 bytes: uint16 x2 direction, uint8 V, uint8 B-V (as above).
- band.bin: 512 * 256 uint8 density, then 512 * 256 uint8 colour, row 0 at latitude -90.

Usage: python3 -I scripts/stars/catalogue.py <download dir>   (queries and fetches what is missing)
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import math
import struct
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "stars"
SKY = ROOT / "public" / "assets" / "sky" / "sky.json"
VIZIER = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
HIP_QUERY = ("hip_all.csv", 'SELECT n.HIP, n.RArad, n.DErad, n.Plx, n.e_Plx, n.pmRA, n.pmDE, h.Vmag, h."B-V", h.CCDM FROM "I/311/hip2" AS n JOIN "I/239/hip_main" AS h ON n.HIP = h.HIP')
TYCHO = "https://cdsarc.cds.unistra.fr/ftp/I/259/"
TYCHO_FILES = [f"tyc2.dat.{i:02d}.gz" for i in range(20)]
# The parallaxes of a few systems measured better than Hipparcos did (mas, its error), by HIP number.
OVERRIDES = {
    # Alpha Centauri A and B: Kervella et al. (2016), A&A 594, A107 (Hipparcos's B, 796.92 +/- 25.9, put it 0.07 pc from A).
    71683: (747.17, 0.61, "kervella-2016-alpha-cen"),
    71681: (747.17, 0.61, "kervella-2016-alpha-cen"),
}
# Close pairs of a multiple share the best parallax only within this separation (arcseconds): Proxima shares Alpha Centauri's CCDM number 2 degrees away, at its own distance.
PAIR_ARCSEC = 30
# Tycho-2 stars taken to be a Hipparcos star: within this (arcseconds) and this many magnitudes of one.
SAME_ARCSEC = 2.0
SAME_MAG = 1.0
# And the Bright Star Catalogue's (the explorer's sky), whose places are less precise.
BRIGHT_ARCSEC = 6.0
# The packs, cumulative counts (brightest first).
PACKS = (300_000, 1_000_000)
BAND = {"width": 512, "height": 256, "fainterThan": 9.0}
# The galactic frame (Hipparcos's: ESA 1997, vol. 1, sect. 1.5.3), ICRS degrees.
POLE = (192.85948, 27.12825)
CENTRE = (266.40499, -28.93617)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(text: str | None) -> float | None:
    try:
        return float(text) if text is not None and text.strip() != "" else None
    except ValueError:
        return None


def unit(ra: float, dec: float) -> tuple[float, float, float]:
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def octahedral(v: tuple[float, float, float]) -> tuple[int, int]:
    """A unit vector on the octahedron folded to a square, each half of it a uint16."""
    x, y, z = v
    s = abs(x) + abs(y) + abs(z)
    x, y, z = x / s, y / s, z / s
    if z < 0:
        x, y = (1 - abs(y)) * (1 if x >= 0 else -1), (1 - abs(x)) * (1 if y >= 0 else -1)
    return (round((x + 1) / 2 * 65535), round((y + 1) / 2 * 65535))


def v_code(v: float) -> int:
    return max(0, min(255, round((v + 1.5) * 16)))


def bv_code(bv: float | None) -> int:
    return 255 if bv is None else max(0, min(254, round((bv + 0.5) * 64)))


def query(folder: Path, name: str, adql: str) -> Path:
    path = folder / name
    if not path.exists():
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "MAXREC": "200000", "QUERY": adql}
        urllib.request.urlretrieve(f"{VIZIER}?{urllib.parse.urlencode(params)}", path)
    return path


def bsc_hips(folder: Path) -> set[int]:
    """The Bright Star Catalogue's stars' HIP numbers (the neighbourhood's query, its result pinned there)."""
    pinned = json.loads((OUT / "neighbourhood.json").read_text())["sources"]["hipparcos"]["queries"]["bsc_hip.csv"]["sha256"]
    path = folder / "bsc_hip.csv"
    if not path.exists() or sha256(path) != pinned:
        raise SystemExit(f"{path}: the neighbourhood's bsc_hip.csv (sha256 {pinned}) is needed; run scripts/stars/neighbourhood.py into the same folder")
    with path.open() as f:
        return {int(r["HIP"]) for r in csv.DictReader(f)}


def separation_arcsec(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    d = math.dist(a, b)
    return math.degrees(2 * math.asin(min(1.0, d / 2))) * 3600


def hipparcos(folder: Path) -> list[dict]:
    with query(folder, *HIP_QUERY).open() as f:
        rows = [r for r in csv.DictReader(f)]
    stars = []
    for r in rows:
        ra, dec, v = number(r["RArad"]), number(r["DErad"]), number(r["Vmag"])
        plx, eplx = number(r["Plx"]), number(r["e_Plx"])
        if ra is None or dec is None or v is None or plx is None or eplx is None:
            continue
        stars.append({"hip": int(r["HIP"]), "ra": ra, "dec": dec, "plx": plx, "eplx": eplx, "pmra": number(r["pmRA"]) or 0.0, "pmde": number(r["pmDE"]) or 0.0, "v": v, "bv": number(r["B-V"]), "ccdm": r["CCDM"].strip(), "dir": unit(ra, dec), "source": None})
    # Close pairs of one multiple: the best-measured parallax for both; then the cited ones.
    groups: dict[str, list[dict]] = {}
    for s in stars:
        if s["ccdm"]:
            groups.setdefault(s["ccdm"], []).append(s)
    shared = 0
    for members in groups.values():
        for s in members:
            # Near on the sky, and parallaxes agreeing within twice their combined error (an optical pair's would not).
            near = [o for o in members if separation_arcsec(s["dir"], o["dir"]) <= PAIR_ARCSEC and abs(o["plx"] - s["plx"]) <= 2 * math.hypot(o["eplx"], s["eplx"])]
            best = min(near, key=lambda o: o["eplx"])
            if best is not s and best["eplx"] < s["eplx"]:
                s["plx"], s["eplx"], s["source"] = best["plx"], best["eplx"], f"HIP {best['hip']}"
                shared += 1
    for s in stars:
        if s["hip"] in OVERRIDES:
            s["plx"], s["eplx"], s["source"] = OVERRIDES[s["hip"]]
    print(f"hipparcos: {len(stars)} stars, {shared} sharing a close companion's parallax")
    return stars


def tycho(folder: Path, in_hipparcos: set[int]) -> tuple[list[tuple[float, float, float, float | None, None]], dict[str, str]]:
    sub = folder / "tycho2"
    sub.mkdir(parents=True, exist_ok=True)
    hashes: dict[str, str] = {}
    out = []
    for name in TYCHO_FILES:
        path = sub / name
        if not path.exists():
            urllib.request.urlretrieve(TYCHO + name, path)
        hashes[name] = sha256(path)
        with gzip.open(path, "rt", encoding="ascii") as f:
            for line in f:
                hip = line[142:148].strip()
                if hip and int(hip) in in_hipparcos:
                    continue  # A Hipparcos star: drawn from Hipparcos (the few the new reduction lacks stay Tycho-2's).
                pflag = line[13]
                ra = number(line[15:27]) if pflag != "X" else None
                dec = number(line[28:40]) if pflag != "X" else None
                if ra is None or dec is None:
                    ra, dec = number(line[152:164]), number(line[165:177])
                bt, vt = number(line[110:116]), number(line[123:129])
                if ra is None or dec is None or (bt is None and vt is None):
                    continue
                if bt is not None and vt is not None:
                    v, bv = vt - 0.090 * (bt - vt), 0.850 * (bt - vt)
                else:
                    v, bv = (vt if vt is not None else bt), None
                out.append((ra, dec, float(v), bv, None))
    print(f"tycho-2: {len(out)} stars without a HIP number")
    return out, hashes


def drop_doubles(tyc: list, hip: list[dict], bright: list[tuple[float, float, float]]) -> tuple[list, int]:
    """
    Tycho-2 stars at a Hipparcos star's place (J2000, by its proper motion) or a Bright Star
    Catalogue star's (J2000; its places are given to a second or so), and of its brightness: the same star.
    """
    cell = BRIGHT_ARCSEC / 3600
    grid: dict[tuple[int, int], list[tuple[tuple[float, float, float], float, float]]] = {}

    def add(ra: float, dec: float, v: float, within: float) -> None:
        key = (int(math.floor(dec / cell)), int(math.floor(ra * math.cos(math.radians(dec)) / cell)))
        grid.setdefault(key, []).append((unit(ra, dec), v, within))

    for s in hip:
        # Hipparcos's epoch is J1991.25: carried 8.75 years on (mas/yr, the RA's already times cos dec).
        dra = s["pmra"] * 8.75 / 3.6e6 / max(math.cos(math.radians(s["dec"])), 1e-6)
        ddec = s["pmde"] * 8.75 / 3.6e6
        add((s["ra"] + dra) % 360, max(-90.0, min(90.0, s["dec"] + ddec)), s["v"], SAME_ARCSEC)
    for ra, dec, v in bright:
        add(ra, dec, v, BRIGHT_ARCSEC)
    kept = []
    dropped = 0
    for row in tyc:
        ra, dec, v = row[0], row[1], row[2]
        u = unit(ra, dec)
        cy = int(math.floor(dec / cell))
        cx = int(math.floor(ra * math.cos(math.radians(dec)) / cell))
        same = False
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for hu, hv, within in grid.get((cy + dy, cx + dx), ()):
                    if abs(hv - v) <= SAME_MAG and separation_arcsec(u, hu) <= within:
                        same = True
        if same:
            dropped += 1
        else:
            kept.append(row)
    print(f"tycho-2: {dropped} left out as Hipparcos or bright stars without a HIP number")
    return kept, dropped


def galactic(v: tuple[float, float, float]) -> tuple[float, float]:
    z = unit(*POLE)
    c = unit(*CENTRE)
    y = (z[1] * c[2] - z[2] * c[1], z[2] * c[0] - z[0] * c[2], z[0] * c[1] - z[1] * c[0])
    ly = math.sqrt(sum(k * k for k in y))
    y = tuple(k / ly for k in y)
    x = (y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0])
    gx, gy, gz = (sum(a * b for a, b in zip(v, axis)) for axis in (x, y, z))
    return (math.degrees(math.atan2(gy, gx)) % 360, math.degrees(math.asin(max(-1.0, min(1.0, gz)))))


def band(tyc: list) -> tuple[bytes, dict]:
    w, h = BAND["width"], BAND["height"]
    counts = [0.0] * (w * h)
    colour = [0.0] * (w * h)
    coloured = [0] * (w * h)
    for ra, dec, v, bv, _ in tyc:
        if v <= BAND["fainterThan"]:
            continue
        l, b = galactic(unit(ra, dec))
        i = min(w - 1, int(l / 360 * w))
        j = min(h - 1, int((b + 90) / 180 * h))
        counts[j * w + i] += 1
        if bv is not None:
            colour[j * w + i] += bv
            coloured[j * w + i] += 1
    # Per square degree (each row's cells shrink toward the poles), then smoothed over a cell (1 2 1 both ways, longitude wrapping).
    cell_deg = (360 / w) * (180 / h)
    density = [0.0] * (w * h)
    for j in range(h):
        b0, b1 = math.radians(-90 + 180 * j / h), math.radians(-90 + 180 * (j + 1) / h)
        area = (360 / w) * math.degrees(math.sin(b1) - math.sin(b0)) if b1 != b0 else cell_deg
        for i in range(w):
            density[j * w + i] = counts[j * w + i] / max(area, 1e-9)

    def smooth(a: list[float]) -> list[float]:
        out = [0.0] * (w * h)
        for j in range(h):
            for i in range(w):
                s = 0.0
                n = 0.0
                for dj, wj in ((-1, 1), (0, 2), (1, 1)):
                    jj = j + dj
                    if jj < 0 or jj >= h:
                        continue
                    for di, wi in ((-1, 1), (0, 2), (1, 1)):
                        s += a[jj * w + (i + di) % w] * wj * wi
                        n += wj * wi
                out[j * w + i] = s / n
        return out

    density = smooth(smooth(density))
    mean_bv = smooth([colour[k] / coloured[k] if coloured[k] else 0.6 for k in range(w * h)])
    top = max(density)
    floor = sorted(density)[len(density) // 20] or 1.0
    scale = math.log1p(top / floor)
    dens = bytes(max(0, min(255, round(255 * math.log1p(d / floor) / scale))) for d in density)
    col = bytes(bv_code(b) for b in mean_bv)
    return dens + col, {"perSquareDegree": {"floor": round(floor, 4), "max": round(top, 2), "code": "density = floor * (exp(code / 255 * ln(1 + max / floor)) - 1)"}}


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    bright = bsc_hips(folder)
    hip = hipparcos(folder)
    sky = json.loads(SKY.read_text())
    f = sky["starFields"]
    bsc = [(row[f.index("raDeg")], row[f.index("decDeg")], row[f.index("vmag")]) for row in sky["stars"]]
    tyc, hashes = tycho(folder, {s["hip"] for s in hip})
    tyc, dropped = drop_doubles(tyc, hip, bsc)
    # Brightest first; ties by place, so the order (and the files) never depend on the input's.
    tyc.sort(key=lambda r: (r[2], r[0], r[1]))
    rest = sorted((s for s in hip if s["hip"] not in bright), key=lambda s: (s["v"], s["hip"]))

    OUT.mkdir(parents=True, exist_ok=True)
    packs = []
    with (OUT / "hipparcos.bin").open("wb") as f:
        for s in rest:
            x, y = octahedral(s["dir"])
            f.write(struct.pack("<IHHfHBB", s["hip"], x, y, s["plx"], max(0, min(65535, round(s["eplx"] * 100))), v_code(s["v"]), bv_code(s["bv"])))
    packs.append({"file": "hipparcos.bin", "kind": "hipparcos", "count": len(rest), "record": 16, "vmag": [round(rest[0]["v"], 2), round(rest[-1]["v"], 2)], "sha256": sha256(OUT / "hipparcos.bin")})
    bounds = [0, *[min(n, len(tyc)) for n in PACKS], len(tyc)]
    for k in range(3):
        part = tyc[bounds[k] : bounds[k + 1]]
        name = f"tycho2-{k}.bin"
        with (OUT / name).open("wb") as f:
            for ra, dec, v, bv, _ in part:
                x, y = octahedral(unit(ra, dec))
                f.write(struct.pack("<HHBB", x, y, v_code(v), bv_code(bv)))
        packs.append({"file": name, "kind": "tycho2", "count": len(part), "record": 6, "vmag": [round(part[0][2], 2), round(part[-1][2], 2)], "sha256": sha256(OUT / name)})
    band_bytes, band_scale = band(tyc)
    (OUT / "band.bin").write_bytes(band_bytes)
    hip_csv = folder / HIP_QUERY[0]
    manifest = {
        "frame": "ICRS unit vectors (Hipparcos epoch J1991.25; Tycho-2 J2000 mean places, or its observed ones where it has none), octahedrally encoded: x = (u + 1) / 2 * 65535 for each of the folded square's two coordinates",
        "encoding": {"vmag": "code / 16 - 1.5", "bv": "code / 64 - 0.5 (255: not measured)", "plx": "float32 mas", "ePlx": "uint16 / 100 mas"},
        "packs": packs,
        "band": {"file": "band.bin", "width": BAND["width"], "height": BAND["height"], "frame": "galactic longitude (0 to 360, left to right) and latitude (-90 to 90, row 0 first)", "stars": f"Tycho-2's stars fainter than V = {BAND['fainterThan']}", **band_scale, "sha256": sha256(OUT / "band.bin")},
        "counts": {"hipparcos": len(hip), "hipparcosInPacks": len(rest), "brightStars": len(bright), "tycho2": len(tyc), "tycho2SameAsHipparcos": dropped},
        "multiples": {"pairArcsec": PAIR_ARCSEC, "overrides": {str(k): {"plxMas": v[0], "ePlxMas": v[1], "source": v[2]} for k, v in OVERRIDES.items()}},
        "sources": {
            "hipparcos": {"ids": ["hipparcos-van-leeuwen-2007", "hipparcos-esa-1997"], "query": {"service": VIZIER, "adql": HIP_QUERY[1], "sha256": sha256(hip_csv)}},
            "tycho2": {"ids": ["tycho-2-hog-2000"], "files": {name: {"url": TYCHO + name, "sha256": h} for name, h in hashes.items()}},
            "parallaxes": {"ids": ["kervella-2016-alpha-cen"]},
        },
    }
    (OUT / "catalogue.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    for p in packs:
        print(f"{p['file']}: {p['count']} stars, V {p['vmag'][0]} to {p['vmag'][1]}")


if __name__ == "__main__":
    main()
