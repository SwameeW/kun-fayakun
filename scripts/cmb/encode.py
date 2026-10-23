"""KTX2 (Basis Universal) encoding of the mip-level PNGs with KTX-Software's `ktx` tool."""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import config
import images

KTX = config.KTX_PREFIX / "bin" / "ktx"


def _run(args: list[str | Path]) -> str:
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(str(a) for a in args[:2])} failed ({result.returncode}):\n{result.stderr}{result.stdout}")
    return result.stdout


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _level0_quality(report: str) -> dict[str, float]:
    """Parses `--compare-psnr --compare-ssim` output for level 0.

    ktx's PSNR is computed on Rec. 709 luma, not on RGB, so it hides the chroma
    loss of ETC1S (RGB PSNR is in cmb.json verification.decoded); the key says so.
    """
    block = report.split("Level 1:")[0]
    quality: dict[str, float] = {}
    psnr = re.search(r"PSNR:\s*([0-9.]+)", block)
    if psnr:
        quality["ktxLumaPsnrDb"] = round(float(psnr.group(1)), 2)
    ssim = re.search(r"SSIM R:\s*([+0-9.]+),\s*G:\s*([+0-9.]+),\s*B:\s*([+0-9.]+)", block)
    if ssim:
        quality.update({f"ktxSsim{c}": round(float(v), 3) for c, v in zip("RGB", ssim.groups())})
    return quality


def tool_version() -> dict[str, str]:
    """Version string plus the release package URL and sha256 written by fetch-ktx.sh."""
    info = {"version": _run([KTX, "--version"]).strip()}
    stamp = config.KTX_PREFIX / "SOURCE"
    if stamp.exists():
        for line in stamp.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if value:
                info[f"package{key.capitalize()}"] = value
    return info


def encode_one(key: str, first_level: int) -> dict[str, Any]:
    level_count = config.WIDTH.bit_length()  # 4096 -> 13 levels down to 1x1
    levels = [images.level_path(i) for i in range(first_level, level_count)]
    missing = [p for p in levels if not p.exists()]
    if missing:
        raise SystemExit(f"Missing mip levels: {missing}")

    # The colour-mapped encodes are kept as verification artifacts in the work directory;
    # the app ships the lossless temperature texture instead (temperature.py).
    out = config.WORK / "published-colour" / config.OUTPUT_FILES[key]
    staged = config.WORK / "encoded" / config.OUTPUT_FILES[key]
    staged.parent.mkdir(parents=True, exist_ok=True)
    report = _run([
        KTX, "create",
        "--format", "R8G8B8_SRGB",
        "--assign-tf", "srgb",
        "--assign-primaries", "srgb",
        "--assign-texcoord-origin", "bottom-left",
        "--levels", str(len(levels)),
        *config.KTX_ENCODE_ARGS,
        "--compare-psnr", "--compare-ssim",
        *levels, staged,
    ])
    _run([KTX, "validate", staged])

    config.DECODED_DIR.mkdir(parents=True, exist_ok=True)
    decoded = config.DECODED_DIR / f"cmb-{key}-level0.png"
    _run([KTX, "extract", "--transcode", "rgba8", "--level", "0", staged, decoded])

    size = staged.stat().st_size
    budget = config.SIZE_BUDGET_BYTES[key]
    if size > budget:
        raise SystemExit(f"{out.name} is {size} bytes, over the {budget}-byte budget")
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(staged, out)
    return {
        "file": out.name,
        "bytes": size,
        "sha256": _sha256(out),
        "width": config.WIDTH >> first_level,
        "height": config.HEIGHT >> first_level,
        "levels": len(levels),
        "budgetBytes": budget,
        "quality": _level0_quality(report),
    }


def encode_all() -> dict[str, Any]:
    return {
        "tool": tool_version(),
        "args": config.KTX_ENCODE_ARGS,
        "files": {"4096": encode_one("4096", 0), "2048": encode_one("2048", 1)},
    }
