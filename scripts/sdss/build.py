"""Real galaxy positions for Chapter 5 from the SDSS DR20 spectroscopic catalogue.

Steps (run in order by scripts/preprocess-sdss.sh, or one at a time):
    fetch     SkyServer SQL queries -> .cache/sdss/raw.csv and raw-near.csv (pinned queries, sha256 recorded)
    credits   official acknowledgement pages -> .cache/sdss/credits.json (verbatim text)
    build     raw.csv -> public/assets/sdss/galaxies.bin + galaxies.json
    sources   credits + manifest -> the "sdss-dr20" entry of data/sources.json

Selection: class = GALAXY and zWarning = 0 (a reliable redshift), in two parts. Near
(0.01 < z < 0.1): every such galaxy (about 380,000 rows), dense enough to show the cosmic
web's walls, filaments and voids. Far (0.1 <= z < 0.8): a deterministic one-in-nine
subsample by fibre number (the "sparse" query, which spans all redshifts; its rows below
z = 0.1 are dropped as already in the near part). The build keeps a hash-chosen subset of
each (KEEP), then writes them together shuffled by a hash of specObjID, so that any prefix
is a fair random subsample of the whole (lower quality tiers draw a prefix).

Positions: comoving distance from astropy's Planck18 cosmology (Planck 2018 VI, Table 2,
TT,TE,EE+lowE+lensing+BAO), placed in galactic coordinates so the survey's footprint sits
correctly against the Milky Way's plane. three.js axes: +x toward the Galactic centre
(l = 0, b = 0), +y the north galactic pole, +z toward l = 270 deg (a right-handed frame).
Stored as int16 (x, y, z, redshift) quadruples: positions in units of `scaleMpc`, redshift
in units of 1/`redshiftScale`.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "sdss"
PUBLIC = ROOT / "public" / "assets" / "sdss"
RAW = CACHE / "raw.csv"
RAW_NEAR = CACHE / "raw-near.csv"
CREDITS = CACHE / "credits.json"
MANIFEST = PUBLIC / "galaxies.json"
BINARY = PUBLIC / "galaxies.bin"
SOURCES = ROOT / "data" / "sources.json"

RELEASE = "DR20"
ENDPOINT = "https://skyserver.sdss.org/dr20/SkyServerWS/SearchTools/SqlSearch"
QUERY = (
    "SELECT specObjID, ra, dec, z FROM SpecObj "
    "WHERE class='GALAXY' AND zWarning=0 AND z>0.01 AND z<0.8 AND (fiberID % 9)=0"
)
QUERY_NEAR = "SELECT specObjID, ra, dec, z FROM SpecObj WHERE class='GALAXY' AND zWarning=0 AND z>0.01 AND z<0.1"
NEAR_LIMIT = 0.1
KEEP = {"near": 300_000, "far": 120_000}
REDSHIFT_SCALE = 40_000
USER_AGENT = "kun-fayakun/0.1 (educational; github.com/SwameeW/kun-fayakun)"

# Official acknowledgement pages (copied verbatim; never retyped).
CREDIT_PAGES = {
    "sdss5": "https://www.sdss.org/collaboration/citing-sdss/",
    "sdss4": "https://www.sdss4.org/collaboration/citing-sdss/",
    "sdss3": "https://www.sdss3.org/collaboration/boiler-plate.php",
    "sdss12": "https://classic.sdss.org/collaboration/credits.html",
}
# The opening words that identify each acknowledgement on its page.
CREDIT_OPENINGS = {
    "sdss5": "Funding for the Sloan Digital Sky Survey V",
    "sdss4": "Funding for the Sloan Digital Sky Survey IV",
    "sdss3": "Funding for SDSS-III",
    "sdss12": "Funding for the SDSS and SDSS-II",
}
OVERVIEW_PAPER = "Kollmeier et al. 2026, AJ 171, 52 (SDSS-V overview; arXiv:2507.06989)"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=600) as response:  # noqa: S310 (pinned https URLs)
        return response.read()


def step_fetch() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    for query, path in ((QUERY, RAW), (QUERY_NEAR, RAW_NEAR)):
        url = ENDPOINT + "?" + urllib.parse.urlencode({"cmd": query, "format": "csv"})
        path.write_bytes(get(url))
        rows = sum(1 for _ in path.open()) - 2
        print(f"{path}: {rows} rows, sha256 {sha256(path)}")


def _read(path: Path) -> list[dict[str, str]]:
    with path.open() as handle:
        lines = [line for line in handle if not line.startswith("#")]
    return list(csv.DictReader(lines))


def _text_blocks(raw: str) -> list[str]:
    raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    blocks = re.split(r"(?i)</?(?:p|pre|blockquote|div|li|h\d)[^>]*>", raw)
    out = []
    for block in blocks:
        text = html.unescape(re.sub(r"<[^>]+>", " ", block))
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            out.append(text)
    return out


def step_credits() -> None:
    credits: dict[str, Any] = {}
    for key, url in CREDIT_PAGES.items():
        blocks = _text_blocks(get(url).decode("utf-8", errors="replace"))
        opening = CREDIT_OPENINGS[key]
        matches = [b for b in blocks if b.startswith(opening)]
        if not matches:
            raise SystemExit(f"{url}: no paragraph starting {opening!r}; the page changed, check it by hand")
        # The fullest version (SDSS-IV and V list their participating institutions).
        credits[key] = {"url": url, "text": max(matches, key=len), "retrieved": date.today().isoformat()}
        print(f"{key}: {len(credits[key]['text'])} characters from {url}")
    CACHE.mkdir(parents=True, exist_ok=True)
    CREDITS.write_text(json.dumps(credits, indent=2, ensure_ascii=False) + "\n")


def _shuffle_key(spec_ids: "Any") -> "Any":
    """splitmix64 of each specObjID: a fixed, well-mixed order (any prefix is a fair sample)."""
    import numpy as np

    x = spec_ids.astype(np.uint64)
    with np.errstate(over="ignore"):
        x = x + np.uint64(0x9E3779B97F4A7C15)
        x = (x ^ (x >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        x = (x ^ (x >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        x = x ^ (x >> np.uint64(31))
    return x


def step_build() -> None:
    import numpy as np
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astropy.cosmology import Planck18

    near_rows = _read(RAW_NEAR)
    sparse_rows = _read(RAW)
    parts = {
        "near": near_rows,
        "far": [r for r in sparse_rows if float(r["z"]) >= NEAR_LIMIT],
    }
    columns: dict[str, list[Any]] = {"id": [], "ra": [], "dec": [], "z": []}
    for name, rows in parts.items():
        ids = np.array([int(r["specObjID"]) for r in rows], dtype=np.uint64)
        keep = np.argsort(_shuffle_key(ids), kind="stable")[: KEEP[name]]
        if len(keep) < KEEP[name]:
            raise SystemExit(f"{name}: only {len(keep)} rows, wanted {KEEP[name]}")
        columns["id"].append(ids[keep])
        columns["ra"].append(np.array([float(rows[i]["ra"]) for i in keep]))
        columns["dec"].append(np.array([float(rows[i]["dec"]) for i in keep]))
        columns["z"].append(np.array([float(rows[i]["z"]) for i in keep]))
    spec_ids = np.concatenate(columns["id"])
    if len(np.unique(spec_ids)) != len(spec_ids):
        raise SystemExit("duplicate specObjID across the near and far parts")
    order = np.argsort(_shuffle_key(spec_ids), kind="stable")
    ra = np.concatenate(columns["ra"])[order]
    dec = np.concatenate(columns["dec"])[order]
    z = np.concatenate(columns["z"])[order]

    distance = Planck18.comoving_distance(z).to(u.Mpc).value
    galactic = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs").galactic
    l = np.radians(galactic.l.deg)
    b = np.radians(galactic.b.deg)
    gx = distance * np.cos(b) * np.cos(l)
    gy = distance * np.cos(b) * np.sin(l)
    gz = distance * np.sin(b)
    # three.js: x = galactic x, y = galactic z (north), z = -galactic y (right-handed).
    xyz = np.stack([gx, gz, -gy], axis=1)
    scale = float(np.abs(xyz).max()) / 32767.0
    quantised = np.rint(xyz / scale).astype(np.int16)
    redshift = np.rint(z * REDSHIFT_SCALE).clip(0, 32767).astype(np.int16)
    packed = np.concatenate([quantised, redshift[:, None]], axis=1).astype("<i2")

    PUBLIC.mkdir(parents=True, exist_ok=True)
    BINARY.write_bytes(packed.tobytes())
    error = float(np.abs(quantised * scale - xyz).max())
    manifest = {
        "$comment": "Generated by scripts/sdss/build.py. Do not edit by hand.",
        "file": BINARY.name,
        "count": int(len(packed)),
        "layout": "int16 little-endian quadruples (x, y, z, redshift); any prefix is a fair random subsample",
        "scaleMpc": scale,
        "redshiftScale": REDSHIFT_SCALE,
        "nearLimit": NEAR_LIMIT,
        "quantisationMaxErrorMpc": round(error, 4),
        "maxDistanceMpc": round(float(distance.max()), 1),
        "redshiftRange": [round(float(z.min()), 4), round(float(z.max()), 4)],
        "frame": "galactic; three.js +x toward the Galactic centre, +y north galactic pole, +z toward l = 270 deg",
        "distance": f"comoving, astropy {Planck18.name} (H0 = {Planck18.H0.value} km/s/Mpc, Om0 = {Planck18.Om0:.5f})",
        "selection": {
            "release": RELEASE,
            "endpoint": ENDPOINT,
            "query": QUERY,
            "queryNear": QUERY_NEAR,
            "rowsFetched": int(len(near_rows) + len(sparse_rows)),
            "kept": KEEP,
            "subsample": (
                f"near: every galaxy with z < {NEAR_LIMIT}; far: the one-in-nine query at z >= {NEAR_LIMIT}; "
                "each part's first KEEP rows in splitmix64(specObjID) order, written together in that order"
            ),
            "rawSha256": sha256(RAW),
            "rawNearSha256": sha256(RAW_NEAR),
        },
        "sha256": sha256(BINARY),
        "credit": "Sloan Digital Sky Survey (SDSS) DR20 spectroscopic galaxies; acknowledgements on the Sources page",
        "reference": OVERVIEW_PAPER,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: manifest[k] for k in ("count", "scaleMpc", "maxDistanceMpc", "redshiftRange", "quantisationMaxErrorMpc")}, indent=2))


def step_sources() -> None:
    credits = json.loads(CREDITS.read_text())
    manifest = json.loads(MANIFEST.read_text())
    sources = json.loads(SOURCES.read_text())
    entry = {
        "id": "sdss-dr20",
        "kind": "dataset",
        "title": "Sloan Digital Sky Survey Data Release 20: spectroscopic galaxy redshifts (SpecObj)",
        "author": "SDSS Collaboration",
        "url": "https://www.sdss.org/dr20/",
        "version": f"{RELEASE}; {manifest['count']} galaxies subsampled from {manifest['selection']['rowsFetched']} rows",
        "license": "SDSS data are public; use requires the SDSS acknowledgements below",
        "licenseUrl": CREDIT_PAGES["sdss5"],
        "credit": " ".join(credits[k]["text"] for k in ("sdss12", "sdss3", "sdss4", "sdss5")),
        "notes": (
            f"The sample spans SDSS-I/II, SDSS-III (BOSS) and SDSS-IV (eBOSS) spectra as distributed in {RELEASE}, so all four "
            f"acknowledgements apply; each is copied verbatim by scripts/sdss/build.py from its official page "
            f"({', '.join(c['url'] for c in credits.values())}). Cite: {OVERVIEW_PAPER}. "
            f"Queries: {manifest['selection']['queryNear']}; {manifest['selection']['query']}"
        ),
        "review": {"reviewer": None, "role": None, "date": None},
    }
    rest = [s for s in sources["sources"] if s["id"] != entry["id"]]
    planck_index = next((i for i, s in enumerate(rest) if s["id"] == "planck-pr3-smica"), len(rest) - 1)
    rest.insert(planck_index + 1, entry)
    sources["sources"] = rest
    SOURCES.write_text(json.dumps(sources, indent=2, ensure_ascii=False) + "\n")
    print(f"updated {SOURCES} ({len(entry['credit'])} characters of acknowledgement)")


STEPS = {"fetch": step_fetch, "credits": step_credits, "build": step_build, "sources": step_sources}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=list(STEPS))
    STEPS[parser.parse_args().step]()


if __name__ == "__main__":
    sys.exit(main())
