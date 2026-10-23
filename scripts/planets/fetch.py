"""Downloads the pinned planet sources into .cache/planets/download/<source id>/ and checks them.

Each file is fetched with curl (the system trust store; Python's may lack a proxy's CA), into its
own directory per source, and must match the byte count and sha256 pinned in config.py. Files
already present are only checked. The Cassini ring profile is not downloaded here: the JPL
builder already fetches and pins it (scripts/jpl/build.py), and its sha256 is checked against the
value public/assets/jpl/physical.json records.

Usage: python scripts/planets/fetch.py [--refresh]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import date
from pathlib import Path

import config

RETRIEVED = config.DOWNLOAD / "retrieved.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 24), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _curl(url: str, out: Path) -> bool:
    result = subprocess.run(  # noqa: S603
        ["curl", "-fsSL", "--retry", "3", "--max-time", "3600", "-A", config.USER_AGENT, "-o", str(out), url],  # noqa: S607
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        print(f"  curl failed ({result.returncode}) for {url}: {result.stderr.strip()}")
    return result.returncode == 0


def check(key: str, source: config.SourceFile) -> None:
    path = source.path
    size = path.stat().st_size
    if size != source.bytes:
        raise SystemExit(f"{key}: {path} is {size} bytes, expected {source.bytes}; delete it and run again")
    actual = sha256(path)
    if actual != source.sha256:
        raise SystemExit(
            f"{key}: sha256 {actual} does not match the pinned {source.sha256}. The publisher may have replaced the file: "
            "inspect it before re-pinning in scripts/planets/config.py."
        )
    print(f"{key}: {path.relative_to(config.ROOT)} {size:,} bytes, sha256 OK")


def fetch(refresh: bool) -> None:
    config.DOWNLOAD.mkdir(parents=True, exist_ok=True)
    dates: dict[str, str] = json.loads(RETRIEVED.read_text()) if RETRIEVED.exists() else {}
    for key, source in config.FILES.items():
        path = source.path
        if refresh or not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            part = path.with_name(path.name + ".part")
            if not _curl(source.url, part) and not (source.fallback and _curl(source.fallback, part)):
                raise SystemExit(f"{key}: could not download {source.url}")
            part.replace(path)
            dates[key] = date.today().isoformat()
        check(key, source)
        # A file that was placed in the cache by hand counts as retrieved the day it is first checked.
        dates.setdefault(key, date.today().isoformat())
    RETRIEVED.write_text(json.dumps(dates, indent=2, sort_keys=True) + "\n")

    rings = config.RINGS_TABLE
    if not rings.exists():
        raise SystemExit(f"Missing {rings}: run npm run preprocess:jpl first (it downloads the Cassini RSS profile)")
    if sha256(rings) != config.RINGS_TABLE_SHA256:
        raise SystemExit(f"{rings.name}: sha256 differs from the one public/assets/jpl/physical.json records")
    physical = json.loads((config.ROOT / "public" / "assets" / "jpl" / "physical.json").read_text())
    if physical["sources"]["rings"]["sha256"] != config.RINGS_TABLE_SHA256:
        raise SystemExit("public/assets/jpl/physical.json records another ring profile; update RINGS_TABLE_SHA256")
    print(f"rings: {rings.relative_to(config.ROOT)} sha256 OK (the JPL builder's copy)")


def retrieved(source_id: str) -> str:
    """The day the files of one source were downloaded (latest of them), for data/sources.json."""
    dates: dict[str, str] = json.loads(RETRIEVED.read_text()) if RETRIEVED.exists() else {}
    days = sorted(dates[k] for k, f in config.FILES.items() if f.source_id == source_id and k in dates)
    return days[-1] if days else date.today().isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--refresh", action="store_true", help="download every file again")
    fetch(parser.parse_args().refresh)


if __name__ == "__main__":
    main()
