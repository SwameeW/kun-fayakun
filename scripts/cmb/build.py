"""Planck CMB texture pipeline. Run through scripts/preprocess-cmb.sh.

Steps (each reads the previous step's output from .cache/cmb-work):
    verify-source  check the FITS file's size and sha256 against config.py
    grid           FITS -> smoothed, resampled 4096x2048 float32 grid in uK (+ checks)
    images         grid -> colour-mapped lossless PNG and mip-level PNGs
    encode         mip levels -> public/assets/cmb/*.ktx2, decoded back for checks
    preview        annotated previews of the PNG and of the decoded KTX2 files
    manifest       public/assets/cmb/cmb.json
    polarisation   Q, U -> the line texture and public/assets/cmb/cmb-polarisation.json (polarisation.py)
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import config


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def step_verify_source() -> None:
    path = config.FITS_PATH
    if not path.exists():
        raise SystemExit(f"Missing {path}. Download it from {config.FITS_URL}")
    size = path.stat().st_size
    if size != config.FITS_BYTES:
        raise SystemExit(f"{path.name} is {size} bytes, expected {config.FITS_BYTES}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 24), b""):
            digest.update(chunk)
    if digest.hexdigest() != config.FITS_SHA256:
        raise SystemExit(f"sha256 mismatch for {path.name}: {digest.hexdigest()}")
    print(f"{path.name}: {size} bytes, sha256 {config.FITS_SHA256} OK")


def step_grid() -> None:
    import sky_map

    stats = sky_map.build_grid()
    write_json(config.GRID_STATS_PATH, stats)
    print(json.dumps(stats, indent=2))


def step_images() -> None:
    import images

    paths = images.build_images()
    print(f"wrote {config.LOSSLESS_PNG} and {len(paths)} mip levels in {config.LEVELS_DIR}")


def step_encode() -> None:
    import encode

    report = encode.encode_all()
    write_json(config.ENCODE_REPORT_PATH, report)
    print(json.dumps(report, indent=2))


def step_preview() -> None:
    import preview

    report = preview.build_previews()
    print(json.dumps(report, indent=2))


def step_temperature() -> None:
    import temperature

    report = temperature.build_temperature()
    write_json(config.WORK / "temperature-report.json", report)
    print(json.dumps(report, indent=2))


def step_manifest() -> None:
    import manifest

    out = config.PUBLIC / "cmb.json"
    write_json(out, manifest.build_manifest())
    print(f"wrote {out}")


def step_polarisation() -> None:
    import polarisation

    report = polarisation.build_polarisation()
    write_json(config.WORK / "polarisation-report.json", report)
    out = config.PUBLIC / polarisation.MANIFEST_NAME
    write_json(out, polarisation.build_manifest(report))
    print(f"wrote {out}")


STEPS = {
    "verify-source": step_verify_source,
    "grid": step_grid,
    "images": step_images,
    "encode": step_encode,
    "preview": step_preview,
    "temperature": step_temperature,
    "manifest": step_manifest,
    "polarisation": step_polarisation,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=list(STEPS))
    args = parser.parse_args()
    STEPS[args.step]()


if __name__ == "__main__":
    main()
