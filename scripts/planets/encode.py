"""Encodes the mip chains from build.py into KTX2 files, one per map and tier, and checks them.

Codecs (config.py): colour ETC1S at Low and Medium, UASTC + RDO + zstd at High and Ultra;
single-channel maps raw R8 + lossless zstd; normal maps UASTC in normal mode (X in RGB, Y in
alpha); the ring strip raw RGBA8 + lossless zstd. Every file declares bottom-left texture
coordinates (KTXorientation "ru"), which is how build.py stored the rows.

After encoding, each file is validated with `ktx validate`, decoded back to 8 bits with `ktx
extract`, compared with its input (PSNR) and put through the same landmark checks as the
source, flipped back to north-up first: so a file in the wrong row order, or shifted in
longitude, cannot be published. Byte budgets per tier and for everything committed are
enforced last.

Low, Medium and High go to public/assets/planets/<body>/; Ultra (8192) files go to
.cache/planets/ultra/<body>/ and are not published (where to host them is an owner decision).

Output: the files above and .cache/planets/reports/encode.json.
Usage: python scripts/planets/encode.py [body/map ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

import build
import config
import landmarks

KTX = config.KTX_PREFIX / "bin" / "ktx"
DECODED = config.WORK / "decoded"
REPORT = config.REPORTS / "encode.json"


def run(args: list[str | Path]) -> str:
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, check=False)  # noqa: S603
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(str(a) for a in args[:2])} failed ({result.returncode}):\n{result.stderr}{result.stdout}")
    return result.stdout


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tool_version() -> dict[str, str]:
    info = {"version": run([KTX, "--version"]).strip()}
    stamp = config.KTX_PREFIX / "SOURCE"
    if stamp.exists():
        for line in stamp.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if value:
                info[f"package{key.capitalize()}"] = value
    return info


def codec_for(spec: config.MapSpec, tier: str) -> str:
    if spec.kind == "colour":
        return "etc1s" if tier in ("low", "medium") else "uastc"
    return {"grey": "r8", "normal": "uastc", "strip": "rgba8"}[spec.kind]


def tier_width(spec: config.MapSpec, tier: str) -> int:
    if spec.kind == "strip":
        return spec.max_width
    cap = spec.max_width
    if tier in config.PUBLISHED_TIERS and spec.published_max_width is not None:
        cap = min(cap, spec.published_max_width)
    return min(config.TIERS[tier], cap)


def file_name(spec: config.MapSpec, width: int, codec: str) -> str:
    return f"{spec.map}-{width}-{codec}.ktx2"


def ktx_args(spec: config.MapSpec, codec: str) -> list[str]:
    if spec.kind == "colour":
        base = ["--format", "R8G8B8_SRGB", "--assign-tf", "srgb", "--assign-primaries", "srgb"]
        return base + (config.ETC1S_ARGS if codec == "etc1s" else config.UASTC_ARGS)
    if spec.kind == "normal":
        return ["--format", "R8G8B8_UNORM", "--assign-tf", "linear", "--assign-primaries", "none", *config.NORMAL_ARGS]
    if spec.kind == "grey":
        return list(config.R8_ARGS)
    return list(config.STRIP_ARGS)


def level_files(spec: config.MapSpec, width: int) -> list[Path]:
    paths = []
    w = width
    while True:
        path = build.level_path(spec.body, spec.map, w)
        if not path.exists():
            raise SystemExit(f"Missing {path}: run build.py {spec.body if spec.map != 'rings' else 'rings'} first")
        paths.append(path)
        if w == 1:
            break
        w //= 2
    return paths


def read_png(path: Path) -> NDArray[np.uint8]:
    image = Image.open(path)
    # `ktx extract` (lodepng) writes a palette PNG when that is smaller; palette indices are not values.
    if image.mode == "P":
        image = image.convert("RGBA" if "transparency" in image.info else "RGB")
    return np.asarray(image)


def decode(out: Path, codec: str) -> NDArray[np.uint8]:
    """Level 0 decoded to 8 bits per channel (rows as stored: bottom-up)."""
    DECODED.mkdir(parents=True, exist_ok=True)
    png = DECODED / (out.stem + ".png")
    png.unlink(missing_ok=True)
    args: list[str | Path] = [KTX, "extract", "--level", "0"]
    if codec in ("etc1s", "uastc"):
        args += ["--transcode", "rgba8"]
    run([*args, out, png])
    return read_png(png)


def normal_xy(decoded: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """X and Y of a decoded normal-mode file. UASTC normal mode is RRRG (X in RGB, Y in A, as a GPU
    sees it after transcoding); `ktx extract` writes those two channels as R and G of an RGB PNG."""
    y = decoded[..., 3] if decoded.shape[-1] == 4 else decoded[..., 1]
    return np.stack([decoded[..., 0], y], axis=-1)


def psnr(a: NDArray[np.uint8], b: NDArray[np.uint8]) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return round(99.0 if mse == 0 else 10.0 * np.log10(255.0**2 / mse), 2)


def check_decoded(spec: config.MapSpec, decoded: NDArray[np.uint8], label: str) -> list[dict[str, object]]:
    """The source's landmark checks on the decoded file, turned north-up again."""
    north_up = np.flipud(decoded)
    if spec.kind == "grey" and north_up.ndim == 3:
        north_up = north_up[..., 0]  # R8 comes back as R, G = B = 0
    key = f"{spec.body}/{spec.map}"
    if key == "earth/day":
        return landmarks.earth_day(north_up[..., :3], label)
    if key == "earth/night":
        return landmarks.earth_night(north_up, label)
    if key == "earth/clouds":
        return landmarks.earth_clouds(north_up, label)
    if key == "earth/water":
        return landmarks.earth_water(north_up.astype(np.float32), label, scale=255.0)
    if key == "earth/normal":
        return landmarks.earth_normals(normal_xy(north_up), label)
    if key == "moon/colour":
        return landmarks.moon_colour(north_up[..., :3], label)
    if key == "moon/normal":
        return landmarks.moon_normals(normal_xy(north_up), label)
    if key == "jupiter/colour":
        return landmarks.jupiter_red_spot(north_up[..., :3], label)
    if key == "saturn/colour":
        return landmarks.saturn_seasons(north_up[..., :3], label)
    if key == "saturn/rings":
        c = landmarks.Checks(label, "saturn")
        alpha = decoded[0, :, 3].astype(np.float64) / 255.0
        luma = landmarks.luma(decoded[0, :, :3])
        km = config.RINGS_INNER_KM + (np.arange(alpha.size) + 0.5) * (config.RINGS_OUTER_KM - config.RINGS_INNER_KM) / alpha.size

        def span(lo: float, hi: float) -> NDArray[np.bool_]:
            return (km > lo) & (km < hi)

        c.expect("B ring core opacity", float(alpha[span(105_000, 110_000)].mean()), ">", 0.9)
        c.expect("Cassini Division opacity", float(alpha[span(118_500, 119_500)].mean()), "<", 0.4)
        # Straight alpha (planets.json): clear texels keep the colour of the ring material beside
        # them. Premultiplied data would be black there, and a consumer told the wrong convention
        # would make the gaps glow or darken the thin rings twice.
        a_ring = float(luma[span(133_000, 133_400) | span(133_800, 134_200)].mean())
        c.expect("Encke Gap opacity", float(alpha[span(133_480, 133_700)].mean()), "<", 0.15)
        c.expect("Encke Gap luma / A ring luma (straight alpha)", float(luma[span(133_480, 133_700)].mean()) / max(a_ring, 1.0), ">", 0.8)
        outer_a = float(luma[span(136_000, 136_400)].mean())
        c.expect("beyond the A ring, opacity", float(alpha[span(137_500, 144_900)].max()), "<", 0.02)
        c.expect("beyond the A ring, luma / outer A ring luma (straight alpha)", float(luma[span(136_800, 144_900)].mean()) / max(outer_a, 1.0), ">", 0.8)
        return c.report()
    raise SystemExit(f"no landmark check for {key}")


def quality(spec: config.MapSpec, codec: str, source: NDArray[np.uint8], decoded: NDArray[np.uint8]) -> dict[str, float]:
    if spec.kind == "normal":
        # Compare X and Y with the input's, and the angle between the unit normals.
        x_in, y_in = source[..., 0], source[..., 1]
        xy = normal_xy(decoded)
        x_out, y_out = xy[..., 0], xy[..., 1]

        def unit(x: NDArray[np.uint8], y: NDArray[np.uint8]) -> NDArray[np.float64]:
            v = np.stack([x / 255.0 * 2 - 1, y / 255.0 * 2 - 1], axis=-1).astype(np.float64)
            z = np.sqrt(np.clip(1.0 - (v**2).sum(-1), 0.0, 1.0))
            return np.concatenate([v, z[..., None]], axis=-1)

        dot = np.clip((unit(x_in, y_in) * unit(x_out, y_out)).sum(-1), -1.0, 1.0)
        angle = np.degrees(np.arccos(dot))
        return {"psnrX": psnr(x_in, x_out), "psnrY": psnr(y_in, y_out), "meanAngleErrorDeg": round(float(angle.mean()), 3), "p99AngleErrorDeg": round(float(np.percentile(angle, 99)), 3)}
    if spec.kind == "grey":
        grey = decoded if decoded.ndim == 2 else decoded[..., 0]
        return {"psnr": psnr(source, grey)}
    if spec.kind == "strip":
        return {"psnrRgb": psnr(source[..., :3], decoded[..., :3]), "psnrA": psnr(source[..., 3], decoded[..., 3])}
    return {"psnrRgb": psnr(source[..., :3], decoded[..., :3]), **{f"psnr{c}": psnr(source[..., i], decoded[..., i]) for i, c in enumerate("RGB")}}


def encode_file(spec: config.MapSpec, width: int, codec: str, out: Path) -> dict[str, Any]:
    levels = level_files(spec, width)
    out.parent.mkdir(parents=True, exist_ok=True)
    staged = out.with_name(out.name + ".part")
    started = time.monotonic()
    run([
        KTX, "create", *ktx_args(spec, codec),
        "--assign-texcoord-origin", "bottom-left",
        "--levels", str(len(levels)),
        *levels, staged,
    ])
    run([KTX, "validate", staged])
    staged.replace(out)
    seconds = round(time.monotonic() - started, 1)
    decoded = decode(out, codec)
    source = read_png(levels[0])
    q = quality(spec, codec, source, decoded)
    marks = check_decoded(spec, decoded, f"{out.name} decoded")
    height = 1 if spec.kind == "strip" else width // 2
    print(f"  {out.relative_to(config.ROOT)}: {out.stat().st_size:,} bytes, {len(levels)} levels, {q}, {seconds} s")
    return {
        "body": spec.body,
        "map": spec.map,
        "width": width,
        "height": height,
        "levels": len(levels),
        "codec": codec,
        "bytes": out.stat().st_size,
        "sha256": sha256(out),
        "file": str(out.relative_to(config.ROOT)),
        "quality": q,
        "landmarks": marks,
        "seconds": seconds,
    }


def encode_all(only: set[str] | None) -> dict[str, Any]:
    previous = json.loads(REPORT.read_text()) if REPORT.exists() and only else {"files": {}}
    files: dict[str, Any] = dict(previous.get("files", {}))
    tiers: dict[str, dict[str, str]] = dict(previous.get("tiers", {}))
    for spec in config.MAPS:
        key = f"{spec.body}/{spec.map}"
        if only and key not in only:
            continue
        print(f"{key}:")
        tiers[key] = {}
        for tier in config.TIERS:
            width = tier_width(spec, tier)
            codec = codec_for(spec, tier)
            name = file_name(spec, width, codec)
            published = any(tier_width(spec, t) == width and codec_for(spec, t) == codec for t in config.PUBLISHED_TIERS)
            out = (config.PUBLIC if published else config.ULTRA) / spec.body / name
            rel = str(out.relative_to(config.ROOT))
            if rel not in files or (only and key in only and files[rel].get("_built") != "now"):
                files[rel] = encode_file(spec, width, codec, out) | {"_built": "now"}
            tiers[key][tier] = rel
    for entry in files.values():
        entry.pop("_built", None)
    # Drop files no tier refers to any more (a map whose widths changed since the last run).
    referenced = {path for paths in tiers.values() for path in paths.values()}
    files = {path: entry for path, entry in files.items() if path in referenced}
    return {"tool": tool_version(), "files": files, "tiers": tiers}


def budgets(report: dict[str, Any]) -> dict[str, Any]:
    """Transfer per tier (each body's whole set) and the committed total; over budget fails."""
    files, tiers = report["files"], report["tiers"]
    totals: dict[str, int] = {}
    for tier in config.TIERS:
        unique = {paths[tier] for paths in tiers.values()}
        totals[tier] = sum(files[p]["bytes"] for p in unique)
    committed = sum(f["bytes"] for p, f in files.items() if p.startswith("public/"))
    problems = [f"{t} set is {totals[t]:,} bytes, over {config.TIER_BUDGET_BYTES[t]:,}" for t in totals if totals[t] > config.TIER_BUDGET_BYTES[t]]
    if committed > config.COMMITTED_BUDGET_BYTES:
        problems.append(f"published files total {committed:,} bytes, over {config.COMMITTED_BUDGET_BYTES:,}")
    for t, n in totals.items():
        print(f"  {t}: {n:,} bytes (budget {config.TIER_BUDGET_BYTES[t]:,})")
    print(f"  published (committed): {committed:,} bytes (budget {config.COMMITTED_BUDGET_BYTES:,})")
    if problems:
        raise SystemExit("over budget:\n  " + "\n  ".join(problems))
    return {"tierBytes": totals, "committedBytes": committed}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("maps", nargs="*", help="body/map keys to re-encode (default: all)")
    only = set(parser.parse_args().maps) or None
    report = encode_all(only)
    # Files no longer produced (renamed or dropped maps) are removed so they cannot linger in public/.
    wanted = {Path(config.ROOT / p) for p in report["files"]}
    for folder in (config.PUBLIC, config.ULTRA):
        for stale in folder.rglob("*.ktx2"):
            if stale not in wanted:
                print(f"  removing stale {stale.relative_to(config.ROOT)}")
                stale.unlink()
    report["budgets"] = budgets(report)
    config.REPORTS.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {REPORT.relative_to(config.ROOT)}")


if __name__ == "__main__":
    main()
